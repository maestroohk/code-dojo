using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

public record TestResult(string Name, bool Pass, string Detail);
public record CheckResult(bool Passed, bool Compiled, List<Diag> Diagnostics, List<TestResult> Tests,
    string Stdout, string Stderr, bool TimedOut, long Ms);

/// <summary>
/// Grades a "code" step. A step can combine three kinds of check:
///   require / forbid   regexes the source must (not) match, e.g. "use a foreach loop"
///   tests              run the program with stdin, compare what it prints
///   template           hidden harness around the learner's code that calls Dojo.Check / Dojo.Eq
/// </summary>
public sealed class Checker(CSharpRunner runner)
{
    public async Task<CheckResult> Check(JsonObject step, string code)
    {
        var results = new List<TestResult>();
        var bare = StripCommentsAndStrings(code);

        foreach (var rule in Rules(step, "require"))
            results.Add(new(rule.Message, Regex.IsMatch(bare, rule.Pattern, RegexOptions.Singleline), "Your code needs this to count as solved."));
        foreach (var rule in Rules(step, "forbid"))
            results.Add(new(rule.Message, !Regex.IsMatch(bare, rule.Pattern, RegexOptions.Singleline), "This exercise asks you to solve it another way."));

        var (program, diags) = runner.Compile(code, (string?)step["template"]);
        if (program is null)
            return new(false, false, diags, results, "", "", false, 0);

        using (program)
        {
            var tests = step["tests"] as JsonArray ?? [];
            string stdout = "", stderr = "";
            var timedOut = false;
            long ms = 0;

            if (tests.Count == 0)
            {
                var run = await runner.Run(program, (string?)step["stdin"]);
                (stdout, stderr, timedOut, ms) = (run.Stdout, run.Stderr, run.TimedOut, run.Ms);
                results.AddRange(run.Marks.Select(m => new TestResult(m.Name, m.Pass, m.Detail)));
                if (run.TimedOut) results.Add(new("Finishes in time", false, "Your program was still running after 6 seconds. Is there a loop that never ends?"));
                else if (run.ExitCode != 0) results.Add(new("Runs without crashing", false, FirstLine(run.Stderr)));
                else if (run.Marks.Count == 0) results.Add(new("Runs without crashing", true, ""));
            }
            else
            {
                var n = 0;
                foreach (var t in tests.OfType<JsonObject>())
                {
                    n++;
                    var name = (string?)t["name"] ?? (tests.Count == 1 ? "Prints the expected output" : $"Test {n}");
                    var run = await runner.Run(program, (string?)t["stdin"]);
                    ms += run.Ms;
                    if (n == 1)
                    {
                        (stdout, stderr) = (run.Stdout, run.Stderr);
                        results.AddRange(run.Marks.Select(m => new TestResult(m.Name, m.Pass, m.Detail)));
                    }
                    if (run.TimedOut) { timedOut = true; results.Add(new(name, false, "Still running after 6 seconds. Is there a loop that never ends?")); continue; }
                    if (run.ExitCode != 0) { results.Add(new(name, false, "Crashed: " + FirstLine(run.Stderr))); continue; }

                    var actual = Tidy(run.Stdout);
                    var input = (string?)t["stdin"] is { Length: > 0 } s ? $"With input {Quote(s)}: " : "";
                    if ((string?)t["expect"] is { } expect)
                    {
                        var ok = actual == Tidy(expect);
                        results.Add(new(name, ok, ok ? "" : $"{input}expected\n{Tidy(expect)}\nbut your program printed\n{(actual.Length == 0 ? "(nothing)" : actual)}"));
                    }
                    else if ((string?)t["expectContains"] is { } part)
                    {
                        var ok = actual.Contains(Tidy(part), StringComparison.Ordinal);
                        results.Add(new(name, ok, ok ? "" : $"{input}the output should contain\n{Tidy(part)}\nbut your program printed\n{(actual.Length == 0 ? "(nothing)" : actual)}"));
                    }
                }
            }
            return new(results.Count > 0 && results.All(r => r.Pass), true, diags, results, stdout, stderr, timedOut, ms);
        }
    }

    static IEnumerable<(string Pattern, string Message)> Rules(JsonObject step, string key) =>
        (step[key] as JsonArray ?? []).OfType<JsonObject>()
            .Select(r => ((string?)r["pattern"] ?? "", (string?)r["message"] ?? key));

    static string FirstLine(string s) => s.Split('\n').FirstOrDefault(l => l.Trim().Length > 0)?.Trim() ?? "The program exited with an error.";

    static string Quote(string s) => "\"" + s.TrimEnd('\n').Replace("\n", "\\n") + "\"";

    /// <summary>Compare output the way a person would: ignore trailing spaces and blank lines at the end.</summary>
    public static string Tidy(string s) =>
        string.Join("\n", s.Replace("\r\n", "\n").Split('\n').Select(l => l.TrimEnd())).Trim('\n');

    /// <summary>So that `// use foreach` in a comment cannot satisfy a "must use foreach" rule.</summary>
    static string StripCommentsAndStrings(string code) =>
        // Interpolated strings are kept whole: the code inside their { } is real code.
        Regex.Replace(code, """//[^\n]*|/\*.*?\*/|\$@?"(?:\\.|""|[^"\\\n])*"|@\$"(?:""|[^"])*"|@"(?:[^"]|"")*"|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'""",
            m => m.Value[0] == '/' ? " " : m.Value.Contains('$') && m.Value.IndexOf('$') < m.Value.IndexOf('"') ? m.Value : "\"\"",
            RegexOptions.Singleline);
}
