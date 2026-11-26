using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeDojo;

/// <summary>
/// C# steps graded with real xUnit v3 ("framework": "xunit", CSharpRunner.TestLib).
///
/// A code step with <c>"xunit": { "target": ..., "mutants": [...] }</c> is graded the way mutation testing judges a test
/// suite: the learner writes xUnit tests for <c>target</c> (code they read in the prompt, compiled beside theirs as
/// Target.cs). The tests must pass on that code, number at least <c>minTests</c> (every [InlineData] row counts), and
/// then fail on every planted bug: each mutant is the target with one change, compiled with the same tests and run with
/// -stopOnFail. A mutant is caught ("killed") when a test fails, the run times out, or it crashes.
///
/// <c>"xunit": { "minTests": 3 }</c> without a target is for test-driven steps: the learner writes the code and their own
/// tests, hidden xUnit tests in the template check the code, and their own tests (those in classes the template does not
/// declare) must number at least minTests.
/// </summary>
public static class XunitCheck
{
    public const string NoTests = "No test ran. xUnit runs public methods marked [Fact] or [Theory] in public classes (not static, not nested in a static class).";

    public static async Task<CheckResult> LearnerTests(CSharpRunner runner, JsonObject spec, string code, List<TestResult> results,
        IReadOnlyList<(string Path, string Text)>? extra, bool web, bool efCore)
    {
        var target = Builds.Text(spec["target"]) ?? "";
        var file = (string?)spec["file"] is { Length: > 0 } f ? f : "Target.cs";
        List<(string Path, string Text)> Files(string text) => [.. extra ?? [], (file, text)];
        var sw = Stopwatch.StartNew();

        var (program, diags) = runner.Compile(code, null, web, efCore: efCore, extra: Files(target), xunit: true);
        if (program is null) return new(false, false, diags, results, "", "", false, sw.ElapsedMilliseconds);

        string stdout, stderr;
        List<CSharpRunner.XunitCase> ran;
        using (program)
        {
            var (run, cases) = await runner.RunTests(program);
            (stdout, stderr) = (run.Stdout, run.Stderr);
            if (run.TimedOut)
            {
                results.Add(new("Your tests finish in time", false, "The test run was stopped. Is there a loop that never ends, or a test that waits for something that never happens?"));
                return new(false, true, diags, results, stdout, stderr, true, sw.ElapsedMilliseconds);
            }
            if (cases is null)
            {
                results.Add(new("Your tests run", false, FirstLine(run.Stderr)));
                return new(false, true, diags, results, stdout, stderr, false, sw.ElapsedMilliseconds);
            }
            ran = cases.Where(c => c.Result is "Pass" or "Fail").ToList();
        }

        var min = (int?)spec["minTests"] ?? 1;
        results.Add(new(min <= 1 ? "xUnit finds your tests" : $"xUnit finds at least {min} tests (each [InlineData] row counts)", ran.Count >= Math.Max(1, min),
            ran.Count == 0 ? NoTests : $"xUnit ran {ran.Count}."));
        var failing = ran.Where(c => c.Failed).ToList();
        results.Add(new("Your tests pass on the correct code", ran.Count > 0 && failing.Count == 0, failing.Count == 0 ? "" :
            "A test that fails on correct code is a wrong test (or a wrong expectation):\n" + string.Join("\n\n", failing.Take(3).Select(c => c.Name + "\n" + CSharpRunner.XunitDetail(c)))));
        if (ran.Count == 0 || failing.Count > 0) return new(false, true, diags, results, stdout, stderr, false, sw.ElapsedMilliseconds);

        // Mutation testing: every planted bug must make at least one test fail.
        var report = new List<(string Name, bool Killed, string How)>();
        foreach (var mutant in (spec["mutants"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var name = (string?)mutant["name"] ?? "a planted bug";
            var row = $"Catches the bug: {name}";
            var (mutated, problem) = PyTest.Mutate(target, mutant);
            if (problem is not null) { results.Add(new(row, false, "The step is broken: " + problem)); report.Add((name, false, "broken mutant")); continue; }
            var (mp, mdiags) = runner.Compile(code, null, web, efCore: efCore, extra: Files(mutated), xunit: true);
            if (mp is null)
            {
                var why = mdiags.FirstOrDefault(d => d.Severity == "error");
                results.Add(new(row, false, $"The step is broken: this planted bug does not compile ({why?.Id} {why?.Message})."));
                report.Add((name, false, "does not compile"));
                continue;
            }
            using (mp)
            {
                var (mr, mc) = await runner.RunTests(mp, "-stopOnFail");
                var by = mc?.FirstOrDefault(c => c.Failed);
                var killed = mr.TimedOut || by is not null || (mc is null && mr.ExitCode != 0);
                var how = by is not null ? "by " + by.Name : mr.TimedOut ? "the tests timed out" : killed ? "the run crashed" : "every test passed";
                report.Add((name, killed, how));
                results.Add(new(row, killed, killed ? "" :
                    $"Every test still passes when the code has this bug ({name}). Add a test that would fail on it." +
                    ((string?)mutant["hint"] is { Length: > 0 } hint ? "\n" + hint : "")));
            }
        }
        if (report.Count > 0) stdout = (stdout.TrimEnd() + "\n\n" + Report(report)).TrimStart('\n');
        return new(results.All(r => r.Pass), true, diags, results, stdout, stderr, false, sw.ElapsedMilliseconds);
    }

    /// <summary>A mutation report in the spirit of Stryker.NET's console summary.</summary>
    public static string Report(List<(string Name, bool Killed, string How)> report)
    {
        var sb = new StringBuilder();
        var killed = report.Count(r => r.Killed);
        sb.Append($"Mutation testing: {report.Count} planted bug{(report.Count == 1 ? "" : "s")} (mutants)\n");
        var width = Math.Min(48, report.Max(r => r.Name.Length));
        foreach (var r in report)
            sb.Append($"  {(r.Killed ? "Killed  " : "Survived")}  {r.Name.PadRight(width)}  {r.How}\n");
        sb.Append($"Mutation score: {100 * killed / report.Count}% ({killed} of {report.Count} killed)");
        return sb.ToString();
    }

    /// <summary>Test-driven steps (<c>"xunit": { "minTests": n }</c>): did the learner write enough tests of their own?</summary>
    public static IEnumerable<TestResult> OwnTests(JsonObject spec, string? template, List<CSharpRunner.XunitCase> cases)
    {
        if (spec["target"] is not null || (int?)spec["minTests"] is not { } min || min < 1) yield break;
        var hidden = new HashSet<string>(StringComparer.Ordinal);
        if (!string.IsNullOrEmpty(template))
            foreach (var t in CSharpSyntaxTree.ParseText(template.Replace("{{CODE}}", "")).GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>())
                hidden.Add(t.Identifier.Text);
        static string Short(string type) => type.Split('.', '+').Last();
        var own = cases.Where(c => c.Result is "Pass" or "Fail" && !hidden.Contains(Short(c.Type))).ToList();
        yield return new($"You wrote at least {min} tests of your own (each [InlineData] row counts)", own.Count >= min,
            own.Count == 0 ? "None of the tests that ran are yours. Write them in your own public test class, with [Fact] or [Theory]." : $"xUnit ran {own.Count} of yours.");
    }

    static string FirstLine(string s) => s.Split('\n').FirstOrDefault(l => l.Trim().Length > 0)?.Trim() ?? "The test run exited with an error.";

    /// <summary>Lint for `dojo validate`: the spec's shape, and every mutant applies to the target.</summary>
    public static IEnumerable<string> Lint(JsonObject step)
    {
        if (step["xunit"] is not { } node) yield break;
        if (node is not JsonObject spec) { yield return "\"xunit\" must be an object"; yield break; }
        if (!CSharpRunner.HasXunit((string?)step["framework"])) yield return "a step with \"xunit\" needs \"framework\": \"xunit\" (or \"xunit+web\", \"xunit+efcore\"; a track default works too)";
        if (spec["minTests"] is { } m && (m is not JsonValue mv || !mv.TryGetValue<int>(out var n) || n < 1)) yield return "xunit \"minTests\" must be a whole number of at least 1";
        if (spec["target"] is null)
        {
            if (spec["mutants"] is not null) yield return "xunit \"mutants\" need a \"target\" (the code the learner's tests run against)";
            if (spec["minTests"] is null) yield return "\"xunit\" needs a \"target\" (the learner writes tests) or \"minTests\" (the learner writes code and tests)";
            yield break;
        }
        if (Builds.Text(spec["target"]) is not { Length: > 0 } target) { yield return "xunit \"target\" must be a string or an array of lines"; yield break; }
        if (step["template"] is not null) yield return "a step with an xunit \"target\" ignores \"template\": put helper types in the target";
        var mutants = (spec["mutants"] as JsonArray ?? []).ToList();
        if (mutants.Count == 0) yield return "xunit \"mutants\" is empty: give the planted bugs the learner's tests must catch";
        var names = new HashSet<string>();
        foreach (var mn in mutants)
        {
            if (mn is not JsonObject mutant) { yield return "each xunit mutant is an object"; continue; }
            var name = (string?)mutant["name"];
            if (string.IsNullOrWhiteSpace(name)) yield return "every xunit mutant needs a \"name\" (shown as \"Catches the bug: ...\")";
            else if (!names.Add(name)) yield return $"two xunit mutants are both called \"{name}\"";
            var (_, problem) = PyTest.Mutate(target, mutant);
            if (problem is not null) yield return $"xunit mutant \"{name}\": {problem}";
        }
    }
}
