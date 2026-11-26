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
                    var meta = new JsonObject
                    {
                        ["id"] = Path.GetFileNameWithoutExtension(file),
                        ["title"] = lesson["title"]?.DeepClone(),
                        ["summary"] = lesson["summary"]?.DeepClone(),
                        ["minutes"] = lesson["minutes"]?.DeepClone(),
                        ["kind"] = lesson["kind"]?.DeepClone() ?? "lesson",
                        ["steps"] = steps.Count,
                        ["exercises"] = steps.Count(s => (string?)s?["type"] != "learn"),
                    };
                    // "Your builds": which code steps add a piece to an artifact, so the UI can count pieces
                    // without loading every lesson (see Builds.cs).
                    if (BuildMarkers(steps) is { Count: > 0 } builds) meta["builds"] = builds;
                    // Pacing: which steps are cold rebuilds, so module gates can be checked on the map (Pacing.cs).
                    if (Pacing.ColdSteps(lesson) is { Count: > 0 } cold) meta["cold"] = cold;
                    lessons.Add(meta);
                }
                module["lessons"] = lessons;
                modules.Add(module);
            }
            track["modules"] = modules;
            result.Add(track);
        }
        return result;
    }

    // ------------------------------------------------------------ dreams: lexicon and variants (docs/CURRICULUM.md 3.7)

    /// <summary>Variant fields that belong to the step's "build" rather than to the step itself.</summary>
    static readonly string[] VariantBuildKeys = ["file", "transform", "stub", "try", "unlocks", "mode", "part", "uses"];

    /// <summary>Fields whose text gets the chosen dream's {{lexicon}} tokens replaced.</summary>
    static readonly HashSet<string> LexiconKeys = ["title", "prompt", "starter", "solution", "template", "tests", "explain", "hints", "body", "build", "file", "transform", "stub", "try", "unlocks", "stdin", "expect", "expectContains", "name", "code", "answer", "options"];

    [GeneratedRegex(@"\{\{([A-Za-z][A-Za-z0-9_]*)\}\}")]
    private static partial Regex LexToken();

    /// <summary>Replaces {{key}} with the lexicon's value; unknown keys (and {{CODE}}) are left as they are.</summary>
    public static string Lex(string text, JsonObject? lexicon) =>
        lexicon is null || lexicon.Count == 0 ? text
            : LexToken().Replace(text, m => lexicon[m.Groups[1].Value] is JsonValue v && v.TryGetValue<string>(out var s) ? s : m.Value);

    static JsonNode? LexNode(JsonNode? node, JsonObject lexicon, bool inText) => node switch
    {
        JsonValue v when inText && v.TryGetValue<string>(out var s) => JsonValue.Create(Lex(s, lexicon)),
        JsonArray a => new JsonArray(a.Select(x => LexNode(x, lexicon, inText)).ToArray()),
        JsonObject o => LexObject(o, lexicon, inText),
        _ => node?.DeepClone(),
    };

    static JsonObject LexObject(JsonObject o, JsonObject lexicon, bool inText)
    {
        var copy = new JsonObject();
        foreach (var (k, v) in o) copy[k] = LexNode(v, lexicon, inText || LexiconKeys.Contains(k));
        return copy;
    }

    /// <summary>
    /// A copy of <paramref name="step"/> with the fields of its variant for <paramref name="dream"/> laid over it and
    /// "variants" removed. "build" fields merge field by field; a variant's top-level file, transform, stub, try, unlocks
    /// and mode go into "build", and its title also names the piece. No variant for that dream: the step as written.
    /// </summary>
    public static JsonObject ApplyVariant(JsonObject step, string dream)
    {
        var copy = (JsonObject)step.DeepClone();
        var variant = (copy["variants"] as JsonObject)?[dream] as JsonObject;
        copy.Remove("variants");
        if (variant is null) return copy;
        var build = copy["build"] as JsonObject;
        foreach (var (k, v) in variant)
        {
            if (k == "build" && v is JsonObject vb && build is not null)
                foreach (var (bk, bv) in vb) build[bk] = bv?.DeepClone();
            else if (build is not null && VariantBuildKeys.Contains(k)) build[k] = v?.DeepClone();
            else
            {
                copy[k] = v?.DeepClone();
                if (k == "title" && build is not null) build["title"] = v?.DeepClone();
            }
        }
        copy["variant"] = dream;
        return copy;
    }

    /// <summary>The step as the learner building <paramref name="dream"/> sees it: its variant, then the dream's lexicon.</summary>
    public static JsonObject ForDream(JsonObject step, string dream, JsonObject? lexicon)
    {
        var copy = ApplyVariant(step, dream);
        if (lexicon is { Count: > 0 }) copy = LexObject(copy, lexicon, false);
        copy["variant"] = dream;
        return copy;
    }

    /// <summary>The dreams a track declares in track.json (empty when none).</summary>
    public JsonArray Dreams(string track)
    {
        if (!SafeSegment(track)) return [];
        var file = Path.Combine(TracksDir, track, "track.json");
        return File.Exists(file) && ReadObject(file)["dreams"] is JsonArray d ? d : [];
    }

    /// <summary>The "build" markers of a lesson's code steps: [{ step, artifact, file, title, mode, stub?, variants? }].</summary>
    public static JsonArray BuildMarkers(JsonArray steps)
    {
        var list = new JsonArray();
        for (var i = 0; i < steps.Count; i++)
        {
            if (steps[i] is not JsonObject s || (string?)s["type"] != "code" || s["build"] is not JsonObject b) continue;
            string? Str(JsonObject o, string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var x) ? x : null;
            var marker = new JsonObject
            {
                ["step"] = i,
                ["artifact"] = Str(b, "artifact"),
                ["file"] = Str(b, "file"),
                ["title"] = Str(b, "title") ?? Str(s, "title"),
                ["mode"] = Str(b, "mode") ?? "replace",
            };
            // What the assembled artifact holds for this file until the piece is earned.
            if (Builds.Text(b["stub"]) is { } stub) marker["stub"] = stub;
            // Per-dream overrides of the piece (another file, title or stub in one dream's skeleton).
            if (s["variants"] is JsonObject vs)
            {
                var over = new JsonObject();
                foreach (var (dream, v) in vs)
                {
                    if (v is not JsonObject vo) continue;
                    var src = vo["build"] as JsonObject;
                    var o = new JsonObject();
                    foreach (var k in new[] { "file", "title", "mode" })
                        if (((src is null ? null : Str(src, k)) ?? Str(vo, k)) is { } val) o[k] = val;
                    if (Builds.Text(src?["stub"] ?? vo["stub"]) is { } vstub) o["stub"] = vstub;
                    if (o.Count > 0) over[dream] = o;
                }
                if (over.Count > 0) marker["variants"] = over;
            }
            list.Add(marker);
        }
        return list;
    }

    /// <param name="coldOf">Fill "coldOf" steps from the step they re-prove (Pacing.ApplyColdOf); off when reading that source.</param>
    public JsonObject? Lesson(string track, string module, string lesson, string? dream = null, bool coldOf = true)
    {
        if (!SafeSegment(track) || !SafeSegment(module) || !SafeSegment(lesson)) return null;
        var file = Path.Combine(TracksDir, track, module, lesson + ".json");
        if (!File.Exists(file)) return null;
        var obj = ReadObject(file);
        Normalize(obj);
        // Dreams: with a dream of this track chosen, every step is served (and graded) as that dream's version:
        // its "variants" entry laid over it, then the dream's "lexicon" tokens replaced. Otherwise the step as written.
        if (dream is { Length: > 0 } && obj["steps"] is JsonArray all
            && Dreams(track).OfType<JsonObject>().FirstOrDefault(d => (string?)d["id"] == dream) is { } chosen)
        {
            var lexicon = chosen["lexicon"] as JsonObject;
            for (var i = 0; i < all.Count; i++)
                if (all[i] is JsonObject st) all[i] = ForDream(st, dream, lexicon);
            if (obj["title"] is JsonValue t && t.TryGetValue<string>(out var title)) obj["title"] = Lex(title, lexicon);
        }
        // A track may set a default "framework" (e.g. "efcore") for every code and predict step that names none.
        if (Framework(track) is { Length: > 0 } framework)
            foreach (var step in (obj["steps"] as JsonArray ?? []).OfType<JsonObject>())
                if ((string?)step["type"] is "code" or "predict" && step["framework"] is null) step["framework"] = framework;
        if (coldOf) Pacing.ApplyColdOf(this, track, obj, dream);
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

    /// <summary>The track's default "framework" for C# steps ("efcore", "web"), or "" for plain C#.</summary>
    public string Framework(string track)
    {
        if (!SafeSegment(track)) return "";
        var file = Path.Combine(TracksDir, track, "track.json");
        return File.Exists(file) ? (string?)ReadObject(file)["framework"] ?? "" : "";
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
