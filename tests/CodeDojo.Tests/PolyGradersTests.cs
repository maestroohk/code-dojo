using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// The real-tool graders: tsc --strict for TypeScript (TsCheck.cs), pytest and mypy for Python (PyTest.cs), and the
/// Python / TypeScript visualizers (PolyViz.cs). Each test returns early when its tool is not on this machine.
/// </summary>
public class PolyGradersTests
{
    static readonly LangRunner Langs = new();
    static JsonObject Step(string json) => JsonNode.Parse(json)!.AsObject();
    static string Why(CheckResult r) => string.Join(" | ", r.Tests.Select(t => $"{t.Name}: {t.Detail}")) + " " + r.Stderr + string.Join(" ", r.Diagnostics.Select(d => d.Message));

    static async Task<bool> HaveTsc() => Langs.Find("typescript") is not null && await TsCheck.Ensure(TimeSpan.FromSeconds(120)) is not null;
    static bool HavePytest() => Langs.Find("python") is not null && PyTest.PythonWith("pytest") is not null;

    [Fact]
    public async Task A_type_error_fails_with_the_compilers_message_and_line()
    {
        if (!await HaveTsc()) return;
        var step = Step("""{ "type": "code", "template": ["{{CODE}}", "Dojo.eq('total', 5, total([2, 3]))"] }""");
        var bad = await PolyChecker.Check(Langs, step, "function total(xs: number[]): number {\n  const s: string = xs.reduce((a, b) => a + b, 0);\n  return s;\n}", "typescript");
        Assert.False(bad.Passed);
        Assert.False(bad.Compiled);
        var d = Assert.Single(bad.Diagnostics.Where(x => x.Id == "TS2322" && x.Line == 2));
        Assert.Contains("not assignable to type 'string'", d.Message);

        var good = await PolyChecker.Check(Langs, step, "function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}", "typescript");
        Assert.True(good.Passed, Why(good));
    }

    [Fact]
    public async Task Strict_mode_rejects_implicit_any_and_errors_in_the_tests_are_marked()
    {
        if (!await HaveTsc()) return;
        var step = Step("""{ "type": "code", "template": ["{{CODE}}", "Dojo.eq('len', 2, size('ab'))"] }""");
        var r = await PolyChecker.Check(Langs, step, "function size(s) { return s.length; }", "typescript");
        Assert.Contains(r.Diagnostics, x => x.Id == "TS7006" && x.Line == 1 && x.File == "");
        var wrongType = await PolyChecker.Check(Langs, step, "function size(s: number) { return s; }", "typescript");
        Assert.Contains(wrongType.Diagnostics, x => x.Id == "TS2345" && x.File == "tests");
    }

    [Fact]
    public void Tsc_output_is_parsed_with_elaboration_lines()
    {
        var p = TsCheck.Parse("main.ts(3,7): error TS2322: Type '{ a: number; }' is not assignable to type 'B'.\n  Property 'b' is missing in type '{ a: number; }'.\nerror TS5023: Unknown compiler option 'x'.");
        Assert.Equal(2, p.Count);
        Assert.Equal((3, 7, "TS2322"), (p[0].Line, p[0].Col, p[0].Code));
        Assert.Contains("Property 'b' is missing", p[0].Message);
        Assert.Equal("TS5023", p[1].Code);
    }

    [Fact]
    public async Task Pytest_hidden_tests_report_each_case()
    {
        if (!HavePytest()) return;
        var step = Step("""
            { "type": "code", "pytest": { "module": "price.py", "tests": [
              "import pytest", "from price import total",
              "@pytest.mark.parametrize('qty,expected', [(1, 10), (3, 30)])",
              "def test_total(qty, expected):", "    assert total(qty) == expected",
              "def test_rejects_negative():", "    with pytest.raises(ValueError):", "        total(-1)" ] } }
            """);
        var good = await PolyChecker.Check(Langs, step, "def total(q):\n    if q < 0:\n        raise ValueError('negative')\n    return q * 10\n", "python");
        Assert.True(good.Passed, Why(good));
        Assert.Equal(3, good.Tests.Count);
        Assert.Contains(good.Tests, t => t.Name == "test_total[3-30]");

        var bad = await PolyChecker.Check(Langs, step, "def total(q):\n    return q * 10\n", "python");
        Assert.False(bad.Passed);
        Assert.Contains(bad.Tests, t => t.Name == "test_rejects_negative" && !t.Pass);

        var broken = await PolyChecker.Check(Langs, step, "def total(q)\n    return q\n", "python");
        Assert.False(broken.Compiled);
        Assert.Equal(1, broken.Diagnostics[0].Line);
    }

    [Fact]
    public async Task Learner_tests_must_pass_on_real_code_and_catch_every_mutant()
    {
        if (!HavePytest()) return;
        var step = Step("""
            { "type": "code", "pytest": { "module": "ship.py", "minTests": 2,
              "target": ["def fee(kg):", "    if kg <= 0:", "        raise ValueError('kg')", "    return 5 if kg < 10 else 12"],
              "mutants": [ { "name": "boundary at 10 kg", "replace": [["kg < 10", "kg <= 10"]] },
                           { "name": "no check for zero", "replace": [["kg <= 0", "kg < 0"]] } ] } }
            """);
        var strong = "import pytest\nfrom ship import fee\n\n@pytest.mark.parametrize('kg,want', [(1, 5), (9.9, 5), (10, 12)])\ndef test_fee(kg, want):\n    assert fee(kg) == want\n\ndef test_zero(tmp_path):\n    with pytest.raises(ValueError):\n        fee(0)\n";
        var r = await PolyChecker.Check(Langs, step, strong, "python");
        Assert.True(r.Passed, Why(r));

        var weak = "from ship import fee\n\ndef test_small():\n    assert fee(1) == 5\n\ndef test_big():\n    assert fee(50) == 12\n";
        var w = await PolyChecker.Check(Langs, step, weak, "python");
        Assert.False(w.Passed);
        Assert.Contains(w.Tests, t => t.Name == "Catches the bug: boundary at 10 kg" && !t.Pass);

        var wrong = "from ship import fee\n\ndef test_a():\n    assert fee(1) == 6\n\ndef test_b():\n    assert fee(50) == 12\n";
        var x = await PolyChecker.Check(Langs, step, wrong, "python");
        Assert.Contains(x.Tests, t => t.Name == "Your tests pass on the correct code" && !t.Pass);
    }

    [Fact]
    public void Mutants_must_change_the_code()
    {
        var (_, problem) = PyTest.Mutate("x = 1", Step("""{ "replace": [["y", "z"]] }"""));
        Assert.NotNull(problem);
        var (code, ok) = PyTest.Mutate("x = 1", Step("""{ "replace": [["1", "2"]] }"""));
        Assert.Null(ok);
        Assert.Equal("x = 2", code);
    }

    [Fact]
    public async Task Python_trace_shows_two_names_for_one_list()
    {
        if (Langs.Find("python") is null) return;
        var t = await PolyViz.PyTrace(Langs, new("a = [1, 2]\nb = a\nb.append(3)\nprint(a)", null));
        Assert.Null((string?)t["error"]);
        var steps = (JsonArray)t["steps"]!;
        var last = steps[^1]!.AsObject();
        Assert.Equal("[1, 2, 3]\n", string.Concat(steps.Select(s => (string?)s!["o"])));
        var vars = last["s"]![0]!["vars"]!.AsArray();
        Assert.Equal((int)vars[0]![1]!["r"]!, (int)vars[1]![1]!["r"]!);
    }

    [Fact]
    public async Task TypeScript_trace_and_event_loop_run_for_real()
    {
        if (Langs.Find("typescript") is null) return;
        var t = await PolyViz.TsTrace(new("const a: number[] = [1];\nconst b = a;\nb.push(2);\nconsole.log(a.length);", null));
        Assert.Null((string?)t["error"]);
        Assert.Contains((t["steps"] as JsonArray)!, s => (string?)s!["o"] == "2\n");

        var e = await PolyViz.EventLoop(new("console.log('A');\nsetTimeout(() => console.log('T'), 0);\nPromise.resolve().then(() => console.log('P'));\nconsole.log('B');", null));
        Assert.Null((string?)e["error"]);
        Assert.Equal("A\nB\nP\nT\n", (string?)e["output"]);
        Assert.Contains((e["events"] as JsonArray)!, x => (string?)x!["k"] == "enq" && (string?)x["q"] == "micro");
    }
}
