using System.Diagnostics;
using System.Text;

namespace CodeDojo;

/// <summary>
/// Runs programs in languages other than C#, using whatever toolchains are installed on this machine.
/// Each run gets a fresh temp folder, the same limits as C# (4 s of CPU, 15 s on the clock, 100 KB of
/// output), and is deleted afterwards. Languages whose tool is missing are simply not offered.
/// </summary>
public sealed class LangRunner
{
    public record Lang(string Id, string Name, string File, string[]? Compile, string[] Run, string Probe, string Sample);

    public record Result(bool Compiled, string CompileOutput, string Stdout, string Stderr, int ExitCode, bool TimedOut, bool Truncated, long Ms)
    {
        /// <summary>Charts the program drew (matplotlib), as data: URLs, in drawing order.</summary>
        public List<string> Images { get; init; } = [];
    }

    /// <summary>
    /// The dojo's own Python environment (numpy, pandas, matplotlib), used for Python when it exists:
    /// %USERPROFILE%\code-dojo\pyenv, or DOJO_PYENV. Kept apart from the system Python.
    /// </summary>
    public static string? PyEnvPython()
    {
        var dir = Environment.GetEnvironmentVariable("DOJO_PYENV") is { Length: > 0 } d ? d
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "code-dojo", "pyenv");
        var exe = Path.Combine(dir, OperatingSystem.IsWindows() ? "Scripts" : "bin", OperatingSystem.IsWindows() ? "python.exe" : "python");
        if (!File.Exists(exe)) return null;
        EnsurePlotHook(dir);
        return exe;
    }

    /// <summary>
    /// A sitecustomize module in the environment: charts render off-screen, and every figure still
    /// open when the program ends (or passed to plt.show()) is saved as dojo-plot-N.png next to it.
    /// </summary>
    static void EnsurePlotHook(string envDir)
    {
        var site = OperatingSystem.IsWindows() ? Path.Combine(envDir, "Lib", "site-packages")
            : Directory.GetDirectories(Path.Combine(envDir, "lib")).Select(d => Path.Combine(d, "site-packages")).FirstOrDefault(Directory.Exists);
        if (site is null || !Directory.Exists(site)) return;
        var file = Path.Combine(site, "sitecustomize.py");
        const string hook = """
            # Written by code-dojo: render charts off-screen and save them so the dojo can show them.
            import os, atexit
            os.environ.setdefault("MPLBACKEND", "Agg")
            _dojo_n = [0]
            def _dojo_save_all():
                import sys
                plt = sys.modules.get("matplotlib.pyplot")
                if plt is None:
                    return
                for num in plt.get_fignums():
                    _dojo_n[0] += 1
                    plt.figure(num).savefig(f"dojo-plot-{_dojo_n[0]}.png", dpi=110, bbox_inches="tight")
                plt.close("all")
            def _dojo_patch():
                import sys
                plt = sys.modules.get("matplotlib.pyplot")
                # pyplot may still be loading (it defines its own show later), so check every time.
                if plt is not None and hasattr(plt, "figure") and getattr(plt.show, "__name__", "") != "_dojo_show":
                    def _dojo_show(*a, **k):
                        _dojo_save_all()
                    plt.show = _dojo_show
            import builtins
            _dojo_import = builtins.__import__
            def _dojo_hooked(name, *a, **k):
                m = _dojo_import(name, *a, **k)
                if name.startswith("matplotlib"):
                    _dojo_patch()
                return m
            builtins.__import__ = _dojo_hooked
            atexit.register(_dojo_save_all)
            """;
        try { if (!File.Exists(file) || File.ReadAllText(file) != hook) File.WriteAllText(file, hook); } catch { }
    }

    // Terminal colour codes some tools emit even when asked not to.
    static readonly System.Text.RegularExpressions.Regex Ansi = new(@"\x1B\[[0-9;]*[A-Za-z]");

    static readonly Lang[] All =
    [
        new("python", "Python", "main.py", null, ["python", "-I", "-X", "utf8", "main.py"], "python --version",
            "# Python: indentation is the block structure.\nscores = {\"ann\": 91, \"bob\": 78, \"cy\": 85}\n\nfor name, score in sorted(scores.items(), key=lambda kv: -kv[1]):\n    print(f\"{name:<5}{score:>4}\")\n\nprint(\"average:\", sum(scores.values()) / len(scores))\n"),
        new("javascript", "JavaScript", "main.js", null, ["node", "main.js"], "node --version",
            "// JavaScript (Node.js)\nconst scores = { ann: 91, bob: 78, cy: 85 };\n\nObject.entries(scores)\n  .sort(([, a], [, b]) => b - a)\n  .forEach(([name, score]) => console.log(`${name.padEnd(5)}${String(score).padStart(4)}`));\n\nconst values = Object.values(scores);\nconsole.log('average:', values.reduce((a, b) => a + b) / values.length);\n"),
        new("typescript", "TypeScript", "main.ts", null, ["node", "--no-warnings", "main.ts"], "node --version",
            "// TypeScript: JavaScript with types. (Types are checked by your editor; Node just strips them.)\ntype Student = { name: string; score: number };\n\nconst students: Student[] = [\n  { name: 'ann', score: 91 },\n  { name: 'bob', score: 78 },\n];\n\nfunction best(list: Student[]): Student {\n  return list.reduce((a, b) => (b.score > a.score ? b : a));\n}\n\nconsole.log(best(students).name);\n"),
        new("java", "Java", "Main.java", ["javac", "-encoding", "UTF-8", "Main.java"], ["java", "-cp", ".", "Main"], "javac -version",
            "// Java: everything lives in a class; the file must define public class Main.\nimport java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Integer> nums = Arrays.asList(5, 3, 8, 1);\n        int sum = 0;\n        for (int n : nums) sum += n;\n        System.out.println(\"sum = \" + sum);\n    }\n}\n"),
        new("go", "Go", "main.go", null, ["go", "run", "main.go"], "go version",
            "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfor i := 1; i <= 3; i++ {\n\t\tfmt.Println(\"hello\", i)\n\t}\n}\n"),
        new("rust", "Rust", "main.rs", ["rustc", "-O", "main.rs", "-o", "main"], ["./main"], "rustc --version",
            "fn main() {\n    let v = vec![5, 3, 8];\n    let sum: i32 = v.iter().sum();\n    println!(\"sum = {}\", sum);\n}\n"),
        new("ruby", "Ruby", "main.rb", null, ["ruby", "main.rb"], "ruby --version", "[3, 1, 2].sort.each { |n| puts n }\n"),
        new("php", "PHP", "main.php", null, ["php", "main.php"], "php --version", "<?php\nforeach ([3, 1, 2] as $n) echo $n, \"\\n\";\n"),
    ];

    readonly Lazy<List<Lang>> _available = new(() => All.Where(l => Works(l.Probe)).ToList());

    /// <summary>Languages whose toolchain answered its version probe on this machine.</summary>
    public IReadOnlyList<Lang> Available => _available.Value;

    public Lang? Find(string id) => Available.FirstOrDefault(l => l.Id == id);

    static bool Works(string probe)
    {
        try
        {
            var parts = probe.Split(' ');
            var psi = new ProcessStartInfo(parts[0]) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var a in parts.Skip(1)) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            if (!p.WaitForExit(5000)) { p.Kill(true); return false; }
            return p.ExitCode == 0;
        }
        catch { return false; }
    }

    /// <param name="extra">More files written into the run folder first (relative paths, never the main file).</param>
    public async Task<Result> Run(Lang lang, string code, string? stdin, IReadOnlyList<(string Path, string Text)>? extra = null)
    {
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", $"{lang.Id}-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(dir);
        try
        {
            foreach (var (rel, text) in extra ?? [])
            {
                if (Builds.CleanPath(rel, out _) is not { } clean || clean == lang.File) continue;
                var full = Path.Combine(dir, clean.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                await File.WriteAllTextAsync(full, text, new UTF8Encoding(false));
            }
            await File.WriteAllTextAsync(Path.Combine(dir, lang.File), code, new UTF8Encoding(false));
            if (lang.Compile is { } compile)
            {
                var c = await Exec(dir, compile, null, cpuMs: 20_000, wallMs: 30_000);
                if (c.ExitCode != 0 || c.TimedOut)
                    return new(false, (c.Stdout + c.Stderr).Trim(), "", "", c.ExitCode, c.TimedOut, false, c.Ms);
            }
            var r = await Exec(dir, lang.Run, stdin, cpuMs: CSharpRunner.CpuLimitMs, wallMs: CSharpRunner.WallLimitMs);
            // Charts the program saved (see EnsurePlotHook), in the order they were drawn.
            var images = Directory.GetFiles(dir, "dojo-plot-*.png")
                .OrderBy(f => int.TryParse(Path.GetFileNameWithoutExtension(f)[10..], out var n) ? n : 0)
                .Take(8).Select(f => "data:image/png;base64," + Convert.ToBase64String(File.ReadAllBytes(f))).ToList();
            return r with { Compiled = true, Images = images };
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    static async Task<Result> Exec(string dir, string[] cmd, string? stdin, int cpuMs, int wallMs)
    {
        // "python" means the dojo environment when it exists (checked per run, so setting it up needs no restart).
        var exe = cmd[0] == "python" ? PyEnvPython() ?? "python" : cmd[0].StartsWith("./") ? Path.Combine(dir, cmd[0][2..] + (OperatingSystem.IsWindows() ? ".exe" : "")) : cmd[0];
        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = dir,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in cmd.Skip(1)) psi.ArgumentList.Add(a);
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
        psi.Environment["MPLBACKEND"] = "Agg";
        psi.Environment["NODE_DISABLE_COLORS"] = "1";
        psi.Environment["NO_COLOR"] = "1";
        psi.Environment["FORCE_COLOR"] = "0";

        var sw = Stopwatch.StartNew();
        using var proc = Process.Start(psi)!;
        try { proc.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        var truncated = false;
        void Kill() { try { proc.Kill(entireProcessTree: true); } catch { } }

        async Task<string> Pump(StreamReader r)
        {
            var sb = new StringBuilder();
            var buf = new char[4096];
            int n;
            while ((n = await r.ReadAsync(buf)) > 0)
            {
                if (sb.Length < 100_000) sb.Append(buf, 0, Math.Min(n, 100_000 - sb.Length));
                else if (!truncated) { truncated = true; Kill(); }
            }
            return sb.ToString();
        }
        var outTask = Pump(proc.StandardOutput);
        var errTask = Pump(proc.StandardError);
        try
        {
            if (!string.IsNullOrEmpty(stdin)) await proc.StandardInput.WriteAsync(stdin);
            proc.StandardInput.Close();
        }
        catch (IOException) { }

        var timedOut = false;
        var exit = proc.WaitForExitAsync();
        while (await Task.WhenAny(exit, Task.Delay(100)) != exit)
        {
            TimeSpan cpu;
            try { cpu = proc.TotalProcessorTime; } catch { cpu = TimeSpan.Zero; }
            if (cpu.TotalMilliseconds <= cpuMs && sw.ElapsedMilliseconds <= wallMs) continue;
            timedOut = true;
            Kill();
            break;
        }
        await exit;
        var stdout = await outTask;
        var stderr = await errTask;
        stdout = Ansi.Replace(stdout, "");
        stderr = Ansi.Replace(stderr, "");
        return new(true, "", stdout, stderr.Replace(dir + Path.DirectorySeparatorChar, ""), timedOut ? -1 : proc.ExitCode, timedOut, truncated, sw.ElapsedMilliseconds);
    }
}
