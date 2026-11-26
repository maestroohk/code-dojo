using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace CodeDojo;

/// <summary>
/// Python steps graded by real pytest, and type hints graded by real mypy.
///
/// A code step with a <c>"pytest"</c> object is graded one of two ways:
/// <list type="bullet">
/// <item><b>Hidden tests</b> (<c>"tests"</c>): the learner writes the module (<c>"module"</c>, default solution.py) and a
///   hidden pytest file runs against it. Every test (every parametrize case) is one row.</item>
/// <item><b>The learner writes the tests</b> (<c>"target"</c>): the learner's file is a pytest test file for a correct
///   implementation. It must pass on that code, have at least <c>"minTests"</c> tests, and fail on every planted bug
///   (<c>"mutants"</c>, each a copy of the target with one change), the way mutation testing judges a suite.</item>
/// </list>
/// The interpreter is the first one that has pytest: the dojo's own tools environment (%USERPROFILE%\code-dojo\tools\python,
/// a venv the dojo creates the first time with pytest and mypy from PyPI), then the data science environment, then the
/// system Python. Without any, the step fails with a message that says how to install pytest.
/// A step with <c>"mypy": true</c> also runs <c>mypy --strict</c> on the learner's code; mypy only comes from the tools
/// environment, so without it the hints are not checked and a warning says so (<c>"mypy": "required"</c> fails instead).
/// </summary>
public static partial class PyTest
{
    public static readonly string[] ToolPackages = ["pytest", "mypy"];

    static readonly object Gate = new();
    static readonly ConcurrentDictionary<string, (bool Ok, DateTime At)> Probed = new();
    static Task? install;
    static DateTime installFailed = DateTime.MinValue;
    static string? lastError;

    public static string ToolsEnv => Path.Combine(TsIntel.ToolsDir, "python");

    static string? ToolsPython()
    {
        var exe = Path.Combine(ToolsEnv, OperatingSystem.IsWindows() ? "Scripts" : "bin", OperatingSystem.IsWindows() ? "python.exe" : "python");
        return File.Exists(exe) ? exe : null;
    }

    /// <summary>Can this interpreter import the module? Cached (failures for a minute, so a fresh install is noticed).</summary>
    static bool Has(string exe, string module)
    {
        var key = exe + "|" + module;
        if (Probed.TryGetValue(key, out var p) && (p.Ok || DateTime.UtcNow - p.At < TimeSpan.FromMinutes(1))) return p.Ok;
        var ok = false;
        try
        {
            var psi = new ProcessStartInfo(exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var a in new[] { "-I", "-c", $"import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('{module}') else 1)" }) psi.ArgumentList.Add(a);
            using var proc = Process.Start(psi)!;
            ok = proc.WaitForExit(15_000) && proc.ExitCode == 0;
            if (!proc.HasExited) proc.Kill(true);
        }
        catch { ok = false; }
        Probed[key] = (ok, DateTime.UtcNow);
        return ok;
    }

    /// <summary>The first interpreter that has <paramref name="module"/>; starts installing the tools environment when it is missing.</summary>
    public static string? PythonWith(string module)
    {
        if (ToolsPython() is { } tools && Has(tools, module)) return tools;
        StartInstall();
        if (module == "mypy") return null;          // mypy only from the dojo's own environment (never the learner's system Python)
        foreach (var exe in new[] { LangRunner.PyEnvPython(), Which("python") })
            if (exe is not null && Has(exe, module)) return exe;
        return null;
    }

    /// <summary>The full path of a program on PATH (LangRunner.Exec reads a bare "python" as the dojo's environment).</summary>
    static string? Which(string name)
    {
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            foreach (var ext in OperatingSystem.IsWindows() ? new[] { ".exe" } : [""])
            {
                var p = Path.Combine(d.Trim('"'), name + ext);
                if (File.Exists(p) && !p.Contains("WindowsApps", StringComparison.OrdinalIgnoreCase)) return p;
            }
        return null;
    }

    /// <summary>Create the tools environment (venv + pytest + mypy) in the background, once (again after 10 minutes if it failed).</summary>
    public static Task? StartInstall()
    {
        lock (Gate)
        {
            if (install is { IsCompleted: false }) return install;
            if (ToolsPython() is { } py && ToolPackages.All(m => Has(py, m))) return null;
            if (DateTime.UtcNow - installFailed < TimeSpan.FromMinutes(10)) return null;
            return install = Task.Run(Install);
        }
    }

    static async Task Install()
    {
        try
        {
            if (ToolsPython() is null)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(ToolsEnv)!);
                var (made, why) = await Quiet("python", ["-m", "venv", ToolsEnv], TimeSpan.FromMinutes(2));
                if (made != 0) throw new InvalidOperationException("python -m venv failed: " + why);
            }
            var py = ToolsPython() ?? throw new InvalidOperationException("the environment has no python");
            var (code, err) = await Quiet(py, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", .. ToolPackages], TimeSpan.FromMinutes(5));
            if (code != 0) throw new InvalidOperationException("pip install failed: " + err);
            foreach (var m in ToolPackages) Probed.TryRemove(py + "|" + m, out _);
        }
        catch (Exception e) { installFailed = DateTime.UtcNow; lastError = e.Message; }
    }

    static async Task<(int Code, string Err)> Quiet(string exe, string[] args, TimeSpan timeout)
    {
        var psi = new ProcessStartInfo(exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        var drain = Task.WhenAll(p.StandardOutput.ReadToEndAsync(), p.StandardError.ReadToEndAsync());
        using var cts = new CancellationTokenSource(timeout);
        try { await p.WaitForExitAsync(cts.Token); } catch (OperationCanceledException) { try { p.Kill(true); } catch { } return (-1, "timed out"); }
        var o = await drain;
        return (p.ExitCode, (o[1].Trim().Split('\n').LastOrDefault() ?? "").Trim());
    }

    public static string MissingPytest() =>
        "pytest is not installed for any Python the dojo can use. The dojo tries to install it by itself (with mypy) into " +
        $"{ToolsEnv}; that needs Python 3 on PATH and a network" + (lastError is { Length: > 0 } e ? $" (last attempt: {e})" : "") +
        ". You can also install it yourself with `python -m pip install pytest`, then press Check again.";

    // ------------------------------------------------------------------ running pytest

    public record Case(string Id, bool Pass, bool Skipped, string Detail);
    public record Run(int Exit, string Output, List<Case> Cases, string? CollectError, bool TimedOut);

    static string Lines(JsonNode? n) => n is JsonArray a ? string.Join('\n', a.Select(l => (string?)l)) : (string?)n ?? "";

    /// <summary>Run pytest once in <paramref name="dir"/> and read its JUnit report.</summary>
    static async Task<Run> Pytest(string python, string dir, bool stopAtFirst)
    {
        var report = Path.Combine(dir, ".dojo-report.xml");
        try { File.Delete(report); } catch { }
        string[] cmd = [python, "-I", "-B", "-X", "utf8", "-m", "pytest", "-q", "--tb=short", "--no-header", "--color=no",
            "-p", "no:cacheprovider", "-o", "junit_family=xunit1", "--junitxml=.dojo-report.xml", .. stopAtFirst ? new[] { "-x" } : []];
        var r = await LangRunner.Exec(dir, cmd, null, cpuMs: 8_000, wallMs: 20_000);
        var cases = new List<Case>();
        string? collect = null;
        if (File.Exists(report))
        {
            try
            {
                var xml = XDocument.Load(report);
                foreach (var tc in xml.Descendants("testcase"))
                {
                    var name = (string?)tc.Attribute("name") ?? "?";
                    var cls = (string?)tc.Attribute("classname") ?? "";
                    var problem = tc.Element("failure") ?? tc.Element("error");
                    var skipped = tc.Element("skipped") is not null;
                    // A test file that cannot even be imported shows up as an error case with an empty name or the module's name.
                    if (problem is not null && tc.Element("error") is not null && (name.Length == 0 || cls.Length == 0 || name == cls))
                    {
                        collect = Short(problem.Value, 25);
                        continue;
                    }
                    var cut = cls.LastIndexOf('.');
                    var klass = cut >= 0 && char.IsUpper(cls[(cut + 1)..].FirstOrDefault()) ? cls[(cut + 1)..] + "::" : "";
                    cases.Add(new(klass + name, problem is null, skipped, problem is null ? "" : Short(problem.Value, 14)));
                }
            }
            catch (Exception e) { collect = "Could not read the pytest report: " + e.Message; }
        }
        var output = Checker.Tidy(r.Stdout + (r.Stderr.Length > 0 ? "\n" + r.Stderr : ""));
        if (collect is null && cases.Count == 0 && r.ExitCode is 2 or 3 or 4) collect = Short(output, 25);
        return new(r.ExitCode, output, cases, collect, r.TimedOut);
    }

    static string Short(string text, int max)
    {
        var lines = text.Replace("\r\n", "\n").Trim('\n').Split('\n');
        return string.Join('\n', lines.Length <= max ? lines : [.. lines.Take(max), "..."]);
    }

    // "solution.py", line 4  /  solution.py:4: in <module>
    [GeneratedRegex(@"(?:""|\b)(?<file>[\w./\\-]+\.py)""?(?:, line |:)(?<line>\d+)")]
    private static partial Regex PyWhere();

    public static async Task<CheckResult> Check(JsonObject step, string code, List<TestResult> results, IReadOnlyList<(string Path, string Text)>? extra)
    {
        var spec = (JsonObject)step["pytest"]!;
        if (PythonWith("pytest") is not { } python)
            return new(false, false, [new Diag("error", "pytest", MissingPytest(), 0, 0, "")], results, "", "", false, 0);

        var module = (string?)spec["module"] ?? "solution.py";
        var learnerWritesTests = spec["target"] is not null;
        var testFile = (string?)spec["testFile"] ?? (learnerWritesTests ? "test_" + module : "test_hidden.py");
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "pytest-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(dir);
        var utf8 = new UTF8Encoding(false);
        async Task Put(string rel, string text)
        {
            if (Builds.CleanPath(rel, out _) is not { } clean) return;
            var full = Path.Combine(dir, clean.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            await File.WriteAllTextAsync(full, text.Replace("\r\n", "\n"), utf8);
        }
        var sw = Stopwatch.StartNew();
        try
        {
            foreach (var (rel, text) in extra ?? []) await Put(rel, text);
            foreach (var (rel, text) in spec["files"] as JsonObject ?? []) await Put(rel, Lines(text));

            if (!learnerWritesTests)
            {
                // Hidden tests against the learner's module.
                await Put(module, code);
                await Put(testFile, Lines(spec["tests"]));
                var run = await Pytest(python, dir, false);
                if (run.TimedOut) results.Add(new("Finishes in time", false, "pytest ran for too long and was stopped. Is there a loop that never ends?"));
                else if (run.CollectError is { } err)
                {
                    // The learner's module does not import: show it like a compile error, on their own line.
                    var where = PyWhere().Matches(err).LastOrDefault(m => Path.GetFileName(m.Groups["file"].Value) == module);
                    var line = where is null ? 0 : int.Parse(where.Groups["line"].Value);
                    var last = err.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0 && !l.StartsWith("=")) ?? err;
                    return new(false, false, [new Diag("error", "pytest", $"The tests could not import {module}: {last.TrimStart('E', ' ')}", line, 0, "")], results, run.Output, "", false, sw.ElapsedMilliseconds);
                }
                foreach (var c in run.Cases.Where(c => !c.Skipped)) results.Add(new(c.Id, c.Pass, c.Detail));
                if (run.Cases.Count == 0 && !run.TimedOut) results.Add(new("The tests run", false, run.Output));
                return new(results.Count > 0 && results.All(r => r.Pass), true, [], results, run.Output, "", run.TimedOut, sw.ElapsedMilliseconds);
            }

            // The learner wrote the tests: they must pass on the real code and catch every planted bug.
            var target = Lines(spec["target"]);
            await Put(module, target);
            await Put(testFile, code);
            var good = await Pytest(python, dir, false);
            var output = good.Output;
            if (good.TimedOut)
            {
                results.Add(new("Your tests finish in time", false, "pytest ran for too long and was stopped."));
                return new(false, true, [], results, output, "", true, sw.ElapsedMilliseconds);
            }
            if (good.CollectError is { } cerr)
            {
                var where = PyWhere().Matches(cerr).LastOrDefault(m => Path.GetFileName(m.Groups["file"].Value) == testFile);
                var line = where is null ? 0 : int.Parse(where.Groups["line"].Value);
                var last = cerr.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0 && !l.StartsWith("=")) ?? cerr;
                return new(false, false, [new Diag("error", "pytest", $"pytest could not collect your tests: {last.TrimStart('E', ' ')}", line, 0, "")], results, output, "", false, sw.ElapsedMilliseconds);
            }
            var ran = good.Cases.Where(c => !c.Skipped).ToList();
            var min = (int?)spec["minTests"] ?? 1;
            results.Add(new(min == 1 ? "pytest finds your tests" : $"pytest finds at least {min} tests (each parametrize case counts)", ran.Count >= min,
                ran.Count == 0 ? "No tests were collected. Test functions must be named test_something, in this file." : $"pytest collected {ran.Count}."));
            var failing = ran.Where(c => !c.Pass).ToList();
            results.Add(new("Your tests pass on the correct code", ran.Count > 0 && failing.Count == 0,
                failing.Count == 0 ? "" : "A test that fails on correct code is a wrong test:\n" + string.Join("\n\n", failing.Take(3).Select(c => c.Id + "\n" + c.Detail))));
            if (ran.Count == 0 || failing.Count > 0) return new(false, true, [], results, output, "", false, sw.ElapsedMilliseconds);

            foreach (var mutant in (spec["mutants"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var name = (string?)mutant["name"] ?? "a planted bug";
                var (mutated, problem) = Mutate(target, mutant);
                if (problem is not null) { results.Add(new($"Catches the bug: {name}", false, "The step is broken: " + problem)); continue; }
                await Put(module, mutated);
                var bad = await Pytest(python, dir, true);
                var caught = !bad.TimedOut && bad.Exit is not 0 and not 5;
                results.Add(new($"Catches the bug: {name}", caught, caught ? "" :
                    $"Every test still passes when the code has this bug ({name}). Add a test that would fail on it." +
                    ((string?)mutant["hint"] is { Length: > 0 } hint ? "\n" + hint : "")));
            }
            await Put(module, target);
            return new(results.All(r => r.Pass), true, [], results, output, "", false, sw.ElapsedMilliseconds);
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    /// <summary>A mutant is the target with <c>"replace": [["old", "new"], ...]</c> applied (each old text must occur), or a whole <c>"code"</c>.</summary>
    public static (string Code, string? Problem) Mutate(string target, JsonObject mutant)
    {
        if (mutant["code"] is { } whole) return (Lines(whole), null);
        var text = target;
        foreach (var pair in mutant["replace"] as JsonArray ?? [])
        {
            if (pair is not JsonArray { Count: 2 } p) return (text, "each replace entry is [\"old\", \"new\"]");
            var old = (string?)p[0] ?? "";
            if (old.Length == 0 || !text.Contains(old, StringComparison.Ordinal)) return (text, $"the mutant's text \"{old}\" is not in the target code");
            var at = text.IndexOf(old, StringComparison.Ordinal);
            text = text[..at] + ((string?)p[1] ?? "") + text[(at + old.Length)..];
        }
        return text == target ? (text, "the mutant does not change the code") : (text, null);
    }

    // ------------------------------------------------------------------ mypy

    // solution.py:3:12: error: Incompatible return value type (got "str", expected "int")  [return-value]
    [GeneratedRegex(@"^(?<file>[^:\n]+\.py):(?<line>\d+):(?:(?<col>\d+):)? (?<sev>error|note): (?<msg>.*?)(?:\s+\[(?<code>[\w-]+)\])?$", RegexOptions.Multiline)]
    private static partial Regex MypyLine();

    /// <summary>
    /// mypy --strict on the learner's code (as solution.py, so line numbers are theirs). Adds one row; returns diagnostics
    /// to show in the editor (as warnings: the code still ran). When mypy is missing, a warning only (or a failing row
    /// when the step says "mypy": "required").
    /// </summary>
    public static async Task<List<Diag>> Mypy(string code, List<TestResult> results, IReadOnlyList<(string Path, string Text)>? extra, bool required = false, string file = "solution.py")
    {
        if (PythonWith("mypy") is not { } python)
        {
            var why = "Type hints were not checked: mypy is not installed yet. The dojo installs it (with pytest) into " +
                $"{ToolsEnv} the first time; that needs Python 3 and a network" + (lastError is { Length: > 0 } e ? $" (last attempt: {e})" : "") + ".";
            if (required) results.Add(new("mypy --strict finds no type errors", false, why));
            return [new Diag("warning", "mypy", why, 0, 0, "")];
        }
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "mypy-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(dir);
        try
        {
            foreach (var (rel, text) in extra ?? [])
                if (Builds.CleanPath(rel, out _) is { } clean && clean != file)
                {
                    var full = Path.Combine(dir, clean.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                    await File.WriteAllTextAsync(full, text);
                }
            await File.WriteAllTextAsync(Path.Combine(dir, file), code.Replace("\r\n", "\n"), new UTF8Encoding(false));
            var cache = Path.Combine(ToolsEnv, "mypy-cache");
            var r = await LangRunner.Exec(dir, [python, "-I", "-B", "-X", "utf8", "-m", "mypy", "--strict", "--no-color-output", "--no-error-summary",
                "--show-column-numbers", "--show-error-codes", "--cache-dir", cache, file], null, cpuMs: 30_000, wallMs: 45_000);
            var diags = new List<Diag>();
            foreach (Match m in MypyLine().Matches(r.Stdout))
            {
                if (m.Groups["sev"].Value != "error") continue;
                diags.Add(new("warning", "mypy " + m.Groups["code"].Value, m.Groups["msg"].Value.Trim(), int.Parse(m.Groups["line"].Value),
                    m.Groups["col"].Success ? int.Parse(m.Groups["col"].Value) : 0, Path.GetFileName(m.Groups["file"].Value) == file ? "" : m.Groups["file"].Value));
            }
            var ok = !r.TimedOut && r.ExitCode == 0;
            var detail = r.TimedOut ? "mypy took too long." : ok ? "" : diags.Count > 0
                ? string.Join("\n", diags.Take(8).Select(d => $"line {d.Line}: {d.Message}  [{d.Id[5..]}]"))
                : Checker.Tidy(r.Stdout + r.Stderr);
            results.Add(new("mypy --strict finds no type errors", ok, detail));
            return diags;
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }
}
