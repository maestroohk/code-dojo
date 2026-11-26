using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Learning paths (Paths.cs): content/paths/*.json name only modules, labs and live labs that exist.</summary>
public sealed class PathsTests
{
    static string Root()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "tracks")) && Directory.Exists(Path.Combine(d.FullName, "content", "paths"))) return d.FullName;
        throw new DirectoryNotFoundException("code-dojo root");
    }

    static readonly JsonArray Tracks = JsonNode.Parse("""
        [ { "id": "csharp", "modules": [ { "id": "01-first-steps" }, { "id": "p01-tasks-api", "kind": "project" } ] } ]
        """)!.AsArray();

    static List<Builds.Issue> CheckOne(string json) =>
        Paths.Check([("test-path", JsonNode.Parse(json)!.AsObject(), null)], Tracks, ["08-tls"]);

    [Fact]
    public void The_shipped_paths_are_valid()
    {
        var root = Root();
        var paths = Paths.Load(root);
        Assert.True(paths.Count >= 5);
        var issues = Paths.Check(paths, new Content(root).Tracks(), Paths.NetlabIds(root));
        Assert.Empty(issues.Where(i => i.Error).Select(i => $"{i.Where}: {i.Message}"));
    }

    [Fact]
    public void A_good_path_has_no_issues()
    {
        var issues = CheckOne("""
            { "title": "T", "summary": "S", "stages": [ { "id": "a", "title": "A", "why": "W", "milestone": "Can ship",
              "items": [ "csharp/01-first-steps", "csharp/p01-tasks-api", { "lab": "pki", "goal": 3 }, { "netlab": "08-tls" } ] } ] }
            """);
        Assert.Empty(issues);
    }

    [Fact]
    public void Unknown_modules_labs_and_live_labs_are_errors()
    {
        var issues = CheckOne("""
            { "title": "T", "summary": "S", "stages": [ { "id": "a", "title": "A", "why": "W",
              "items": [ "csharp/99-nope", { "lab": "space-lab" }, { "netlab": "99-nope" }, { "lab": "pki", "goal": 0 }, 42 ] } ] }
            """);
        var errors = issues.Where(i => i.Error).Select(i => i.Message).ToList();
        Assert.Contains(errors, e => e.Contains("unknown module \"csharp/99-nope\""));
        Assert.Contains(errors, e => e.Contains("unknown lab"));
        Assert.Contains(errors, e => e.Contains("unknown live lab"));
        Assert.Contains(errors, e => e.Contains("goal"));
        Assert.Contains(errors, e => e.Contains("an item is"));
    }

    [Fact]
    public void Missing_why_duplicate_stage_ids_and_repeated_modules_are_reported()
    {
        var issues = CheckOne("""
            { "title": "T", "summary": "S", "stages": [
              { "id": "a", "title": "A", "why": "W", "items": [ "csharp/01-first-steps" ] },
              { "id": "a", "title": "B", "items": [ "csharp/01-first-steps" ] } ] }
            """);
        Assert.Contains(issues, i => i.Error && i.Message.Contains("used twice"));
        Assert.Contains(issues, i => i.Error && i.Message.Contains("\"why\""));
        Assert.Contains(issues, i => !i.Error && i.Message.Contains("already in an earlier stage"));
    }
}
