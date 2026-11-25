using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// A recording that keeps going while the program runs (CodeDebugger.cs records a whole run, then stops).
///
/// Web apps: the app runs on a private port with the recorder in web mode. Its middleware (CodeDebugger.WebSupport)
/// tags every request, so each step carries the request it ran for. The recording file is read as it grows and
/// split per request (startup is request 0); the UI lists the requests and loads one at a time into the debugger.
/// Old requests are dropped beyond <see cref="MaxRequests"/> or <see cref="MaxStoredEvents"/>; the recorder caps
/// each request at MaxEvents steps.
///
/// Console programs (interactive input): Console.ReadLine reports when it is about to wait (a W record, then a
/// marker on stdout). The dojo then shows the timeline so far; the line the learner types goes to stdin and the
/// recording continues in the same process.
///
/// Extra records on top of CodeDebugger's: W (waiting for input), R / RE (request start / end), RT (a request
/// reached its cap), O (output printed between steps), FULL (the file cap was reached).
/// </summary>
public sealed class LiveDebug : IDisposable
{
    public const int MaxRequests = 40;
    public const int MaxStoredEvents = 400_000;
    public const int IdleLimitMs = 20 * 60_000;
    const int WebCpuLimitMs = 10 * 60_000, LogCap = 200_000, StderrCap = 20_000;

    public sealed class Request
    {
        public int Id;
        public string Method = "", Path = "";
        public int? Status;
        public long? Ms;
        public bool Done, Failed, Truncated;
        public DateTimeOffset Started = DateTimeOffset.UtcNow;
        public readonly List<JsonObject> Events = [];
        public readonly HashSet<long> Lines = [];
        public int Steps, Throws;
    }

    public string Id { get; } = Guid.NewGuid().ToString("N")[..12];
    public bool Web { get; }
    public int Port { get; }
    public string? Url => Web && Port > 0 ? $"http://127.0.0.1:{Port}" : null;
    public bool Listening { get; private set; }
    public bool Exited { get { try { return _proc.HasExited; } catch { return true; } } }
    public List<string> Files { get; }
    public DateTimeOffset LastTouched { get; private set; } = DateTimeOffset.UtcNow;

    readonly Process _proc;
    readonly CodeDebugger.Built _built;
    readonly CodeDebugger.Input _input;
    readonly int _max;
    readonly List<string> _notes;
    readonly object _lock = new();
    readonly SemaphoreSlim _turn = new(1, 1);
    readonly Stopwatch _sw = Stopwatch.StartNew();
    readonly Task _stdout, _stderrTask;
    readonly StringBuilder _stderr = new();

    // The live reader (web).
    long _offset;
    byte[] _partial = [];
    readonly List<string?> _values = [], _stacks = [];
    readonly Request _startup = new() { Id = 0, Path = "(startup)" };
    readonly SortedDictionary<int, Request> _requests = [];
    int _stored, _dropped;
    readonly StringBuilder _log = new();
    long _logTotal;
    bool _full, _ended;

    // Interactive input (console).
    int _waits, _supplied;
    long _activeMs;
    bool _timedOut, _killed, _disposed;
    string? _killReason;
    CodeDebugger.Result? _final;

    LiveDebug(Process proc, CodeDebugger.Built built, CodeDebugger.Input input, CodeDebugger.Result first, int port)
    {
        _proc = proc; _built = built; _input = input; Port = port; Web = input.Web;
        _max = first.MaxEvents;
        Files = first.Files;
        _notes = [.. first.Notes];
        _stdout = ReadStdout();
        _stderrTask = ReadStderr();
        _ = Monitor();
    }

    /// <summary>Compile, start, and return the session (null with the reason in the result when it cannot start).</summary>
    public static (LiveDebug? Session, CodeDebugger.Result Result) Start(string dotnet, CodeDebugger.Input input)
    {
        var result = CodeDebugger.NewResult(input);
        if (CodeDebugger.Build(input, result) is not { } built) return (null, result);
        var psi = CodeDebugger.StartInfo(dotnet, built.Dll, built.Dir, built.Sink, result.MaxEvents, input);
        var port = 0;
        if (input.Web)
        {
            using (var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0)) { probe.Start(); port = ((IPEndPoint)probe.LocalEndpoint).Port; }
            psi.Environment["DOJO_DEBUG_WEB"] = "1";
            psi.Environment["ASPNETCORE_URLS"] = $"http://127.0.0.1:{port}";
            psi.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";
            psi.Environment["Logging__Console__FormatterName"] = "simple";
            psi.Environment["Logging__Console__FormatterOptions__ColorBehavior"] = "Disabled";
        }
        else psi.Environment["DOJO_DEBUG_LIVE"] = "1";
        Process proc;
        try { proc = Process.Start(psi)!; }
        catch (Exception e)
        {
            result.Error = "The program could not start: " + e.Message;
            try { Directory.Delete(built.Dir, true); } catch { }
            return (null, result);
        }
        try { proc.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        var s = new LiveDebug(proc, built, input, result, port);
        try
        {
            if (!input.Web && !string.IsNullOrEmpty(input.Stdin))
            {
                var text = input.Stdin.Replace("\r\n", "\n");
                if (!text.EndsWith('\n')) text += "\n";
                s._supplied = text.Count(c => c == '\n');
                proc.StandardInput.Write(text);
                proc.StandardInput.Flush();
            }
            if (input.Web) proc.StandardInput.Close();
        }
        catch (IOException) { }
        return (s, result);
    }

    public void Touch() => LastTouched = DateTimeOffset.UtcNow;

    /// <summary>The program is blocked in Console.ReadLine and waits for a line from the learner.</summary>
    public bool Waiting { get { lock (_lock) return !Web && _waits > _supplied && !Exited; } }

    async Task ReadStdout()
    {
        try
        {
            string? line;
            while ((line = await _proc.StandardOutput.ReadLineAsync()) is not null)
            {
                if (line == "\u0002WAIT") { lock (_lock) _waits++; continue; }
                lock (_lock) Log(line + "\n");        // output that bypassed Console.Out
            }
        }
        catch { }
    }

    async Task ReadStderr()
    {
        try
        {
            string? line;
            while ((line = await _proc.StandardError.ReadLineAsync()) is not null)
                lock (_lock)
                {
                    if (_stderr.Length < StderrCap) _stderr.Append(line).Append('\n');
                    Log(line + "\n");
                }
        }
        catch { }
    }

    void Log(string text)
    {
        _log.Append(text);
        _logTotal += text.Length;
        if (_log.Length > LogCap * 2) _log.Remove(0, _log.Length - LogCap);
    }

    /// <summary>Limits, listening, and (web) keeping the parsed recording current.</summary>
    async Task Monitor()
    {
        var last = _sw.ElapsedMilliseconds;
        while (!_disposed)
        {
            await Task.Delay(Web ? 150 : 50);
            var now = _sw.ElapsedMilliseconds;
            if (Exited) { if (Web) Pump(); break; }
            if (!Web && !Waiting) _activeMs += now - last;
            last = now;
            try
            {
                var cpu = _proc.TotalProcessorTime.TotalMilliseconds;
                long size = 0;
                try { size = new FileInfo(_built.Sink).Length; } catch { }
                string? reason = null;
                if (DateTimeOffset.UtcNow - LastTouched > TimeSpan.FromMilliseconds(IdleLimitMs)) reason = "Stopped: nobody was looking at it for 20 minutes.";
                else if (Web && cpu > WebCpuLimitMs) reason = "Stopped: it used more processor time than the debugger allows.";
                else if (!Web && (cpu > CodeDebugger.CpuLimitMs || _activeMs > CodeDebugger.WallLimitMs || size > CodeDebugger.SinkCap))
                { reason = "It ran longer than the debugger allows and was stopped; the steps up to then are here."; _timedOut = true; }
                if (reason is not null) { Kill(reason); break; }
            }
            catch { }
            if (Web)
            {
                if (!Listening && Port > 0) _ = Probe();
                Pump();
            }
        }
    }

    bool _probing;
    async Task Probe()
    {
        if (_probing) return;
        _probing = true;
        try
        {
            using var c = new System.Net.Sockets.TcpClient();
            await c.ConnectAsync(IPAddress.Loopback, Port);
            Listening = true;
        }
        catch { }
        finally { _probing = false; }
    }

    void Kill(string reason)
    {
        lock (_lock) { _killed = true; _killReason = reason; Log("[dojo] " + reason + "\n"); }
        try { _proc.Kill(entireProcessTree: true); } catch { }
    }

    /// <summary>Wait until the web app accepts connections (or stops).</summary>
    public async Task<bool> WaitListening(int ms)
    {
        var sw = Stopwatch.StartNew();
        while (!Listening && !Exited && sw.ElapsedMilliseconds < ms)
        {
            await Probe();
            if (!Listening) await Task.Delay(150);
        }
        Pump();
        return Listening;
    }

    // ================================================================ the live reader (web)

    /// <summary>Read what the recorder has written since last time.</summary>
    public void Pump()
    {
        lock (_lock)
        {
            byte[] fresh;
            try
            {
                using var fs = new FileStream(_built.Sink, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                if (fs.Length <= _offset) return;
                fs.Seek(_offset, SeekOrigin.Begin);
                fresh = new byte[Math.Min(fs.Length - _offset, 64L << 20)];
                var n = 0;
                while (n < fresh.Length) { var k = fs.Read(fresh, n, fresh.Length - n); if (k <= 0) break; n += k; }
                if (n < fresh.Length) Array.Resize(ref fresh, n);
                _offset += n;
            }
            catch { return; }
            var data = _partial.Length == 0 ? fresh : [.. _partial, .. fresh];
            var start = 0;
            for (var i = 0; i < data.Length; i++)
            {
                if (data[i] != (byte)'\n') continue;
                Handle(Encoding.UTF8.GetString(data, start, i - start));
                start = i + 1;
            }
            _partial = start < data.Length ? data[start..] : [];
        }
    }

    static void Set(List<string?> list, int id, string json)
    {
        while (list.Count <= id) list.Add(null);
        list[id] = json;
    }

    void Handle(string line)
    {
        try
        {
            if (line.StartsWith("V\t") || line.StartsWith("S\t"))
            {
                var tab = line.IndexOf('\t', 2);
                if (tab < 0) return;
                Set(line[0] == 'V' ? _values : _stacks, int.Parse(line.AsSpan(2, tab - 2)), line[(tab + 1)..]);
            }
            else if (line.StartsWith("E\t") || line.StartsWith("X\t") || line.StartsWith("W\t"))
            {
                if (JsonNode.Parse(line[2..]) is not JsonObject e) return;
                if ((string?)e["o"] is { Length: > 0 } o) Log(o);
                var r = (int?)e["r"] ?? 0;
                var req = r == 0 ? _startup : _requests.GetValueOrDefault(r);
                if (req is null) return;                  // dropped already
                if (req.Events.Count >= _max + 2000) { req.Truncated = true; return; }
                e.Remove("r");
                req.Events.Add(e);
                _stored++;
                if (line[0] == 'E')
                {
                    req.Steps++;
                    if (e["f"] is { } f && e["l"] is { } l) req.Lines.Add(Key((int)f, (int)l));
                }
                else if (line[0] == 'X' && (string?)e["k"] == "throw") req.Throws++;
                Evict();
            }
            else if (line.StartsWith("O\t"))
            {
                if (JsonNode.Parse(line[2..]) is JsonObject e && (string?)e["o"] is { Length: > 0 } o) Log(o);
            }
            else if (line.StartsWith("R\t"))
            {
                if (JsonNode.Parse(line[2..]) is not JsonObject e) return;
                var id = (int)e["r"]!;
                _requests[id] = new Request { Id = id, Method = (string?)e["m"] ?? "", Path = (string?)e["p"] ?? "" };
                Evict();
            }
            else if (line.StartsWith("RE\t"))
            {
                if (JsonNode.Parse(line[3..]) is not JsonObject e || !_requests.TryGetValue((int)e["r"]!, out var req)) return;
                req.Status = (int?)e["st"]; req.Ms = (long?)e["ms"]; req.Failed = (bool?)e["failed"] == true; req.Done = true;
            }
            else if (line.StartsWith("RT\t"))
            {
                if (JsonNode.Parse(line[3..]) is not JsonObject e) return;
                var id = (int)e["r"]!;
                if (id == 0) _startup.Truncated = true;
                else if (_requests.TryGetValue(id, out var req)) req.Truncated = true;
            }
            else if (line.StartsWith("END\t"))
            {
                if (JsonNode.Parse(line[4..]) is JsonObject e && (string?)e["o"] is { Length: > 0 } o) Log(o);
                _ended = true;
            }
            else if (line == "FULL")
            {
                _full = true;
                _notes.Add("The recording reached its size limit: new requests are no longer recorded. Restart to record again.");
            }
        }
        catch { /* a malformed line */ }
    }

    static long Key(int f, int l) => ((long)f << 32) | (uint)l;

    void Evict()
    {
        while (_requests.Count > 1 && (_requests.Count > MaxRequests || _stored > MaxStoredEvents))
        {
            var oldest = _requests.First();
            _stored -= oldest.Value.Events.Count;
            _requests.Remove(oldest.Key);
            _dropped++;
        }
    }

    HashSet<long> BreakpointKeys(List<CodeDebugger.Breakpoint>? bps)
    {
        var keys = new HashSet<long>();
        foreach (var b in bps ?? [])
        {
            var f = Files.IndexOf(b.File ?? (Files.Count > 0 ? Files[0] : ""));
            if (f >= 0) keys.Add(Key(f, b.Line));
        }
        return keys;
    }

    // ================================================================ what the UI asks for

    /// <summary>The session's state: requests (web), the app's output, whether it waits for input.</summary>
    public object Summary(List<CodeDebugger.Breakpoint>? bps)
    {
        Touch();
        if (Web) Pump();
        lock (_lock)
        {
            var keys = BreakpointKeys(bps);
            object Row(Request q) => new
            {
                id = q.Id, method = q.Method, path = q.Path, status = q.Status, ms = q.Ms, done = q.Done,
                steps = q.Steps, throws = q.Throws, truncated = q.Truncated,
                failed = q.Failed || (q.Status >= 500 && q.Throws > 0) || q.Events.Any(e => (string?)e["k"] == "crash"),
                hit = keys.Count > 0 && q.Lines.Overlaps(keys),
                at = q.Started.ToUnixTimeMilliseconds(),
            };
            int? exitCode = null;
            if (Exited) try { exitCode = _proc.ExitCode; } catch { }
            var log = _log.Length > LogCap ? _log.ToString(_log.Length - LogCap, LogCap) : _log.ToString();
            return new
            {
                session = Id, web = Web, url = Url, listening = Listening, alive = !Exited, exitCode,
                waiting = !Web && _waits > _supplied && !Exited,
                startup = Web ? Row(_startup) : null,
                requests = Web ? _requests.Values.Reverse().Select(Row).ToList() : [],
                dropped = _dropped, full = _full, ended = _ended, log, logTotal = _logTotal, stopped = _killReason, maxEvents = _max,
            };
        }
    }

    /// <summary>One request's recording (0: startup), shaped like a whole-run recording so the debugger UI can load it.</summary>
    public CodeDebugger.Result RequestResult(int id, List<CodeDebugger.Breakpoint>? bps)
    {
        Touch();
        Pump();
        var r = new CodeDebugger.Result { Files = Files, MaxEvents = _max };
        lock (_lock)
        {
            r.Notes = [.. _notes];
            var req = id == 0 ? _startup : _requests.GetValueOrDefault(id);
            if (req is null) { r.Error = "That request is no longer kept (only the newest ones are)."; return r; }
            var vmap = new Dictionary<int, int>();
            var smap = new Dictionary<int, int>();
            int MapS(int s)
            {
                if (s < 0) return s;
                if (smap.TryGetValue(s, out var n)) return n;
                n = r.Stacks.Count;
                r.Stacks.Add(s < _stacks.Count && _stacks[s] is { } json ? JsonNode.Parse(json) : null);
                return smap[s] = n;
            }
            int MapV(int v)
            {
                if (vmap.TryGetValue(v, out var n)) return n;
                n = r.Values.Count;
                r.Values.Add(v >= 0 && v < _values.Count && _values[v] is { } json ? JsonNode.Parse(json) : null);
                return vmap[v] = n;
            }
            JsonObject Copy(JsonObject e)
            {
                var c = (JsonObject)e.DeepClone();
                if (c["s"] is { } s) c["s"] = MapS((int)s);
                if (c["v"] is JsonArray vs) c["v"] = new JsonArray(vs.Select(x => (JsonNode?)JsonValue.Create(MapV((int)x!))).ToArray());
                return c;
            }
            var output = new StringBuilder();
            JsonObject? lastThrow = null;
            foreach (var e in req.Events)
            {
                var c = Copy(e);
                output.Append((string?)c["o"] ?? "");
                if ((string?)c["k"] == "throw") lastThrow = c;
                if ((string?)c["k"] == "crash") r.Exception = (JsonObject)c.DeepClone();
                r.Events.Add(c);
            }
            // A request that ended in a 500 after the program's own code threw: that exception is what failed it.
            if (r.Exception is null && id > 0 && lastThrow is not null && (req.Failed || req.Status >= 500))
            {
                var crash = (JsonObject)lastThrow.DeepClone();
                crash["k"] = "crash";
                crash.Remove("o");
                r.Events.Add(crash);
                r.Exception = (JsonObject)crash.DeepClone();
            }
            if (id > 0 && req.Done)
                r.Events.Add(new JsonObject { ["k"] = "end", ["req"] = $"{req.Method} {req.Path} answered {req.Status} in {req.Ms} ms." });
            r.Output = output.ToString();
            r.Ms = req.Ms ?? 0;
            r.Truncated = req.Truncated;
            if (req.Truncated) r.Notes.Add($"This {(id == 0 ? "startup" : "request")} stopped being recorded after {_max:N0} steps{(id > 0 ? " and was cancelled" : "")}.");
            if (_dropped > 0) r.Notes.Add($"{_dropped} older request{(_dropped == 1 ? " was" : "s were")} dropped to save memory.");
            if (Exited)
            {
                try { r.ExitCode = _proc.ExitCode; } catch { }
                r.Stderr = _stderr.ToString().Trim();
            }
        }
        CodeDebugger.AddHits(r, bps);
        return r;
    }

    // ================================================================ interactive console

    /// <summary>Wait until the program waits for input or ends, then read the recording so far.</summary>
    public async Task<CodeDebugger.Result> Snapshot(List<CodeDebugger.Breakpoint>? bps)
    {
        Touch();
        await _turn.WaitAsync();
        try { return await SnapshotCore(bps); }
        finally { _turn.Release(); }
    }

    async Task<CodeDebugger.Result> SnapshotCore(List<CodeDebugger.Breakpoint>? bps)
    {
        if (_final is not null) { CodeDebugger.AddHits(_final, bps); return _final; }
        var sw = Stopwatch.StartNew();
        while (!Waiting && !Exited && sw.ElapsedMilliseconds < CodeDebugger.WallLimitMs + 10_000) await Task.Delay(25);
        var r = new CodeDebugger.Result { Files = Files, MaxEvents = _max, Notes = [.. _notes] };
        if (Exited)
        {
            try { await Task.WhenAll(_stdout, _stderrTask).WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            r.TimedOut = _timedOut;
            try { r.ExitCode = _timedOut ? -1 : _proc.ExitCode; } catch { }
            lock (_lock) r.Stderr = _stderr.ToString().Trim();
        }
        r.Ms = _sw.ElapsedMilliseconds;
        CodeDebugger.Read(_built.Sink, r);
        if (_timedOut) r.Notes.Add("It ran longer than the debugger allows and was stopped; the steps up to then are here.");
        else if (_killed && _killReason is not null) r.Notes.Add(_killReason);
        CodeDebugger.AddHits(r, bps);
        if (Exited)
        {
            _final = r;
            Cleanup();
        }
        return r;
    }

    /// <summary>Give the waiting program one line, then wait for the next read or the end.</summary>
    public async Task<CodeDebugger.Result> Input(string? text, List<CodeDebugger.Breakpoint>? bps)
    {
        Touch();
        await _turn.WaitAsync();
        try
        {
            if (!Exited && _final is null)
            {
                var line = (text ?? "").Replace("\r", "").Replace("\n", " ");
                try
                {
                    _proc.StandardInput.Write(line + "\n");
                    _proc.StandardInput.Flush();
                    lock (_lock) _supplied++;
                }
                catch (IOException) { }
            }
            return await SnapshotCore(bps);
        }
        finally { _turn.Release(); }
    }

    // ================================================================ lifetime

    void Cleanup()
    {
        for (var i = 0; i < 5; i++)
        {
            try { if (Directory.Exists(_built.Dir)) Directory.Delete(_built.Dir, true); return; }
            catch { Thread.Sleep(100); }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { if (!_proc.HasExited) _proc.Kill(entireProcessTree: true); } catch { }
        try { _proc.WaitForExit(3000); } catch { }
        Cleanup();
        _proc.Dispose();
    }
}
