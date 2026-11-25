using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>These compile and run real programs, so they are slower than the rest.</summary>
public class CheckerTests
{
    static readonly CSharpRunner Runner = new();
    static readonly Checker Checker = new(Runner);

    static JsonObject Step(string json) => JsonNode.Parse(json)!.AsObject();

    static string Why(CheckResult r) => string.Join("\n", r.Tests.Select(t => $"{t.Name}: {t.Detail}"));

    [Fact]
    public async Task Correct_output_passes()
    {
        var step = Step("""{ "type": "code", "tests": [ { "expect": "Hello, World!" } ] }""");
        var r = await Checker.Check(step, "Console.WriteLine(\"Hello, World!\");");
        Assert.True(r.Compiled);
        Assert.True(r.Passed, Why(r));
    }

    [Fact]
    public async Task Wrong_output_fails_and_says_what_was_printed()
    {
        var step = Step("""{ "type": "code", "tests": [ { "expect": "4" } ] }""");
        var r = await Checker.Check(step, "Console.WriteLine(5);");
        Assert.False(r.Passed);
        Assert.Contains("printed\n5", Assert.Single(r.Tests).Detail);
    }

    [Fact]
    public async Task Stdin_is_fed_to_each_test()
    {
        var step = Step("""
            { "type": "code", "tests": [
              { "stdin": "3", "expect": "6" },
              { "stdin": "10", "expect": "20" } ] }
            """);
        var r = await Checker.Check(step, "var n = int.Parse(Console.ReadLine()!); Console.WriteLine(n * 2);");
        Assert.True(r.Passed, Why(r));
        Assert.Equal(2, r.Tests.Count);
    }

    [Fact]
    public async Task Compile_errors_are_reported_not_run()
    {
        var step = Step("""{ "type": "code", "tests": [ { "expect": "x" } ] }""");
        var r = await Checker.Check(step, "Console.WriteLine(");
        Assert.False(r.Compiled);
        Assert.False(r.Passed);
        Assert.Contains(r.Diagnostics, d => d.Severity == "error");
    }

    [Fact]
    public async Task Require_rule_is_not_satisfied_by_a_comment()
    {
        var step = Step("""
            { "type": "code",
              "require": [ { "pattern": "\\bforeach\\b", "message": "Use foreach" } ],
              "tests": [ { "expect": "1\n2" } ] }
            """);
        var cheat = await Checker.Check(step, "// foreach\nConsole.WriteLine(1); Console.WriteLine(2);");
        Assert.False(cheat.Passed);
        var real = await Checker.Check(step, "foreach (var i in new[] { 1, 2 }) Console.WriteLine(i);");
        Assert.True(real.Passed, Why(real));
    }

    [Fact]
    public async Task Crash_is_reported_with_the_exception()
    {
        var step = Step("""{ "type": "code", "tests": [ { "expect": "x" } ] }""");
        var r = await Checker.Check(step, "throw new InvalidOperationException(\"boom\");");
        Assert.False(r.Passed);
        Assert.StartsWith("Crashed:", Assert.Single(r.Tests).Detail);
    }

    [Fact]
    public async Task Endless_loop_times_out()
    {
        var r = await Checker.Check(Step("""{ "type": "code" }"""), "while (true) { }");
        Assert.True(r.TimedOut);
        Assert.False(r.Passed);
    }
}
