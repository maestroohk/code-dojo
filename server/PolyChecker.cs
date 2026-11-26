using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// Grades code steps written in languages other than C# (Python, JavaScript, TypeScript), with the
/// same three kinds of check as C#: require/forbid rules, stdinâ†’stdout tests, and a hidden template
/// that calls Dojo.eq / Dojo.check / Dojo.throws. The Dojo helpers are a one-line prelude, so the
/// learner's line numbers are only off by one, and that is corrected in error messages.
/// </summary>
public static partial class PolyChecker
{
    const char MarkStart = '\u001e', MarkSep = '\u001f';

    // Each prelude is ONE line, so it shifts the learner's code down by exactly one.
    const string PythonPrelude =
        "exec(\"import sys as _dojo_sys, io as _dojo_io\\nclass Dojo:\\n" +
        "    @staticmethod\\n    def _report(name, ok, detail):\\n        _dojo_sys.stdout.flush(); _dojo_sys.__stdout__.write('\\\\x1e' + ('PASS' if ok else 'FAIL') + '\\\\x1f' + str(name) + '\\\\x1f' + str(detail).replace('\\\\n', '\\\\\\\\n') + '\\\\n'); _dojo_sys.__stdout__.flush()\\n" +
        "    @staticmethod\\n    def eq(name, expected, actual):\\n        ok = expected == actual\\n        Dojo._report(name, ok, '' if ok else 'expected ' + repr(expected) + ' but got ' + repr(actual))\\n" +
        "    @staticmethod\\n    def check(name, ok, detail=''):\\n        Dojo._report(name, bool(ok), '' if ok else detail)\\n" +
        "    @staticmethod\\n    def throws(name, exc, fn):\\n        try:\\n            fn()\\n        except exc:\\n            Dojo._report(name, True, ''); return\\n        except Exception as e:\\n            Dojo._report(name, False, 'expected ' + exc.__name__ + ' but got ' + type(e).__name__ + ': ' + str(e)); return\\n        Dojo._report(name, False, 'expected ' + exc.__name__ + ' but nothing was raised')\\n" +
        "    @staticmethod\\n    def capture(fn):\\n        old = _dojo_sys.stdout; buf = _dojo_io.StringIO(); _dojo_sys.stdout = buf\\n        try:\\n            fn()\\n        finally:\\n            _dojo_sys.stdout = old\\n        return buf.getvalue()\\n\", globals())";

    const string JsPrelude =
        "var Dojo = (() => { const rep = (n, ok, d) => process.stdout.write('\\x1e' + (ok ? 'PASS' : 'FAIL') + '\\x1f' + n + '\\x1f' + String(d).replace(/\\n/g, '\\\\n') + '\\n'); " +
        // Plain JSON would make every Map and Set look like {} and NaN like null, and would drop undefined.
        "const tag = (k, v) => v instanceof Map ? { Map: [...v] } : v instanceof Set ? { Set: [...v] } : v === undefined ? 'undefined' : typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v === 'bigint' ? v + 'n' : v; " +
        "const show = v => { try { return v === undefined ? 'undefined' : JSON.stringify(v, tag); } catch { return String(v); } }; " +
        "const same = (a, b) => show(a) === show(b); " +
        "return { eq(n, e, a) { const ok = same(e, a); rep(n, ok, ok ? '' : 'expected ' + show(e) + ' but got ' + show(a)); }, " +
        "check(n, ok, d = '') { rep(n, !!ok, ok ? '' : d); }, " +
        "throws(n, fn) { try { fn(); rep(n, false, 'expected an error but nothing was thrown'); } catch (e) { rep(n, true, ''); } }, " +
        "async throwsAsync(n, fn) { try { await fn(); rep(n, false, 'expected an error but nothing was thrown'); } catch (e) { rep(n, true, ''); } }, " +
        // capture() takes a plain function; captureAsync() awaits one, so output after an await is caught too.
        "capture(fn) { const lg = console.log; let s = ''; console.log = (...a) => { s += a.join(' ') + '\\n'; }; try { fn(); } finally { console.log = lg; } return s; }, " +
        "async captureAsync(fn) { const lg = console.log; let s = ''; console.log = (...a) => { s += a.join(' ') + '\\n'; }; try { await fn(); } finally { console.log = lg; } return s; } }; })();";

    public static bool Handles(string language) => language is "python" or "javascript" or "typescript";

    /// <param name="extra">Earlier pieces this step "uses": written beside main.py / main.ts at their own paths (Pacing.cs).</param>
    public static async Task<CheckResult> Check(LangRunner langs, JsonObject step, string code, string language, IReadOnlyList<(string Path, string Text)>? extra = null)
    {
        if (langs.Find(language) is not { } lang)
            return new(false, false, [new Diag("error", language, $"{language} is not installed on this machine, so this exercise cannot run here.", 0, 0, "")], [], "", "", false, 0);

        var results = new List<TestResult>();
        var bare = StripComments(code, language);
        foreach (var (pattern, message) in Rules(step, "require"))
            results.Add(new(message, Regex.IsMatch(bare, pattern, RegexOptions.Singleline), "Your code needs this to count as solved."));
        foreach (var (pattern, message) in Rules(step, "forbid"))
            results.Add(new(message, !Regex.IsMatch(bare, pattern, RegexOptions.Singleline), "This exercise asks you to solve it another way."));

        var template = step["template"] is JsonArray lines ? string.Join('\n', lines.Select(l => (string?)l)) : (string?)step["template"];

        // Python steps graded by pytest (hidden tests, or the learner's own tests against planted bugs): PyTest.cs.
        if (language == "python" && step["pytest"] is JsonObject) return await PyTest.Check(step, code, results, extra);

        // TypeScript: the real compiler first (tsc --strict --noEmit, TsCheck.cs). A type error fails the step like a compile error.
        var notes = new List<Diag>();
        if (language == "typescript")
        {
            var source = string.IsNullOrEmpty(template) ? code : template.Replace("{{CODE}}", code);
            var first = string.IsNullOrEmpty(template) ? 1 : template.Replace("\r\n", "\n").Split('\n').TakeWhile(l => !l.Contains("{{CODE}}")).Count() + 1;
            var types = await TsCheck.Check(source, first, code.Replace("\r\n", "\n").Split('\n').Length, extra);
            if (types is null)
            {
                if (TsCheck.Required(step)) results.Add(new("Type checks with tsc --strict", false, TsCheck.MissingMessage()));
                notes.Add(new("warning", "tsc", TsCheck.MissingMessage(), 0, 0, ""));
            }
            else if (types.Any(d => d.Severity == "error")) return new(false, false, types, results, "", "", false, 0);
            else notes.AddRange(types);
        }
        // "mypy": true (or "required") also runs mypy --strict on the learner's code (PyTest.cs).
        if (language == "python" && step["mypy"] is JsonValue mypyFlag && (mypyFlag.TryGetValue<bool>(out var useMypy) ? useMypy : (string?)mypyFlag == "required"))
            notes.AddRange(await PyTest.Mypy(code, results, extra, (string?)(mypyFlag.TryGetValue<string>(out var s) ? s : null) == "required"));

        // Python runs isolated (-I), so the folder holding the used modules goes on sys.path, on the prelude's one line.
        var prelude = Prelude(language) + (extra is { Count: > 0 } && language == "python" ? "; __import__('sys').path.insert(0, __import__('os').getcwd())" : "");
        var program = prelude + "\n" +(string.IsNullOrEmpty(template) ? code : template.Replace("{{CODE}}", code));
        var tests = step["tests"] as JsonArray ?? [];
        string stdout = "", stderr = "";
        var timedOut = false;
        long ms = 0;

        if (tests.Count == 0)
        {
            var r = await langs.Run(lang, program, (string?)step["stdin"], extra);
            if (!r.Compiled) return new(false, false, [new Diag("error", lang.Name, Fix(r.CompileOutput, language), 0, 0, "")], results, "", "", false, r.Ms);
            var (visible, marks) = Marks(r.Stdout);
            (stdout, stderr, timedOut, ms) = (visible, Fix(r.Stderr, language), r.TimedOut, r.Ms);
            results.AddRange(marks);
            if (r.TimedOut) results.Add(new("Finishes in time", false, "Your program ran for too long and was stopped. Is there a loop that never ends?"));
            else if (r.ExitCode != 0) results.Add(new("Runs without crashing", false, LastLine(stderr)));
            else if (marks.Count == 0) results.Add(new("Runs without crashing", true, ""));
        }
        else
        {
            var n = 0;
            foreach (var t in tests.OfType<JsonObject>())
            {
                n++;
                var name = (string?)t["name"] ?? (tests.Count == 1 ? "Prints the expected output" : $"Test {n}");
                var r = await langs.Run(lang, program, (string?)t["stdin"], extra);
                ms += r.Ms;
                if (!r.Compiled) return new(false, false, [new Diag("error", lang.Name, Fix(r.CompileOutput, language), 0, 0, "")], results, "", "", false, ms);
                var (visible, marks) = Marks(r.Stdout);
                if (n == 1) { (stdout, stderr) = (visible, Fix(r.Stderr, language)); results.AddRange(marks); }
                if (r.TimedOut) { timedOut = true; results.Add(new(name, false, "Ran for too long and was stopped.")); continue; }
                if (r.ExitCode != 0) { results.Add(new(name, false, "Crashed: " + LastLine(Fix(r.Stderr, language)))); continue; }
                var actual = Checker.Tidy(visible);
                var input = (string?)t["stdin"] is { Length: > 0 } s ? $"With input \"{s.TrimEnd('\n').Replace("\n", "\\n")}\": " : "";
                if ((string?)t["expect"] is { } expect)
                {
                    var ok = actual == Checker.Tidy(expect);
                    results.Add(new(name, ok, ok ? "" : $"{input}expected\n{Checker.Tidy(expect)}\nbut your program printed\n{(actual.Length == 0 ? "(nothing)" : actual)}"));
                }
                else if ((string?)t["expectContains"] is { } part)
                {
                    var ok = actual.Contains(Checker.Tidy(part), StringComparison.Ordinal);
                    results.Add(new(name, ok, ok ? "" : $"{input}the output should contain\n{Checker.Tidy(part)}\nbut your program printed\n{(actual.Length == 0 ? "(nothing)" : actual)}"));
                }
            }
        }
        return new(results.Count > 0 && results.All(r => r.Pass), true, notes, results, stdout, stderr, timedOut, ms);
    }

    static string Prelude(string language) => language == "python" ? PythonPrelude : JsPrelude;

    /// <summary>Split marks (test results) from what the program printed.</summary>
    static (string Visible, List<TestResult> Marks) Marks(string stdout)
    {
        var marks = new List<TestResult>();
        var visible = new List<string>();
        foreach (var line in stdout.Replace("\r\n", "\n").Split('\n'))
        {
            var at = line.IndexOf(MarkStart);
            if (at < 0) { visible.Add(line); continue; }
            if (at > 0) visible.Add(line[..at]);
            var parts = line[(at + 1)..].Split(MarkSep);
            if (parts.Length >= 3) marks.Add(new(parts[1], parts[0] == "PASS", parts[2].Replace("\\n", "\n")));
        }
        return (string.Join("\n", visible), marks);
    }

    [GeneratedRegex(@"(line |main\.[jt]s:)(\d+)")]
    private static partial Regex LineRef();

    /// <summary>The one-line prelude moves the learner's code down a line; put the numbers back.</summary>
    static string Fix(string text, string language) =>
        LineRef().Replace(text, m => m.Groups[1].Value + Math.Max(1, int.Parse(m.Groups[2].Value) - 1));

    static string LastLine(string s) => s.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? "The program exited with an error.";

    // Comments are removed but string literals are stepped over, so "https://x" or "# tag" inside a string survives.
    [GeneratedRegex(@"(""""""[\s\S]*?""""""|'''[\s\S]*?'''|""(?:\\.|[^""\\\n])*""|'(?:\\.|[^'\\\n])*')|#[^\n]*")]
    private static partial Regex PyComment();
    [GeneratedRegex(@"(""(?:\\.|[^""\\\n])*""|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|/\*[\s\S]*?\*/|//[^\n]*")]
    private static partial Regex JsComment();

    static string StripComments(string code, string language) =>
        (language == "python" ? PyComment() : JsComment()).Replace(code, m => m.Groups[1].Success ? m.Value : " ");

    static IEnumerable<(string Pattern, string Message)> Rules(JsonObject step, string key) =>
        (step[key] as JsonArray ?? []).OfType<JsonObject>().Select(r => ((string?)r["pattern"] ?? "", (string?)r["message"] ?? key));
}
