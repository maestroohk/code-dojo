using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// "Your builds": every topic quietly assembles a real artifact (a tool, a service, a script kit) from the
/// learner's own passing code. A track declares artifacts in track.json; a code step marks the piece it
/// contributes with "build". The UI keeps the latest passing version of each piece; this class turns
/// template + pieces into files, exports them into a code space (never overwriting files the learner edited
/// there since the last export) and zips them for download. Format: tracks/AUTHORING.md, "Building a real artifact".
/// </summary>
public static partial class Builds
{
    public static readonly string[] Kinds = ["dotnet-console", "dotnet-web", "python", "node", "shell", "sql", "docs", "infra"];
    public static readonly string[] Modes = ["replace", "append"];

    /// <summary>One piece as the UI stores it: the (already transformed) passing code for one file.</summary>
    public record Piece(string? File, string? Mode, string? Code, string? Lesson, int Step);
    public record ExportRequest(Piece[]? Pieces);
    public record ExportResult(List<string> Written, List<string> Unchanged, List<string> Kept);

    const string MetaFile = ".dojo-space.json";        // the code space's own metadata, hidden from the explorer
    const string KeptSuffix = ".dojo-new";
    const int MaxFiles = 400;
    const int MaxFileChars = 1_000_000;

    [GeneratedRegex(@"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", RegexOptions.IgnoreCase)] private static partial Regex ReservedRx();

    // ================================================================ pure helpers (public for tests)

    /// <summary>
    /// A relative artifact path normalised to forward slashes ("src/Lint.cs"), or null with a reason when it is
    /// absolute, climbs out, uses . or .., names a device, or touches .git / the space's metadata.
    /// </summary>
    public static string? CleanPath(string? rel, out string error)
    {
        error = "";
        if (string.IsNullOrWhiteSpace(rel)) { error = "a path is required"; return null; }
        if (rel.Length > 200) { error = "the path is too long"; return null; }
        var norm = rel.Replace('\\', '/');
        if (norm.StartsWith('/') || norm.Contains(':') || Path.IsPathRooted(rel)) { error = $"\"{rel}\" must be relative"; return null; }
        var parts = norm.Split('/');
        foreach (var p in parts)
        {
            if (p.Length == 0) { error = $"\"{rel}\" has an empty segment"; return null; }
            if (p is "." or "..") { error = $"\"{rel}\" cannot use . or .. segments"; return null; }
            if (p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || p.IndexOfAny(['<', '>', '"', '|', '?', '*']) >= 0 || p.Any(char.IsControl))
            { error = $"\"{p}\" has characters a file name cannot hold"; return null; }
            if (p.EndsWith('.') || p.EndsWith(' ') || ReservedRx().IsMatch(p)) { error = $"\"{p}\" is not a usable file name on Windows"; return null; }
            if (p.Equals(".git", StringComparison.OrdinalIgnoreCase) || p.Equals(MetaFile, StringComparison.OrdinalIgnoreCase))
            { error = $"\"{rel}\" is a reserved path"; return null; }
        }
        return string.Join('/', parts);
    }

    /// <summary>A template value: one string, or an array of lines (joined, ending in a newline).</summary>
    public static string? Text(JsonNode? node) => node switch
    {
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonArray a when a.All(l => l is JsonValue lv && lv.TryGetValue<string>(out _)) => string.Join("\n", a.Select(l => (string)l!)) + "\n",
        _ => null,
    };

    /// <summary>
    /// Wraps the learner's code with a step's "transform" ({{CODE}} marks where it goes). When {{CODE}} is
    /// indented on its line, every line of the code gets that indent. ui/builds.js does the same in the browser.
    /// </summary>
    public static string Transform(JsonNode? transform, string code)
    {
        if (Text(transform) is not { } t) return code;
        code = code.Replace("\r\n", "\n").TrimEnd('\n');
        return CodeSlot().Replace(t, m =>
        {
            var indent = m.Groups[1].Value;
            return indent + string.Join("\n", code.Split('\n').Select((l, i) => i == 0 || l.Length == 0 ? l : indent + l));
        });
    }

    [GeneratedRegex(@"(?m:^([ \t]*))?\{\{CODE\}\}")] private static partial Regex CodeSlot();

    static string WithNewline(string s) => s.Length == 0 || s.EndsWith('\n') ? s : s + "\n";

    /// <summary>
    /// Template files, then every piece in teaching order (lesson key, then step): "replace" sets the file's
    /// content (a later lesson replaces an earlier version, which is how pieces grow), "append" adds to it.
    /// <paramref name="allowed"/>, when given, limits pieces to the files the track's markers declare.
    /// </summary>
    public static SortedDictionary<string, string> Assemble(JsonObject artifact, IEnumerable<Piece> pieces, List<string> problems,
        IReadOnlySet<string>? allowed = null, IReadOnlyDictionary<string, string>? stubs = null)
    {
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        if (artifact["template"] is JsonObject template)
            foreach (var (path, value) in template)
            {
                if (CleanPath(path, out var err) is not { } clean) { problems.Add("template: " + err); continue; }
                if (Text(value) is not { } text) { problems.Add($"template: \"{path}\" must be a string or an array of lines"); continue; }
                files[clean] = text;
            }
        // A piece's "stub" stands in for it until it is earned (the template wins when it already has the file).
        foreach (var (path, stub) in stubs ?? new Dictionary<string, string>())
            if (CleanPath(path, out _) is { } clean) files.TryAdd(clean, WithNewline(stub));
        foreach (var piece in pieces.OrderBy(p => p.Lesson ?? "", StringComparer.Ordinal).ThenBy(p => p.Step))
        {
            if (CleanPath(piece.File, out var err) is not { } clean) { problems.Add("piece: " + err); continue; }
            if (allowed is not null && !allowed.Contains(clean)) { problems.Add($"piece: \"{clean}\" is not a file this artifact's lessons build"); continue; }
            var code = WithNewline(piece.Code ?? "");
            if (piece.Mode == "append" && files.TryGetValue(clean, out var before))
                files[clean] = WithNewline(before) + code;
            else
                files[clean] = code;
        }
        if (files.Count > MaxFiles) problems.Add($"too many files ({files.Count})");
        return files;
    }

    static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    static string HashFile(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    static JsonObject ReadMeta(string dir)
    {
        try { return JsonNode.Parse(File.ReadAllText(Path.Combine(dir, MetaFile))) as JsonObject ?? []; }
        catch { return []; }
    }

    /// <summary>The code space template id that matches an artifact kind, so the IDE treats it like one of its own.</summary>
    public static (string Template, string Kind) SpaceKind(string? kind) => kind switch
    {
        "dotnet-console" => ("console", "dotnet"),
        "dotnet-web" => ("web", "dotnet"),
        "python" => ("py-script", "python"),
        "node" => ("node-script", "node"),
        "infra" => ("empty", "dotnet"),
        _ => ("empty", "dotnet"),
    };

    /// <summary>
    /// Writes <paramref name="files"/> into <paramref name="dir"/>. The space's metadata keeps the hash of every
    /// file as last exported. A file whose content on disk no longer matches (the learner edited it there), or a
    /// file the export did not write, is left alone; the new version goes next to it as "name.dojo-new".
    /// </summary>
    public static ExportResult Export(string dir, IReadOnlyDictionary<string, string> files, string artifactKey, string? kind)
    {
        Directory.CreateDirectory(dir);
        var meta = ReadMeta(dir);
        var build = meta["build"] as JsonObject ?? [];
        var manifest = build["files"] as JsonObject ?? [];
        var result = new ExportResult([], [], []);
        foreach (var (path, text) in files)
        {
            if (CodeSpaces.SafePath(dir, path, out _) is not { } full) continue;   // CleanPath already vetted it; this also refuses links
            var hash = Hash(text);
            if (!File.Exists(full))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                File.WriteAllText(full, text);
                manifest[path] = hash;
                result.Written.Add(path);
                continue;
            }
            var onDisk = HashFile(full);
            if (onDisk == hash) { manifest[path] = hash; result.Unchanged.Add(path); continue; }
            if ((string?)manifest[path] == onDisk)
            {
                File.WriteAllText(full, text);                 // untouched since the last export: safe to update
                manifest[path] = hash;
                result.Written.Add(path);
                continue;
            }
            // Edited by the learner (or never ours): keep theirs, put the new version beside it.
            if (CodeSpaces.SafePath(dir, path + KeptSuffix, out _) is { } side) File.WriteAllText(side, text);
            result.Kept.Add(path);
        }
        var (template, spaceKind) = SpaceKind(kind);
        meta["template"] ??= template;
        meta["kind"] ??= spaceKind;
        meta["created"] ??= DateTimeOffset.UtcNow.ToString("O");
        build["artifact"] = artifactKey;
        build["exported"] = DateTimeOffset.UtcNow.ToString("O");
        build["files"] = manifest.DeepClone();
        meta["build"] = build.DeepClone();
        File.WriteAllText(Path.Combine(dir, MetaFile), meta.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return result;
    }

    /// <summary>
    /// The space an artifact exports into: its id, unless a space of that name already holds something else,
    /// then "id-build", "id-build-2", ...
    /// </summary>
    public static string? SpaceName(string spacesRoot, string artifactId, string artifactKey)
    {
        foreach (var name in new[] { artifactId, $"{artifactId}-build" }.Concat(Enumerable.Range(2, 8).Select(i => $"{artifactId}-build-{i}")))
        {
            if (!CodeSpaces.ValidSpaceName(name)) continue;
            var dir = Path.Combine(spacesRoot, name);
            if (File.Exists(dir)) continue;
            if (!Directory.Exists(dir)) return name;
            if ((string?)ReadMeta(dir)["build"]?["artifact"] == artifactKey) return name;
        }
        return null;
    }

    public static byte[] Zip(IReadOnlyDictionary<string, string> files, string folder)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (path, text) in files)
            {
                var entry = zip.CreateEntry($"{folder}/{path}", CompressionLevel.Optimal);
                using var w = new StreamWriter(entry.Open(), new UTF8Encoding(false));
                w.Write(text);
            }
        return ms.ToArray();
    }

    // ================================================================ validation (`dojo validate`)

    public record Issue(bool Error, string Where, string Message);

    /// <summary>
    /// Every artifact a track can build, as one flat list. A track declares either "artifacts" (one fixed build)
    /// or "dreams" (4-5 builds the learner picks from); a dream's "artifact" object holds kind, template and run,
    /// and the dream's own id, title, icon, pitch, features and preview are laid over it. Dream entries get "dream": true.
    /// </summary>
    public static List<JsonObject> Artifacts(JsonObject track)
    {
        var list = new List<JsonObject>();
        foreach (var a in (track["artifacts"] as JsonArray ?? []).OfType<JsonObject>()) list.Add(a);
        foreach (var d in (track["dreams"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var art = d["artifact"] is JsonObject inner ? (JsonObject)inner.DeepClone() : [];
            foreach (var (k, v) in d) if (k != "artifact") art[k] = v?.DeepClone();
            art["dream"] = true;
            list.Add(art);
        }
        return list;
    }

    /// <summary>
    /// The file a build marker writes in <paramref name="artifact"/>, or null when the marker builds something else.
    /// A marker with no "artifact" (or "dream") builds whichever dream the learner chose, so it counts for every dream.
    /// </summary>
    public static string? MarkerFile(JsonObject marker, JsonObject artifact)
    {
        var id = (string?)artifact["id"];
        var target = (string?)marker["artifact"];
        var isDream = (bool?)artifact["dream"] == true;
        if (!(target == id || (isDream && ChosenDream(target)))) return null;
        var file = (string?)(marker["variants"]?[id!]?["file"] as JsonValue) ?? (string?)marker["file"];
        return file is null ? null : Content.Lex(file, artifact["lexicon"] as JsonObject);   // "src/{{App}}.Core/..." per dream
    }

    /// <summary>A marker "artifact" that means the learner's chosen dream: none, "@dream" or "dream".</summary>
    public static bool ChosenDream(string? target) => target is null or "@dream" or "dream";

    /// <summary>What an artifact holds for each piece file until the piece is earned: the markers' "stub" texts.</summary>
    public static Dictionary<string, string> Stubs(JsonObject track, JsonObject artifact)
    {
        var stubs = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (_, m) in MarkersOf(track))
            if (MarkerFile(m, artifact) is { } f && CleanPath(f, out _) is { } clean
                && ((string?)(m["variants"]?[(string)artifact["id"]!]?["stub"] as JsonValue) ?? (string?)m["stub"]) is { } stub)
                stubs.TryAdd(clean, Content.Lex(stub, artifact["lexicon"] as JsonObject));
        return stubs;
    }

    static IEnumerable<(string Key, JsonObject Marker)> MarkersOf(JsonObject track) =>
        from module in (track["modules"] as JsonArray ?? []).OfType<JsonObject>()
        from lesson in (module["lessons"] as JsonArray ?? []).OfType<JsonObject>()
        from m in (lesson["builds"] as JsonArray ?? []).OfType<JsonObject>()
        select ($"{track["id"]}/{module["id"]}/{lesson["id"]}", m);

    /// <summary>Checks every track's artifacts, dreams and build markers (from <see cref="Content.Tracks"/>).</summary>
    public static List<Issue> Check(JsonArray tracks, string? tracksDir = null)
    {
        var issues = new List<Issue>();
        var ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var track in tracks.OfType<JsonObject>())
        {
            var tid = (string?)track["id"] ?? "?";
            var declared = new Dictionary<string, JsonObject>();
            foreach (var k in new[] { "artifacts", "dreams" })
                if (track[k] is { } node && (node is not JsonArray arr || arr.Any(x => x is not JsonObject))) issues.Add(new(true, tid, $"\"{k}\" must be an array of objects"));
            if (track["dreams"] is JsonArray ds && ds.Count == 1) issues.Add(new(false, tid, "a dream is a choice: declare 4 or 5 (or use \"artifacts\" for one fixed build)"));
            foreach (var d in (track["dreams"] as JsonArray ?? []).OfType<JsonObject>())
                if (d["artifact"] is not JsonObject) issues.Add(new(true, $"{tid} dream {d["id"]}", "missing \"artifact\": { kind, template, run }"));
            foreach (var art in Artifacts(track))
            {
                var id = (string?)(art["id"] as JsonValue);
                var dream = (bool?)art["dream"] == true;
                var where = $"{tid} {(dream ? "dream" : "artifact")} {id ?? "?"}";
                if (!CodeSpaces.ValidSpaceName(id)) { issues.Add(new(true, where, "\"id\" must be 1-40 letters, digits, - or _, starting with a letter")); continue; }
                if (id == "dream") { issues.Add(new(true, where, "\"dream\" is reserved (a marker with \"artifact\": \"dream\" means the learner's chosen dream)")); continue; }
                if (ids.TryGetValue(id!, out var other)) issues.Add(new(true, where, $"the id is already used by track {other}"));
                ids[id!] = tid;
                declared[id!] = art;
                if ((string?)(art["title"] as JsonValue) is not { Length: > 0 }) issues.Add(new(true, where, "missing \"title\""));
                if ((string?)(art["kind"] as JsonValue) is not { } kind || !Kinds.Contains(kind))
                    issues.Add(new(true, where, $"\"kind\" must be one of {string.Join(", ", Kinds)}"));
                if (art["run"] is null) issues.Add(new(false, where, "no \"run\": say how to run the finished artifact"));
                if (art["template"] is not null and not JsonObject) issues.Add(new(true, where, "\"template\" must be an object of path -> content"));
                foreach (var (path, value) in art["template"] as JsonObject ?? [])
                {
                    if (CleanPath(path, out var err) is null) issues.Add(new(true, where, "template path " + err));
                    else if (Text(value) is null) issues.Add(new(true, where, $"template \"{path}\" must be a string or an array of lines"));
                }
                // The dream reveal: a pitch, feature bullets and an optional preview (an image in the track folder, or a demo snippet).
                if (art["pitch"] is null) issues.Add(new(false, where, "no \"pitch\": one vivid sentence the learner will look forward to"));
                if (art["features"] is { } feats && (feats is not JsonArray fa || fa.Any(f => Text(f) is null)))
                    issues.Add(new(true, where, "\"features\" must be an array of strings"));
                if (art["tags"] is { } tags && (tags is not JsonArray ta || ta.Any(t => Text(t) is null)))
                    issues.Add(new(true, where, "\"tags\" must be an array of strings"));
                if (art["preview"] is { } pv)
                {
                    if (pv is not JsonObject preview) issues.Add(new(true, where, "\"preview\" must be an object with \"image\" and/or \"demo\""));
                    else
                    {
                        if (preview["demo"] is { } demo && Text(demo) is null) issues.Add(new(true, where, "preview \"demo\" must be a string or an array of lines"));
                        if (preview["frames"] is { } frames && (frames is not JsonArray fr || fr.Any(f => f is not JsonObject fo || Text(fo["cmd"]) is null || (fo["out"] is { } o && Text(o) is null))))
                            issues.Add(new(true, where, "preview \"frames\" must be [{ \"cmd\": \"...\", \"out\": [\"lines\"] }]"));
                        if (preview["image"] is { } img)
                        {
                            var rel = (string?)(img as JsonValue);
                            if (CleanPath(rel, out var ierr) is not { } clean) issues.Add(new(true, where, "preview image " + ierr));
                            else if (!ImageTypes.ContainsKey(Path.GetExtension(clean).ToLowerInvariant())) issues.Add(new(true, where, "preview image must be .png, .jpg, .gif, .webp or .svg"));
                            else if (tracksDir is not null && !File.Exists(Path.Combine(tracksDir, tid, clean))) issues.Add(new(true, where, $"preview image {clean} is not in tracks/{tid}/"));
                        }
                    }
                }
            }

            var hasDreams = declared.Values.Any(a => (bool?)a["dream"] == true);
            var used = new HashSet<string>();
            var seen = new Dictionary<(string Artifact, string File), (string Lesson, int Step, string Mode)>();
            foreach (var (key, m) in MarkersOf(track))
            {
                var step = (int?)m["step"] ?? 0;
                var where = $"{key} step {step + 1} (build)";
                var target = (string?)m["artifact"];
                var mode = (string?)m["mode"] ?? "replace";
                var chosen = ChosenDream(target);
                if (chosen ? !hasDreams : !declared.ContainsKey(target!))
                {
                    issues.Add(new(true, where, chosen
                        ? $"builds the chosen dream, but {tid}/track.json declares no \"dreams\""
                        : $"artifact \"{target}\" is not declared in {tid}/track.json \"artifacts\" or \"dreams\""));
                    continue;
                }
                if (!Modes.Contains(mode)) issues.Add(new(true, where, "\"mode\" must be replace or append"));
                foreach (var v in (m["variants"] as JsonObject ?? []).Select(p => p.Key).Where(d => !declared.ContainsKey(d)))
                    issues.Add(new(true, where, $"variant \"{v}\" is not a dream of {tid}"));
                foreach (var art in declared.Values)
                {
                    if (MarkerFile(m, art) is not { } raw) continue;
                    var aid = (string)art["id"]!;
                    used.Add(aid);
                    if (CleanPath(raw, out var err) is not { } file) { issues.Add(new(true, where, "file " + err)); continue; }
                    // Later lessons replacing a file is how a piece grows. Two pieces that would silently undo each other are not.
                    if (seen.TryGetValue((aid, file), out var prev))
                    {
                        if (prev.Lesson == key && mode == "replace" && prev.Mode == "replace")
                            issues.Add(new(false, where, $"replaces {file} in {aid}, which step {prev.Step + 1} of the same lesson also replaces; use another file or mode append"));
                        else if (mode == "replace" && prev.Mode == "append")
                            issues.Add(new(false, where, $"replaces {file} in {aid}, wiping the pieces earlier steps appended to it"));
                    }
                    seen[(aid, file)] = (key, step, mode);
                }
            }
            foreach (var id in declared.Keys.Where(id => !used.Contains(id)))
                issues.Add(new(false, $"{tid} {((bool?)declared[id]["dream"] == true ? "dream" : "artifact")} {id}", "no code step builds a piece of it yet"));
        }
        return issues;
    }

    static readonly Dictionary<string, string> ImageTypes = new()
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".gif"] = "image/gif",
        [".webp"] = "image/webp", [".svg"] = "image/svg+xml",
    };

    /// <summary>A preview image from a track folder, or null. Only image types, only inside tracks/{track}/.</summary>
    public static (string Path, string Type)? TrackImage(string tracksDir, string track, string? rel)
    {
        if (!Content.SafeSegment(track) || CleanPath(rel, out _) is not { } clean) return null;
        if (!ImageTypes.TryGetValue(Path.GetExtension(clean).ToLowerInvariant(), out var type)) return null;
        var dir = Path.Combine(tracksDir, track);
        if (CodeSpaces.SafePath(dir, clean, out _) is not { } full || !File.Exists(full)) return null;
        return (full, type);
    }

    // ================================================================ endpoints

    public static void Map(WebApplication app, Content content, string spacesRoot)
    {
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        (JsonObject? Artifact, SortedDictionary<string, string>? Files, string? Error) Resolve(string track, string id, ExportRequest req)
        {
            if (!Content.SafeSegment(track)) return (null, null, "No such topic.");
            var t = content.Tracks().OfType<JsonObject>().FirstOrDefault(x => (string?)x["id"] == track);
            var artifact = t is null ? null : Artifacts(t).FirstOrDefault(a => (string?)a["id"] == id);
            if (t is null || artifact is null || !CodeSpaces.ValidSpaceName(id)) return (null, null, "No such build.");
            var allowed = MarkersOf(t).Select(x => CleanPath(MarkerFile(x.Marker, artifact), out _)).OfType<string>().ToHashSet();
            var pieces = (req.Pieces ?? []).Where(p => (p.Code?.Length ?? 0) <= MaxFileChars).Take(MaxFiles).ToList();
            var problems = new List<string>();
            var files = Builds.Assemble(artifact, pieces, problems, allowed, Stubs(t, artifact));
            return (artifact, files, null);
        }

        app.MapPost("/api/builds/{track}/{artifact}/space", (string track, string artifact, ExportRequest req) =>
        {
            var (art, files, error) = Resolve(track, artifact, req);
            if (error is not null) return Results.Json(new { error }, json);
            var key = $"{track}/{artifact}";
            if (SpaceName(spacesRoot, artifact, key) is not { } name) return Results.Json(new { error = "Every space name for this build is taken." }, json);
            var r = Export(Path.Combine(spacesRoot, name), files!, key, (string?)art!["kind"]);
            return Results.Json(new { ok = true, space = name, written = r.Written, unchanged = r.Unchanged, kept = r.Kept }, json);
        });

        // Preview images for the dream reveal live in the track folder: tracks/{track}/assets/...
        app.MapGet("/api/track-asset/{track}/{**path}", (HttpContext ctx, string track, string path) =>
        {
            if (TrackImage(content.TracksDir, track, path) is not { } img) return Results.NotFound();
            ctx.Response.Headers.ContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'";   // an SVG must not run script
            return Results.File(img.Path, img.Type);
        });

        app.MapPost("/api/builds/{track}/{artifact}/zip", (string track, string artifact, ExportRequest req) =>
        {
            var (_, files, error) = Resolve(track, artifact, req);
            if (error is not null) return Results.Json(new { error }, json, statusCode: 404);
            return Results.File(Zip(files!, artifact), "application/zip", artifact + ".zip");
        });
    }
}
