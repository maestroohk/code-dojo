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

    public record Result(bool Compiled, string CompileOutput, string Stdout, string Stderr, int ExitCode, bool TimedOut, bool Truncated, long Ms);

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

    public async Task<Result> Run(Lang lang, string code, string? stdin)
    {
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", $"{lang.Id}-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(dir);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(dir, lang.File), code, new UTF8Encoding(false));
            if (lang.Compile is { } compile)
            {
                var c = await Exec(dir, compile, null, cpuMs: 20_000, wallMs: 30_000);
                if (c.ExitCode != 0 || c.TimedOut)
                    return new(false, (c.Stdout + c.Stderr).Trim(), "", "", c.ExitCode, c.TimedOut, false, c.Ms);
            }
            var r = await Exec(dir, lang.Run, stdin, cpuMs: CSharpRunner.CpuLimitMs, wallMs: CSharpRunner.WallLimitMs);
            return r with { Compiled = true };
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    static async Task<Result> Exec(string dir, string[] cmd, string? stdin, int cpuMs, int wallMs)
    {
        var exe = cmd[0].StartsWith("./") ? Path.Combine(dir, cmd[0][2..] + (OperatingSystem.IsWindows() ? ".exe" : "")) : cmd[0];
        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = dir,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in cmd.Skip(1)) psi.ArgumentList.Add(a);
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
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
