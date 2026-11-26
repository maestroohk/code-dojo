using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// "lab" lesson steps link a lesson to a lab and can require it (format: tracks/AUTHORING.md, "lab"):
///   { "type": "lab", "lab": "netbuild", "challenge": "static", "prompt": "..." }   a visual lab challenge (ui/lab-*.js);
///        the step passes once that challenge is solved (the lab's saved progress in the browser)
///   { "type": "lab", "live": "13-pipes-and-plumbing", "task": "t3", "prompt": "..." }   a live Docker lab task
///        (netlabs/labs); the step passes once the lab records the task as done ("task" may be an array)
/// The step is graded in the page (ui/steps.js); this file is what `dojo validate` knows about the labs.
/// </summary>
public static partial class LabSteps
{
    /// <summary>Visual labs a step can name, and the module that holds each one's CHALLENGES list.</summary>
    public static readonly IReadOnlyDictionary<string, string> Visual = new Dictionary<string, string>
    {
        ["netbuild"] = "netsim.js",
        ["archbuild"] = "archsim.js",
        ["composebuild"] = "composesim.js",
        ["kubebuild"] = "kubesim.js",
        ["pipebuild"] = "pipesim.js",
        ["pki"] = "lab-pki.js",
    };

    // { id: 'static', title: 'Two routers, static routes', xp: 40, ... } as the labs write them.
    [GeneratedRegex(@"\{\s*id:\s*'([a-z0-9-]+)'[^\n]*?\bxp:\s*(\d+)")]
    private static partial Regex ChallengeRe();

    /// <summary>The challenges of a visual lab with their XP (0 = a sandbox that is never "solved"). Empty when unknown.</summary>
    public static Dictionary<string, int> Challenges(string uiDir, string lab)
    {
        if (!Visual.TryGetValue(lab, out var file) || !File.Exists(Path.Combine(uiDir, file))) return [];
        var text = File.ReadAllText(Path.Combine(uiDir, file));
        var at = text.IndexOf("CHALLENGES = [", StringComparison.Ordinal);
        if (at < 0) return [];
        var found = new Dictionary<string, int>();
        foreach (Match m in ChallengeRe().Matches(text, at)) found.TryAdd(m.Groups[1].Value, int.Parse(m.Groups[2].Value));
        return found;
    }

    static string? Str(JsonObject o, string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>The task ids of a live-lab step: "task" as one id or an array of ids.</summary>
    public static List<string> Tasks(JsonObject step) => step["task"] switch
    {
        JsonArray a => a.Select(x => x is JsonValue v && v.TryGetValue<string>(out var s) ? s : "").ToList(),
        JsonValue v when v.TryGetValue<string>(out var s) => [s],
        _ => [],
    };

    /// <summary>Author errors in one lab step (empty when it is fine). <paramref name="root"/> is the code-dojo folder.</summary>
    public static List<string> Check(JsonObject step, string root)
    {
        var errors = new List<string>();
        if (Str(step, "prompt") is not { Length: > 0 }) errors.Add("missing 'prompt'");
        var visual = Str(step, "lab");
        var live = Str(step, "live");
        if ((visual is null) == (live is null)) { errors.Add("name exactly one of \"lab\" (a visual lab) or \"live\" (a live lab)"); return errors; }
        if (visual is not null)
        {
            if (!Visual.ContainsKey(visual)) { errors.Add($"\"lab\": \"{visual}\" is not a visual lab ({string.Join(", ", Visual.Keys)})"); return errors; }
            var all = Challenges(Path.Combine(root, "ui"), visual);
            var ch = Str(step, "challenge");
            if (ch is null) errors.Add("a visual lab step needs \"challenge\": the challenge id to solve");
            else if (!all.TryGetValue(ch, out var xp)) errors.Add($"\"challenge\": \"{ch}\" is not a challenge of {visual} ({string.Join(", ", all.Keys)})");
            else if (xp == 0) errors.Add($"\"challenge\": \"{ch}\" is a sandbox with no goals, so it can never be solved");
            if (step["task"] is not null) errors.Add("\"task\" belongs to live labs; a visual lab step names a \"challenge\"");
            return errors;
        }
        var labs = new NetLabs(Path.Combine(root, "netlabs", "labs"), Path.Combine(root, "netlabs", "images", "toolbox"), Path.GetTempPath());
        if (labs.FindLab(live) is not { } lab) { errors.Add($"\"live\": \"{live}\" is not a lab folder under netlabs/labs"); return errors; }
        var tasks = Tasks(step);
        if (tasks.Count == 0) errors.Add("a live lab step needs \"task\": a task id (or an array of them) from its lab.json");
        foreach (var t in tasks)
            if (lab.Task(t) is null) errors.Add($"\"task\": \"{t}\" is not a task of {live} ({string.Join(", ", lab.Tasks.Select(x => (string?)x["id"]))})");
        if (step["challenge"] is not null) errors.Add("\"challenge\" belongs to visual labs; a live lab step names a \"task\"");
        return errors;
    }
}
