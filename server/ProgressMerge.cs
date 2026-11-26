using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// Merging two copies of a learner's progress (two machines, an imported file, a sync folder). Pure functions over JSON,
/// so they can be tested without a server. The rules are chosen so that merging is commutative, idempotent and
/// associative: every machine that has seen the same files ends up with the same record, whatever the order.
///
///   lessons        union; stars, bestXp and runs take the max, completedAt the earliest
///   days           union; XP of a day is the max of the two (a day studied on both machines keeps the bigger one)
///   xp             max(a.xp, b.xp, sum of the merged days)
///   streak         not stored: it is computed from the union of active days (and streak freezes)
///   achievements   union, earliest date
///   review         union per (lesson, step); the higher Leitner box wins; a re-proof already passed since it was due goes
///   pacing         proven gates: earliest provenAt; cold rebuilds: latest pass, best time; "rusty" only if no later pass
///   builds         per piece the version from the furthest lesson, then the newest; markers passed: union, earliest
///   labs           challenges solved: union (earliest date) or max count; stars: max; the rest of a lab: newest edit
///   drafts, projects, dreams, notes   newest edit wins (per entry, also deletions), using _stamps
///   settings, workbench, learningPath, rewards' theme and title       newest edit wins, using _stamps
///   profile        the one with the newest updatedAt
///   quests, challenge  the newer day wins; the same day merges (progress max, done union)
///   anything else  objects merge key by key, numbers take the max, booleans OR, arrays union, strings the larger
///
/// _stamps = { "drafts": { key: isoTime }, ..., "$": { "settings": isoTime, ... } } is written by the server when it sees
/// an entry change (ProgressSync.Stamp). An entry missing on one side with a newer stamp there is a deletion.
/// </summary>
public static class ProgressMerge
{
    public const string Format = "code-dojo-progress";
    public const int Version = 1;
    public const string StampsKey = "_stamps";

    /// <summary>Maps where each entry is replaced wholesale and the newest edit wins.</summary>
    public static readonly string[] StampedMaps = ["drafts", "projects", "dreams", "notes"];
    /// <summary>Top-level values replaced wholesale, newest edit wins (stamped under "$").</summary>
    public static readonly string[] StampedWhole = ["settings", "workbench", "learningPath", "rewards"];

    // ------------------------------------------------------------ bundles (the file that travels between machines)

    /// <summary>
    /// The versioned file: { format, version, exportedAt, machine, progress, profile, netlabs }.
    /// netlabs = { labId: { taskId: date } }, the live-lab tasks done (kept by the server in netlabs.json).
    /// </summary>
    public static JsonObject MakeBundle(JsonObject? progress, JsonNode? profile, JsonObject? netlabs, string machine, DateTimeOffset now) => new()
    {
        ["format"] = Format,
        ["version"] = Version,
        ["exportedAt"] = now.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture),
        ["machine"] = machine,
        ["progress"] = progress?.DeepClone() ?? new JsonObject(),
        ["profile"] = profile?.DeepClone(),
        ["netlabs"] = netlabs?.DeepClone() ?? new JsonObject(),
    };

    /// <summary>Accepts a bundle, or a bare progress.json (an older backup). Returns an error message for anything else.</summary>
    public static (JsonObject? Bundle, string? Error) ReadBundle(JsonNode? node)
    {
        if (node is not JsonObject o) return (null, "This is not a code-dojo progress file (it is not a JSON object).");
        // JsonNode reads objects lazily and only fails on a duplicate key when it is enumerated (a line-based git merge
        // can produce one). Touch everything now so a damaged file is refused here, not halfway through a merge.
        try { Canon(o); }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or JsonException)
        { return (null, "This progress file is damaged (" + e.Message.Split('\n')[0] + ")."); }
        if ((string?)Str(o["format"]) is { } fmt)
        {
            if (fmt != Format) return (null, $"This file is a \"{fmt}\" file, not a code-dojo progress file.");
            var v = Num(o["version"]) ?? 0;
            if (v > Version) return (null, $"This file was written by a newer code-dojo (format version {v}); update this copy first.");
            if (o["progress"] is not (JsonObject or null)) return (null, "The file's \"progress\" is not an object.");
            return (o, null);
        }
        if (o.ContainsKey("lessons") || o.ContainsKey("xp") || o.ContainsKey("days"))
            return (new JsonObject { ["format"] = Format, ["version"] = Version, ["progress"] = o.DeepClone(), ["netlabs"] = new JsonObject() }, null);
        return (null, "This is not a code-dojo progress file (no \"format\", no lessons).");
    }

    /// <summary>The merged bundle without machine/exportedAt (the writer adds those).</summary>
    public static JsonObject MergeBundles(JsonObject? a, JsonObject? b) => new()
    {
        ["format"] = Format,
        ["version"] = Version,
        ["progress"] = MergeProgress(a?["progress"] as JsonObject, b?["progress"] as JsonObject),
        ["profile"] = MergeProfile(a?["profile"], b?["profile"]),
        ["netlabs"] = MapOf(a?["netlabs"], b?["netlabs"], (p, q) => MapOf(p, q, MinStr)) ?? new JsonObject(),
    };

    /// <summary>The part of a bundle that is learner data (what merging is about), canonical, for "did anything change?".</summary>
    public static string Content(JsonObject? bundle) =>
        Canon(new JsonObject
        {
            ["progress"] = bundle?["progress"]?.DeepClone(),
            ["profile"] = bundle?["profile"]?.DeepClone(),
            ["netlabs"] = bundle?["netlabs"]?.DeepClone() ?? new JsonObject(),
        });

    // ------------------------------------------------------------ progress (.state/progress.json)

    public static JsonObject MergeProgress(JsonObject? a, JsonObject? b)
    {
        a ??= []; b ??= [];
        var sa = a[StampsKey] as JsonObject;
        var sb = b[StampsKey] as JsonObject;
        var result = new JsonObject();
        var keys = a.Select(p => p.Key).Union(b.Select(p => p.Key)).Where(k => k is not ("xp" or "review")).Order(StringComparer.Ordinal);
        foreach (var key in keys)
        {
            var x = a[key];
            var y = b[key];
            result[key] = key switch
            {
                "lessons" => MapOf(x, y, MergeLesson),
                "days" => MapOf(x, y, MaxNum),
                "achievements" => MapOf(x, y, MinStr),
                "pacing" => MergePacing(x, y),
                "builds" => MapOf(x, y, MergeBuild),
                "labs" => MapOfKeyed(x, y, (id, p, q) => MergeLab(id, p, q, sa, sb)),
                "profile" => MergeProfile(x, y),
                "quests" or "challenge" => ByDay(x, y),
                "accuracy" => MapOf(x, y, MergeAccuracy),
                "rewards" => MergeRewards(x, y, sa, sb),
                _ when StampedMaps.Contains(key) => StampedMap(key, x, y, sa, sb),
                _ when StampedWhole.Contains(key) => Pick(x, y, StampOf(sa, "$", key), StampOf(sb, "$", key)),
                _ => Generic(x, y),
            };
        }
        if (a.ContainsKey("review") || b.ContainsKey("review"))
            result["review"] = MergeReview(a["review"], b["review"], result["pacing"]?["cold"] as JsonObject);
        var daysTotal = (result["days"] as JsonObject)?.Sum(p => Num(p.Value) ?? 0) ?? 0;
        if (a.ContainsKey("xp") || b.ContainsKey("xp") || daysTotal > 0)
        {
            var xp = Math.Max(Math.Max(Num(a["xp"]) ?? 0, Num(b["xp"]) ?? 0), daysTotal);
            result["xp"] = xp == Math.Floor(xp) ? JsonValue.Create((long)xp) : JsonValue.Create(xp);
        }
        return result;
    }

    static JsonNode? MergeLesson(JsonNode? p, JsonNode? q) => Obj(p, q, (k, x, y) => k == "completedAt" ? MinStr(x, y) : null);

    static JsonNode? MergeAccuracy(JsonNode? p, JsonNode? q)
    {
        var (tp, tq) = (Num(p?["total"]) ?? 0, Num(q?["total"]) ?? 0);
        if (tp != tq) return (tp > tq ? p : q)?.DeepClone();
        var (rp, rq) = (Num(p?["right"]) ?? 0, Num(q?["right"]) ?? 0);
        if (rp != rq) return (rp > rq ? p : q)?.DeepClone();
        return CanonMax(p, q);
    }

    static JsonNode? MergePacing(JsonNode? x, JsonNode? y)
    {
        if (x is not JsonObject || y is not JsonObject) return Generic(x, y);
        var cold = MapOf(x["cold"], y["cold"], (p, q) => Obj(p, q, (k, u, v) => k switch
        {
            "ms" => MinNum(u, v),
            _ => null,
        })) as JsonObject;
        var modules = MapOf(x["modules"], y["modules"], (p, q) => Obj(p, q, (k, u, v) => k == "provenAt" ? MinStr(u, v) : null)) as JsonObject;
        // Rusty (a re-proof failed) unless a cold rebuild of the module passed after the latest failure. Worked out for every
        // module from both sides and the merged cold records; only rusty sides' rustyAt counts, and a module that is not
        // rusty keeps no rustyAt. That keeps the rule commutative, idempotent and associative.
        foreach (var (mk, node) in modules?.ToList() ?? [])
        {
            if (node is not JsonObject merged) continue;
            var sides = new[] { x["modules"]?[mk], y["modules"]?[mk] }.OfType<JsonObject>().ToList();
            var rustyAt = sides.Where(o => Truthy(o["rusty"])).Select(o => Str(o["rustyAt"]) ?? "").Max(StringComparer.Ordinal);
            var latest = cold?.Where(c => c.Key.StartsWith(mk + "/", StringComparison.Ordinal)).Select(c => Str(c.Value?["at"]))
                .Where(s => s is not null).Max(StringComparer.Ordinal);
            var rusty = rustyAt is not null && !(latest is not null && rustyAt.Length > 0 && string.CompareOrdinal(latest, rustyAt) > 0);
            if (sides.Any(o => o.ContainsKey("rusty"))) merged["rusty"] = rusty;
            if (rusty && rustyAt!.Length > 0) merged["rustyAt"] = rustyAt; else merged.Remove("rustyAt");
        }
        var result = Obj(x, y, (k, u, v) => k switch { "cold" => cold, "modules" => modules, _ => null }) as JsonObject;
        return result;
    }

    static JsonNode? MergeBuild(JsonNode? p, JsonNode? q) => Obj(p, q, (k, u, v) => k switch
    {
        "pieces" => MapOf(u, v, MergePiece),
        "done" => MapOf(u, v, MinStr),
        "revealed" => MinStr(u, v),
        _ => null,
    });

    /// <summary>A replace piece keeps the version from the furthest lesson (as builds.js does), then the newest.</summary>
    static JsonNode? MergePiece(JsonNode? p, JsonNode? q)
    {
        if (p is not JsonObject po || q is not JsonObject qo) return Generic(p, q);
        var c = string.CompareOrdinal(Str(po["lessonKey"]) ?? "", Str(qo["lessonKey"]) ?? "");
        if (c == 0) c = string.CompareOrdinal(Str(po["at"]) ?? "", Str(qo["at"]) ?? "");
        var win = (c > 0 ? po : c < 0 ? qo : CanonMax(po, qo))!.DeepClone() as JsonObject;
        if (Str(po["lessonKey"]) == Str(qo["lessonKey"]) && Canon(po["stepIdx"]) == Canon(qo["stepIdx"]) && (Truthy(po["cold"]) || Truthy(qo["cold"])))
            win!["cold"] = true;
        return win;
    }

    static JsonNode? MergeLab(string id, JsonNode? p, JsonNode? q, JsonObject? sa, JsonObject? sb)
    {
        if (p is not JsonObject || q is not JsonObject) return Generic(p, q);
        var (ta, tb) = (StampOf(sa, "labs", id), StampOf(sb, "labs", id));
        return Obj(p, q, (k, u, v) => k switch
        {
            "solved" when u is JsonObject && v is JsonObject => MapOf(u, v, MinStr),
            "solved" or "best" => Generic(u, v),
            "stars" => MapOf(u, v, MaxNum),
            _ => Pick(u, v, ta, tb) ?? Absent,
        });
    }

    static JsonNode? MergeRewards(JsonNode? x, JsonNode? y, JsonObject? sa, JsonObject? sb)
    {
        if (x is not JsonObject || y is not JsonObject) return Generic(x, y);
        var (ta, tb) = (StampOf(sa, "$", "rewards"), StampOf(sb, "$", "rewards"));
        return Obj(x, y, (k, u, v) => k switch
        {
            "titles" => MapOf(u, v, MinStr),
            "levelSeen" => MaxNum(u, v),
            _ => Pick(u, v, ta, tb) ?? Absent,
        });
    }

    /// <summary>The welcome profile: the newer answers win.</summary>
    public static JsonNode? MergeProfile(JsonNode? x, JsonNode? y)
    {
        if (x is not JsonObject) return y?.DeepClone() ?? x?.DeepClone();
        if (y is not JsonObject) return x.DeepClone();
        var c = string.CompareOrdinal(Str(x["updatedAt"]) ?? Str(x["createdAt"]) ?? "", Str(y["updatedAt"]) ?? Str(y["createdAt"]) ?? "");
        return c > 0 ? x.DeepClone() : c < 0 ? y.DeepClone() : CanonMax(x, y);
    }

    /// <summary>Daily things (quests, the daily challenge): the newer day wins; the same day merges.</summary>
    static JsonNode? ByDay(JsonNode? x, JsonNode? y)
    {
        if (x is not JsonObject || y is not JsonObject) return Generic(x, y);
        var c = string.CompareOrdinal(Str(x["day"]) ?? "", Str(y["day"]) ?? "");
        return c > 0 ? x.DeepClone() : c < 0 ? y.DeepClone() : Generic(x, y);
    }

    /// <summary>Review queue: one entry per (lesson, step) for Leitner items, per (lesson, step, due) for re-proofs.</summary>
    static JsonArray MergeReview(JsonNode? x, JsonNode? y, JsonObject? cold)
    {
        var best = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var item in (x as JsonArray ?? []).Concat(y as JsonArray ?? []).OfType<JsonObject>())
        {
            var reproof = Str(item["kind"]) == "reproof";
            var id = reproof ? $"r|{Str(item["key"])}|{Canon(item["idx"])}|{Str(item["due"])}" : $"l|{Str(item["key"])}|{Canon(item["idx"])}|{Str(item["kind"])}";
            if (!best.TryGetValue(id, out var have)) { best[id] = item; continue; }
            var c = (Num(item["box"]) ?? 0).CompareTo(Num(have["box"]) ?? 0);
            if (c == 0) c = string.CompareOrdinal(Str(item["due"]) ?? "", Str(have["due"]) ?? "");
            if (c == 0) c = string.CompareOrdinal(Canon(item), Canon(have));
            if (c > 0) best[id] = item;
        }
        var list = best.OrderBy(p => Str(p.Value["due"]) ?? "", StringComparer.Ordinal).ThenBy(p => p.Key, StringComparer.Ordinal)
            .Select(p => p.Value)
            // A re-proof whose cold step was passed on or after its due day has been answered (on some machine).
            .Where(r => !(Str(r["kind"]) == "reproof" && Str(cold?[$"{Str(r["key"])}#{Canon(r["idx"])}"]?["at"]) is { } at && string.CompareOrdinal(at, Str(r["due"]) ?? "") >= 0));
        return new JsonArray(list.Select(r => r.DeepClone()).ToArray());
    }

    /// <summary>Newest edit wins per entry, deletions included (an entry missing on the side with the newer stamp).</summary>
    static JsonNode? StampedMap(string section, JsonNode? x, JsonNode? y, JsonObject? sa, JsonObject? sb)
    {
        if (x is not (JsonObject or null) || y is not (JsonObject or null)) return Generic(x, y);
        if (x is null && y is null) return null;
        var xo = x as JsonObject; var yo = y as JsonObject;
        var keys = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var o in new[] { xo, yo, sa?[section] as JsonObject, sb?[section] as JsonObject })
            if (o is not null) foreach (var p in o) keys.Add(p.Key);
        var result = new JsonObject();
        foreach (var k in keys)
            if (Pick(xo?[k], yo?[k], StampOf(sa, section, k), StampOf(sb, section, k)) is { } v) result[k] = v;
        return result;
    }

    // ------------------------------------------------------------ streak and the preview ("adds 34 lessons ...")

    static bool ActiveOn(JsonObject? p, string day) => (Num(p?["days"]?[day]) ?? 0) > 0 || Truthy(p?["habit"]?["frozen"]?[day]);

    /// <summary>Consecutive active days ending today (or yesterday), the same rule as game.js streak().</summary>
    public static int Streak(JsonObject? progress, DateOnly today)
    {
        static string Key(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var d = today;
        if (!ActiveOn(progress, Key(d))) d = d.AddDays(-1);
        var n = 0;
        while (ActiveOn(progress, Key(d)) && n < 100_000) { n++; d = d.AddDays(-1); }
        return n;
    }

    /// <summary>What merging <paramref name="incoming"/> into <paramref name="local"/> would change, in numbers and a sentence.</summary>
    public static JsonObject Summarize(JsonObject local, JsonObject merged, DateOnly today)
    {
        var lp = local["progress"] as JsonObject ?? [];
        var mp = merged["progress"] as JsonObject ?? [];
        int Count(JsonObject? o) => o?.Count ?? 0;
        var lessonsAdded = Count(mp["lessons"] as JsonObject) - Count(lp["lessons"] as JsonObject);
        var starsRaised = (mp["lessons"] as JsonObject ?? []).Count(p => lp["lessons"]?[p.Key] is { } before && (Num(p.Value?["stars"]) ?? 0) > (Num(before["stars"]) ?? 0));
        var piecesOf = (JsonObject p) => (p["builds"] as JsonObject ?? []).ToDictionary(b => b.Key, b => Count(b.Value?["done"] as JsonObject));
        var (lb, mb) = (piecesOf(lp), piecesOf(mp));
        var buildsAdded = mb.Count(b => b.Value > 0 && (!lb.TryGetValue(b.Key, out var n) || n == 0));
        var piecesAdded = mb.Sum(b => b.Value) - lb.Sum(b => b.Value);
        var coldAdded = Count(mp["pacing"]?["cold"] as JsonObject) - Count(lp["pacing"]?["cold"] as JsonObject);
        var gatesOf = (JsonObject p) => (p["pacing"]?["modules"] as JsonObject ?? []).Count(m => Str(m.Value?["provenAt"]) is not null);
        var daysOf = (JsonObject p) => (p["days"] as JsonObject ?? []).Count(d => (Num(d.Value) ?? 0) > 0);
        var labsOf = (JsonObject p) => (p["labs"] as JsonObject ?? []).Sum(l => l.Value?["solved"] switch { JsonObject s => s.Count, JsonValue v => (int)(Num(v) ?? 0), _ => 0 });
        var tasksOf = (JsonObject b) => (b["netlabs"] as JsonObject ?? []).Sum(l => Count(l.Value as JsonObject));
        var draftsChanged = DiffCount(lp["drafts"] as JsonObject, mp["drafts"] as JsonObject);
        var (sl, sm) = (Streak(lp, today), Streak(mp, today));
        var (xl, xm) = ((long)(Num(lp["xp"]) ?? 0), (long)(Num(mp["xp"]) ?? 0));
        var s = new JsonObject
        {
            ["changed"] = Content(local) != Content(merged),
            ["lessonsAdded"] = lessonsAdded,
            ["starsRaised"] = starsRaised,
            ["buildsAdded"] = buildsAdded,
            ["piecesAdded"] = piecesAdded,
            ["coldAdded"] = coldAdded,
            ["gatesAdded"] = gatesOf(mp) - gatesOf(lp),
            ["daysAdded"] = daysOf(mp) - daysOf(lp),
            ["achievementsAdded"] = Count(mp["achievements"] as JsonObject) - Count(lp["achievements"] as JsonObject),
            ["labChallengesAdded"] = labsOf(mp) - labsOf(lp),
            ["labTasksAdded"] = tasksOf(merged) - tasksOf(local),
            ["draftsChanged"] = draftsChanged,
            ["profileChanged"] = Canon(local["profile"]) != Canon(merged["profile"]),
            ["streakBefore"] = sl,
            ["streakAfter"] = sm,
            ["xpBefore"] = xl,
            ["xpAfter"] = xm,
            ["lessonsBefore"] = Count(lp["lessons"] as JsonObject),
            ["lessonsAfter"] = Count(mp["lessons"] as JsonObject),
        };
        s["sentence"] = Sentence(s);
        return s;
    }

    static int DiffCount(JsonObject? a, JsonObject? b)
    {
        var keys = (a?.Select(p => p.Key) ?? []).Union(b?.Select(p => p.Key) ?? []);
        return keys.Count(k => Canon(a?[k]) != Canon(b?[k]));
    }

    static string Sentence(JsonObject s)
    {
        if (!(bool)s["changed"]!) return "Nothing new: this machine already has everything in that file.";
        string N(string key, string one, string many) { var n = (int)s[key]!; return n > 0 ? $"{n} {(n == 1 ? one : many)}" : ""; }
        var parts = new[]
        {
            N("lessonsAdded", "lesson", "lessons"), N("starsRaised", "better star score", "better star scores"),
            N("buildsAdded", "build", "builds"), N("piecesAdded", "build piece", "build pieces"),
            N("coldAdded", "cold rebuild", "cold rebuilds"), N("labChallengesAdded", "lab challenge", "lab challenges"),
            N("labTasksAdded", "live-lab task", "live-lab tasks"), N("achievementsAdded", "achievement", "achievements"),
            N("draftsChanged", "newer draft", "newer drafts"), N("daysAdded", "active day", "active days"),
        }.Where(p => p.Length > 0).ToList();
        var head = parts.Count > 0 ? "Adds " + string.Join(", ", parts) : "Updates settings and records";
        var (b, a) = ((int)s["streakBefore"]!, (int)s["streakAfter"]!);
        var streak = a != b ? $"; your streak becomes {a} day{(a == 1 ? "" : "s")} (was {b})" : $"; your streak stays {a} day{(a == 1 ? "" : "s")}";
        return head + streak + ".";
    }

    // ------------------------------------------------------------ stamps

    /// <summary>
    /// Marks the entries of stamped sections that differ between <paramref name="before"/> and <paramref name="after"/> as
    /// edited at <paramref name="now"/>, on <paramref name="after"/>. Stamps already known on either side are kept (max).
    /// </summary>
    public static void Stamp(JsonObject? before, JsonObject after, string now)
    {
        var stamps = Generic(before?[StampsKey], after[StampsKey]) as JsonObject ?? new JsonObject();
        JsonObject Section(string name) => stamps[name] as JsonObject ?? (JsonObject)(stamps[name] = new JsonObject());
        if (before is not null)
        {
            foreach (var section in StampedMaps.Append("labs"))
            {
                var (b, a) = (before[section] as JsonObject, after[section] as JsonObject);
                var keys = (b?.Select(p => p.Key) ?? []).Union(a?.Select(p => p.Key) ?? []).ToList();
                foreach (var k in keys.Where(k => Canon(b?[k]) != Canon(a?[k]))) Section(section)[k] = now;
            }
            foreach (var whole in StampedWhole)
                if (Canon(before[whole]) != Canon(after[whole])) Section("$")[whole] = now;
        }
        if (stamps.Count > 0) after[StampsKey] = stamps;
    }

    static string StampOf(JsonObject? stamps, string section, string key) => Str(stamps?[section]?[key]) ?? "";

    // ------------------------------------------------------------ building blocks

    /// <summary>Choose one whole value: the newer stamp wins; equal stamps fall back to a fixed order (absent lowest).</summary>
    static JsonNode? Pick(JsonNode? x, JsonNode? y, string tx, string ty)
    {
        if (Canon(x) == Canon(y)) return x?.DeepClone() ?? y?.DeepClone();
        var c = string.CompareOrdinal(tx, ty);
        if (c != 0) return (c > 0 ? x : y)?.DeepClone();
        return CanonMax(x, y);
    }

    static JsonNode? CanonMax(JsonNode? x, JsonNode? y)
    {
        if (x is null) return y?.DeepClone();
        if (y is null) return x.DeepClone();
        return (string.CompareOrdinal(Canon(x), Canon(y)) >= 0 ? x : y).DeepClone();
    }

    /// <summary>Merge two maps entry by entry; an entry on one side only is copied.</summary>
    static JsonNode? MapOf(JsonNode? x, JsonNode? y, Func<JsonNode?, JsonNode?, JsonNode?> merge) =>
        MapOfKeyed(x, y, (_, p, q) => merge(p, q));

    static JsonNode? MapOfKeyed(JsonNode? x, JsonNode? y, Func<string, JsonNode?, JsonNode?, JsonNode?> merge)
    {
        if (x is null && y is null) return null;
        if (x is not (JsonObject or null) || y is not (JsonObject or null)) return Generic(x, y);
        var xo = x as JsonObject ?? []; var yo = y as JsonObject ?? [];
        var result = new JsonObject();
        foreach (var k in xo.Select(p => p.Key).Union(yo.Select(p => p.Key)).Order(StringComparer.Ordinal))
        {
            var (p, q) = (xo[k], yo[k]);
            result[k] = !xo.ContainsKey(k) ? q?.DeepClone() : !yo.ContainsKey(k) ? p?.DeepClone() : merge(k, p, q);
        }
        return result;
    }

    /// <summary>Returned by a special rule to mean "null", since null means "use the generic rule". Never stored.</summary>
    static readonly JsonObject Absent = [];

    /// <summary>Merge two objects key by key; <paramref name="special"/> returns non-null to override the generic rule.</summary>
    static JsonNode? Obj(JsonNode? x, JsonNode? y, Func<string, JsonNode?, JsonNode?, JsonNode?>? special)
    {
        if (x is not JsonObject xo || y is not JsonObject yo) return Generic(x, y);
        var result = new JsonObject();
        foreach (var k in xo.Select(p => p.Key).Union(yo.Select(p => p.Key)).Order(StringComparer.Ordinal))
        {
            var (p, q) = (xo[k], yo[k]);
            if (!xo.ContainsKey(k)) { result[k] = q?.DeepClone(); continue; }
            if (!yo.ContainsKey(k)) { result[k] = p?.DeepClone(); continue; }
            var v = special?.Invoke(k, p, q);
            result[k] = ReferenceEquals(v, Absent) ? null : v ?? Generic(p, q);
        }
        return result;
    }

    /// <summary>The fallback for anything without its own rule. Commutative and idempotent.</summary>
    public static JsonNode? Generic(JsonNode? x, JsonNode? y)
    {
        if (x is null) return y?.DeepClone();
        if (y is null) return x.DeepClone();
        if (Canon(x) == Canon(y)) return x.DeepClone();
        if (x is JsonObject && y is JsonObject) return Obj(x, y, null);
        if (x is JsonArray xa && y is JsonArray ya)
        {
            var seen = new SortedDictionary<string, JsonNode?>(StringComparer.Ordinal);
            foreach (var item in xa.Concat(ya)) seen.TryAdd(Canon(item), item);
            return new JsonArray(seen.Values.Select(v => v?.DeepClone()).ToArray());
        }
        if (x is JsonValue && y is JsonValue)
        {
            var (kx, ky) = (x.GetValueKind(), y.GetValueKind());
            if (kx == JsonValueKind.Number && ky == JsonValueKind.Number) return MaxNum(x, y);
            if (kx == JsonValueKind.String && ky == JsonValueKind.String) return string.CompareOrdinal((string)x!, (string)y!) >= 0 ? x.DeepClone() : y.DeepClone();
            if ((kx is JsonValueKind.True or JsonValueKind.False) && (ky is JsonValueKind.True or JsonValueKind.False)) return JsonValue.Create(Truthy(x) || Truthy(y));
            if (kx == JsonValueKind.Null) return y.DeepClone();
            if (ky == JsonValueKind.Null) return x.DeepClone();
        }
        return CanonMax(x, y);
    }

    static JsonNode? MaxNum(JsonNode? x, JsonNode? y)
    {
        var (a, b) = (Num(x), Num(y));
        if (a is null) return y?.DeepClone() ?? x?.DeepClone();
        if (b is null) return x?.DeepClone();
        return (a > b ? x : a < b ? y : CanonMax(x, y))?.DeepClone();
    }

    static JsonNode? MinNum(JsonNode? x, JsonNode? y)
    {
        var (a, b) = (Num(x), Num(y));
        if (a is null) return y?.DeepClone() ?? x?.DeepClone();
        if (b is null) return x?.DeepClone();
        return (a < b ? x : a > b ? y : CanonMax(x, y))?.DeepClone();
    }

    /// <summary>The earlier of two date strings; a missing one loses.</summary>
    static JsonNode? MinStr(JsonNode? x, JsonNode? y)
    {
        var (a, b) = (Str(x), Str(y));
        if (a is null) return b is not null ? y!.DeepClone() : Generic(x, y);
        if (b is null) return x!.DeepClone();
        return (string.CompareOrdinal(a, b) <= 0 ? x : y)!.DeepClone();
    }

    static string? Str(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? (string?)v : null;

    // Parsed and built values hold different CLR types (JsonElement, int, long, double): read them all through their JSON text.
    static double? Num(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.Number
        ? double.Parse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture) : null;

    static bool Truthy(JsonNode? n) => n is JsonValue v && v.GetValueKind() switch
    {
        JsonValueKind.True => true,
        JsonValueKind.Number => Num(v) != 0,
        JsonValueKind.String => ((string?)v)?.Length > 0,
        _ => false,
    } || n is JsonObject or JsonArray;

    /// <summary>Canonical JSON: object keys sorted (ordinal), no whitespace. Equal values give equal strings.</summary>
    public static string Canon(JsonNode? n)
    {
        var sb = new StringBuilder();
        Write(n, sb);
        return sb.ToString();
    }

    static void Write(JsonNode? n, StringBuilder sb)
    {
        switch (n)
        {
            case null: sb.Append("null"); break;
            case JsonObject o:
                sb.Append('{');
                var first = true;
                foreach (var (k, v) in o.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(JsonSerializer.Serialize(k)).Append(':');
                    Write(v, sb);
                }
                sb.Append('}');
                break;
            case JsonArray a:
                sb.Append('[');
                for (var i = 0; i < a.Count; i++) { if (i > 0) sb.Append(','); Write(a[i], sb); }
                sb.Append(']');
                break;
            default:
                if (n.GetValueKind() == JsonValueKind.Number) sb.Append(Num(n)!.Value.ToString("R", CultureInfo.InvariantCulture));
                else sb.Append(n.ToJsonString());
                break;
        }
    }
}
