using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Progress sync (ProgressMerge.cs): merge rules, and the algebra that makes two machines converge.</summary>
public sealed class ProgressMergeTests
{
    // ------------------------------------------------------------ random learner states (seeded, so failures reproduce)

    static readonly string[] Lessons = ["csharp/01-a/01-x", "csharp/01-a/02-y", "csharp/02-b/01-z", "sql/01-a/01-q", "sql/01-a/02-r"];
    static readonly string[] Days = ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"];
    static readonly string[] Stamps = ["", "2026-11-24T08:00:00.000Z", "2026-11-25T09:00:00.000Z", "2026-11-26T10:00:00.000Z"];

    static T Any<T>(Random r, T[] items) => items[r.Next(items.Length)];

    static JsonObject RandomState(Random r)
    {
        var lessons = new JsonObject();
        foreach (var k in Lessons.Where(_ => r.Next(3) > 0))
            lessons[k] = new JsonObject { ["stars"] = r.Next(1, 4), ["bestXp"] = r.Next(10, 90), ["runs"] = r.Next(1, 4), ["completedAt"] = Any(r, Days) };
        var days = new JsonObject();
        foreach (var d in Days.Where(_ => r.Next(2) > 0)) days[d] = r.Next(0, 80);
        var drafts = new JsonObject();
        var stamps = new JsonObject();
        var draftStamps = new JsonObject();
        foreach (var k in Lessons.Where(_ => r.Next(3) == 0))
        {
            if (r.Next(4) > 0) drafts[k + "#0"] = "code " + r.Next(5);
            if (Any(r, Stamps) is { Length: > 0 } t) draftStamps[k + "#0"] = t;
        }
        stamps["drafts"] = draftStamps;
        if (Any(r, Stamps) is { Length: > 0 } st) stamps["$"] = new JsonObject { ["settings"] = st };
        var cold = new JsonObject();
        foreach (var k in Lessons.Where(_ => r.Next(3) == 0))
            cold[k + "#1"] = new JsonObject { ["at"] = Any(r, Days), ["ms"] = r.Next(1000, 9000), ["inTime"] = r.Next(2) == 0 };
        var modules = new JsonObject();
        foreach (var m in new[] { "csharp/01-a", "sql/01-a" }.Where(_ => r.Next(2) == 0))
            modules[m] = new JsonObject { ["provenAt"] = Any(r, Days), ["rusty"] = r.Next(3) == 0, ["rustyAt"] = Any(r, Days) };
        var review = new JsonArray();
        foreach (var k in Lessons.Where(_ => r.Next(3) == 0))
            review.Add(r.Next(2) == 0
                ? new JsonObject { ["key"] = k, ["idx"] = 2, ["box"] = r.Next(0, 4), ["due"] = Any(r, Days) }
                : new JsonObject { ["key"] = k, ["idx"] = 1, ["box"] = 0, ["due"] = Any(r, Days), ["kind"] = "reproof", ["module"] = "m" });
        var pieces = new JsonObject();
        foreach (var f in new[] { "Core/A.cs", "Core/B.cs" }.Where(_ => r.Next(2) == 0))
            pieces[f] = new JsonObject { ["file"] = f, ["code"] = "v" + r.Next(4), ["at"] = Any(r, Days) + "T10:00:00Z", ["lessonKey"] = Any(r, Lessons), ["stepIdx"] = 0, ["cold"] = r.Next(3) == 0 };
        var done = new JsonObject();
        foreach (var k in Lessons.Where(_ => r.Next(2) == 0)) done[k + "#0"] = Any(r, Days);
        return new JsonObject
        {
            ["v"] = 1,
            ["xp"] = days.Sum(d => D(d.Value)) + r.Next(0, 50),
            ["lessons"] = lessons,
            ["days"] = days,
            ["achievements"] = r.Next(2) == 0 ? new JsonObject { ["first-lesson"] = Any(r, Days) } : new JsonObject(),
            ["review"] = review,
            ["pacing"] = new JsonObject { ["modules"] = modules, ["cold"] = cold },
            ["drafts"] = drafts,
            ["builds"] = new JsonObject { ["kit"] = new JsonObject { ["pieces"] = pieces, ["done"] = done } },
            ["labs"] = new JsonObject { ["pki"] = new JsonObject { ["solved"] = new JsonObject { ["c" + r.Next(3)] = Any(r, Days) }, ["challenge"] = "c" + r.Next(3), ["model"] = new JsonObject { ["n"] = r.Next(3) } } },
            ["stats"] = new JsonObject { ["correct"] = r.Next(100), ["bestCombo"] = r.Next(10) },
            ["settings"] = new JsonObject { ["dailyGoal"] = Any(r, new[] { 30, 60, 120 }), ["sound"] = r.Next(2) == 0 },
            ["habit"] = new JsonObject { ["freezes"] = r.Next(3), ["frozen"] = r.Next(2) == 0 ? new JsonObject { [Any(r, Days)] = true } : new JsonObject() },
            ["quests"] = new JsonObject { ["day"] = Any(r, Days), ["progress"] = new JsonObject { ["q1"] = r.Next(4) }, ["done"] = new JsonObject() },
            ["profile"] = r.Next(2) == 0 ? null : new JsonObject { ["goal"] = "job", ["updatedAt"] = Any(r, Days) },
            ["_stamps"] = stamps,
        };
    }

    static double D(JsonNode? n) => double.Parse(n!.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture);
    static string C(JsonNode? n) => ProgressMerge.Canon(n);
    static JsonObject M(JsonObject a, JsonObject b) => ProgressMerge.MergeProgress(a, b);

    // ------------------------------------------------------------ properties

    [Fact]
    public void Merge_is_commutative()
    {
        var r = new Random(1);
        for (var i = 0; i < 300; i++)
        {
            var (a, b) = (RandomState(r), RandomState(r));
            Assert.Equal(C(M(a, b)), C(M(b, a)));
        }
    }

    [Fact]
    public void Merge_is_idempotent()
    {
        var r = new Random(2);
        for (var i = 0; i < 300; i++)
        {
            var m = M(RandomState(r), RandomState(r));
            Assert.Equal(C(m), C(M(m, m)));
            // Merging the same file in again changes nothing.
            var b = RandomState(r);
            var once = M(m, b);
            Assert.Equal(C(once), C(M(once, b)));
        }
    }

    [Fact]
    public void Merge_is_associative_so_three_machines_converge_in_any_order()
    {
        var r = new Random(3);
        for (var i = 0; i < 200; i++)
        {
            var (a, b, c) = (RandomState(r), RandomState(r), RandomState(r));
            var left = M(M(a, b), c);
            Assert.Equal(C(left), C(M(a, M(b, c))));
            Assert.Equal(C(left), C(M(M(c, a), b)));
        }
    }

    [Fact]
    public void Merge_never_loses_a_finished_lesson_or_a_star()
    {
        var r = new Random(4);
        for (var i = 0; i < 300; i++)
        {
            var (a, b) = (RandomState(r), RandomState(r));
            var m = M(a, b);
            foreach (var side in new[] { a, b })
            foreach (var (k, rec) in (JsonObject)side["lessons"]!)
            {
                Assert.NotNull(m["lessons"]![k]);
                Assert.True(D(m["lessons"]![k]!["stars"]) >= D(rec!["stars"]));
                Assert.True(string.CompareOrdinal((string)m["lessons"]![k]!["completedAt"]!, (string)rec["completedAt"]!) <= 0);
            }
            Assert.True(D(m["xp"]) >= Math.Max(D(a["xp"]), D(b["xp"])));
        }
    }

    // ------------------------------------------------------------ the rules, one at a time

    [Fact]
    public void Lessons_union_with_best_stars_and_first_completion()
    {
        var a = JsonNode.Parse("""{ "lessons": { "t/m/a": { "stars": 2, "bestXp": 40, "runs": 1, "completedAt": "2026-11-20" } } }""")!.AsObject();
        var b = JsonNode.Parse("""{ "lessons": { "t/m/a": { "stars": 3, "bestXp": 30, "runs": 2, "completedAt": "2026-11-22" }, "t/m/b": { "stars": 1, "completedAt": "2026-11-23" } } }""")!.AsObject();
        var m = M(a, b);
        Assert.Equal("""{"bestXp":40,"completedAt":"2026-11-20","runs":2,"stars":3}""", C(m["lessons"]!["t/m/a"]));
        Assert.NotNull(m["lessons"]!["t/m/b"]);
    }

    [Fact]
    public void Streak_comes_from_the_union_of_active_days()
    {
        // Home laptop studied Mon, Wed; work machine Tue, Thu. Alone each has a 1-day streak, together 4.
        var home = JsonNode.Parse("""{ "days": { "2026-11-23": 30, "2026-11-25": 20 } }""")!.AsObject();
        var work = JsonNode.Parse("""{ "days": { "2026-11-24": 40, "2026-11-26": 10 } }""")!.AsObject();
        var today = new DateOnly(2026, 11, 26);
        Assert.Equal(1, ProgressMerge.Streak(work, today));
        var m = M(home, work);
        Assert.Equal(4, ProgressMerge.Streak(m, today));
        Assert.Equal(100, D(m["xp"]));   // the sum of the merged days
    }

    [Fact]
    public void Newest_draft_wins_and_a_newer_deletion_sticks()
    {
        var a = JsonNode.Parse("""{ "drafts": { "k1": "old", "k2": "keep" }, "_stamps": { "drafts": { "k1": "2026-11-24T08:00:00Z", "k2": "2026-11-24T08:00:00Z" } } }""")!.AsObject();
        var b = JsonNode.Parse("""{ "drafts": { "k1": "new" }, "_stamps": { "drafts": { "k1": "2026-11-25T08:00:00Z", "k2": "2026-11-26T08:00:00Z" } } }""")!.AsObject();
        var m = M(a, b);
        Assert.Equal("new", (string?)m["drafts"]!["k1"]);
        Assert.Null(m["drafts"]!["k2"]);    // deleted on b after a's edit
        Assert.False(((JsonObject)m["drafts"]!).ContainsKey("k2"));
    }

    [Fact]
    public void Stamp_marks_changed_entries_and_keeps_known_stamps()
    {
        var before = JsonNode.Parse("""{ "drafts": { "a": "1", "b": "2" }, "settings": { "sound": true }, "_stamps": { "drafts": { "b": "2026-01-01T00:00:00Z" } } }""")!.AsObject();
        var after = JsonNode.Parse("""{ "drafts": { "a": "1", "b": "3", "c": "new" }, "settings": { "sound": false } }""")!.AsObject();
        ProgressMerge.Stamp(before, after, "2026-11-26T12:00:00Z");
        var s = after["_stamps"]!;
        Assert.Null(s["drafts"]!["a"]);
        Assert.Equal("2026-11-26T12:00:00Z", (string?)s["drafts"]!["b"]);
        Assert.Equal("2026-11-26T12:00:00Z", (string?)s["drafts"]!["c"]);
        Assert.Equal("2026-11-26T12:00:00Z", (string?)s["$"]!["settings"]);
    }

    [Fact]
    public void Build_pieces_keep_the_furthest_lesson_and_cold_proofs()
    {
        var a = JsonNode.Parse("""{ "builds": { "kit": { "pieces": { "A.cs": { "code": "v2", "lessonKey": "t/m/02", "stepIdx": 0, "at": "2026-11-20T00:00:00Z" } }, "done": { "t/m/01#0": "2026-11-19" } } } }""")!.AsObject();
        var b = JsonNode.Parse("""{ "builds": { "kit": { "pieces": { "A.cs": { "code": "v1", "lessonKey": "t/m/01", "stepIdx": 0, "at": "2026-11-25T00:00:00Z" } }, "done": { "t/m/01#0": "2026-11-21", "t/m/02#0": "2026-11-20" } } } }""")!.AsObject();
        var m = M(a, b);
        Assert.Equal("v2", (string?)m["builds"]!["kit"]!["pieces"]!["A.cs"]!["code"]);
        Assert.Equal("2026-11-19", (string?)m["builds"]!["kit"]!["done"]!["t/m/01#0"]);
        Assert.NotNull(m["builds"]!["kit"]!["done"]!["t/m/02#0"]);
    }

    [Fact]
    public void A_reproof_passed_on_the_other_machine_leaves_the_queue()
    {
        var a = JsonNode.Parse("""{ "review": [ { "key": "t/m/l", "idx": 1, "box": 0, "due": "2026-11-24", "kind": "reproof" } ], "pacing": { "cold": {}, "modules": {} } }""")!.AsObject();
        var b = JsonNode.Parse("""{ "review": [], "pacing": { "cold": { "t/m/l#1": { "at": "2026-11-24", "ms": 5000, "inTime": true } }, "modules": {} } }""")!.AsObject();
        Assert.Empty(M(a, b)["review"]!.AsArray());
    }

    [Fact]
    public void Bundles_merge_live_lab_tasks_and_the_newer_profile()
    {
        var a = JsonNode.Parse("""{ "format": "code-dojo-progress", "version": 1, "progress": {}, "profile": { "goal": "job", "updatedAt": "2026-11-01" }, "netlabs": { "08-tls": { "t1": "2026-11-20 10:00:00" } } }""")!.AsObject();
        var b = JsonNode.Parse("""{ "format": "code-dojo-progress", "version": 1, "progress": {}, "profile": { "goal": "hobby", "updatedAt": "2026-11-20" }, "netlabs": { "08-tls": { "t1": "2026-11-22 10:00:00", "t2": "2026-11-22 11:00:00" } } }""")!.AsObject();
        var m = ProgressMerge.MergeBundles(a, b);
        Assert.Equal("hobby", (string?)m["profile"]!["goal"]);
        Assert.Equal("2026-11-20 10:00:00", (string?)m["netlabs"]!["08-tls"]!["t1"]);
        Assert.NotNull(m["netlabs"]!["08-tls"]!["t2"]);
        Assert.Equal(ProgressMerge.Content(m), ProgressMerge.Content(ProgressMerge.MergeBundles(b, a)));
    }

    [Fact]
    public void ReadBundle_accepts_a_bare_progress_file_and_rejects_newer_formats()
    {
        Assert.NotNull(ProgressMerge.ReadBundle(JsonNode.Parse("""{ "xp": 10, "lessons": {} }""")).Bundle);
        Assert.NotNull(ProgressMerge.ReadBundle(JsonNode.Parse("""{ "format": "code-dojo-progress", "version": 99 }""")).Error);
        Assert.NotNull(ProgressMerge.ReadBundle(JsonNode.Parse("""{ "hello": 1 }""")).Error);
    }

    [Fact]
    public void A_file_with_duplicate_keys_from_a_line_merge_is_refused_not_half_merged()
    {
        // git's line merge of two progress files can leave the same lesson key twice.
        var damaged = JsonNode.Parse("""{ "format": "code-dojo-progress", "version": 1, "progress": { "lessons": { "t/m/a": { "stars": 1 }, "t/m/a": { "stars": 3 } } } }""");
        var (bundle, error) = ProgressMerge.ReadBundle(damaged);
        Assert.Null(bundle);
        Assert.Contains("damaged", error);
    }

    [Fact]
    public void Summary_counts_what_an_import_adds()
    {
        var local = JsonNode.Parse("""{ "format": "code-dojo-progress", "version": 1, "progress": { "days": { "2026-11-26": 10 }, "lessons": { "t/m/a": { "stars": 1 } } }, "netlabs": {} }""")!.AsObject();
        var other = JsonNode.Parse("""{ "format": "code-dojo-progress", "version": 1, "progress": { "days": { "2026-11-25": 10, "2026-11-24": 5 }, "lessons": { "t/m/a": { "stars": 3 }, "t/m/b": { "stars": 2 } }, "builds": { "kit": { "done": { "x#0": "2026-11-24" } } } }, "netlabs": {} }""")!.AsObject();
        var s = ProgressMerge.Summarize(local, ProgressMerge.MergeBundles(local, other), new DateOnly(2026, 11, 26));
        Assert.Equal(1, (int)s["lessonsAdded"]!);
        Assert.Equal(1, (int)s["starsRaised"]!);
        Assert.Equal(1, (int)s["buildsAdded"]!);
        Assert.Equal(3, (int)s["streakAfter"]!);
        Assert.Contains("streak becomes 3 days", (string)s["sentence"]!);
    }

    [Fact]
    public void Sync_store_merges_a_stale_page_save_instead_of_overwriting()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dojo-sync-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var store = new ProgressSync(dir, null, timers: false);
            var rev = store.Rev;
            store.Put(JsonNode.Parse("""{ "lessons": { "t/m/a": { "stars": 2 } } }""")!.AsObject(), rev);
            // Another machine's file is merged in: the revision moves on.
            store.Apply(JsonNode.Parse("""{ "format": "code-dojo-progress", "version": 1, "progress": { "lessons": { "t/m/b": { "stars": 3 } } } }""")!.AsObject(), "test");
            Assert.NotEqual(rev, store.Rev);
            // The page, still on the old revision, saves a new lesson: nothing from the other machine is lost.
            var (merged, _) = store.Put(JsonNode.Parse("""{ "lessons": { "t/m/a": { "stars": 2 }, "t/m/c": { "stars": 1 } } }""")!.AsObject(), rev);
            Assert.NotNull(merged);
            Assert.NotNull(merged!["lessons"]!["t/m/b"]);
            Assert.NotNull(merged["lessons"]!["t/m/c"]);
            Assert.Single(Directory.GetFiles(Path.Combine(dir, "backups")));
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }

    [Fact]
    public async Task Two_machines_converge_through_a_sync_folder()
    {
        var root = Path.Combine(Path.GetTempPath(), "dojo-sync2-" + Guid.NewGuid().ToString("N"));
        var folder = Path.Combine(root, "shared");
        Directory.CreateDirectory(folder);
        try
        {
            using var home = new ProgressSync(Path.Combine(root, "home"), null, timers: false);
            using var work = new ProgressSync(Path.Combine(root, "work"), null, timers: false);
            Assert.Null(home.Configure(folder, "home-laptop"));
            Assert.Null(work.Configure(folder, "work-pc"));
            home.Put(JsonNode.Parse("""{ "days": { "2026-11-24": 30 }, "lessons": { "t/m/a": { "stars": 3 } } }""")!.AsObject(), home.Rev);
            work.Put(JsonNode.Parse("""{ "days": { "2026-11-25": 20 }, "lessons": { "t/m/b": { "stars": 2 } } }""")!.AsObject(), work.Rev);
            await home.SyncNow();
            await work.SyncNow();
            await home.SyncNow();
            Assert.Equal(ProgressMerge.Content(home.Bundle()), ProgressMerge.Content(work.Bundle()));
            Assert.Equal("work-pc", (string?)home.Status()["lastFromMachine"]);
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }
}
