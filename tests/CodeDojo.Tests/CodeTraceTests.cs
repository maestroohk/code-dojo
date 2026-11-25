using CodeDojo;

namespace CodeDojo.Tests;

public class CodeTraceTests
{
    static readonly CSharpRunner Runner = new();

    static Task<CodeTrace.Response> Trace(string code) => CodeTrace.Run(Runner, new(code, null));

    [Fact]
    public async Task Loop_steps_show_variables_changing()
    {
        var r = await Trace("var sum = 0;\nfor (var i = 1; i <= 3; i++)\n{\n    sum += i;\n}\nConsole.WriteLine(sum);");
        Assert.True(r.Error is null, r.Error);
        var steps = r.Steps.Select(s => s!).Where(s => !(bool)s["end"]!).ToList();
        // the loop condition is visited 4 times: i = 1, 2, 3 and the failing 4
        Assert.Equal(5, steps.Count(s => (int)s["l"]! == 2));   // arriving at the loop, then testing i = 1, 2, 3 and the failing 4
        var lastSum = steps.Last(s => (int)s["l"]! == 6)["v"]!.AsArray().First(v => (string)v!["n"]! == "sum")!;
        Assert.Equal("6", (string)lastSum["t"]!);
        Assert.Equal("6", r.Output.Trim());
    }

    [Fact]
    public async Task Arrays_come_with_their_items()
    {
        var r = await Trace("int[] a = { 3, 1 };\n(a[0], a[1]) = (a[1], a[0]);\nConsole.WriteLine(a[0]);");
        Assert.Null(r.Error);
        var last = r.Steps.Last(s => (int)s!["l"]! == 3)!;
        var a = last["v"]!.AsArray().First(v => (string)v!["n"]! == "a")!;
        Assert.Equal(["1", "3"], a["items"]!.AsArray().Select(x => (string)x!));
    }

    [Fact]
    public async Task Recursion_shows_the_call_stack()
    {
        var r = await Trace("Console.WriteLine(Fact(3));\nint Fact(int n)\n{\n    if (n <= 1) return 1;\n    return n * Fact(n - 1);\n}");
        Assert.Null(r.Error);
        var deepest = r.Steps.Max(s => s!["s"]!.AsArray().Count);
        Assert.Equal(4, deepest);   // top level + Fact(3) + Fact(2) + Fact(1)
        Assert.Contains(r.Steps, s => s!["s"]!.AsArray().Any(f => (string?)f == "Fact"));
    }

    [Fact]
    public async Task Compile_errors_are_reported_with_real_lines()
    {
        var r = await Trace("var x = ;");
        Assert.NotNull(r.Error);
        Assert.Contains(r.Diagnostics, d => d.Line == 1);
    }

    [Fact]
    public async Task Endless_loops_are_cut_off()
    {
        var r = await Trace("var i = 0;\nwhile (true) { i++; }");
        Assert.True(r.Truncated);
    }
}
