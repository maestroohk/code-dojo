using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Grading in Python, JavaScript and TypeScript. Each test is skipped when the language is not installed.</summary>
public class PolyCheckerTests
{
    static readonly LangRunner Langs = new();
    static JsonObject Step(string json) => JsonNode.Parse(json)!.AsObject();
    static string Why(CheckResult r) => string.Join(" | ", r.Tests.Select(t => $"{t.Name}: {t.Detail}")) + " " + r.Stderr + string.Join(" ", r.Diagnostics.Select(d => d.Message));

    [Fact]
    public async Task Python_template_harness_reports_each_check()
    {
        if (Langs.Find("python") is null) return;
        var step = Step("""
            { "type": "code", "template": ["{{CODE}}", "Dojo.eq('add(2, 3) is 5', 5, add(2, 3))", "Dojo.check('add is commutative', add(1, 2) == add(2, 1))", "Dojo.throws('rejects strings', TypeError, lambda: add('a', 1))"] }
            """);
        var good = await PolyChecker.Check(Langs, step, "def add(a, b):\n    return a + b", "python");
        Assert.True(good.Passed, Why(good));
        Assert.Equal(3, good.Tests.Count);

        var bad = await PolyChecker.Check(Langs, step, "def add(a, b):\n    return a - b", "python");
        Assert.False(bad.Passed);
        Assert.Contains("expected 5 but got -1", bad.Tests[0].Detail);
    }

    [Fact]
    public async Task Learner_names_cannot_clash_with_the_helpers()
    {
        if (Langs.Find("python") is null) return;
        // _s and _io used to be the helpers' own names for sys and io; a learner variable replaced them.
        var step = Step("""{ "type": "code", "template": ["{{CODE}}", "Dojo.eq('sum', 6, _s)", "Dojo.eq('io', 'ok', _io)"] }""");
        var r = await PolyChecker.Check(Langs, step, "_s = 1 + 2 + 3\n_io = 'ok'", "python");
        Assert.True(r.Passed, Why(r));
    }

    [Fact]
    public async Task Python_stdin_tests_compare_output()
    {
        if (Langs.Find("python") is null) return;
        var step = Step("""{ "type": "code", "tests": [ { "stdin": "3\n", "expect": "9" }, { "stdin": "5\n", "expect": "25" } ] }""");
        var r = await PolyChecker.Check(Langs, step, "n = int(input())\nprint(n * n)", "python");
        Assert.True(r.Passed, Why(r));
    }

    [Fact]
    public async Task Python_errors_point_at_the_learners_own_line()
    {
        if (Langs.Find("python") is null) return;
        var step = Step("""{ "type": "code", "tests": [ { "expect": "x" } ] }""");
        var r = await PolyChecker.Check(Langs, step, "print('ok')\nraise ValueError('boom')", "python");
        Assert.False(r.Passed);
        Assert.Contains("line 2", r.Stderr);
    }

    [Theory]
    [InlineData("javascript", "function double(n) { return n * 2; }")]
    [InlineData("typescript", "function double(n: number): number { return n * 2; }")]
    public async Task Js_and_ts_templates_grade(string language, string code)
    {
        if (Langs.Find(language) is null) return;
        var step = Step("""
            { "type": "code", "template": ["{{CODE}}", "Dojo.eq('double(4) is 8', 8, double(4));", "Dojo.eq('works on arrays', [2, 4], [1, 2].map(double));"] }
            """);
        var r = await PolyChecker.Check(Langs, step, code, language);
        Assert.True(r.Passed, Why(r));
        Assert.Equal(2, r.Tests.Count);
    }

    [Fact]
    public async Task Js_eq_tells_maps_sets_nan_and_undefined_apart()
    {
        if (Langs.Find("javascript") is null) return;
        var step = Step("""
            { "type": "code", "template": ["{{CODE}}",
              "Dojo.eq('maps differ', new Map([['a', 1]]), new Map([['a', 2]]));",
              "Dojo.eq('sets differ', new Set([1]), new Set([2]));",
              "Dojo.eq('NaN is not null', null, NaN);",
              "Dojo.eq('undefined is kept', { a: 1 }, { a: 1, b: undefined });",
              "Dojo.eq('equal maps match', new Map([['a', 1]]), new Map([['a', 1]]));"] }
            """);
        var r = await PolyChecker.Check(Langs, step, "", "javascript");
        Assert.Equal([false, false, false, false, true], r.Tests.Select(t => t.Pass));
    }

    [Fact]
    public async Task Comment_stripping_keeps_string_contents()
    {
        if (Langs.Find("javascript") is null) return;
        var step = Step("""
            { "type": "code", "require": [ { "pattern": "fetch\\(", "message": "Calls fetch" } ] }
            """);
        // Everything after // inside the string used to be eaten, hiding the fetch( call on the same line.
        var r = await PolyChecker.Check(Langs, step, "const u = 'https://x.example'; const f = typeof fetch; if (false) fetch(u);", "javascript");
        Assert.True(r.Tests.Single(t => t.Name == "Calls fetch").Pass);
    }

    [Fact]
    public async Task Require_rules_ignore_comments()
    {
        if (Langs.Find("javascript") is null) return;
        var step = Step("""
            { "type": "code", "require": [ { "pattern": "\\.reduce\\(", "message": "Uses reduce" } ], "tests": [ { "expect": "6" } ] }
            """);
        var cheat = await PolyChecker.Check(Langs, step, "// .reduce(\nconsole.log(1 + 2 + 3)", "javascript");
        Assert.False(cheat.Passed);
        var real = await PolyChecker.Check(Langs, step, "console.log([1, 2, 3].reduce((a, b) => a + b))", "javascript");
        Assert.True(real.Passed, Why(real));
    }
}
