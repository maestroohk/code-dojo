using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// Learner C# graded with real xUnit v3 ("framework": "xunit"): hidden tests, the learner's own tests against planted
/// bugs (mutants), NSubstitute and FakeTimeProvider. These compile and run real test assemblies, so they are slow.
/// </summary>
public class XunitCheckTests
{
    static readonly CSharpRunner Runner = new();
    static readonly Checker Checker = new(Runner);

    /// <summary>The step as the server serves it: a template written as lines is one string (Content.Normalize).</summary>
    static JsonObject Step(string json)
    {
        var step = JsonNode.Parse(json)!.AsObject();
        if (step["template"] is JsonArray lines) step["template"] = string.Join("\n", lines.Select(l => (string?)l));
        return step;
    }
    static string Why(CheckResult r) => string.Join("\n", r.Tests.Select(t => $"{(t.Pass ? "ok" : "FAIL")} {t.Name}: {t.Detail}")) + "\n" + r.Stdout + r.Stderr
        + string.Join("\n", r.Diagnostics.Select(d => $"{d.File}({d.Line}) {d.Id} {d.Message}"));

    const string Shipping = """
        public static class Shipping
        {
            public static decimal Cost(decimal total) => total >= 50m ? 0m : 4.99m;
        }
        """;

    static JsonObject MutantStep() => Step($$"""
        { "type": "code", "framework": "xunit",
          "xunit": { "minTests": 2, "target": {{System.Text.Json.JsonSerializer.Serialize(Shipping)}},
            "mutants": [
              { "name": "the boundary moved", "replace": [[">=", ">"]] },
              { "name": "never charges", "replace": [["0m : 4.99m", "0m : 0m"]] } ] } }
        """);

    [Fact]
    public async Task Hidden_xunit_tests_become_one_row_each()
    {
        var step = Step("""
            { "type": "code", "framework": "xunit", "template": [
              "{{CODE}}",
              "public class AddTests",
              "{",
              "    [Fact] public void Adds_two() => Assert.Equal(5, Calc.Add(2, 3));",
              "    [Theory] [InlineData(0, 0)] [InlineData(-1, 1)] public void Zero_sum(int a, int b) => Assert.Equal(0, Calc.Add(a, b));",
              "}" ] }
            """);
        var good = await Checker.Check(step, "public static class Calc { public static int Add(int a, int b) => a + b; }");
        Assert.True(good.Passed, Why(good));
        Assert.Equal(3, good.Tests.Count);
        Assert.Contains(good.Tests, t => t.Name.Contains("Zero_sum(a: -1, b: 1)"));
        Assert.Contains("Total: 3", good.Stdout);      // xUnit's own console summary is shown

        var bad = await Checker.Check(step, "public static class Calc { public static int Add(int a, int b) => a * b; }");
        Assert.False(bad.Passed);
        var row = Assert.Single(bad.Tests, t => t.Name == "AddTests.Adds_two");
        Assert.Contains("Assert.Equal() Failure", row.Detail);
    }

    [Fact]
    public async Task Learner_tests_must_pass_on_the_target_and_catch_every_mutant()
    {
        var strong = """
            public class ShippingTests
            {
                [Theory]
                [InlineData(49.99, 4.99)]
                [InlineData(50, 0)]
                public void Cost_depends_on_the_total(decimal total, decimal expected) => Assert.Equal(expected, Shipping.Cost(total));
            }
            """;
        var r = await Checker.Check(MutantStep(), strong);
        Assert.True(r.Passed, Why(r));
        Assert.Contains(r.Tests, t => t.Name == "Catches the bug: the boundary moved" && t.Pass);
        Assert.Contains("Mutation score: 100% (2 of 2 killed)", r.Stdout);
    }

    [Fact]
    public async Task A_mutant_that_survives_fails_the_step_with_its_name()
    {
        var weak = """
            public class ShippingTests
            {
                [Fact] public void Small_orders_pay() => Assert.Equal(4.99m, Shipping.Cost(10m));
                [Fact] public void Big_orders_ship_free() => Assert.Equal(0m, Shipping.Cost(100m));
            }
            """;
        var r = await Checker.Check(MutantStep(), weak);
        Assert.False(r.Passed);
        var survived = Assert.Single(r.Tests, t => !t.Pass);
        Assert.Equal("Catches the bug: the boundary moved", survived.Name);
        Assert.Contains("Every test still passes", survived.Detail);
        Assert.Contains("Survived", r.Stdout);
    }

    [Fact]
    public async Task Tests_that_fail_on_correct_code_stop_before_the_mutants()
    {
        var wrong = """
            public class ShippingTests
            {
                [Fact] public void Fifty_pays() => Assert.Equal(4.99m, Shipping.Cost(50m));
                [Fact] public void Ten_pays() => Assert.Equal(4.99m, Shipping.Cost(10m));
            }
            """;
        var r = await Checker.Check(MutantStep(), wrong);
        Assert.False(r.Passed);
        var row = Assert.Single(r.Tests, t => t.Name == "Your tests pass on the correct code");
        Assert.False(row.Pass);
        Assert.Contains("ShippingTests.Fifty_pays", row.Detail);
        Assert.Contains("Program.cs line 3", row.Detail);
        Assert.DoesNotContain(r.Tests, t => t.Name.StartsWith("Catches the bug"));
    }

    [Fact]
    public async Task Too_few_tests_fail_the_count_row()
    {
        var r = await Checker.Check(MutantStep(), "public class T { [Fact] public void One() => Assert.Equal(0m, Shipping.Cost(50m)); }");
        Assert.Contains(r.Tests, t => t.Name.StartsWith("xUnit finds at least 2 tests") && !t.Pass);
    }

    [Fact]
    public async Task NSubstitute_and_FakeTimeProvider_are_available()
    {
        var step = Step("""{ "type": "code", "framework": "xunit" }""");
        var code = """
            using Microsoft.Extensions.Time.Testing;
            using NSubstitute;

            public interface IMailer { void Send(string to, string body); }
            public class Reminder(IMailer mailer, TimeProvider clock)
            {
                public void Run() { if (clock.GetUtcNow().Hour >= 9) mailer.Send("ops@example.com", "standup"); }
            }
            public class ReminderTests
            {
                [Fact]
                public void Sends_after_nine()
                {
                    var mailer = Substitute.For<IMailer>();
                    var clock = new FakeTimeProvider(new DateTimeOffset(2026, 11, 27, 8, 59, 0, TimeSpan.Zero));
                    var reminder = new Reminder(mailer, clock);
                    reminder.Run();
                    mailer.DidNotReceiveWithAnyArgs().Send(default!, default!);
                    clock.Advance(TimeSpan.FromMinutes(1));
                    reminder.Run();
                    mailer.Received(1).Send("ops@example.com", "standup");
                }
            }
            """;
        var r = await Checker.Check(step, code);
        Assert.True(r.Passed, Why(r));
        Assert.Equal("ReminderTests.Sends_after_nine", Assert.Single(r.Tests).Name);
    }

    [Fact]
    public async Task Web_tests_host_a_minimal_api_in_a_TestServer()
    {
        var step = Step("""{ "type": "code", "framework": "xunit+web" }""");
        var code = """
            using Microsoft.AspNetCore.TestHost;

            public static class Api
            {
                public static WebApplication Create(WebApplicationBuilder builder)
                {
                    var app = builder.Build();
                    app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
                    return app;
                }
            }
            public class HealthTests
            {
                [Fact]
                public async Task Health_is_ok()
                {
                    var builder = WebApplication.CreateBuilder();
                    builder.WebHost.UseTestServer();
                    await using var app = Api.Create(builder);
                    await app.StartAsync(TestContext.Current.CancellationToken);
                    var response = await app.GetTestClient().GetAsync("/health", TestContext.Current.CancellationToken);
                    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                    Assert.Equal("ok", (await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken)).GetProperty("status").GetString());
                }
            }
            """;
        var r = await Checker.Check(step, code);
        Assert.True(r.Passed, Why(r));
    }

    [Fact]
    public async Task A_test_assembly_without_tests_says_so()
    {
        var r = await Checker.Check(Step("""{ "type": "code", "framework": "xunit" }"""), "public class Nothing { public void NotATest() { } }");
        Assert.False(r.Passed);
        Assert.Equal("xUnit finds the tests", Assert.Single(r.Tests).Name);
    }

    [Fact]
    public async Task Test_driven_steps_count_the_learners_own_tests()
    {
        var step = Step("""
            { "type": "code", "framework": "xunit", "xunit": { "minTests": 2 }, "template": [
              "{{CODE}}",
              "public class HiddenChecks { [Fact] public void Adds() => Assert.Equal(5, Calc.Add(2, 3)); }" ] }
            """);
        var one = "public static class Calc { public static int Add(int a, int b) => a + b; }\npublic class MyTests { [Fact] public void A() => Assert.Equal(2, Calc.Add(1, 1)); }";
        var r = await Checker.Check(step, one);
        Assert.False(r.Passed);
        Assert.Contains(r.Tests, t => t.Name.StartsWith("You wrote at least 2 tests") && !t.Pass);
    }

    [Fact]
    public void TestViz_check_finds_a_mutant_on_the_wrong_line()
    {
        var step = Step("""
            { "type": "learn", "body": "x", "testviz": { "kind": "mutation", "code": ["a >= b", "return c;"],
              "mutants": [ { "line": 2, "from": ">=", "to": ">", "status": "killed" } ] } }
            """);
        Assert.Contains(TestViz.Check(step), m => m.Contains("is not on that line"));
        Assert.Empty(TestViz.Check(Step("""{ "type": "learn", "body": "x", "testviz": { "kind": "pyramid" } }""")));
    }

    [Fact]
    public void A_module_can_run_another_language_than_its_track()
    {
        var root = Directory.CreateTempSubdirectory("dojo-lang-");
        try
        {
            var module = Path.Combine(root.FullName, "tracks", "t", "02-py");
            Directory.CreateDirectory(module);
            File.WriteAllText(Path.Combine(root.FullName, "tracks", "t", "track.json"), """{ "title": "T", "language": "csharp" }""");
            File.WriteAllText(Path.Combine(module, "module.json"), """{ "title": "P", "language": "python" }""");
            var content = new Content(root.FullName);
            Assert.Equal("python", content.Language("t", "02-py"));
            Assert.Equal("csharp", content.Language("t", "01-missing"));
            Assert.Equal("csharp", content.Language("t"));
        }
        finally { root.Delete(true); }
    }

    [Fact]
    public void Lint_reports_a_mutant_that_does_not_apply()
    {
        var step = Step("""
            { "type": "code", "framework": "xunit", "xunit": { "target": "class A { int X => 1; }",
              "mutants": [ { "name": "two", "replace": [["=> 2", "=> 3"]] } ] } }
            """);
        Assert.Contains(XunitCheck.Lint(step), m => m.Contains("is not in the target"));
        Assert.Contains(XunitCheck.Lint(Step("""{ "type": "code", "xunit": { "minTests": 1 } }""")), m => m.Contains("framework"));
    }
}
