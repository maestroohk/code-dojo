using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace CodeDojo;

/// <summary>
/// Python code intelligence: definition, references, hover and completion, answered by
/// server/intel/pyintel.py (standard library only) running in the dojo's Python. One long-lived
/// process speaks JSON lines over stdin/stdout; it is restarted when it dies or stops answering.
/// The learner's code is only parsed there, never run.
/// </summary>
public static class PyIntel
{
    static readonly SemaphoreSlim Gate = new(1, 1);
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    static Process? proc;
    static string? scriptPath;

    /// <summary>How long one answer may take (the first import of pandas can take a few seconds).</summary>
    public static TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(20);

    static readonly CodeIntel.Response Empty = new(null, null, null, null, null);

    static bool IsPython(string path) => path.EndsWith(".py", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".pyw", StringComparison.OrdinalIgnoreCase);

    /// <summary><paramref name="projectDir"/>: the code space the files come from (Jedi then sees its .venv).</summary>
    public static async Task<CodeIntel.Response> Run(CodeIntel.Request req, string? projectDir = null)
    {
        var all = req.Files ?? [];
        var me = all.FirstOrDefault(f => f.Path == req.Path);
        if (me is null) return Empty;
        // The editor counts UTF-16 units over \n-separated text; Python counts code points.
        var files = all.Where(f => f.Path == req.Path || IsPython(f.Path))
            .Select(f => new { path = f.Path, code = (f.Code ?? "").Replace("\r\n", "\n") }).ToList();
        var code = (me.Code ?? "");
        var pos = Math.Clamp(req.Position, 0, code.Length);
        var before = code[..pos];
        pos = pos - CountOf(before, "\r\n") - before.Count(char.IsLowSurrogate);
        var site = projectDir is null ? null : CodeSpaces.SitePackages(projectDir);
        var payload = JsonSerializer.Serialize(new { action = req.Action, files, path = req.Path, position = pos, engine = req.Engine ?? "auto", site, root = projectDir }, Json);

        var line = await Ask(payload);
        if (line is null) return Empty;
        try
        {
            var node = System.Text.Json.Nodes.JsonNode.Parse(line);
            if ((bool?)node?["jediMissing"] == true) _ = StartJediInstall();
            var r = node.Deserialize<CodeIntel.Response>(Json);
            if (r is null) return Empty;
            // Columns back to UTF-16 for files with characters outside the BMP.
            CodeIntel.Location Fix(CodeIntel.Location l)
            {
                var text = files.FirstOrDefault(f => f.path == l.Path)?.code;
                if (text is null) return l;
                var lines = text.Split('\n');
                if (l.Line < 1 || l.Line > lines.Length) return l;
                var lineText = lines[l.Line - 1];
                if (!lineText.Any(char.IsSurrogate)) return l;
                int units = 0, points = 0;
                while (units < lineText.Length && points < l.Column - 1) { units += char.IsHighSurrogate(lineText[units]) ? 2 : 1; points++; }
                return l with { Column = units + 1 };
            }
            return r with
            {
                Definition = r.Definition is { } d ? Fix(d) : null,
                References = r.References?.Select(Fix).ToList(),
            };
        }
        catch (JsonException) { return Empty; }
    }

    static int CountOf(string s, string what)
    {
        int n = 0, i = 0;
        while ((i = s.IndexOf(what, i, StringComparison.Ordinal)) >= 0) { n++; i += what.Length; }
        return n;
    }

    static async Task<string?> Ask(string payload)
    {
        await Gate.WaitAsync();
        try
        {
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var p = Start();
                if (p is null) return null;
                try
                {
                    await p.StandardInput.WriteLineAsync(payload);
                    await p.StandardInput.FlushAsync();
                    var read = p.StandardOutput.ReadLineAsync();
                    if (await Task.WhenAny(read, Task.Delay(Timeout)) != read) { Stop(); return null; }   // stuck: a fresh one next time
                    var line = await read;
                    if (line is not null) return line;
                }
                catch (IOException) { }
                catch (InvalidOperationException) { }
                Stop();   // it died: start again and retry once
            }
            return null;
        }
        finally { Gate.Release(); }
    }

    static Process? Start()
    {
        if (proc is { HasExited: false }) return proc;
        Stop();
        try
        {
            var script = Script();
            var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "intel-cwd");
            Directory.CreateDirectory(dir);
            var psi = new ProcessStartInfo(LangRunner.PyEnvPython() ?? "python")
            {
                WorkingDirectory = dir,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                UseShellExecute = false, CreateNoWindow = true,
                StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            foreach (var a in new[] { "-I", "-X", "utf8", "-u", script, "--tools", JediTarget }) psi.ArgumentList.Add(a);
            psi.Environment["MPLBACKEND"] = "Agg";
            var p = Process.Start(psi)!;
            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
            p.ErrorDataReceived += (_, _) => { };   // drained, so imports that print cannot block it
            p.BeginErrorReadLine();
            proc = p;
            return p;
        }
        catch { proc = null; return null; }
    }

    static void Stop()
    {
        var p = proc;
        proc = null;
        if (p is null) return;
        try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { }
        p.Dispose();
    }

    // ---------------------------------------------------------------- Jedi

    static readonly object InstallGate = new();
    static Task? jediInstall;
    static DateTime jediFailed = DateTime.MinValue;

    /// <summary>
    /// Where Jedi goes when the dojo has no Python environment of its own: a folder the helper adds to its
    /// path, so the system Python's packages are left alone.
    /// </summary>
    static string JediTarget => Path.Combine(TsIntel.ToolsDir, "python");

    /// <summary>
    /// Install Jedi in the background: into the dojo's Python environment when there is one (as its data
    /// science setup does), else into the tools folder. Once, and again after 10 minutes if it failed.
    /// </summary>
    public static Task? StartJediInstall()
    {
        lock (InstallGate)
        {
            if (jediInstall is { IsCompleted: false }) return jediInstall;
            if (DateTime.UtcNow - jediFailed < TimeSpan.FromMinutes(10)) return null;
            if (jediInstall is { IsCompletedSuccessfully: true } && jediFailed == DateTime.MinValue) return null;   // installed; the helper picks it up
            return jediInstall = Task.Run(InstallJedi);
        }
    }

    static async Task InstallJedi()
    {
        try
        {
            var env = LangRunner.PyEnvPython();
            string[] args = env is not null
                ? ["-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off", "jedi"]
                : ["-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off", "--upgrade", "--target", JediTarget, "jedi"];
            var psi = new ProcessStartInfo(env ?? "python") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var a in args) psi.ArgumentList.Add(a);
            psi.Environment["PIP_NO_INPUT"] = "1";
            using var p = Process.Start(psi)!;
            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
            var drain = Task.WhenAll(p.StandardOutput.ReadToEndAsync(), p.StandardError.ReadToEndAsync());
            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(4));
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException) { try { p.Kill(true); } catch { } }
            await drain;
            jediFailed = p.HasExited && p.ExitCode == 0 ? DateTime.MinValue : DateTime.UtcNow;
        }
        catch { jediFailed = DateTime.UtcNow; }
    }

    /// <summary>The analyser ships inside the server assembly; it is written out once per version.</summary>
    static string Script()
    {
        if (scriptPath is not null && File.Exists(scriptPath)) return scriptPath;
        using var s = typeof(PyIntel).Assembly.GetManifestResourceStream("pyintel.py") ?? throw new FileNotFoundException("pyintel.py resource");
        using var reader = new StreamReader(s, Encoding.UTF8);
        var text = reader.ReadToEnd();
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..12];
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "intel");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"pyintel-{hash}.py");
        if (!File.Exists(path))
        {
            var tmp = path + "." + Guid.NewGuid().ToString("N")[..8];
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            try { File.Move(tmp, path); } catch (IOException) { File.Delete(tmp); }   // another server wrote it first
        }
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Stop();
        return scriptPath = path;
    }
}
