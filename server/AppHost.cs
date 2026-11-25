using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// The Workbench: runs learner web apps as long-lived processes on private loopback ports, sends
/// requests to them on the learner's behalf (JSON, form, multipart), and collects a trace of every
/// request each app handles and every call it makes to another app. Apps can find each other through
/// configuration: an app started after "tasks" can read builder.Configuration["Services:tasks"].
/// </summary>
public sealed partial class AppHost(CSharpRunner runner) : IDisposable
{
    public const int MaxApps = 4;
    static readonly TimeSpan IdleLimit = TimeSpan.FromMinutes(30);
    const int LogCap = 500, TraceCap = 300;

    readonly ConcurrentDictionary<string, LiveApp> _apps = new();
    readonly HttpClient _http = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(30) };

    public sealed class LiveApp
    {
        public required string Id { get; init; }
        public required string Name { get; init; }
        public required int Port { get; init; }
        public required Process Process { get; init; }
        public required Compiled Program { get; init; }
        public required string Code { get; init; }
        public DateTimeOffset Started { get; } = DateTimeOffset.UtcNow;
        public DateTimeOffset LastUsed { get; set; } = DateTimeOffset.UtcNow;
        public List<LogLine> Logs { get; } = [];
        public List<JsonObject> Traces { get; } = [];
        public bool Listening;
        public string Url => $"http://127.0.0.1:{Port}";
        public string Status => Process.HasExited ? "stopped" : Listening ? "running" : "starting";
    }

    public record LogLine(int N, string Stream, string Text, long At);
    public record StartRequest(string? Name, string? Code);
    public record Part(string Name, string? Value, string? FileName, string? ContentType, string? Base64);
    public record Body(string? Kind, string? Text, Part[]? Fields);
    public record SendRequest(string? Method, string? Path, string[][]? Headers, Body? Body);

    [GeneratedRegex("[^a-z0-9-]+")]
    private static partial Regex NotSlug();

    static string Slug(string? s)
    {
        var slug = NotSlug().Replace((s ?? "app").Trim().ToLowerInvariant().Replace(' ', '-'), "").Trim('-');
        return slug.Length == 0 ? "app" : slug[..Math.Min(slug.Length, 24)];
    }

    public object List()
    {
        Reap();
        return _apps.Values.OrderBy(a => a.Started).Select(Describe).ToList();
    }

    object Describe(LiveApp a) => new { a.Id, a.Name, a.Port, a.Url, status = a.Status, started = a.Started, exitCode = a.Process.HasExited ? a.Process.ExitCode : (int?)null };

    public async Task<object> Start(StartRequest req)
    {
        Reap();
        var name = Slug(req.Name);
        if (_apps.TryGetValue(name, out var old)) Stop(old.Id);
        if (_apps.Count >= MaxApps) return new { error = $"At most {MaxApps} apps can run at once. Stop one first." };

        var (program, diags) = runner.Compile(req.Code ?? "", live: true);
        if (program is null) return new { error = "Your code does not compile.", diagnostics = diags };

        int port;
        using (var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0))
        {
            probe.Start();
            port = ((IPEndPoint)probe.LocalEndpoint).Port;
        }

        var psi = new ProcessStartInfo(runner.DotnetPath)
        {
            WorkingDirectory = program.Dir,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add(program.Dll);
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["DOJO_LIVE"] = "1";
        psi.Environment["ASPNETCORE_URLS"] = $"http://127.0.0.1:{port}";
        psi.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";
        psi.Environment["Logging__LogLevel__Default"] = "Information";
        psi.Environment["Logging__LogLevel__Microsoft.AspNetCore"] = "Warning";
        psi.Environment["Logging__Console__FormatterName"] = "simple";
        psi.Environment["DOTNET_hostBuilder__reloadConfigOnChange"] = "false";
        foreach (var other in _apps.Values) psi.Environment[$"Services__{other.Name}"] = other.Url;

        var proc = Process.Start(psi)!;
        try { proc.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        var app = new LiveApp { Id = name, Name = name, Port = port, Process = proc, Program = program, Code = req.Code ?? "" };
        _apps[name] = app;
        _ = Pump(app, proc.StandardOutput, "out");
        _ = Pump(app, proc.StandardError, "err");

        // Wait until it listens (or dies), so the learner's first request does not race the start.
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed < TimeSpan.FromSeconds(20) && !proc.HasExited)
        {
            try
            {
                using var probe = new System.Net.Sockets.TcpClient();
                await probe.ConnectAsync(IPAddress.Loopback, port);
                app.Listening = true;
                break;
            }
            catch { await Task.Delay(120); }
        }
        await Task.Delay(50);
        return new { app = Describe(app), diagnostics = diags, error = proc.HasExited ? "Your app stopped right after starting. Check its log: does it end with app.Run()?" : null };
    }

    int _seq;

    async Task Pump(LiveApp app, StreamReader reader, string stream)
    {
        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            lock (app)
            {
                if (line.StartsWith("\u001eTRACE\u001f"))
                {
                    if (JsonNode.Parse(line[7..]) is JsonObject t)
                    {
                        t["n"] = Interlocked.Increment(ref _seq);
                        t["app"] = app.Name;
                        app.Traces.Add(t);
                        if (app.Traces.Count > TraceCap) app.Traces.RemoveAt(0);
                    }
                    continue;
                }
                app.Logs.Add(new(Interlocked.Increment(ref _seq), stream, line.Length > 2000 ? line[..2000] + "…" : line, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
                if (app.Logs.Count > LogCap) app.Logs.RemoveAt(0);
            }
        }
    }

    public bool Stop(string id)
    {
        if (!_apps.TryRemove(id, out var app)) return false;
        try { app.Process.Kill(entireProcessTree: true); app.Process.WaitForExit(3000); } catch { }
        app.Process.Dispose();
        app.Program.Dispose();
        return true;
    }

    /// <summary>Logs and traces from every app after sequence number <paramref name="since"/>.</summary>
    public object Events(long since)
    {
        Reap();
        var logs = new List<object>();
        var traces = new List<JsonObject>();
        foreach (var app in _apps.Values)
            lock (app)
            {
                logs.AddRange(app.Logs.Where(l => l.N > since).Select(l => new { app = app.Name, l.N, l.Stream, l.Text, l.At }));
                traces.AddRange(app.Traces.Where(t => (int)t["n"]! > since).Select(t => (JsonObject)t.DeepClone()));
            }
        return new { apps = _apps.Values.OrderBy(a => a.Started).Select(Describe).ToList(), logs, traces };
    }

    public async Task<object> Send(string id, SendRequest req)
    {
        if (!_apps.TryGetValue(id, out var app)) return new { error = "That app is not running." };
        app.LastUsed = DateTimeOffset.UtcNow;
        var method = new HttpMethod((req.Method ?? "GET").Trim().ToUpperInvariant());
        var path = (req.Path ?? "/").Trim();
        if (!path.StartsWith('/')) path = "/" + path;
        var trace = Guid.NewGuid().ToString("N")[..12];

        using var msg = new HttpRequestMessage(method, app.Url + path);
        msg.Headers.TryAddWithoutValidation("X-Dojo-Trace", trace);
        HttpContent? content = req.Body?.Kind switch
        {
            "json" => new StringContent(req.Body.Text ?? "", Encoding.UTF8, "application/json"),
            "text" => new StringContent(req.Body.Text ?? "", Encoding.UTF8, "text/plain"),
            "form" => new FormUrlEncodedContent((req.Body.Fields ?? []).Select(f => new KeyValuePair<string, string>(f.Name, f.Value ?? ""))),
            "multipart" => Multipart(req.Body.Fields ?? []),
            _ => null,
        };
        msg.Content = content;
        foreach (var pair in req.Headers ?? [])
        {
            if (pair.Length < 2 || string.IsNullOrWhiteSpace(pair[0])) continue;
            if (!msg.Headers.TryAddWithoutValidation(pair[0], pair[1]) && content is not null)
            {
                content.Headers.Remove(pair[0]);
                content.Headers.TryAddWithoutValidation(pair[0], pair[1]);
            }
        }

        var sw = Stopwatch.StartNew();
        HttpResponseMessage res;
        try { res = await _http.SendAsync(msg); }
        catch (Exception e) { return new { error = $"No response: {e.Message}", trace }; }
        using (res)
        {
            var bytes = await res.Content.ReadAsByteArrayAsync();
            sw.Stop();
            var headers = res.Headers.Concat(res.Content.Headers).Select(h => new[] { h.Key, string.Join(", ", h.Value) }).ToList();
            var mediaType = res.Content.Headers.ContentType?.MediaType ?? "";
            var textual = mediaType.Length == 0 || mediaType.StartsWith("text/") || mediaType.Contains("json") || mediaType.Contains("xml");
            var body = textual ? Encoding.UTF8.GetString(bytes, 0, Math.Min(bytes.Length, 200_000)) : $"({bytes.Length:N0} bytes of {mediaType})";

            // The trace line arrives on the app's stdout a moment after the response.
            JsonObject? seen = null;
            for (var i = 0; i < 20 && seen is null; i++)
            {
                lock (app) seen = app.Traces.LastOrDefault(t => (string?)t["trace"] == trace);
                if (seen is null) await Task.Delay(25);
            }
            return new
            {
                status = (int)res.StatusCode, reason = res.ReasonPhrase, headers, body, size = bytes.Length,
                ms = sw.ElapsedMilliseconds, trace, server = seen?.DeepClone(),
                curl = Curl(method.Method, app.Url + path, req),
            };
        }
    }

    static MultipartFormDataContent Multipart(Part[] fields)
    {
        var form = new MultipartFormDataContent();
        foreach (var f in fields)
        {
            if (string.IsNullOrWhiteSpace(f.Name)) continue;
            if (f.Base64 is { } b64)
            {
                var file = new ByteArrayContent(Convert.FromBase64String(b64));
                file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(string.IsNullOrWhiteSpace(f.ContentType) ? "application/octet-stream" : f.ContentType);
                form.Add(file, f.Name, string.IsNullOrWhiteSpace(f.FileName) ? "upload.bin" : f.FileName);
            }
            else form.Add(new StringContent(f.Value ?? ""), f.Name);
        }
        return form;
    }

    static string Curl(string method, string url, SendRequest req)
    {
        static string Q(string s) => "'" + s.Replace("'", "'\\''") + "'";
        var sb = new StringBuilder($"curl -i -X {method} {Q(url)}");
        foreach (var p in req.Headers ?? []) if (p.Length >= 2 && p[0].Length > 0) sb.Append($" \\\n  -H {Q(p[0] + ": " + p[1])}");
        switch (req.Body?.Kind)
        {
            case "json": sb.Append($" \\\n  -H 'Content-Type: application/json' \\\n  --data {Q(req.Body.Text ?? "")}"); break;
            case "text": sb.Append($" \\\n  -H 'Content-Type: text/plain' \\\n  --data {Q(req.Body.Text ?? "")}"); break;
            case "form": foreach (var f in req.Body.Fields ?? []) sb.Append($" \\\n  --data-urlencode {Q(f.Name + "=" + f.Value)}"); break;
            case "multipart":
                foreach (var f in req.Body.Fields ?? [])
                    sb.Append(f.Base64 is not null ? $" \\\n  -F {Q(f.Name + "=@" + (f.FileName ?? "file"))}" : $" \\\n  -F {Q(f.Name + "=" + f.Value)}");
                break;
        }
        return sb.ToString();
    }

    void Reap()
    {
        foreach (var app in _apps.Values)
            if (DateTimeOffset.UtcNow - app.LastUsed > IdleLimit) Stop(app.Id);
    }

    public void Dispose()
    {
        foreach (var id in _apps.Keys.ToList()) Stop(id);
        _http.Dispose();
    }
}
