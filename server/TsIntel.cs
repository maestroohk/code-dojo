using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// JavaScript / TypeScript code intelligence from TypeScript itself: its LanguageService, run by Node in
/// one long-lived helper (server/intel/tsintel.js) that speaks JSON lines over stdin/stdout. The typescript
/// package comes from the code space's node_modules when it has one, else from a copy the dojo installs
/// once into its tools folder. Whenever the engine cannot answer in time (not installed yet, no Node,
/// still loading, crashed), <see cref="Run"/> returns null and the caller uses JsIntel instead.
/// </summary>
public static class TsIntel
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    static readonly object Gate = new();
    static readonly ConcurrentDictionary<long, (TaskCompletionSource<string?> Answer, DateTime Sent)> Pending = new();
    static Process? proc;
    static string? scriptPath;
    static long seq;
    static Task? install;
    static DateTime installFailed = DateTime.MinValue;

    /// <summary>How long the editor waits for an answer before it uses the fallback for that request.</summary>
    public static TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>Where the dojo keeps tools it installs for itself (beside pyenv and spaces).</summary>
    public static string ToolsDir => Environment.GetEnvironmentVariable("DOJO_TOOLS") is { Length: > 0 } d ? d
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "code-dojo", "tools");

    static string OwnCopy => Path.Combine(ToolsDir, "typescript");

    static readonly CodeIntel.Response Empty = new(null, null, null, null, null);

    static bool IsJs(string p) => System.Text.RegularExpressions.Regex.IsMatch(p, @"\.(m|c)?(j|t)sx?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    /// <summary>The folder of a usable typescript package: the project's own, else the dojo's (started installing when missing).</summary>
    public static string? TypeScriptFor(string? projectDir)
    {
        if (projectDir is not null && Usable(Path.Combine(projectDir, "node_modules", "typescript")) is { } own) return own;
        if (Usable(Path.Combine(OwnCopy, "node_modules", "typescript")) is { } ours) return ours;
        StartInstall();
        return null;
    }

    static string? Usable(string dir)
    {
        try
        {
            if (!File.Exists(Path.Combine(dir, "lib", "typescript.js"))) return null;
            var version = (string?)JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "package.json")))?["version"];
            // The LanguageService calls used here have been stable since TypeScript 4.
            return version is not null && int.TryParse(version.Split('.')[0], out var major) && major >= 4 ? Path.GetFullPath(dir) : null;
        }
        catch { return null; }
    }

    /// <summary>
    /// The engine's answer, or null when it has none to give (the caller falls back to JsIntel).
    /// <paramref name="typescriptDir"/> overrides where typescript is loaded from (tests).
    /// </summary>
    public static async Task<CodeIntel.Response?> Run(CodeIntel.Request req, string? projectDir, TimeSpan? timeout = null, string? typescriptDir = null)
    {
        var ts = typescriptDir ?? TypeScriptFor(projectDir);
        if (ts is null || CodeSpaces.NodeExe() is null) return null;
        var all = req.Files ?? [];
        var me = all.FirstOrDefault(f => f.Path == req.Path);
        if (me is null) return Empty;
        var code = me.Code ?? "";
        var pos = Math.Clamp(req.Position, 0, code.Length);
        pos -= CountCrLf(code, pos);   // the helper sees \n line ends
        var files = all.Where(f => f.Path == req.Path || IsJs(f.Path) || f.Path.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            .Select(f => new { path = f.Path, code = f.Code ?? "" }).ToList();
        var id = Interlocked.Increment(ref seq);
        var payload = JsonSerializer.Serialize(new { id, action = req.Action, files, path = req.Path, position = pos, ts, root = projectDir }, Json);

        var line = await Ask(id, payload, timeout ?? Timeout);
        if (line is null) return null;
        try
        {
            var node = JsonNode.Parse(line);
            if (node?["error"] is not null) return null;
            var r = node.Deserialize<CodeIntel.Response>(Json);
            return r is null ? null : r with { Engine = "typescript" };
        }
        catch (JsonException) { return null; }
    }

    static int CountCrLf(string s, int end)
    {
        int n = 0;
        for (var i = s.IndexOf("\r\n", StringComparison.Ordinal); i >= 0 && i < end; i = s.IndexOf("\r\n", i + 2, StringComparison.Ordinal)) n++;
        return n;
    }

    static async Task<string?> Ask(long id, string payload, TimeSpan timeout)
    {
        var answer = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (Gate)
        {
            // A queue means the helper is busy (a big project loading): answer from the fallback, do not pile up.
            if (Pending.Count >= 3) { RestartIfStuck(); return null; }
            var p = Start();
            if (p is null) return null;
            Pending[id] = (answer, DateTime.UtcNow);
            try
            {
                p.StandardInput.WriteLine(payload);
                p.StandardInput.Flush();
            }
            catch (Exception e) when (e is IOException or InvalidOperationException or ObjectDisposedException)
            {
                Pending.TryRemove(id, out _);
                Stop();
                return null;
            }
        }
        // The helper keeps working on a request that took too long: its project is then warm for the next one.
        var done = await Task.WhenAny(answer.Task, Task.Delay(timeout));
        if (done == answer.Task) return await answer.Task;
        lock (Gate) RestartIfStuck();
        return null;
    }

    /// <summary>Nothing answered for 20 seconds: the helper is stuck (or swapping); start a fresh one.</summary>
    static void RestartIfStuck()
    {
        if (Pending.Values.Any(v => DateTime.UtcNow - v.Sent > TimeSpan.FromSeconds(20))) Stop();
    }

    static Process? Start()
    {
        if (proc is { HasExited: false }) return proc;
        Stop();
        if (CodeSpaces.NodeExe() is not { } node) return null;
        try
        {
            var psi = new ProcessStartInfo(node)
            {
                WorkingDirectory = Path.GetTempPath(),
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                UseShellExecute = false, CreateNoWindow = true,
                StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            psi.ArgumentList.Add(Script());
            psi.Environment["NODE_OPTIONS"] = "";   // the learner's NODE_OPTIONS (--require hooks) are not for this helper
            var p = Process.Start(psi)!;
            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
            p.ErrorDataReceived += (_, _) => { };
            p.BeginErrorReadLine();
            proc = p;
            _ = Task.Run(() => Read(p));
            return p;
        }
        catch { proc = null; return null; }
    }

    /// <summary>Hands each answer line to the request with the same id; when the helper dies, the waiting requests fall back.</summary>
    static async Task Read(Process p)
    {
        try
        {
            string? line;
            while ((line = await p.StandardOutput.ReadLineAsync()) is not null)
            {
                long id;
                try { id = JsonNode.Parse(line)?["id"]?.GetValue<long>() ?? 0; } catch { continue; }
                if (Pending.TryRemove(id, out var w)) w.Answer.TrySetResult(line);
            }
        }
        catch { }
        lock (Gate)
        {
            if (proc == p) proc = null;
            foreach (var id in Pending.Keys.ToList())
                if (Pending.TryRemove(id, out var w)) w.Answer.TrySetResult(null);
        }
    }

    static void Stop()
    {
        var p = proc;
        proc = null;
        if (p is null) return;
        try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { }
        foreach (var id in Pending.Keys.ToList())
            if (Pending.TryRemove(id, out var w)) w.Answer.TrySetResult(null);
    }

    /// <summary>The helper ships inside the server assembly; it is written out once per version.</summary>
    static string Script()
    {
        if (scriptPath is not null && File.Exists(scriptPath)) return scriptPath;
        using var s = typeof(TsIntel).Assembly.GetManifestResourceStream("tsintel.js") ?? throw new FileNotFoundException("tsintel.js resource");
        using var reader = new StreamReader(s, Encoding.UTF8);
        var text = reader.ReadToEnd();
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..12];
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "intel");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"tsintel-{hash}.js");
        if (!File.Exists(path))
        {
            var tmp = path + "." + Guid.NewGuid().ToString("N")[..8];
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            try { File.Move(tmp, path); } catch (IOException) { File.Delete(tmp); }   // another server wrote it first
        }
        if (scriptPath is null) AppDomain.CurrentDomain.ProcessExit += (_, _) => { lock (Gate) Stop(); };
        return scriptPath = path;
    }

    // ---------------------------------------------------------------- the dojo's own copy of typescript

    /// <summary>Install typescript@5 into the tools folder, in the background, once (again after 10 minutes if it failed).</summary>
    public static Task? StartInstall()
    {
        lock (Gate)
        {
            if (install is { IsCompleted: false }) return install;
            if (Usable(Path.Combine(OwnCopy, "node_modules", "typescript")) is not null) return null;
            if (DateTime.UtcNow - installFailed < TimeSpan.FromMinutes(10)) return null;
            if (CodeSpaces.NodeExe() is null || CodeSpaces.NpmCli() is null) return null;
            return install = Task.Run(Install);
        }
    }

    static async Task Install()
    {
        try
        {
            var dir = OwnCopy;
            Directory.CreateDirectory(dir);
            var manifest = Path.Combine(dir, "package.json");
            if (!File.Exists(manifest))
                File.WriteAllText(manifest, "{\n  \"name\": \"dojo-typescript\",\n  \"private\": true,\n  \"description\": \"TypeScript for code-dojo's editor (completion, hover, go to definition).\"\n}\n");
            var psi = new ProcessStartInfo(CodeSpaces.NodeExe()!)
            {
                WorkingDirectory = dir, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            };
            foreach (var a in new[] { CodeSpaces.NpmCli()!, "install", "typescript@5", "--no-audit", "--no-fund", "--loglevel=error" }) psi.ArgumentList.Add(a);
            psi.Environment["npm_config_update_notifier"] = "false";
            psi.Environment["NO_UPDATE_NOTIFIER"] = "1";
            using var p = Process.Start(psi)!;
            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
            var drain = Task.WhenAll(p.StandardOutput.ReadToEndAsync(), p.StandardError.ReadToEndAsync());
            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(4));
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException) { try { p.Kill(true); } catch { } }
            await drain;
            if (!p.HasExited || p.ExitCode != 0 || Usable(Path.Combine(dir, "node_modules", "typescript")) is null) installFailed = DateTime.UtcNow;
        }
        catch { installFailed = DateTime.UtcNow; }
    }
}
