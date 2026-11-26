using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// Learning paths: role routes across topics ("Backend developer (.NET)", "DevOps / platform engineer", ...), stored as
/// content/paths/{id}.json and checked by `dojo validate`. A path is an ordered list of stages; a stage is a short why,
/// a list of items and an optional milestone:
///
///   { "title": "...", "role": "...", "summary": "...", "order": 1, "outcome": "...",
///     "stages": [ { "id": "ship", "title": "Ship it", "why": "...", "milestone": "Can ship a containerised API with CI",
///                   "items": [ "docker/04-compose",                      a module (lessons or a project), track/module
///                              { "lab": "composebuild", "goal": 6 },    a visual lab: solve `goal` challenges (default 3)
///                              { "netlab": "08-tls" } ] } ] }          a live lab: every task done
///
/// Progress is worked out in the UI (ui/paths.js) from the learner's state; live-lab task counts come from here.
/// </summary>
public static class Paths
{
    /// <summary>The visual labs that record solved challenges in state.labs (ids as the UI stores them). Same list as ui/paths.js.</summary>
    public static readonly string[] Labs = ["pki", "subnet", "netbuild", "archbuild", "composebuild", "kubebuild", "pipebuild", "msgbuild-rabbit", "msgbuild-kafka", "vim", "regex"];

    static readonly JsonDocumentOptions DocOptions = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    public static string Dir(string root) => Path.Combine(root, "content", "paths");

    /// <summary>Every path file, with "id" set from the file name. A file that does not parse comes back with its error.</summary>
    public static List<(string Id, JsonObject? Path, string? Error)> Load(string root)
    {
        var list = new List<(string, JsonObject?, string?)>();
        var dir = Dir(root);
        if (!Directory.Exists(dir)) return list;
        foreach (var file in Directory.GetFiles(dir, "*.json").Order(StringComparer.Ordinal))
        {
            var id = Path.GetFileNameWithoutExtension(file);
            try
            {
                if (JsonNode.Parse(File.ReadAllText(file), documentOptions: DocOptions) is not JsonObject o) { list.Add((id, null, "not a JSON object")); continue; }
                o["id"] = id;
                list.Add((id, o, null));
            }
            catch (JsonException e) { list.Add((id, null, "cannot parse: " + e.Message)); }
        }
        return list;
    }

    /// <summary>The paths that parse, in their "order".</summary>
    public static JsonArray All(string root) =>
        new(Load(root).Where(p => p.Path is not null).Select(p => p.Path!)
            .OrderBy(p => (int?)p["order"] ?? 99).ThenBy(p => (string?)p["id"], StringComparer.Ordinal)
            .Select(p => (JsonNode)p).ToArray());

    /// <summary>`dojo validate`: unknown modules, labs and live labs are errors; a module listed twice is a warning.</summary>
    public static List<Builds.Issue> Check(IEnumerable<(string Id, JsonObject? Path, string? Error)> paths, JsonArray tracks, IEnumerable<string> netlabIds)
    {
        var issues = new List<Builds.Issue>();
        var modules = new HashSet<string>(StringComparer.Ordinal);
        foreach (var t in tracks.OfType<JsonObject>())
        foreach (var m in (t["modules"] as JsonArray ?? []).OfType<JsonObject>())
            modules.Add($"{t["id"]}/{m["id"]}");
        var netlabs = netlabIds.ToHashSet(StringComparer.Ordinal);
        foreach (var (id, path, error) in paths)
        {
            var where = $"paths/{id}";
            void Err(string msg) => issues.Add(new(true, where, msg));
            void Warn(string msg) => issues.Add(new(false, where, msg));
            if (error is not null) { Err(error); continue; }
            if (!Content.SafeSegment(id)) Err("bad file name (use lowercase letters, digits and dashes)");
            if ((string?)path!["title"] is not { Length: > 0 }) Err("missing \"title\"");
            if ((string?)path["summary"] is not { Length: > 0 }) Err("missing \"summary\"");
            if (path["stages"] is not JsonArray { Count: > 0 } stages) { Err("no \"stages\""); continue; }
            var stageIds = new HashSet<string>(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < stages.Count; i++)
            {
                var sw = $"stage {i + 1}";
                if (stages[i] is not JsonObject stage) { Err($"{sw}: not an object"); continue; }
                if ((string?)stage["id"] is not { Length: > 0 } sid || !Content.SafeSegment(sid)) Err($"{sw}: needs an \"id\" (lowercase letters, digits and dashes)");
                else if (!stageIds.Add(sid)) Err($"{sw}: stage id \"{sid}\" is used twice");
                if ((string?)stage["title"] is not { Length: > 0 }) Err($"{sw}: missing \"title\"");
                if ((string?)stage["why"] is not { Length: > 0 }) Err($"{sw}: missing \"why\" (one or two sentences: why this stage, why here)");
                if (stage["milestone"] is { } ms && (string?)(ms as JsonValue) is not { Length: > 0 }) Err($"{sw}: \"milestone\" must be a sentence");
                if (stage["items"] is not JsonArray { Count: > 0 } items) { Err($"{sw}: no \"items\""); continue; }
                foreach (var item in items)
                {
                    switch (item)
                    {
                        case JsonValue v when v.GetValueKind() == JsonValueKind.String:
                            var key = (string)v!;
                            if (!modules.Contains(key)) Err($"{sw}: unknown module \"{key}\" (write track/module, as in tracks/)");
                            else if (!seen.Add(key)) Warn($"{sw}: module \"{key}\" is already in an earlier stage");
                            break;
                        case JsonObject o when o["lab"] is { } lab:
                            if (!Labs.Contains((string?)(lab as JsonValue))) Err($"{sw}: unknown lab \"{lab}\" (one of {string.Join(", ", Labs)})");
                            if (o["goal"] is { } g && (g is not JsonValue gv || gv.GetValueKind() != JsonValueKind.Number || (int)gv < 1)) Err($"{sw}: lab \"goal\" must be a whole number of challenges, 1 or more");
                            break;
                        case JsonObject o when o["netlab"] is { } nl:
                            if (!netlabs.Contains((string?)(nl as JsonValue) ?? "")) Err($"{sw}: unknown live lab \"{nl}\" (a folder in netlabs/labs)");
                            break;
                        default:
                            Err($"{sw}: an item is \"track/module\", {{ \"lab\": id, \"goal\": n }} or {{ \"netlab\": id }}");
                            break;
                    }
                }
            }
        }
        return issues;
    }

    public static IEnumerable<string> NetlabIds(string root)
    {
        var dir = Path.Combine(root, "netlabs", "labs");
        return Directory.Exists(dir)
            ? Directory.GetDirectories(dir).Where(d => File.Exists(Path.Combine(d, "lab.json"))).Select(d => Path.GetFileName(d)!)
            : [];
    }

    public static void Map(WebApplication app, string root, NetLabs? netlabs)
    {
        // Read on every request, like lessons, so editing a path file shows up on refresh.
        app.MapGet("/api/paths", () => Results.Text(new JsonObject
        {
            ["paths"] = All(root),
            ["netlabs"] = netlabs?.TaskSummary() ?? [],
        }.ToJsonString(), "application/json"));
    }
}
