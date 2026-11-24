using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// Reads tracks from disk on every request, so editing a lesson file shows up on refresh.
///   tracks/{track}/track.json                 title, language, tagline
///   tracks/{track}/{NN-module}/module.json    title, summary
///   tracks/{track}/{NN-module}/{NN-lesson}.json
/// </summary>
public sealed partial class Content(string root)
{
    public string TracksDir { get; } = Path.Combine(root, "tracks");

    static readonly JsonDocumentOptions DocOptions = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    // Authors may write any of these as an array of lines instead of one long escaped string.
    static readonly string[] TextKeys = ["body", "prompt", "code", "starter", "solution", "template", "explain", "expect", "stdin", "expectContains"];

    [GeneratedRegex("^[a-z0-9][a-z0-9-]*$")]
    private static partial Regex Segment();

    public static bool SafeSegment(string s) => Segment().IsMatch(s);

    static JsonObject ReadObject(string path) =>
        JsonNode.Parse(File.ReadAllText(path), documentOptions: DocOptions) as JsonObject
        ?? throw new InvalidDataException($"{path} is not a JSON object");

    public JsonArray Tracks()
    {
        var result = new JsonArray();
        if (!Directory.Exists(TracksDir)) return result;
        foreach (var trackDir in Directory.GetDirectories(TracksDir).Order())
        {
            var trackFile = Path.Combine(trackDir, "track.json");
            if (!File.Exists(trackFile)) continue;
            var track = ReadObject(trackFile);
            track["id"] = Path.GetFileName(trackDir);
            var modules = new JsonArray();
            foreach (var moduleDir in Directory.GetDirectories(trackDir).Order())
            {
                var moduleFile = Path.Combine(moduleDir, "module.json");
                if (!File.Exists(moduleFile)) continue;
                var module = ReadObject(moduleFile);
                module["id"] = Path.GetFileName(moduleDir);
                var lessons = new JsonArray();
                foreach (var file in Directory.GetFiles(moduleDir, "*.json").Order())
                {
                    if (Path.GetFileName(file) == "module.json") continue;
                    var lesson = ReadObject(file);
                    var steps = lesson["steps"] as JsonArray ?? [];
                    lessons.Add(new JsonObject
                    {
                        ["id"] = Path.GetFileNameWithoutExtension(file),
                        ["title"] = lesson["title"]?.DeepClone(),
                        ["summary"] = lesson["summary"]?.DeepClone(),
                        ["minutes"] = lesson["minutes"]?.DeepClone(),
                        ["kind"] = lesson["kind"]?.DeepClone() ?? "lesson",
                        ["steps"] = steps.Count,
                        ["exercises"] = steps.Count(s => (string?)s?["type"] != "learn"),
                    });
                }
                module["lessons"] = lessons;
                modules.Add(module);
            }
            track["modules"] = modules;
            result.Add(track);
        }
        return result;
    }

    public JsonObject? Lesson(string track, string module, string lesson)
    {
        if (!SafeSegment(track) || !SafeSegment(module) || !SafeSegment(lesson)) return null;
        var file = Path.Combine(TracksDir, track, module, lesson + ".json");
        if (!File.Exists(file)) return null;
        var obj = ReadObject(file);
        Normalize(obj);
        obj["id"] = lesson;
        obj["key"] = $"{track}/{module}/{lesson}";
        return obj;
    }

    public string Language(string track)
    {
        if (!SafeSegment(track)) return "";
        var file = Path.Combine(TracksDir, track, "track.json");
        return File.Exists(file) ? (string?)ReadObject(file)["language"] ?? "" : "";
    }

    /// <summary>Join line arrays into strings everywhere a text field is expected.</summary>
    static void Normalize(JsonNode? node, string? stepType = null)
    {
        switch (node)
        {
            case JsonObject obj:
                var type = (string?)obj["type"] ?? stepType;
                foreach (var key in obj.Select(p => p.Key).ToList())
                {
                    var isText = TextKeys.Contains(key) || (key == "answer" && type == "predict");
                    if (isText && obj[key] is JsonArray lines && lines.All(l => l is JsonValue v && v.TryGetValue<string>(out _)))
                        obj[key] = string.Join("\n", lines.Select(l => (string)l!));
                    else
                        Normalize(obj[key], type);
                }
                break;
            case JsonArray arr:
                foreach (var item in arr) Normalize(item, stepType);
                break;
        }
    }
}
