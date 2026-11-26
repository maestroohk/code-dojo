using System.Text.Json;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Pacing and continuity (Pacing.cs): "uses" with learner vs reference pieces, cold steps, coldOf, gate validation.</summary>
public sealed class PacingTests : IDisposable
{
    static readonly CSharpRunner Runner = new();
    static readonly Checker Checker = new(Runner);
    static readonly LangRunner Langs = new();

    readonly string root = Path.Combine(Path.GetTempPath(), "dojo-pacing-" + Guid.NewGuid().ToString("N"));
    readonly Content content;

    const string Greet = "pt/01-a/01-greet";
    const string Shout = "pt/02-b/01-shout";

    public PacingTests()
    {
        Write("tracks/pt/track.json", """
            { "title": "Pacing test", "language": "csharp",
              "artifacts": [ { "id": "kit", "title": "Kit", "kind": "dotnet-console", "run": "dotnet run",
                "template": { "Program.cs": "System.Console.WriteLine(Kit.Greet.Hello(\"you\"));\n" } } ] }
            """);
        Write("tracks/pt/01-a/module.json", """{ "title": "A", "gate": { "requires": ["boss"], "minStars": 2, "cold": ["02-cold"] } }""");
        Write("tracks/pt/01-a/01-greet.json", """
            { "title": "Greet", "steps": [
              { "type": "code", "title": "Hello", "prompt": "Write Hello.", "starter": "// write Hello",
                "solution": "public static string Hello(string n) => $\"Hello, {n}\";",
                "template": ["Dojo.Eq(\"Hello(ann)\", \"Hello, ann\", Kit.Greet.Hello(\"ann\"));", "{{CODE}}"],
                "build": { "artifact": "kit", "file": "Core/Greet.cs",
                           "transform": ["namespace Kit;", "public static class Greet", "{", "    {{CODE}}", "}"] },
                "hints": ["use $\"\""] } ] }
            """);
        // The class wrapper the template above needs, so the reference solution passes on its own.
        Patch("tracks/pt/01-a/01-greet.json", "\"{{CODE}}\"]", "\"namespace Kit { public static class Greet {\", \"{{CODE}}\", \"} }\"]");
        Write("tracks/pt/01-a/02-cold.json", """
            { "title": "Cold", "steps": [
              { "type": "learn", "body": "From memory now." },
              { "type": "code", "coldOf": "pt/01-a/01-greet#1", "timeLimit": 120 } ] }
            """);
        Write("tracks/pt/01-a/03-boss.json", """{ "title": "Boss", "kind": "boss", "steps": [ { "type": "learn", "body": "x" } ] }""");
        Write("tracks/pt/02-b/module.json", """{ "title": "B" }""");
        Write("tracks/pt/02-b/01-shout.json", """
            { "title": "Shout", "steps": [
              { "type": "code", "title": "Shout", "prompt": "Call your Hello.", "starter": "string Shout(string n) => \"\";",
                "solution": "string Shout(string n) => Kit.Greet.Hello(n).ToUpper();",
                "template": ["{{CODE}}", "Dojo.Eq(\"Shout(ann)\", \"HELLO, ANN\", Shout(\"ann\"));"],
                "uses": ["Core/Greet.cs"] },
              { "type": "code", "title": "Cold one", "prompt": "From memory.", "cold": true, "starter": "secret starter",
                "solution": "int X() => 1;", "hints": ["a hint"], "template": ["{{CODE}}", "Dojo.Eq(\"X\", 1, X());"] } ] }
            """);
        content = new Content(root);
    }

    void Write(string rel, string text)
    {
        var path = Path.Combine(root, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
    }

    void Patch(string rel, string from, string to)
    {
        var path = Path.Combine(root, rel);
        File.WriteAllText(path, File.ReadAllText(path).Replace(from, to));
    }

    public void Dispose() { try { Directory.Delete(root, true); } catch { } }

    JsonObject Step(string key, int idx)
    {
        var p = key.Split('/');
        return (JsonObject)content.Lesson(p[0], p[1], p[2])!["steps"]![idx]!;
    }

    static Dictionary<string, Pacing.UsesInput> Learner(string code) => new()
    {
        ["Core/Greet.cs"] = new("kit", [new("Core/Greet.cs", "replace", code, Greet, 0)]),
    };

    const string Wrapped = "namespace Kit;\npublic static class Greet\n{\n    {{BODY}}\n}\n";

    // ---------------------------------------------------------------- uses

    [Theory]
    [InlineData("Core/Greet.cs", null, null, "Core/Greet.cs")]
    [InlineData("kit:Lint.cs", null, "kit", "Lint.cs")]
    [InlineData("csharp/@dream:src/X.cs", "csharp", "@dream", "src/X.cs")]
    public void Refs_parse(string raw, string? track, string? artifact, string file) =>
        Assert.Equal((track, artifact, file), Pacing.ParseRef(raw));

    [Fact]
    public void Uses_falls_back_to_the_reference_piece_and_says_so()
    {
        var step = Step(Shout, 0);
        var r = Pacing.Resolve(content, content.Tracks(), "pt", Shout, 0, step, null, null);
        Assert.Empty(r.Problems);
        var used = Assert.Single(r.Files);
        Assert.Equal("reference", used.Source);
        Assert.Contains("reference version of Greet.cs", used.Note);
        Assert.Contains("public static string Hello", used.Text);
        Assert.StartsWith("namespace Kit;", used.Text);                   // the owner step's transform was applied
    }

    [Fact]
    public async Task Grading_compiles_the_reference_piece_when_the_learner_has_none()
    {
        var step = Step(Shout, 0);
        var r = Pacing.Resolve(content, content.Tracks(), "pt", Shout, 0, step, null, new Dictionary<string, Pacing.UsesInput>());
        var result = await Pacing.Grade(Checker, Langs, "csharp", step, (string)step["solution"]!, r.Files);
        Assert.True(result.Passed, string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        // Without the used piece the same code does not even compile: the step really calls the earlier work.
        Assert.False((await Pacing.Grade(Checker, Langs, "csharp", step, (string)step["solution"]!)).Compiled);
    }

    [Fact]
    public async Task Grading_uses_the_learners_own_piece_and_their_bug_shows()
    {
        var step = Step(Shout, 0);
        var good = Pacing.Resolve(content, content.Tracks(), "pt", Shout, 0, step, null,
            Learner(Wrapped.Replace("{{BODY}}", "public static string Hello(string who) => \"Hello, \" + who;")));
        Assert.Equal("yours", Assert.Single(good.Files).Source);
        Assert.True((await Pacing.Grade(Checker, Langs, "csharp", step, (string)step["solution"]!, good.Files)).Passed);

        var broken = Pacing.Resolve(content, content.Tracks(), "pt", Shout, 0, step, null,
            Learner(Wrapped.Replace("{{BODY}}", "public static string Hello(string who) => \"Hi \" + who;")));
        var result = await Pacing.Grade(Checker, Langs, "csharp", step, (string)step["solution"]!, broken.Files);
        Assert.True(result.Compiled);
        Assert.False(result.Passed);                                       // the review fails because their piece is wrong
    }

    [Fact]
    public async Task A_step_with_uses_is_compiled_inside_its_own_transform_beside_partial_pieces()
    {
        // Pieces are members of one partial class (as Delve's "static partial class Game"): the later step's code only
        // sees the earlier member when it is compiled inside the same wrapper.
        const string Wrap = """["namespace Delve;", "public static partial class Game", "{", "    {{CODE}}", "}"]""";
        Write("tracks/pw/track.json", """{ "title": "W", "language": "csharp", "artifacts": [ { "id": "delve", "title": "Delve", "kind": "dotnet-console", "run": "x" } ] }""");
        Write("tracks/pw/01-a/module.json", """{ "title": "A" }""");
        Write("tracks/pw/01-a/01-hp.json", $$$"""
            { "title": "Hp", "steps": [ { "type": "code", "prompt": "p",
              "solution": "static int Heal(int hp) => hp + 10;",
              "template": ["Dojo.Eq(\"Heal\", 15, Delve.Game.Heal(5));", "namespace Delve { public static partial class Game {", "{{CODE}}", "} }"],
              "build": { "artifact": "delve", "file": "Game/Hp.cs", "transform": {{{Wrap}}} } } ] }
            """);
        Write("tracks/pw/01-a/02-potion.json", $$$"""
            { "title": "Potion", "steps": [ { "type": "code", "prompt": "p",
              "solution": "public static int Potion(int hp) => Heal(Heal(hp));",
              "template": ["Dojo.Eq(\"Potion\", 25, Delve.Game.Potion(5));", "{{CODE}}"],
              "build": { "artifact": "delve", "file": "Game/Potion.cs", "uses": ["Game/Hp.cs"], "transform": {{{Wrap}}} } } ] }
            """);
        var c = new Content(root);
        var step = (JsonObject)c.Lesson("pw", "01-a", "02-potion")!["steps"]![0]!;
        var r = Pacing.Resolve(c, c.Tracks(), "pw", "pw/01-a/02-potion", 0, step, null, null);
        Assert.Empty(r.Problems);
        Assert.NotNull(Pacing.WrapOwn(step, "x", true));
        var good = await Pacing.Grade(Checker, Langs, "csharp", step, (string)step["solution"]!, r.Files);
        Assert.True(good.Passed, string.Join("; ", good.Diagnostics.Select(d => d.Message)) + string.Join("; ", good.Tests.Select(t => t.Detail)));
        // Errors in the learner's code keep their own line numbers, in Program.cs.
        var bad = await Pacing.Grade(Checker, Langs, "csharp", step, "\npublic static int Potion(int hp) => Nope(hp);", r.Files);
        var err = Assert.Single(bad.Diagnostics, d => d.Severity == "error");
        Assert.Equal(("Program.cs", 2), (err.File, err.Line));
        // "wrap": false puts the code at {{CODE}} as before (here it no longer compiles: Heal is not in scope).
        step["wrap"] = false;
        Assert.False((await Pacing.Grade(Checker, Langs, "csharp", step, (string)step["solution"]!, r.Files)).Compiled);
    }

    [Fact]
    public void Result_json_lists_whose_pieces_were_used()
    {
        var step = Step(Shout, 0);
        var r = Pacing.Resolve(content, content.Tracks(), "pt", Shout, 0, step, null, null);
        var json = Pacing.WithUses(new CheckResult(true, true, [], [], "", "", false, 1), r, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("reference", (string?)json["uses"]![0]!["source"]);
        Assert.Equal("Core/Greet.cs", (string?)json["uses"]![0]!["file"]);
        Assert.True((bool)json["passed"]!);
    }

    [Fact]
    public void Uses_must_name_a_piece_an_earlier_step_builds()
    {
        var step = Step(Shout, 0);
        step["uses"] = new JsonArray("Core/Nothing.cs", "nope:X.cs");
        var r = Pacing.Resolve(content, content.Tracks(), "pt", Shout, 0, step, null, null);
        Assert.Empty(r.Files);
        Assert.Equal(2, r.Problems.Count);
        Assert.Contains("no earlier step builds Core/Nothing.cs", r.Problems[0]);

        // The greet step itself cannot use the file it builds (nothing before it builds Core/Greet.cs either).
        var own = Step(Greet, 0);
        own["build"]!["uses"] = new JsonArray("Core/Greet.cs");
        Assert.NotEmpty(Pacing.Resolve(content, content.Tracks(), "pt", Greet, 0, own, null, null).Problems);
    }

    [Fact]
    public async Task Sql_pieces_run_after_the_setup()
    {
        var step = JsonNode.Parse("""{ "type": "code", "setup": "CREATE TABLE t(x INT);", "solution": "SELECT SUM(x) AS s FROM t;" }""")!.AsObject();
        var piece = new Pacing.UsedFile("seed.sql", "db", "seed.sql", "INSERT INTO t VALUES (1), (2);", "reference", "");
        var r = await Pacing.Grade(Checker, Langs, "sql", step, "SELECT SUM(x) AS s FROM t;", [piece]);
        Assert.True(r.Passed);
        Assert.Equal("3", ((SqlCheckResult)r).Table!.Rows[0][0]);
    }

    // ---------------------------------------------------------------- cold steps

    [Fact]
    public void Cold_steps_are_served_without_starter_hints_or_solution()
    {
        var lesson = Pacing.ForLearner(content.Lesson("pt", "02-b", "01-shout")!);
        var cold = (JsonObject)lesson["steps"]![1]!;
        Assert.True((bool)cold["cold"]!);
        Assert.Equal("", (string?)cold["starter"]);
        Assert.Null(cold["hints"]);
        Assert.Null(cold["solution"]);
        var warm = (JsonObject)lesson["steps"]![0]!;
        Assert.NotNull(warm["solution"]);                                  // other steps are untouched
        Assert.NotEqual("", (string?)warm["starter"]);
        // Grading still sees the full step.
        Assert.NotNull(content.Lesson("pt", "02-b", "01-shout")!["steps"]![1]!["solution"]);
    }

    [Fact]
    public void The_map_lists_cold_steps()
    {
        var b = content.Tracks()[0]!["modules"]![1]!["lessons"]![0]!;
        Assert.Equal([1], b["cold"]!.AsArray().Select(x => (int)x!));
        var coldOf = content.Tracks()[0]!["modules"]![0]!["lessons"]![1]!;
        Assert.Equal([1], coldOf["cold"]!.AsArray().Select(x => (int)x!));    // a coldOf step is cold too
    }

    [Fact]
    public async Task ColdOf_borrows_the_grading_of_the_step_it_reproves()
    {
        var step = Step("pt/01-a/02-cold", 1);
        Assert.Equal(Step(Greet, 0)["template"]!.ToJsonString(), step["template"]!.ToJsonString());
        Assert.Equal("Hello", (string?)step["title"]);
        Assert.True((bool)step["cold"]!);
        Assert.Null(step["build"]);                                        // a re-proof does not overwrite the piece
        Assert.True((await Checker.Check(step, (string)step["solution"]!)).Passed);
        Assert.DoesNotContain(Pacing.CheckStep(content.Lesson("pt", "01-a", "02-cold")!, step, "x"), i => i.Error);
    }

    [Fact]
    public void Step_checks_catch_bad_pacing_fields()
    {
        var lesson = new JsonObject();
        var bad = JsonNode.Parse("""{ "type": "mcq", "cold": true }""")!.AsObject();
        Assert.Contains(Pacing.CheckStep(lesson, bad, "x"), i => i.Error && i.Message.Contains("only works on code steps"));
        var limit = JsonNode.Parse("""{ "type": "code", "cold": true, "timeLimit": 2, "hints": ["h"], "uses": "X.cs" }""")!.AsObject();
        var issues = Pacing.CheckStep(lesson, limit, "x");
        Assert.Contains(issues, i => i.Error && i.Message.Contains("timeLimit"));
        Assert.Contains(issues, i => !i.Error && i.Message.Contains("hides its hints"));
        Assert.Contains(issues, i => i.Error && i.Message.Contains("\"uses\" must be an array"));
        var missing = JsonNode.Parse("""{ "type": "code", "coldOfMissing": "pt/x/y#1" }""")!.AsObject();
        Assert.Contains(Pacing.CheckStep(lesson, missing, "x"), i => i.Error && i.Message.Contains("coldOf"));
    }

    // ---------------------------------------------------------------- gates

    [Fact]
    public void A_valid_gate_has_no_errors()
    {
        Assert.DoesNotContain(Pacing.CheckGates(content.Tracks()), i => i.Error);
    }

    [Fact]
    public void Gates_must_name_real_lessons_and_a_real_boss()
    {
        Write("tracks/pt/02-b/module.json", """{ "title": "B", "gate": { "requires": ["boss", "99-nope"], "minStars": 5, "cold": ["01-shout", "88-gone"] } }""");
        var issues = Pacing.CheckGates(new Content(root).Tracks());
        Assert.Contains(issues, i => i.Error && i.Message.Contains("no boss"));
        Assert.Contains(issues, i => i.Error && i.Message.Contains("99-nope"));
        Assert.Contains(issues, i => i.Error && i.Message.Contains("minStars"));
        Assert.Contains(issues, i => i.Error && i.Message.Contains("88-gone"));
        Assert.DoesNotContain(issues, i => i.Message.Contains("cold \"01-shout\""));   // it has a cold step
        Assert.Equal("pt/02-b/01-shout", Pacing.GateKey("pt", "02-b", "01-shout"));
        Assert.Equal("x/y/z", Pacing.GateKey("pt", "02-b", "x/y/z"));
    }

    [Fact]
    public void Coming_soon_dreams_are_announced_not_built()
    {
        var track = JsonNode.Parse("""
            { "id": "z", "dreams": [
              { "id": "real", "title": "Real", "pitch": "p", "artifact": { "kind": "docs", "run": "x" } },
              { "id": "later", "title": "Later", "pitch": "soon", "soon": true } ] }
            """)!.AsObject();
        Assert.Equal(["real"], Builds.Artifacts(track).Select(a => (string)a["id"]!));
        var issues = Builds.Check(new JsonArray(track));
        Assert.DoesNotContain(issues, i => i.Error);
        Assert.DoesNotContain(issues, i => i.Message.Contains("declare 4 or 5"));
    }
}
