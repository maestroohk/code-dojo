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

    public static async Task<CodeIntel.Response> Run(CodeIntel.Request req)
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
        var payload = JsonSerializer.Serialize(new { action = req.Action, files, path = req.Path, position = pos }, Json);

        var line = await Ask(payload);
        if (line is null) return Empty;
        try
        {
            var r = JsonSerializer.Deserialize<CodeIntel.Response>(line, Json);
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
            foreach (var a in new[] { "-I", "-X", "utf8", "-u", script }) psi.ArgumentList.Add(a);
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
