using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// Pacing and continuity (docs/CURRICULUM.md 1.2 and 3.4-3.5): the server side of the features that stop learners
/// rushing through. Format: tracks/AUTHORING.md, "Pacing: prove it, keep it".
///
///   "uses" on a code step (or its "build")  earlier pieces compiled with the learner's code: their own latest
///                                           version when they have one, else the reference solution, labelled
///   "cold": true on a code step or lesson   served with no starter, hints or solution; the UI turns assists off
///   "coldOf": "track/module/lesson#N"       a cold step that borrows its tests from step N (1-based) of that lesson
///   "gate" in module.json                   the next module stays locked until it is proven (checked in the UI,
///                                           ui/pacing.js; validated here)
/// </summary>
public static class Pacing
{
    /// <summary>A "uses" entry as the UI sends it: the artifact it resolved (for "@dream" of another track) and the pieces it holds for it.</summary>
    public record UsesInput(string? Artifact, Builds.Piece[]? Pieces);

    /// <summary>One earlier piece compiled with a step. Source: "yours", "reference" or "mixed".</summary>
    public record UsedFile(string Ref, string Artifact, string File, string Text, string Source, string Note);

    public record UsesResult(List<UsedFile> Files, List<string> Problems);

    // ================================================================ "uses"

    /// <summary>The raw "uses" entries of a step: build.uses, else the step's own "uses". Empty when none.</summary>
    public static List<string> UsesOf(JsonObject step)
    {
        var node = (step["build"] as JsonObject)?["uses"] ?? step["uses"];
        return node switch
        {
            JsonArray a => a.Select(x => x is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).OfType<string>().ToList(),
            JsonValue v when v.TryGetValue<string>(out var one) => [one],
            _ => [],
        };
    }

    /// <summary>"Core/Journal.cs" -> (null, null, file); "kit:Lint.cs" -> (null, kit, file); "csharp/sidekick:src/X.cs" -> (csharp, sidekick, file).</summary>
    public static (string? Track, string? Artifact, string File) ParseRef(string raw)
    {
        var colon = raw.IndexOf(':');
        if (colon < 0) return (null, null, raw.Trim());
        var left = raw[..colon].Trim();
        var file = raw[(colon + 1)..].Trim();
        var slash = left.IndexOf('/');
        return slash < 0 ? (null, left.Length == 0 ? null : left, file) : (left[..slash], left[(slash + 1)..], file);
    }

    /// <summary>Teaching order: lesson key, then step index (as Builds.Assemble applies pieces).</summary>
    static int Order(string keyA, int stepA, string keyB, int stepB)
    {
        var c = string.CompareOrdinal(keyA, keyB);
        return c != 0 ? c : stepA.CompareTo(stepB);
    }

    /// <summary>
    /// The artifact a bare "uses" entry (no "artifact:") means: the artifact the step's own build marker writes, else the
    /// learner's dream of this track, else the track's only artifact.
    /// </summary>
    static JsonObject? DefaultArtifact(JsonObject track, JsonObject step, string? dream)
    {
        var all = Builds.Artifacts(track);
        var target = (step["build"] as JsonObject)?["artifact"] is JsonValue tv && tv.TryGetValue<string>(out var t) ? t : null;
        if (step["build"] is JsonObject && target is not null && !Builds.ChosenDream(target)) return all.FirstOrDefault(a => (string?)a["id"] == target);
        var dreams = all.Where(a => (bool?)a["dream"] == true).ToList();
        if (dreams.Count > 0) return dreams.FirstOrDefault(a => (string?)a["id"] == dream) ?? dreams[0];
        var fixedOnes = all.Where(a => (bool?)a["dream"] != true).ToList();
        return fixedOnes.Count == 1 ? fixedOnes[0] : null;
    }

    /// <summary>
    /// Resolves every "uses" entry of the step at <paramref name="lessonKey"/>#<paramref name="stepIdx"/> to the text of that
    /// file as the learner has it now: template and stub, then the pieces of every earlier step that builds the file, using
    /// the learner's own piece when <paramref name="learner"/> holds one and the reference solution (after its transform)
    /// when not. With no learner pieces (`dojo validate`), everything is reference. Problems are authoring errors.
    /// </summary>
    public static UsesResult Resolve(Content content, JsonArray tracks, string trackId, string lessonKey, int stepIdx, JsonObject step,
        string? dream, IReadOnlyDictionary<string, UsesInput>? learner)
    {
        var files = new List<UsedFile>();
        var problems = new List<string>();
        var raws = UsesOf(step);
        if (raws.Count == 0) return new(files, problems);
        var ownTrack = tracks.OfType<JsonObject>().FirstOrDefault(t => (string?)t["id"] == trackId);
        if (ownTrack is null) { problems.Add($"track {trackId} not found"); return new(files, problems); }
        var ownFile = step["build"] is JsonObject ob && Builds.Text(ob["file"]) is { } of ? Builds.CleanPath(of.TrimEnd('\n'), out _) : null;

        foreach (var raw in raws.Distinct())
        {
            var (rt, ra, rf) = ParseRef(raw);
            var track = rt is null ? ownTrack : tracks.OfType<JsonObject>().FirstOrDefault(t => (string?)t["id"] == rt);
            if (track is null) { problems.Add($"uses \"{raw}\": there is no track \"{rt}\""); continue; }
            var sameTrack = ReferenceEquals(track, ownTrack);
            var input = learner is not null && learner.TryGetValue(raw, out var li) ? li : null;
            JsonObject? artifact;
            if (ra is null) artifact = sameTrack ? DefaultArtifact(track, step, dream) : DefaultArtifact(track, new JsonObject(), input?.Artifact);
            else if (Builds.ChosenDream(ra))
            {
                var dreams = Builds.Artifacts(track).Where(a => (bool?)a["dream"] == true).ToList();
                var want = sameTrack ? dream : input?.Artifact;
                artifact = dreams.FirstOrDefault(a => (string?)a["id"] == want) ?? dreams.FirstOrDefault();
            }
            else artifact = Builds.Artifacts(track).FirstOrDefault(a => (string?)a["id"] == ra);
            if (artifact is null) { problems.Add($"uses \"{raw}\": no artifact {(ra is null ? "to build (name one: \"artifact:file\")" : $"\"{ra}\" in {track["id"]}")}"); continue; }
            var aid = (string)artifact["id"]!;
            var isDream = (bool?)artifact["dream"] == true;
            if (Builds.CleanPath(Content.Lex(rf, artifact["lexicon"] as JsonObject), out var perr) is not { } file) { problems.Add($"uses \"{raw}\": {perr}"); continue; }
            if (sameTrack && file == ownFile && ra is null) { problems.Add($"uses \"{raw}\": that is the file this step builds; a step cannot use its own piece"); continue; }

            // Every earlier marker that writes this file of this artifact.
            var earlier = Builds.MarkersOf(track)
                .Select(x => (x.Key, Step: (int?)x.Marker["step"] ?? 0, x.Marker, File: Builds.MarkerFile(x.Marker, artifact) is { } f ? Builds.CleanPath(f, out _) : null))
                .Where(x => x.File == file && (!sameTrack || Order(x.Key, x.Step, lessonKey, stepIdx) < 0))
                .OrderBy(x => x.Key, StringComparer.Ordinal).ThenBy(x => x.Step)
                .ToList();
            if (earlier.Count == 0) { problems.Add($"uses \"{raw}\": no earlier step builds {file} in {aid}"); continue; }

            var mine = (input?.Pieces ?? []).Where(p => Builds.CleanPath(p.File, out _) == file && !(p.Lesson == lessonKey && p.Step == stepIdx)).ToList();
            var lastReplace = earlier.FindLastIndex(x => ((string?)x.Marker["mode"] ?? "replace") != "append");
            var pieces = new List<Builds.Piece>();
            int yours = 0, refs = 0;

            Builds.Piece? Reference((string Key, int Step, JsonObject Marker, string? File) m)
            {
                var parts = m.Key.Split('/');
                var lesson = parts.Length == 3 ? content.Lesson(parts[0], parts[1], parts[2], isDream ? aid : null) : null;
                if ((lesson?["steps"] as JsonArray)?.ElementAtOrDefault(m.Step) is not JsonObject s || (string?)s["solution"] is not { } solution)
                {
                    problems.Add($"uses \"{raw}\": {m.Key} step {m.Step + 1} has no reference solution to stand in for the learner's piece");
                    return null;
                }
                return new(file, (string?)m.Marker["mode"] ?? "replace", Builds.Transform((s["build"] as JsonObject)?["transform"], solution), m.Key, m.Step);
            }

            if (lastReplace >= 0)
            {
                var anchor = earlier[lastReplace];
                // The learner's newest replace version counts when it is at least as far on as the version this step expects.
                var theirs = mine.Where(p => p.Mode != "append").OrderBy(p => p.Lesson ?? "", StringComparer.Ordinal).ThenBy(p => p.Step).LastOrDefault();
                if (theirs is not null && Order(theirs.Lesson ?? "", theirs.Step, anchor.Key, anchor.Step) >= 0) { pieces.Add(theirs with { File = file }); yours++; }
                else if (Reference(anchor) is { } r) { pieces.Add(r); refs++; }
            }
            foreach (var m in earlier.Skip(lastReplace + 1))
            {
                var theirs = mine.FirstOrDefault(p => p.Mode == "append" && p.Lesson == m.Key && p.Step == m.Step);
                if (theirs is not null) { pieces.Add(theirs with { File = file }); yours++; }
                else if (Reference(m) is { } r) { pieces.Add(r); refs++; }
            }
            var assembleProblems = new List<string>();
            var text = Builds.Assemble(artifact, pieces, assembleProblems, null, Builds.Stubs(track, artifact)).GetValueOrDefault(file) ?? "";
            var name = Path.GetFileName(file);
            var source = refs == 0 ? "yours" : yours == 0 ? "reference" : "mixed";
            var note = source switch
            {
                "yours" => $"Using your own {name}.",
                "reference" => $"Using the reference version of {name}: you have not built it yet (it comes from {earlier[^1].Key}).",
                _ => $"Using your {name}, with the reference version of the parts you have not built yet.",
            };
            files.Add(new(raw, aid, file, text, source, note));
        }
        return new(files, problems);
    }

    /// <summary>Grades a code step in its track's language, with the used pieces compiled or imported alongside.</summary>
    public static async Task<CheckResult> Grade(Checker checker, LangRunner langs, string language, JsonObject step, string code, IReadOnlyList<UsedFile>? uses = null)
    {
        var extra = (uses ?? []).Select(u => (u.File, u.Text)).ToList();
        if (language == "sql")
        {
            // SQL pieces run after the step's own setup, in the order they are listed.
            if (extra.Count == 0) return SqlChecker.Check(step, code);
            var copy = (JsonObject)step.DeepClone();
            copy["setup"] = string.Join("\n\n", new[] { SqlChecker.Text(step["setup"]) }.Concat(extra.Select(e => e.Text)).Where(s => !string.IsNullOrWhiteSpace(s)));
            return SqlChecker.Check(copy, code);
        }
        if (language == "csharp") return await checker.Check(step, code, extra.Count > 0 ? extra : null, WrapOwn(step, code, extra.Count > 0));
        return await PolyChecker.Check(langs, step, code, language, extra.Count > 0 ? extra : null);
    }

    /// <summary>
    /// A C# step that uses earlier pieces and has a build "transform" is graded the way the artifact compiles: the learner's
    /// code goes inside its own transform (e.g. `static partial class Game { ... }`) as a separate file, next to the used
    /// pieces in theirs, so members of the same partial class meet. The template is then only the harness and calls
    /// through the wrapper (`Delve.Game.Move(...)`). `#line` keeps compiler errors on the learner's own line numbers.
    /// Opt out with "wrap": false on the step (the code then goes at {{CODE}} as usual).
    /// </summary>
    public static (string Path, string Text)? WrapOwn(JsonObject step, string code, bool hasUses)
    {
        if (!hasUses || (bool?)(step["wrap"] as JsonValue) == false || step["build"] is not JsonObject b || Builds.Text(b["transform"]) is null) return null;
        var file = Builds.Text(b["file"])?.TrimEnd('\n') is { } f && Builds.CleanPath(f, out _) is { } clean ? clean : "Step.cs";
        var body = $"#line 1 \"{CSharpRunner.UserFile}\"\n{code.Replace("\r\n", "\n").TrimEnd('\n')}\n#line default";
        return ("step/" + file, Builds.Transform(b["transform"], body));
    }

    /// <summary>The check result as JSON, plus "uses": which pieces were compiled with it and whose they were.</summary>
    public static JsonObject WithUses(CheckResult result, UsesResult? uses, JsonSerializerOptions json)
    {
        var node = JsonSerializer.SerializeToNode(result, result.GetType(), json) as JsonObject ?? [];
        if (uses is { Files.Count: > 0 } || uses is { Problems.Count: > 0 })
        {
            node["uses"] = new JsonArray(uses.Files.Select(u => (JsonNode)new JsonObject
            {
                ["ref"] = u.Ref, ["artifact"] = u.Artifact, ["file"] = u.File, ["source"] = u.Source, ["note"] = u.Note,
            }).ToArray());
            if (uses.Problems.Count > 0) node["usesProblems"] = new JsonArray(uses.Problems.Select(p => (JsonNode)p).ToArray());
        }
        return node;
    }

    // ================================================================ cold steps

    /// <summary>A code step that is a cold rebuild: "cold": true on the step, or on the whole lesson.</summary>
    public static bool IsCold(JsonObject step, JsonObject? lesson = null) =>
        (string?)step["type"] == "code" && ((bool?)(step["cold"] as JsonValue) == true || step["coldOf"] is JsonValue || (lesson is not null && (bool?)(lesson["cold"] as JsonValue) == true));

    /// <summary>Indices of the cold code steps of a lesson file (for the map, without loading every lesson).</summary>
    public static JsonArray ColdSteps(JsonObject lesson)
    {
        var list = new JsonArray();
        var steps = lesson["steps"] as JsonArray ?? [];
        for (var i = 0; i < steps.Count; i++)
            if (steps[i] is JsonObject s && IsCold(s, lesson)) list.Add(i);
        return list;
    }

    /// <summary>Fields a "coldOf" step borrows from the step it re-proves, so the two never drift apart.</summary>
    static readonly string[] ColdOfKeys = ["tests", "template", "require", "forbid", "setup", "check", "stateQuery", "framework", "stdin", "solution", "uses"];

    /// <summary>
    /// "coldOf": "track/module/lesson#N" (N is the 1-based step number): copy the grading of that step onto this one.
    /// The step's own fields win, so a cold step can still say its own prompt. Called by Content.Lesson.
    /// </summary>
    public static void ApplyColdOf(Content content, string trackId, JsonObject lesson, string? dream)
    {
        foreach (var step in (lesson["steps"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (step["coldOf"] is not JsonValue cv || !cv.TryGetValue<string>(out var target)) continue;
            if (ColdSource(content, target, target.StartsWith(trackId + "/", StringComparison.Ordinal) ? dream : null) is not { } src) { step["coldOfMissing"] = target; continue; }
            foreach (var k in ColdOfKeys)
                if (step[k] is null && (k == "uses" ? src["uses"] ?? (src["build"] as JsonObject)?["uses"] : src[k]) is { } v) step[k] = v.DeepClone();
            step["prompt"] ??= src["prompt"]?.DeepClone();
            step["title"] ??= src["title"]?.DeepClone();
            step["cold"] ??= true;
        }
    }

    /// <summary>The step a "coldOf" points at, or null when it is missing or not a code step.</summary>
    public static JsonObject? ColdSource(Content content, string target, string? dream)
    {
        var hash = target.LastIndexOf('#');
        if (hash < 0 || !int.TryParse(target[(hash + 1)..], out var n) || n < 1) return null;
        var parts = target[..hash].Split('/');
        if (parts.Length != 3) return null;
        var src = content.Lesson(parts[0], parts[1], parts[2], dream, coldOf: false);
        return (src?["steps"] as JsonArray)?.ElementAtOrDefault(n - 1) is JsonObject s && (string?)s["type"] == "code" && s["coldOf"] is null ? s : null;
    }

    /// <summary>
    /// The lesson as the learner's browser gets it: a cold step loses its starter, hints and solution (and "carry"), so
    /// nothing in the page can give the answer away. Grading still uses the full lesson.
    /// </summary>
    public static JsonObject ForLearner(JsonObject lesson)
    {
        foreach (var step in (lesson["steps"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (!IsCold(step, lesson)) continue;
            step["cold"] = true;
            step["starter"] = "";
            foreach (var k in new[] { "hints", "solution", "carry", "explainSolution" }) step.Remove(k);
        }
        return lesson;
    }

    // ================================================================ validation (`dojo validate`)

    /// <summary>Checks the pacing fields of one step: uses, cold, timeLimit, coldOf. Grading with the used pieces is the validator's.</summary>
    public static List<Builds.Issue> CheckStep(JsonObject lesson, JsonObject step, string where)
    {
        var issues = new List<Builds.Issue>();
        var type = (string?)step["type"];
        foreach (var k in new[] { "cold", "timeLimit", "coldOf" })
            if (step[k] is not null && type != "code") issues.Add(new(true, where, $"\"{k}\" only works on code steps"));
        if (step["cold"] is { } c && (c is not JsonValue cvv || !cvv.TryGetValue<bool>(out _))) issues.Add(new(true, where, "\"cold\" must be true or false"));
        if (step["timeLimit"] is { } tl && (tl is not JsonValue tv || !tv.TryGetValue<double>(out var secs) || secs < 10 || secs > 3600))
            issues.Add(new(true, where, "\"timeLimit\" must be a number of seconds between 10 and 3600"));
        if (step["timeLimit"] is not null && !IsCold(step, lesson)) issues.Add(new(false, where, "\"timeLimit\" is only shown on a cold step"));
        if (step["coldOfMissing"] is { } miss) issues.Add(new(true, where, $"\"coldOf\": \"{miss}\" is not a code step (write \"track/module/lesson#N\", N counting from 1)"));
        if (IsCold(step, lesson) && step["hints"] is JsonArray { Count: > 0 }) issues.Add(new(false, where, "a cold step hides its hints; remove them or drop \"cold\""));
        foreach (var node in new[] { (step["build"] as JsonObject)?["uses"], step["uses"] })
            if (node is not null and not JsonArray) issues.Add(new(true, where, "\"uses\" must be an array of file paths"));
            else if (node is JsonArray arr && arr.Any(x => x is not JsonValue v || !v.TryGetValue<string>(out _))) issues.Add(new(true, where, "\"uses\" entries must be strings"));
        return issues;
    }

    /// <summary>A lesson reference in a gate: a bare lesson id in this module, or a full "track/module/lesson" key.</summary>
    public static string GateKey(string trackId, string moduleId, string id) => id.Contains('/') ? id : $"{trackId}/{moduleId}/{id}";

    /// <summary>Checks every module "gate": the lessons it names exist, there is a boss when it asks for one, minStars is 1-3.</summary>
    public static List<Builds.Issue> CheckGates(JsonArray tracks)
    {
        var issues = new List<Builds.Issue>();
        var lessons = new Dictionary<string, JsonObject>();
        foreach (var t in tracks.OfType<JsonObject>())
        foreach (var m in (t["modules"] as JsonArray ?? []).OfType<JsonObject>())
        foreach (var l in (m["lessons"] as JsonArray ?? []).OfType<JsonObject>())
            lessons[$"{t["id"]}/{m["id"]}/{l["id"]}"] = l;

        foreach (var t in tracks.OfType<JsonObject>())
        foreach (var m in (t["modules"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (m["gate"] is not { } g) continue;
            var (tid, mid) = ((string)t["id"]!, (string)m["id"]!);
            var where = $"{tid}/{mid} (gate)";
            if (g is not JsonObject gate) { issues.Add(new(true, where, "\"gate\" must be an object")); continue; }
            var ids = (m["lessons"] as JsonArray ?? []).OfType<JsonObject>().ToList();
            var requires = gate["requires"] as JsonArray;
            if (gate["requires"] is not null && requires is null) issues.Add(new(true, where, "\"requires\" must be an array of \"boss\" or lesson ids"));
            foreach (var r in requires ?? [])
            {
                var id = (string?)(r as JsonValue);
                if (id is null) { issues.Add(new(true, where, "\"requires\" entries must be strings")); continue; }
                if (id == "boss") { if (!ids.Any(l => (string?)l["kind"] == "boss")) issues.Add(new(true, where, "requires \"boss\" but the module has no boss lesson")); }
                else if (!lessons.ContainsKey(GateKey(tid, mid, id))) issues.Add(new(true, where, $"requires \"{id}\", which is not a lesson"));
            }
            if (gate["boss"] is { } b && (b is not JsonObject && !(b is JsonValue bv && bv.TryGetValue<bool>(out _)))) issues.Add(new(true, where, "\"boss\" must be true or { \"minStars\": n }"));
            if (gate["boss"] is not null && !ids.Any(l => (string?)l["kind"] == "boss")) issues.Add(new(true, where, "asks for the boss but the module has no boss lesson"));
            var min = gate["minStars"] ?? (gate["boss"] as JsonObject)?["minStars"];
            if (min is not null && (min is not JsonValue mv || !mv.TryGetValue<int>(out var stars) || stars < 1 || stars > 3)) issues.Add(new(true, where, "\"minStars\" must be 1, 2 or 3"));
            if (gate["cold"] is { } cn && cn is not JsonArray) issues.Add(new(true, where, "\"cold\" must be an array of lesson ids"));
            foreach (var c in gate["cold"] as JsonArray ?? [])
            {
                var id = (string?)(c as JsonValue);
                if (id is null) { issues.Add(new(true, where, "\"cold\" entries must be strings")); continue; }
                var key = GateKey(tid, mid, id.Split('#')[0]);
                if (!lessons.TryGetValue(key, out var lm)) issues.Add(new(true, where, $"cold \"{id}\" is not a lesson"));
                else if (lm["cold"] is not JsonArray { Count: > 0 }) issues.Add(new(false, where, $"cold \"{id}\" has no cold step (mark one \"cold\": true)"));
            }
            if (requires is null && gate["boss"] is null && gate["cold"] is null) issues.Add(new(false, where, "the gate asks for nothing (add \"requires\" and/or \"cold\")"));
        }
        return issues;
    }
}
