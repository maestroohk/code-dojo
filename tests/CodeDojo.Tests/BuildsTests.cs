using System.IO.Compression;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>"Your builds": template + pieces -> files, export into a code space, validation (Builds.cs).</summary>
public sealed class BuildsTests : IDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "dojo-builds-" + Guid.NewGuid().ToString("N"));

    public void Dispose() { try { Directory.Delete(dir, true); } catch { } }

    // The repository (tests may build to a folder outside it), found from this source file's location.
    static string RepoRoot([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        for (var d = new DirectoryInfo(Path.GetDirectoryName(here)!); d is not null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "tracks", "git"))) return d.FullName;
        throw new DirectoryNotFoundException("repository root");
    }

    static JsonObject Obj(string json) => (JsonObject)JsonNode.Parse(json)!;

    static readonly JsonObject Kit = Obj("""
        { "id": "kit", "title": "Kit", "kind": "dotnet-console", "run": "dotnet run",
          "template": { "Program.cs": ["return Kit.Run(args);"], "Lint.cs": "// stub\n", "README.md": "# kit\n" } }
        """);

    // ---------------------------------------------------------------- paths

    [Theory]
    [InlineData("Program.cs", "Program.cs")]
    [InlineData("src\\Tools\\Lint.cs", "src/Tools/Lint.cs")]
    [InlineData(".gitignore", ".gitignore")]
    public void Clean_paths_are_normalised(string rel, string expected) => Assert.Equal(expected, Builds.CleanPath(rel, out _));

    [Theory]
    [InlineData("../escape.cs")]
    [InlineData("src/../../escape.cs")]
    [InlineData("./a.cs")]
    [InlineData("/etc/passwd")]
    [InlineData("C:\\x.cs")]
    [InlineData("a//b.cs")]
    [InlineData(".git/hooks/pre-commit")]
    [InlineData(".dojo-space.json")]
    [InlineData("nul")]
    [InlineData("trailing.")]
    [InlineData("a?b")]
    [InlineData("")]
    [InlineData(null)]
    public void Unsafe_paths_are_refused(string? rel)
    {
        Assert.Null(Builds.CleanPath(rel, out var error));
        Assert.NotEqual("", error);
    }

    // ---------------------------------------------------------------- assembly

    [Fact]
    public void Transform_wraps_and_indents_the_code()
    {
        var t = JsonNode.Parse("""["class Kit", "{", "    {{CODE}}", "}"]""");
        Assert.Equal("class Kit\n{\n    int A() => 1;\n\n    int B() => 2;\n}\n", Builds.Transform(t, "int A() => 1;\n\nint B() => 2;\n"));
        Assert.Equal("x", Builds.Transform(null, "x"));
    }

    [Fact]
    public void Template_then_pieces_in_teaching_order()
    {
        var problems = new List<string>();
        var files = Builds.Assemble(Kit, [
            new("Lint.cs", "replace", "// lesson 3 version", "git/02-b/01-x", 4),
            new("Lint.cs", "replace", "// lesson 1 version", "git/01-a/04-y", 8),
            new("README.md", "append", "## Lint", "git/01-a/04-y", 8),
            new("Extra.cs", "replace", "// new file", "git/01-a/05-z", 1),
        ], problems);
        Assert.Empty(problems);
        Assert.Equal(["Extra.cs", "Lint.cs", "Program.cs", "README.md"], files.Keys);
        Assert.Equal("return Kit.Run(args);\n", files["Program.cs"]);           // a line array ends in a newline
        Assert.Equal("// lesson 3 version\n", files["Lint.cs"]);                // the later lesson replaces the earlier version
        Assert.Equal("# kit\n## Lint\n", files["README.md"]);                    // append adds to the template
    }

    [Fact]
    public void Pieces_with_unsafe_or_undeclared_files_are_dropped()
    {
        var problems = new List<string>();
        var files = Builds.Assemble(Kit, [
            new("../../evil.cs", "replace", "x", "a", 0),
            new("Other.cs", "replace", "x", "a", 1),
            new("Lint.cs", "replace", "ok", "a", 2),
        ], problems, allowed: new HashSet<string> { "Lint.cs" });
        Assert.Equal(2, problems.Count);
        Assert.False(files.ContainsKey("Other.cs"));
        Assert.Equal("ok\n", files["Lint.cs"]);
    }

    // ---------------------------------------------------------------- export into a code space

    [Fact]
    public void Export_writes_then_updates_but_keeps_what_the_learner_edited()
    {
        var space = Path.Combine(dir, "kit");
        var first = Builds.Export(space, new SortedDictionary<string, string> { ["Program.cs"] = "v1\n", ["Lint.cs"] = "stub\n", ["src/A.cs"] = "a\n" }, "git/kit", "dotnet-console");
        Assert.Equal(3, first.Written.Count);
        Assert.Equal("a\n", File.ReadAllText(Path.Combine(space, "src", "A.cs")));
        var meta = Obj(File.ReadAllText(Path.Combine(space, ".dojo-space.json")));
        Assert.Equal("console", (string?)meta["template"]);
        Assert.Equal("dotnet", (string?)meta["kind"]);
        Assert.Equal("git/kit", (string?)meta["build"]!["artifact"]);
        Assert.Equal(3, ((JsonObject)meta["build"]!["files"]!).Count);

        // The learner edits Program.cs in the space; the dojo later exports new versions of everything.
        File.WriteAllText(Path.Combine(space, "Program.cs"), "my own change\n");
        var second = Builds.Export(space, new SortedDictionary<string, string> { ["Program.cs"] = "v2\n", ["Lint.cs"] = "real lint\n", ["src/A.cs"] = "a\n" }, "git/kit", "dotnet-console");
        Assert.Equal(["Lint.cs"], second.Written);
        Assert.Equal(["src/A.cs"], second.Unchanged);
        Assert.Equal(["Program.cs"], second.Kept);
        Assert.Equal("my own change\n", File.ReadAllText(Path.Combine(space, "Program.cs")));
        Assert.Equal("v2\n", File.ReadAllText(Path.Combine(space, "Program.cs.dojo-new")));
        Assert.Equal("real lint\n", File.ReadAllText(Path.Combine(space, "Lint.cs")));

        // Still edited on the third export: still kept.
        var third = Builds.Export(space, new SortedDictionary<string, string> { ["Program.cs"] = "v3\n" }, "git/kit", "dotnet-console");
        Assert.Equal(["Program.cs"], third.Kept);
        Assert.Equal("v3\n", File.ReadAllText(Path.Combine(space, "Program.cs.dojo-new")));
    }

    [Fact]
    public void Export_never_overwrites_a_file_it_did_not_write()
    {
        var space = Path.Combine(dir, "mine");
        Directory.CreateDirectory(space);
        File.WriteAllText(Path.Combine(space, "Program.cs"), "hand written\n");
        var r = Builds.Export(space, new SortedDictionary<string, string> { ["Program.cs"] = "generated\n" }, "git/kit", "python");
        Assert.Equal(["Program.cs"], r.Kept);
        Assert.Equal("hand written\n", File.ReadAllText(Path.Combine(space, "Program.cs")));
        Assert.Equal("py-script", (string?)Obj(File.ReadAllText(Path.Combine(space, ".dojo-space.json")))["template"]);
    }

    [Fact]
    public void Space_name_avoids_spaces_that_hold_something_else()
    {
        Directory.CreateDirectory(Path.Combine(dir, "kit"));                       // the learner's own space called kit
        Assert.Equal("kit-build", Builds.SpaceName(dir, "kit", "git/kit"));
        Builds.Export(Path.Combine(dir, "kit-build"), new SortedDictionary<string, string> { ["a.txt"] = "a" }, "git/kit", null);
        Assert.Equal("kit-build", Builds.SpaceName(dir, "kit", "git/kit"));        // ours: reuse it
        Assert.Equal("fresh", Builds.SpaceName(dir, "fresh", "git/fresh"));
    }

    [Fact]
    public void Zip_holds_every_file_under_the_artifact_folder()
    {
        var bytes = Builds.Zip(new SortedDictionary<string, string> { ["Program.cs"] = "x", ["src/A.cs"] = "y" }, "kit");
        using var zip = new ZipArchive(new MemoryStream(bytes));
        Assert.Equal(["kit/Program.cs", "kit/src/A.cs"], zip.Entries.Select(e => e.FullName).Order());
    }

    [Fact]
    public void Track_images_only_serve_images_inside_the_track()
    {
        var tracks = Path.Combine(dir, "tracks");
        Directory.CreateDirectory(Path.Combine(tracks, "git", "assets"));
        File.WriteAllText(Path.Combine(tracks, "git", "assets", "kit.svg"), "<svg/>");
        File.WriteAllText(Path.Combine(tracks, "git", "track.json"), "{}");
        Assert.Equal("image/svg+xml", Builds.TrackImage(tracks, "git", "assets/kit.svg")?.Type);
        Assert.Null(Builds.TrackImage(tracks, "git", "track.json"));
        Assert.Null(Builds.TrackImage(tracks, "git", "../git/assets/kit.svg"));
        Assert.Null(Builds.TrackImage(tracks, "..", "assets/kit.svg"));
        Assert.Null(Builds.TrackImage(tracks, "git", "assets/missing.png"));
    }

    // ---------------------------------------------------------------- validation

    static JsonArray Track(string trackJson, params (string Lesson, string Builds)[] lessons)
    {
        var t = Obj(trackJson);
        t["id"] = "t";
        var mod = new JsonObject { ["id"] = "01-m", ["lessons"] = new JsonArray(lessons.Select(l => (JsonNode)new JsonObject { ["id"] = l.Lesson, ["builds"] = JsonNode.Parse(l.Builds) }).ToArray()) };
        t["modules"] = new JsonArray(mod);
        return new JsonArray(t);
    }

    static List<Builds.Issue> Errors(JsonArray tracks) => Builds.Check(tracks).Where(i => i.Error).ToList();

    const string KitTrack = """{ "artifacts": [ { "id": "kit", "title": "Kit", "kind": "dotnet-console", "run": "dotnet run", "pitch": "p", "template": { "Program.cs": "x" } } ] }""";

    [Fact]
    public void Markers_must_name_a_declared_artifact()
    {
        var issues = Errors(Track(KitTrack, ("01-a", """[{ "step": 3, "artifact": "nope", "file": "A.cs", "mode": "replace" }]""")));
        Assert.Contains(issues, i => i.Message.Contains("\"nope\" is not declared") && i.Where.Contains("t/01-m/01-a step 4"));
        Assert.Empty(Errors(Track(KitTrack, ("01-a", """[{ "step": 3, "artifact": "kit", "file": "A.cs", "mode": "replace" }]"""))));
    }

    [Fact]
    public void Template_and_marker_paths_must_be_safe()
    {
        var bad = """{ "artifacts": [ { "id": "kit", "title": "Kit", "kind": "dotnet-console", "run": "r", "template": { "../x.cs": "x" } } ] }""";
        Assert.Contains(Errors(Track(bad)), i => i.Message.StartsWith("template path"));
        Assert.Contains(Errors(Track(KitTrack, ("01-a", """[{ "step": 0, "artifact": "kit", "file": "../A.cs" }]"""))), i => i.Message.StartsWith("file"));
        var kind = """{ "artifacts": [ { "id": "kit", "title": "Kit", "kind": "cobol", "run": "r" } ] }""";
        Assert.Contains(Errors(Track(kind)), i => i.Message.Contains("\"kind\""));
    }

    [Fact]
    public void Later_lessons_may_replace_a_piece_but_the_same_lesson_twice_is_flagged()
    {
        var grows = Builds.Check(Track(KitTrack,
            ("01-a", """[{ "step": 2, "artifact": "kit", "file": "A.cs", "mode": "replace" }]"""),
            ("02-b", """[{ "step": 5, "artifact": "kit", "file": "A.cs", "mode": "replace" }]""")));
        Assert.DoesNotContain(grows, i => i.Message.Contains("replaces"));

        var twice = Builds.Check(Track(KitTrack,
            ("01-a", """[{ "step": 2, "artifact": "kit", "file": "A.cs", "mode": "replace" }, { "step": 5, "artifact": "kit", "file": "A.cs", "mode": "replace" }]""")));
        Assert.Contains(twice, i => !i.Error && i.Message.Contains("same lesson also replaces"));
    }

    const string DreamTrack = """
        { "dreams": [
            { "id": "arcade", "title": "Arcade", "pitch": "p", "tags": ["games"], "artifact": { "kind": "python", "run": "python main.py", "template": { "main.py": "x" } } },
            { "id": "dash", "title": "Dashboard", "pitch": "p", "tags": ["data"], "artifact": { "kind": "python", "run": "python app.py", "template": { "app.py": "x" } } } ] }
        """;

    [Fact]
    public void Dream_markers_build_the_chosen_dream_and_variants_must_be_dreams()
    {
        var tracks = Track(DreamTrack, ("01-a", """[{ "step": 1, "file": "core.py", "mode": "replace", "variants": { "dash": { "file": "charts.py" } } }]"""));
        Assert.Empty(Errors(tracks));
        var t = (JsonObject)tracks[0]!;
        var marker = (JsonObject)t["modules"]![0]!["lessons"]![0]!["builds"]![0]!;
        var all = Builds.Artifacts(t);
        Assert.Equal(["arcade", "dash"], all.Select(a => (string)a["id"]!));
        Assert.Equal("python", (string?)all[0]["kind"]);
        Assert.Equal("core.py", Builds.MarkerFile(marker, all[0]));
        Assert.Equal("charts.py", Builds.MarkerFile(marker, all[1]));

        var bad = Track(DreamTrack, ("01-a", """[{ "step": 1, "file": "core.py", "variants": { "ghost": { "file": "x.py" } } }]"""));
        Assert.Contains(Errors(bad), i => i.Message.Contains("\"ghost\" is not a dream"));
        Assert.Contains(Errors(Track(KitTrack, ("01-a", """[{ "step": 1, "file": "core.py" }]"""))), i => i.Message.Contains("declares no \"dreams\""));
    }

    [Fact]
    public void A_variant_replaces_the_step_fields_for_that_dream()
    {
        var step = Obj("""
            { "type": "code", "prompt": "base", "solution": "s0", "build": { "file": "core.py", "title": "Core" },
              "variants": { "dash": { "prompt": "dash prompt", "solution": "s1", "build": { "file": "charts.py" } } } }
            """);
        var v = Content.ApplyVariant(step, "dash");
        Assert.Equal("dash prompt", (string?)v["prompt"]);
        Assert.Equal("s1", (string?)v["solution"]);
        Assert.Equal("charts.py", (string?)v["build"]!["file"]);
        Assert.Equal("Core", (string?)v["build"]!["title"]);       // build fields merge
        Assert.Equal("dash", (string?)v["variant"]);
        Assert.Null(v["variants"]);
        Assert.Equal("base", (string?)Content.ApplyVariant(step, "arcade")["prompt"]);
        Assert.Equal("base", (string?)step["prompt"]);                // the original is untouched
    }

    [Fact]
    public void A_dream_lexicon_renames_the_step_but_not_the_code_slot()
    {
        var step = Obj("""
            { "type": "code", "title": "Format a {{item}}", "prompt": "For {{app}}: {{unknown}}", "template": ["{{CODE}}", "Check({{item}})"],
              "tests": [ { "name": "a {{item}}", "expect": "{{Item}}" } ],
              "build": { "artifact": "@dream", "file": "src/{{App}}.Core/Format.cs" },
              "variants": { "pantry": { "file": "src/Pantry.Core/Freshness.cs", "title": "Freshness" } } }
            """);
        var lex = Obj("""{ "item": "task", "Item": "Task", "app": "Sidekick", "App": "Sidekick" }""");
        var v = Content.ForDream(step, "sidekick", lex);
        Assert.Equal("Format a task", (string?)v["title"]);
        Assert.Equal("For Sidekick: {{unknown}}", (string?)v["prompt"]);
        Assert.Equal("{{CODE}}", (string?)v["template"]![0]);
        Assert.Equal("Check(task)", (string?)v["template"]![1]);
        Assert.Equal("Task", (string?)v["tests"]![0]!["expect"]);
        Assert.Equal("src/Sidekick.Core/Format.cs", (string?)v["build"]!["file"]);
        Assert.Equal("sidekick", (string?)v["variant"]);

        var p = Content.ForDream(step, "pantry", Obj("""{ "item": "jar" }"""));
        Assert.Equal("src/Pantry.Core/Freshness.cs", (string?)p["build"]!["file"]);   // a variant's top-level file goes to the piece
        Assert.Equal("Freshness", (string?)p["build"]!["title"]);
        Assert.Equal("Freshness", (string?)p["title"]);
    }

    [Fact]
    public void Stubs_stand_in_for_unearned_pieces_and_files_follow_the_lexicon()
    {
        var tracks = Track("""
            { "dreams": [ { "id": "sk", "title": "Sidekick", "lexicon": { "App": "Sidekick" }, "artifact": { "kind": "dotnet-console", "run": "r", "template": { "Program.cs": "x" } } } ] }
            """, ("01-a", """[{ "step": 1, "artifact": "@dream", "file": "src/{{App}}/Banner.cs", "stub": "// banner not built yet\n" }]"""));
        Assert.Empty(Errors(tracks));
        var t = (JsonObject)tracks[0]!;
        var sk = Builds.Artifacts(t)[0];
        var stubs = Builds.Stubs(t, sk);
        Assert.Equal("// banner not built yet\n", stubs["src/Sidekick/Banner.cs"]);
        var problems = new List<string>();
        Assert.Equal("// banner not built yet\n", Builds.Assemble(sk, [], problems, null, stubs)["src/Sidekick/Banner.cs"]);
        Assert.Equal("mine\n", Builds.Assemble(sk, [new("src/Sidekick/Banner.cs", "replace", "mine", "t/01-m/01-a", 1)], problems, null, stubs)["src/Sidekick/Banner.cs"]);
    }

    [Fact]
    public void Lesson_metadata_lists_build_markers()
    {
        var steps = (JsonArray)JsonNode.Parse("""
            [ { "type": "learn" },
              { "type": "code", "title": "Lint", "build": { "artifact": "kit", "file": "Lint.cs" } },
              { "type": "code", "build": { "artifact": "kit", "file": "R.md", "mode": "append", "title": "Notes" }, "variants": { "x": { "build": { "file": "S.md" } } } } ]
            """)!;
        var m = Content.BuildMarkers(steps);
        Assert.Equal(2, m.Count);
        Assert.Equal(1, (int)m[0]!["step"]!);
        Assert.Equal("Lint", (string?)m[0]!["title"]);
        Assert.Equal("replace", (string?)m[0]!["mode"]);
        Assert.Equal("append", (string?)m[1]!["mode"]);
        Assert.Equal("S.md", (string?)m[1]!["variants"]!["x"]!["file"]);
    }

    [Fact]
    public void The_git_demo_artifact_is_valid_and_assembles()
    {
        var root = RepoRoot();
        var content = new Content(root);
        var tracks = content.Tracks();
        var git = tracks.OfType<JsonObject>().First(t => (string?)t["id"] == "git");
        Assert.Empty(Builds.Check(new JsonArray(git.DeepClone()), content.TracksDir).Where(i => i.Error));
        var kit = Builds.Artifacts(git).Single(a => (string?)a["id"] == "gitkit");

        // Assemble from the reference solutions, exactly as the UI would after passing each step.
        var pieces = new List<Builds.Piece>();
        foreach (var module in git["modules"]!.AsArray().OfType<JsonObject>())
        foreach (var lesson in module["lessons"]!.AsArray().OfType<JsonObject>())
        foreach (var b in (lesson["builds"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var full = content.Lesson("git", (string)module["id"]!, (string)lesson["id"]!)!;
            var step = (JsonObject)full["steps"]![(int)b["step"]!]!;
            pieces.Add(new((string?)b["file"], "replace", Builds.Transform(step["build"]!["transform"], (string)step["solution"]!), (string?)full["key"], (int)b["step"]!));
        }
        Assert.Equal(3, pieces.Count);
        var problems = new List<string>();
        var files = Builds.Assemble(kit, pieces, problems);
        Assert.Empty(problems);
        Assert.Contains("gitkit.csproj", files.Keys);
        Assert.Contains("    static List<string> Lint(string message)", files["Lint.cs"]);
        Assert.DoesNotContain("NotBuiltYetException", files["Scan.cs"]);
    }
}
