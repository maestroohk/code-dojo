using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

public sealed class ContentTests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "dojo-tests-" + Guid.NewGuid().ToString("N"));
    readonly Content content;

    public ContentTests()
    {
        Write("tracks/demo/track.json", """{ "title": "Demo", "language": "csharp" }""");
        Write("tracks/demo/01-basics/module.json", """{ "title": "Basics" }""");
        Write("tracks/demo/01-basics/01-hello.json", """
            {
              // comments and trailing commas are allowed
              "title": "Hello",
              "steps": [
                { "type": "learn", "body": ["line one", "line two"] },
                { "type": "predict", "code": ["a", "b"], "answer": ["1", "2"] },
                { "type": "quiz", "answer": ["x", "y"] },
              ]
            }
            """);
        Write("tracks/no-track-file/01-x/module.json", """{ "title": "Ignored" }""");
        content = new Content(root);
    }

    void Write(string rel, string text)
    {
        var path = Path.Combine(root, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
    }

    public void Dispose()
    {
        try { Directory.Delete(root, true); } catch { }
    }

    [Fact]
    public void Tracks_lists_only_folders_with_track_json_and_counts_exercises()
    {
        var track = Assert.Single(content.Tracks())!.AsObject();
        Assert.Equal("demo", (string?)track["id"]);
        var lesson = track["modules"]![0]!["lessons"]![0]!;
        Assert.Equal("01-hello", (string?)lesson["id"]);
        Assert.Equal(3, (int)lesson["steps"]!);
        Assert.Equal(2, (int)lesson["exercises"]!);
        Assert.Equal("lesson", (string?)lesson["kind"]);
    }

    [Fact]
    public void Lesson_joins_line_arrays_for_text_fields_only()
    {
        var lesson = content.Lesson("demo", "01-basics", "01-hello")!;
        var steps = (JsonArray)lesson["steps"]!;
        Assert.Equal("line one\nline two", (string?)steps[0]!["body"]);
        Assert.Equal("a\nb", (string?)steps[1]!["code"]);
        Assert.Equal("1\n2", (string?)steps[1]!["answer"]);   // predict answers are text
        Assert.IsType<JsonArray>(steps[2]!["answer"]);          // quiz answers stay arrays
        Assert.Equal("demo/01-basics/01-hello", (string?)lesson["key"]);
    }

    [Theory]
    [InlineData("..", "01-basics", "01-hello")]
    [InlineData("demo", "..\\..", "01-hello")]
    [InlineData("demo", "01-basics", "../../secret")]
    [InlineData("Demo", "01-basics", "01-hello")]
    [InlineData("demo", "01-basics", "missing")]
    public void Lesson_rejects_unsafe_or_missing_paths(string t, string m, string l) =>
        Assert.Null(content.Lesson(t, m, l));

    [Fact]
    public void Language_reads_track_json()
    {
        Assert.Equal("csharp", content.Language("demo"));
        Assert.Equal("", content.Language("nope"));
        Assert.Equal("", content.Language("../demo"));
    }
}
