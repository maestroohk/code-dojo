using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// "Search everything" (Ctrl+K) and the glossary. One in-memory index over every topic, module, lesson (title,
/// summary, card headings and text, per step), senior's toolkit command, lab, lab challenge, live-lab task and
/// glossary term. Built on first use and rebuilt when any source file changes (checked at most every few seconds),
/// so the browser never downloads the lessons to search them.
///
/// Ranking: a query is split into words (stop words dropped). Each word is looked up in the index's vocabulary:
/// an exact word scores 1, a prefix 0.8 (so results appear as you type), a word containing it 0.45, and for words
/// of four letters or more a typo (one edit, two for long words) 0.5 / 0.35. That quality is multiplied by the
/// weight of the field it was found in (title 10, toolkit command 9, glossary term 10, card heading 6, summary 4,
/// prose 1, code 0.4). A document's score is the sum over query words of its best hit for each word, times a small
/// per-kind boost, plus bonuses when the whole query appears in the title. Every query word must match; when
/// nothing matches all of them, documents missing one word are shown at half score.
/// </summary>
public sealed partial class SearchIndex(string root, Content content)
{
    public TimeSpan RecheckAfter { get; init; } = TimeSpan.FromSeconds(3);

    readonly object gate = new();
    Built? built;
    string signature = "";
    DateTime checkedAt = DateTime.MinValue;

    // ------------------------------------------------------------ model

    public sealed record Seg(int Step, float Weight, string Text, bool Snippet);

    public sealed class Doc
    {
        public required string Kind { get; init; }
        public required string Title { get; init; }
        public string Sub { get; init; } = "";
        public string Href { get; init; } = "";
        public string? Key { get; init; }            // lesson key, for locks
        public string? Track { get; init; }
        public string? Lab { get; init; }            // game.state.labs key to set "challenge" in
        public string? Challenge { get; init; }
        public string? Slug { get; init; }
        public float Boost { get; init; } = 1;
        public bool StepLink { get; init; }          // lesson-like: the href gets the step of the best match
        public List<Seg> Segs { get; } = [];
    }

    public sealed record GlossaryLink(string Key, string Title, int? Step, string Track);

    public sealed class Term
    {
        public required string Slug { get; init; }
        public required string Name { get; init; }
        public List<string> Aliases { get; init; } = [];
        public required string Definition { get; init; }
        public string Topic { get; init; } = "";
        public string Source { get; init; } = "curated";   // curated | lesson
        public List<GlossaryLink> Lessons { get; } = [];
    }

    readonly record struct Posting(int Doc, int Seg, float Weight);

    sealed class Built
    {
        public List<Doc> Docs { get; } = [];
        public Dictionary<string, List<Posting>> Vocab { get; } = new(StringComparer.Ordinal);
        public string[] Words { get; set; } = [];
        public List<Term> Glossary { get; } = [];
        public Dictionary<string, string> TrackTitles { get; } = [];
    }

    // ------------------------------------------------------------ cache

    Built Current()
    {
        lock (gate)
        {
            if (built is not null && DateTime.UtcNow - checkedAt < RecheckAfter) return built;
            var sig = Signature();
            checkedAt = DateTime.UtcNow;
            if (built is null || sig != signature)
            {
                built = Build();
                signature = sig;
            }
            return built;
        }
    }

    /// <summary>Number of files, newest write and total size of every source the index reads.</summary>
    string Signature()
    {
        long newest = 0, size = 0;
        var count = 0;
        void Add(string f)
        {
            var info = new FileInfo(f);
            if (!info.Exists) return;
            count++;
            size += info.Length;
            newest = Math.Max(newest, info.LastWriteTimeUtc.Ticks);
        }
        if (Directory.Exists(content.TracksDir))
            foreach (var f in Directory.EnumerateFiles(content.TracksDir, "*.json", SearchOption.AllDirectories)) Add(f);
        var labs = Path.Combine(root, "netlabs", "labs");
        if (Directory.Exists(labs))
            foreach (var d in Directory.EnumerateDirectories(labs)) Add(Path.Combine(d, "lab.json"));
        Add(GlossaryFile);
        Add(Path.Combine(root, "ui", "app.js"));
        foreach (var (file, _, _, _) in ChallengeSources) Add(Path.Combine(root, "ui", file));
        return $"{count}:{newest}:{size}";
    }

    public string GlossaryFile => Path.Combine(root, "content", "glossary.json");

    // ------------------------------------------------------------ build

    /// <summary>Lab challenge lists in the UI: file, the array that starts them, the lab state key and the route.</summary>
    static readonly (string File, string Array, string Lab, string Route)[] ChallengeSources =
    [
        ("netsim.js", "CHALLENGES", "netbuild", "netbuild"),
        ("archsim.js", "CHALLENGES", "archbuild", "archbuild"),
        ("composesim.js", "CHALLENGES", "composebuild", "composebuild"),
        ("kubesim.js", "CHALLENGES", "kubebuild", "kubebuild"),
        ("pipesim.js", "CHALLENGES", "pipebuild", "pipebuild"),
        ("rabbitsim.js", "CHALLENGES", "msgbuild-rabbit", "msgbuild/rabbitmq"),
        ("kafkasim.js", "CHALLENGES", "msgbuild-kafka", "msgbuild/kafka"),
        ("lab-pki.js", "CHALLENGES", "pki", "pki"),
        ("lab-regex.js", "CHALLENGES", "regex", "regex"),
        ("vim-levels.js", "VIM_LEVELS", "vim", "vim"),
        ("vim-levels.js", "NANO_LEVELS", "vim", "vim"),
    ];

    sealed record LessonText(string Key, string Track, string Title, List<(int Step, string Heading, string Text)> Steps);

    Built Build()
    {
        var b = new Built();
        var lessonTexts = new List<LessonText>();
        var generated = new List<(string Term, string Def, string Track, string Key, string Title, int Step)>();

        foreach (var track in content.Tracks().OfType<JsonObject>())
        {
            var tid = Str(track, "id") ?? "";
            var ttitle = Str(track, "title") ?? tid;
            b.TrackTitles[tid] = ttitle;
            var topic = new Doc { Kind = "topic", Title = ttitle, Sub = Str(track, "category") ?? "Topic", Href = $"#/track/{tid}", Track = tid, Boost = 1.3f };
            topic.Segs.Add(new(-1, 10, ttitle, false));
            if (Str(track, "tagline") is { } tag) topic.Segs.Add(new(-1, 3, tag, true));
            b.Docs.Add(topic);

            foreach (var module in (track["modules"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var mid = Str(module, "id") ?? "";
                var mtitle = Str(module, "title") ?? mid;
                var project = Str(module, "kind") == "project";
                var mdoc = new Doc { Kind = "module", Title = mtitle, Sub = $"{(project ? "Project" : "Module")} · {ttitle}", Href = $"#/track/{tid}/{mid}", Track = tid, Boost = 1.1f };
                mdoc.Segs.Add(new(-1, 10, mtitle, false));
                if (Str(module, "summary") is { } ms) mdoc.Segs.Add(new(-1, 4, ms, true));
                b.Docs.Add(mdoc);

                foreach (var meta in (module["lessons"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    var lid = Str(meta, "id") ?? "";
                    JsonObject? lesson;
                    try { lesson = content.Lesson(tid, mid, lid, coldOf: false); } catch { continue; }
                    if (lesson is null) continue;
                    var key = $"{tid}/{mid}/{lid}";
                    var ltitle = Str(lesson, "title") ?? lid;
                    var ldoc = new Doc { Kind = "lesson", Title = ltitle, Sub = $"{ttitle} · {mtitle}", Href = $"#/lesson/{key}", Key = key, Track = tid, StepLink = true };
                    ldoc.Segs.Add(new(-1, 10, ltitle, false));
                    if (Str(lesson, "summary") is { } ls) ldoc.Segs.Add(new(-1, 4, ls, true));
                    var texts = new List<(int, string, string)>();
                    var steps = lesson["steps"] as JsonArray ?? [];
                    for (var i = 0; i < steps.Count; i++)
                    {
                        if (steps[i] is not JsonObject step) continue;
                        var type = Str(step, "type") ?? "";
                        var heading = Str(step, "title") ?? "";
                        if (type == "learn")
                        {
                            if (heading.Length > 0) ldoc.Segs.Add(new(i, 6, heading, true));
                            var body = Str(step, "body") ?? "";
                            var (prose, code, subheads) = SplitMarkdown(body);
                            foreach (var sh in subheads) ldoc.Segs.Add(new(i, 4, sh, true));
                            if (prose.Length > 0) ldoc.Segs.Add(new(i, 1, prose, true));
                            if (code.Length > 0) ldoc.Segs.Add(new(i, 0.4f, code, false));
                            texts.Add((i, heading.ToLowerInvariant(), (prose + "\n" + string.Join("\n", subheads)).ToLowerInvariant()));
                            foreach (var (term, def) in BoldDefinitions(body)) generated.Add((term, def, tid, key, ltitle, i));
                            var tk = step["toolkit"] as JsonArray;
                            foreach (var e in (tk ?? []).OfType<JsonObject>()) b.Docs.Add(ToolkitDoc(e, key, i, ttitle, mtitle, ltitle, tid));
                        }
                        else
                        {
                            if (heading.Length > 0) ldoc.Segs.Add(new(i, 3, heading, true));
                            if (Str(step, "prompt") is { Length: > 0 } p) ldoc.Segs.Add(new(i, 0.8f, Plain(p), true));
                            if (Str(step, "explain") is { Length: > 0 } ex) ldoc.Segs.Add(new(i, 0.6f, Plain(ex), true));
                        }
                    }
                    b.Docs.Add(ldoc);
                    lessonTexts.Add(new LessonText(key, tid, ltitle, texts));
                }
            }
        }

        AddLabs(b);
        AddChallenges(b);
        AddLiveLabs(b);
        BuildGlossary(b, lessonTexts, generated);

        // The vocabulary: every word of every segment, with the segment's weight. Parts of CamelCase words too.
        for (var d = 0; d < b.Docs.Count; d++)
        {
            var doc = b.Docs[d];
            for (var s = 0; s < doc.Segs.Count; s++)
            {
                var seen = new Dictionary<string, float>();
                foreach (var (word, w) in IndexWords(doc.Segs[s].Text))
                    if (!seen.TryGetValue(word, out var have) || have < w) seen[word] = w;
                foreach (var (word, w) in seen)
                {
                    if (!b.Vocab.TryGetValue(word, out var list)) b.Vocab[word] = list = [];
                    list.Add(new Posting(d, s, doc.Segs[s].Weight * w));
                }
            }
        }
        b.Words = [.. b.Vocab.Keys];
        return b;
    }

    static Doc ToolkitDoc(JsonObject e, string key, int step, string ttitle, string mtitle, string ltitle, string tid)
    {
        var cmd = Str(e, "cmd") ?? "";
        var doc = new Doc { Kind = "command", Title = cmd, Sub = $"Senior's toolkit · {ttitle} · {mtitle}", Href = $"#/lesson/{key}/{step + 1}", Key = key, Track = tid, Boost = 1.1f };
        doc.Segs.Add(new(step, 9, cmd, false));
        if (Str(e, "what") is { } what) doc.Segs.Add(new(step, 3, Plain(what), true));
        if (Str(e, "when") is { } when) doc.Segs.Add(new(step, 2, Plain(when), true));
        if (e["flags"] is JsonArray flags)
        {
            var text = string.Join("  ·  ", flags.OfType<JsonArray>().Select(f => string.Join(": ", f.Select(x => x is JsonValue v && v.TryGetValue<string>(out var s) ? Plain(s) : ""))));
            if (text.Length > 0) doc.Segs.Add(new(step, 2, text, true));
        }
        if (Str(e, "example") is { } ex && ex != cmd) doc.Segs.Add(new(step, 1.5f, ex, true));
        return doc;
    }

    [GeneratedRegex(@"\{\s*id:\s*'([^']+)',\s*icon:\s*'((?:[^'\\]|\\.)*)',\s*title:\s*'((?:[^'\\]|\\.)*)',\s*category:\s*'((?:[^'\\]|\\.)*)',\s*text:\s*'((?:[^'\\]|\\.)*)'")]
    private static partial Regex LabEntry();

    /// <summary>The lab catalogue (the LABS array in ui/app.js).</summary>
    void AddLabs(Built b)
    {
        var file = Path.Combine(root, "ui", "app.js");
        if (!File.Exists(file)) return;
        var js = File.ReadAllText(file);
        var start = js.IndexOf("const LABS = [", StringComparison.Ordinal);
        if (start < 0) return;
        var end = js.IndexOf("\n];", start, StringComparison.Ordinal);
        var block = js[start..(end < 0 ? js.Length : end)];
        foreach (Match m in LabEntry().Matches(block))
        {
            var id = m.Groups[1].Value;
            var title = JsString(m.Groups[3].Value);
            var doc = new Doc { Kind = "lab", Title = title, Sub = $"Lab · {JsString(m.Groups[4].Value)}", Href = $"#/labs/{id}", Boost = 1.15f };
            doc.Segs.Add(new(-1, 10, title, false));
            doc.Segs.Add(new(-1, 2, JsString(m.Groups[4].Value), false));
            doc.Segs.Add(new(-1, 1.5f, Plain(JsString(m.Groups[5].Value)), true));
            b.Docs.Add(doc);
        }
    }

    [GeneratedRegex(@"^  \{\s*id:\s*'([^']+)'", RegexOptions.Multiline)]
    private static partial Regex ChallengeStart();

    [GeneratedRegex(@"\btitle:\s*'((?:[^'\\]|\\.)*)'")]
    private static partial Regex JsTitle();

    [GeneratedRegex(@"\b(?:brief|task|text):\s*'((?:[^'\\]|\\.)*)'")]
    private static partial Regex JsBrief();

    [GeneratedRegex(@"\b(?:group|level):\s*'((?:[^'\\]|\\.)*)'")]
    private static partial Regex JsGroup();

    static readonly Dictionary<string, string> LabNames = new()
    {
        ["netbuild"] = "Network builder", ["archbuild"] = "Architecture builder", ["composebuild"] = "Compose builder",
        ["kubebuild"] = "Kubernetes builder", ["pipebuild"] = "Pipeline builder", ["msgbuild-rabbit"] = "Messaging builder · RabbitMQ",
        ["msgbuild-kafka"] = "Messaging builder · Kafka", ["pki"] = "Certificate chain lab", ["regex"] = "Regex lab", ["vim"] = "Vim & nano trainer",
    };

    /// <summary>
    /// Builder and trainer challenges, read from the UI's challenge arrays: each top-level entry (indented two spaces)
    /// with an id, a title and a brief / task / text. Free sandboxes are left out.
    /// </summary>
    void AddChallenges(Built b)
    {
        foreach (var (file, array, lab, route) in ChallengeSources)
        {
            var path = Path.Combine(root, "ui", file);
            if (!File.Exists(path)) continue;
            var js = File.ReadAllText(path);
            var start = Regex.Match(js, $@"\b{array}\s*=\s*\[");
            if (!start.Success) continue;
            var end = js.IndexOf("\n];", start.Index, StringComparison.Ordinal);
            var block = js[start.Index..(end < 0 ? js.Length : end)];
            var starts = ChallengeStart().Matches(block).ToList();
            for (var i = 0; i < starts.Count; i++)
            {
                var id = starts[i].Groups[1].Value;
                if (id == "sandbox") continue;
                var chunk = block[starts[i].Index..(i + 1 < starts.Count ? starts[i + 1].Index : block.Length)];
                var t = JsTitle().Match(chunk);
                if (!t.Success) continue;
                var title = Plain(JsString(t.Groups[1].Value));
                var brief = JsBrief().Match(chunk) is { Success: true } bm ? Plain(JsString(bm.Groups[1].Value)) : "";
                var group = JsGroup().Match(chunk) is { Success: true } gm ? JsString(gm.Groups[1].Value) : "";
                var name = LabNames.GetValueOrDefault(lab, lab);
                if (lab == "vim") name = array == "NANO_LEVELS" ? "nano trainer" : "Vim trainer";
                var doc = new Doc
                {
                    Kind = "challenge", Title = title, Sub = $"Challenge · {name}{(group.Length > 0 ? $" · {group}" : "")}",
                    Href = $"#/labs/{route}", Lab = lab, Challenge = id, Boost = 0.95f,
                };
                doc.Segs.Add(new(-1, 9, title, false));
                if (brief.Length > 0) doc.Segs.Add(new(-1, 1.5f, brief, true));
                doc.Segs.Add(new(-1, 1, name, false));
                b.Docs.Add(doc);
            }
        }
    }

    /// <summary>Live labs (netlabs/labs/*/lab.json): one result per lab and one per task.</summary>
    void AddLiveLabs(Built b)
    {
        var dir = Path.Combine(root, "netlabs", "labs");
        if (!Directory.Exists(dir)) return;
        foreach (var labDir in Directory.GetDirectories(dir).Order(StringComparer.Ordinal))
        {
            var file = Path.Combine(labDir, "lab.json");
            if (!File.Exists(file)) continue;
            JsonObject? def;
            try { def = JsonNode.Parse(File.ReadAllText(file)) as JsonObject; } catch { continue; }
            if (def is null) continue;
            var id = Path.GetFileName(labDir);
            var title = Str(def, "title") ?? id;
            var module = Str(def, "module") ?? "";
            var linux = module.StartsWith("Linux missions", StringComparison.Ordinal);
            var href = $"#/labs/{(linux ? "linux" : "net")}/{id}";
            var family = linux ? "Linux mission" : "Live network lab";
            var labDoc = new Doc { Kind = "livelab", Title = title, Sub = $"{family}{(module.Length > 0 ? $" · {module}" : "")}", Href = href, Boost = 1.05f };
            labDoc.Segs.Add(new(-1, 10, title, false));
            if (Str(def, "summary") is { } s) labDoc.Segs.Add(new(-1, 3, Plain(s), true));
            b.Docs.Add(labDoc);
            foreach (var task in (def["tasks"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var tt = Str(task, "title");
                if (tt is null) continue;
                var doc = new Doc { Kind = "livelab", Title = tt, Sub = $"{family} · {title}", Href = href, Boost = 0.9f };
                doc.Segs.Add(new(-1, 8, tt, false));
                if (Str(task, "text") is { } text) doc.Segs.Add(new(-1, 1, Plain(text), true));
                doc.Segs.Add(new(-1, 1.5f, title, false));
                b.Docs.Add(doc);
            }
        }
    }

    // ------------------------------------------------------------ glossary

    void BuildGlossary(Built b, List<LessonText> lessons, List<(string Term, string Def, string Track, string Key, string Title, int Step)> generated)
    {
        var bySlug = new Dictionary<string, Term>();
        var byName = new Dictionary<string, Term>();   // normalized term and aliases -> term
        if (File.Exists(GlossaryFile))
        {
            JsonNode? node = null;
            try { node = JsonNode.Parse(File.ReadAllText(GlossaryFile), documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }); }
            catch (JsonException) { }
            var list = node is JsonObject o ? o["terms"] as JsonArray : node as JsonArray;
            foreach (var e in (list ?? []).OfType<JsonObject>())
            {
                var name = Str(e, "term");
                var def = Str(e, "def");
                if (name is null || def is null) continue;
                var slug = Slug(name);
                if (bySlug.ContainsKey(slug)) continue;
                var term = new Term
                {
                    Slug = slug, Name = name, Definition = def, Topic = Str(e, "topic") ?? "",
                    Aliases = (e["aliases"] as JsonArray ?? []).Select(a => a is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).OfType<string>().ToList(),
                };
                bySlug[slug] = term;
                foreach (var n in term.Aliases.Prepend(name)) byName.TryAdd(Norm(n), term);
                // Hand-picked lessons first, if the entry names any.
                foreach (var k in (e["lessons"] as JsonArray ?? []).Select(x => (string?)x).OfType<string>())
                    if (lessons.FirstOrDefault(l => l.Key == k) is { } lt) term.Lessons.Add(new(lt.Key, lt.Title, null, lt.Track));
                LinkLessons(term, lessons);
            }
        }

        // Terms the lessons define themselves: "**Backpressure** is ...". The first lesson that defines one wins.
        foreach (var g in generated)
        {
            var n = Norm(g.Term);
            if (byName.TryGetValue(n, out var known) || byName.TryGetValue(n.TrimEnd('s'), out known) || byName.TryGetValue(n + "s", out known))
            {
                if (known.Lessons.Count < 4 && known.Lessons.All(l => l.Key != g.Key)) known.Lessons.Add(new(g.Key, g.Title, g.Step, g.Track));
                continue;
            }
            var slug = Slug(g.Term);
            if (slug.Length == 0 || bySlug.ContainsKey(slug)) continue;
            var term = new Term { Slug = slug, Name = g.Term, Definition = g.Def, Topic = g.Track, Source = "lesson" };
            term.Lessons.Add(new(g.Key, g.Title, g.Step, g.Track));
            bySlug[slug] = term;
            byName[n] = term;
        }

        foreach (var t in bySlug.Values.OrderBy(t => t.Name, StringComparer.OrdinalIgnoreCase))
        {
            b.Glossary.Add(t);
            var topicTitle = b.TrackTitles.GetValueOrDefault(t.Topic, "");
            var doc = new Doc
            {
                Kind = "glossary", Title = t.Name, Sub = $"Glossary{(topicTitle.Length > 0 ? $" · {topicTitle}" : "")}",
                Href = $"#/glossary/{t.Slug}", Slug = t.Slug, Track = t.Topic, Boost = t.Source == "curated" ? 1.25f : 1.05f,
            };
            doc.Segs.Add(new(-1, 10, t.Name, false));
            if (t.Aliases.Count > 0) doc.Segs.Add(new(-1, 8, string.Join(", ", t.Aliases), false));
            doc.Segs.Add(new(-1, 2, t.Definition, true));
            b.Docs.Add(doc);
        }
    }

    /// <summary>The lessons that teach a curated term best: in the title, then a card heading, then the text.</summary>
    static void LinkLessons(Term term, List<LessonText> lessons)
    {
        // The term itself and its longer, specific aliases ("JSON Web Token") first; short aliases only if those find nothing.
        var name = Regex.Replace(term.Name, @"\s*\([^)]*\)$", "");
        var specific = term.Aliases.Where(a => a.Contains(' ') || a.Contains('-') || a.Contains('/')).Prepend(name);
        if (!LinkLessons(term, lessons, specific))
            LinkLessons(term, lessons, term.Aliases.Where(a => a.Length >= 3));
    }

    static bool LinkLessons(Term term, List<LessonText> lessons, IEnumerable<string> candidates)
    {
        var names = candidates.Select(n => n.ToLowerInvariant()).Where(n => n.Length > 1).Distinct().ToList();
        var scored = new List<(LessonText L, double Score, int? Step)>();
        foreach (var l in lessons)
        {
            var title = l.Title.ToLowerInvariant();
            double titleScore = names.Any(n => ContainsWord(title, n)) ? 6 : 0, stepScore = 0;
            int? step = null;
            foreach (var (i, heading, text) in l.Steps)
            {
                double s = names.Any(n => ContainsWord(heading, n)) ? 4
                    : names.Any(n => ContainsWord(text, n)) ? 1 + Math.Min(1.5, names.Sum(n => Count(text, n)) * 0.25) : 0;
                if (s > stepScore) { stepScore = s; step = i; }
            }
            var best = Math.Max(titleScore, stepScore);
            if (best <= 0) continue;
            if (l.Track == term.Topic) best += 1.5;
            if (l.Title.StartsWith("Cold rebuild", StringComparison.OrdinalIgnoreCase)) best -= 3;   // teach it, not re-prove it
            scored.Add((l, best, titleScore >= stepScore ? null : step));
        }
        if (scored.Count == 0) return false;
        var top = scored.Max(s => s.Score);
        foreach (var (l, _, step) in scored.Where(s => s.Score >= top / 2).OrderByDescending(s => s.Score).ThenBy(s => s.L.Key, StringComparer.Ordinal).Take(3))
            if (term.Lessons.All(x => x.Key != l.Key)) term.Lessons.Add(new(l.Key, l.Title, step, l.Track));
        return true;
    }

    [GeneratedRegex(@"(?:^|(?<=[.!?:]\s)|(?<=^\s*[-*]\s))(?:(?:A|An|The)\s+)?\*\*([^*\n]{2,48})\*\*(?:\s*\([^)\n]{1,80}\))?,?\s+(?:is|are|means|refers to|stands for)\s+([^\n]+?[.!?])(?=\s|$)", RegexOptions.Multiline)]
    private static partial Regex BoldDef();

    static readonly HashSet<string> NotTerms = ["not", "never", "only", "always", "every", "all", "no", "one", "this", "that", "it", "both", "each", "none", "nothing", "same", "why", "how", "what", "when", "where", "who", "yes", "and", "or", "but"];

    /// <summary>"**Term** is/are/means ... ." sentences in a card body (outside code fences).</summary>
    public static IEnumerable<(string Term, string Def)> BoldDefinitions(string body)
    {
        var prose = string.Join("\n", ProseLines(body));
        foreach (Match m in BoldDef().Matches(prose))
        {
            var term = m.Groups[1].Value.Replace("`", "").Trim().TrimEnd(':', ',', '.');
            if (term.Length < 2 || !term.Any(char.IsLetter) || term.Split(' ').Length > 5) continue;
            var first = term.Split(' ')[0].ToLowerInvariant();
            if (NotTerms.Contains(first) || char.IsDigit(term[0])) continue;
            var sentence = Plain(m.Value.Trim()).Trim();
            if (sentence.StartsWith("- ") || sentence.StartsWith("* ")) sentence = sentence[2..];
            var rest = m.Groups[2].Value;
            sentence = Regex.Replace(sentence, @"\s+", " ");
            if (rest.Length < 25 || sentence.Length < 40 || sentence.Length > 340 || Regex.IsMatch(term, @"^(Stage|Step|Part|Phase|Level)\s+\d", RegexOptions.IgnoreCase)) continue;
            term = Regex.Replace(term, @"\s*\([^)]*\)$", "");
            if (sentence.Length > 0) sentence = char.ToUpperInvariant(sentence[0]) + sentence[1..];
            yield return (term, sentence);
        }
    }

    // ------------------------------------------------------------ search

    public sealed record Hit(Doc Doc, double Score, int? Step, string Snippet, List<int[]> SnippetHl, List<int[]> TitleHl);

    static readonly HashSet<string> Stop = ["the", "a", "an", "of", "to", "in", "is", "are", "what", "how", "and", "for", "on", "with", "do", "does", "i", "my", "it", "vs", "or", "be", "by", "at", "as", "why", "when"];

    public static List<string> QueryWords(string q)
    {
        var words = Words(q.ToLowerInvariant()).Select(w => w.Word).Distinct().ToList();
        var kept = words.Where(w => !Stop.Contains(w)).ToList();
        return kept.Count > 0 ? kept : words;
    }

    /// <summary>How well an index word answers a query word (0: not at all).</summary>
    public static double Quality(string query, string word)
    {
        if (word == query) return 1;
        if (query.Length >= 2 && word.StartsWith(query, StringComparison.Ordinal)) return 0.8 - Math.Min(0.2, (word.Length - query.Length) * 0.015);
        if (query.Length >= 3 && word.Length <= 40 && word.Contains(query, StringComparison.Ordinal)) return 0.45;
        if (query.Length >= 4)
        {
            var max = query.Length >= 8 ? 2 : 1;
            if (Math.Abs(word.Length - query.Length) <= max)
            {
                var d = Edits(query, word, max);
                if (d == 1) return Fuzzy1;
                if (d == 2 && max >= 2) return Fuzzy2;
            }
            // A typo in a word still being typed: compare with the start of longer words.
            if (word.Length > query.Length && Edits(query, word[..query.Length], 1) == 1) return FuzzyPrefix;
        }
        return 0;
    }

    const double Fuzzy1 = 0.5, Fuzzy2 = 0.35, FuzzyPrefix = 0.3;

    public List<Hit> Search(string q, int limit = 60)
    {
        var (b, ranked, matches) = Rank(q);
        return ranked.Take(limit).Select(s => MakeHit(b.Docs[s.Doc], s.Score, matches)).ToList();
    }

    /// <summary>For each query word: the index words that answer it, and how well.</summary>
    static List<Dictionary<string, double>> Matches(Built b, List<string> words) => words.Select(w =>
    {
        var m = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var x in b.Words) { var q = Quality(w, x); if (q > 0) m[x] = q; }
        // The word (or words starting with it) exists: typo neighbours are only a faint "did you mean".
        if (m.Values.Any(v => v >= 0.6))
            foreach (var k in m.Where(p => p.Value is Fuzzy1 or Fuzzy2 or FuzzyPrefix).Select(p => p.Key).ToList()) m[k] *= 0.2;
        return m;
    }).ToList();

    (Built B, List<(int Doc, double Score)> Ranked, List<Dictionary<string, double>> Matches) Rank(string q)
    {
        var b = Current();
        var words = QueryWords(q);
        if (words.Count == 0) return (b, [], []);
        if (words.Count > 8) words = words.Take(8).ToList();
        var matches = Matches(b, words);
        var best = new Dictionary<int, double[]>();
        for (var t = 0; t < words.Count; t++)
            foreach (var (word, quality) in matches[t])
                foreach (var p in b.Vocab[word])
                {
                    if (!best.TryGetValue(p.Doc, out var arr)) best[p.Doc] = arr = new double[words.Count];
                    var s = quality * p.Weight;
                    if (s > arr[t]) arr[t] = s;
                }

        var phrase = string.Join(" ", Words(q.ToLowerInvariant()).Select(w => w.Word));
        var scored = new List<(int Doc, double Score)>();
        foreach (var need in new[] { words.Count, words.Count - 1 })
        {
            if (need < 1) break;
            foreach (var (d, arr) in best)
            {
                var hits = arr.Count(x => x > 0);
                if (hits != need) continue;
                var doc = b.Docs[d];
                var score = arr.Sum() * doc.Boost;
                var title = string.Join(" ", Words(doc.Title.ToLowerInvariant()).Select(w => w.Word));
                if (title == phrase) score += 25;
                else if (title.StartsWith(phrase, StringComparison.Ordinal)) score += 10;
                else if (words.Count > 1 && title.Contains(phrase, StringComparison.Ordinal)) score += 8;
                score *= 1 + 0.12 / (1 + title.Length / 24.0);   // shorter titles first on ties
                if (need < words.Count) score *= 0.5;
                scored.Add((d, score));
            }
            if (scored.Count > 0) break;
        }
        return (b, scored.OrderByDescending(s => s.Score).ThenBy(s => b.Docs[s.Doc].Title.Length).ToList(), matches);
    }

    Hit MakeHit(Doc doc, double score, List<Dictionary<string, double>> matches)
    {
        // The segment that answers the most query words (weighted by the field) gives the snippet and the step.
        Seg? pick = null;
        double pickScore = 0;
        foreach (var seg in doc.Segs)
        {
            if (!seg.Snippet) continue;
            var ws = IndexWords(seg.Text).Select(x => x.Word).ToHashSet();
            var covered = matches.Count(m => ws.Any(m.ContainsKey));
            if (covered == 0) continue;
            var s = covered * 10 + matches.Sum(m => ws.Select(w => m.GetValueOrDefault(w)).DefaultIfEmpty(0).Max()) * Math.Sqrt(seg.Weight);
            if (s > pickScore) { pickScore = s; pick = seg; }
        }
        var lit = matches.SelectMany(m => m.Where(p => p.Value >= 0.3).Select(p => p.Key)).ToHashSet();
        var fallback = doc.Segs.FirstOrDefault(s => s.Snippet);
        var (snippet, hl) = Snip((pick ?? fallback)?.Text ?? "", lit);
        int? step = null;
        // Title or summary matched as well as the cards: open the lesson at the start.
        var titleCovered = matches.Count(m => IndexWords(doc.Title).Any(w => m.ContainsKey(w.Word)));
        if (doc.StepLink && pick is { Step: >= 0 } && titleCovered < matches.Count) step = pick.Step;
        if (doc.Kind == "command") step = doc.Segs[0].Step;
        return new Hit(doc, score, step, snippet, hl, Highlights(doc.Title, lit));
    }

    /// <summary>About 190 characters around the first lit word, with the lit words' ranges.</summary>
    public static (string Text, List<int[]> Hl) Snip(string text, HashSet<string> lit, int width = 190)
    {
        text = Regex.Replace(text, @"\s+", " ").Trim();
        var first = Words(text).Select(w => (w.Start, Lit: IsLit(w.Word.ToLowerInvariant(), lit))).FirstOrDefault(w => w.Lit).Start;
        var start = 0;
        if (text.Length > width && first > 50)
        {
            start = Math.Min(first - 50, text.Length - width);
            var space = text.LastIndexOf(' ', Math.Max(0, start));
            start = space >= 0 && start - space < 20 ? space + 1 : Math.Max(0, start);
        }
        var end = Math.Min(text.Length, start + width);
        if (end < text.Length) { var space = text.LastIndexOf(' ', end); if (space > start + width / 2) end = space; }
        var cut = text[start..end];
        var prefix = start > 0 ? "…" : "";
        var result = prefix + cut + (end < text.Length ? "…" : "");
        var hl = Highlights(cut, lit).Select(r => new[] { r[0] + prefix.Length, r[1] }).ToList();
        return (result, hl);
    }

    static bool IsLit(string word, HashSet<string> lit) => lit.Contains(word);

    /// <summary>[start, length] of every word (or CamelCase part) in <paramref name="text"/> that is lit.</summary>
    public static List<int[]> Highlights(string text, HashSet<string> lit)
    {
        var list = new List<int[]>();
        foreach (var w in Words(text))
        {
            var lower = w.Word.ToLowerInvariant();
            if (lit.Contains(lower)) { list.Add([w.Start, w.Word.Length]); continue; }
            foreach (Match part in CamelPart().Matches(w.Word))
                if (part.Length > 1 && lit.Contains(part.Value.ToLowerInvariant())) list.Add([w.Start + part.Index, part.Length]);
        }
        return list;
    }

    // ------------------------------------------------------------ JSON for the API

    static readonly string[] KindOrder = ["glossary", "command", "lesson", "module", "topic", "lab", "challenge", "livelab"];
    public static readonly Dictionary<string, string> KindLabel = new()
    {
        ["topic"] = "Topics", ["module"] = "Modules", ["lesson"] = "Lessons", ["command"] = "Senior's toolkit",
        ["glossary"] = "Glossary", ["lab"] = "Labs", ["challenge"] = "Lab challenges", ["livelab"] = "Live labs and missions",
    };

    public JsonObject SearchJson(string q, int perKind = 6)
    {
        var started = DateTime.UtcNow;
        var (b, ranked, matches) = Rank(q);
        var groups = new JsonArray();
        foreach (var g in ranked.GroupBy(r => b.Docs[r.Doc].Kind).OrderByDescending(g => g.Max(r => r.Score)).ThenBy(g => Array.IndexOf(KindOrder, g.Key)))
        {
            var items = new JsonArray();
            foreach (var r in g.Take(perKind))
            {
                var hit = MakeHit(b.Docs[r.Doc], r.Score, matches);
                var d = hit.Doc;
                var item = new JsonObject
                {
                    ["kind"] = d.Kind, ["title"] = d.Title, ["titleHl"] = Ranges(hit.TitleHl), ["sub"] = d.Sub,
                    ["snippet"] = hit.Snippet, ["snippetHl"] = Ranges(hit.SnippetHl),
                    ["href"] = hit.Step is { } st && d.Kind == "lesson" ? $"{d.Href}/{st + 1}" : d.Href,
                    ["score"] = Math.Round(hit.Score, 2),
                };
                if (d.Key is not null) item["key"] = d.Key;
                if (hit.Step is { } s) item["step"] = s;
                if (d.Lab is not null) { item["lab"] = d.Lab; item["challenge"] = d.Challenge; }
                if (d.Slug is not null) item["slug"] = d.Slug;
                items.Add(item);
            }
            groups.Add(new JsonObject { ["kind"] = g.Key, ["label"] = KindLabel.GetValueOrDefault(g.Key, g.Key), ["total"] = g.Count(), ["items"] = items });
        }
        return new JsonObject { ["q"] = q, ["ms"] = (int)(DateTime.UtcNow - started).TotalMilliseconds, ["groups"] = groups };
    }

    static JsonArray Ranges(List<int[]> r) => new(r.Select(x => (JsonNode)new JsonArray(x[0], x[1])).ToArray());

    public JsonObject GlossaryJson()
    {
        var b = Current();
        var terms = new JsonArray();
        foreach (var t in b.Glossary)
            terms.Add(new JsonObject
            {
                ["slug"] = t.Slug, ["term"] = t.Name, ["aliases"] = new JsonArray(t.Aliases.Select(a => (JsonNode)a).ToArray()),
                ["def"] = t.Definition, ["topic"] = t.Topic, ["topicTitle"] = b.TrackTitles.GetValueOrDefault(t.Topic, ""), ["source"] = t.Source,
                ["lessons"] = new JsonArray(t.Lessons.Select(l => (JsonNode)new JsonObject { ["key"] = l.Key, ["title"] = l.Title, ["step"] = l.Step, ["track"] = l.Track }).ToArray()),
            });
        return new JsonObject { ["terms"] = terms, ["curated"] = b.Glossary.Count(t => t.Source == "curated"), ["fromLessons"] = b.Glossary.Count(t => t.Source == "lesson") };
    }

    public int DocCount => Current().Docs.Count;
    public IReadOnlyList<Doc> Docs => Current().Docs;

    public static void Map(WebApplication app, SearchIndex index)
    {
        app.MapGet("/api/search", (string? q, int? per) =>
            Results.Text(index.SearchJson((q ?? "").Length > 200 ? q![..200] : q ?? "", Math.Clamp(per ?? 6, 1, 30)).ToJsonString(), "application/json"));
        app.MapGet("/api/glossary", () => Results.Text(index.GlossaryJson().ToJsonString(), "application/json"));
    }

    // ------------------------------------------------------------ text helpers

    [GeneratedRegex(@"[\p{L}\p{N}]+(?:[+#][\p{L}\p{N}+#]*)?")]
    private static partial Regex WordRx();

    [GeneratedRegex(@"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")]
    private static partial Regex CamelPart();

    static IEnumerable<(string Word, int Start)> Words(string text)
    {
        foreach (Match m in WordRx().Matches(text)) yield return (m.Value, m.Index);
    }

    /// <summary>Lower-case words to index, with a weight: the word itself (1) and its CamelCase parts (0.6).</summary>
    public static IEnumerable<(string Word, float Weight)> IndexWords(string text)
    {
        foreach (Match m in WordRx().Matches(text))
        {
            yield return (m.Value.ToLowerInvariant(), 1);
            var parts = CamelPart().Matches(m.Value);
            if (parts.Count > 1)
                foreach (Match p in parts)
                    if (p.Length > 1) yield return (p.Value.ToLowerInvariant(), 0.6f);
        }
    }

    /// <summary>Damerau-style edit distance, giving up (returning max + 1) once it exceeds <paramref name="max"/>.</summary>
    public static int Edits(string a, string b, int max)
    {
        if (Math.Abs(a.Length - b.Length) > max) return max + 1;
        var prev2 = new int[b.Length + 1];
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) prev[j] = j;
        for (var i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            var rowMin = cur[0];
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                var v = Math.Min(Math.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + cost);
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) v = Math.Min(v, prev2[j - 2] + 1);
                cur[j] = v;
                rowMin = Math.Min(rowMin, v);
            }
            if (rowMin > max) return max + 1;
            (prev2, prev, cur) = (prev, cur, prev2);
        }
        return prev[b.Length];
    }

    static IEnumerable<string> ProseLines(string body)
    {
        var inFence = false;
        foreach (var line in body.Replace("\r\n", "\n").Split('\n'))
        {
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal)) { inFence = !inFence; continue; }
            if (!inFence) yield return line;
        }
    }

    /// <summary>A card body as plain prose, its code samples, and its own sub-headings.</summary>
    public static (string Prose, string Code, List<string> Headings) SplitMarkdown(string body)
    {
        var prose = new StringBuilder();
        var code = new StringBuilder();
        var heads = new List<string>();
        var inFence = false;
        foreach (var line in body.Replace("\r\n", "\n").Split('\n'))
        {
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal)) { inFence = !inFence; continue; }
            if (inFence) { code.Append(line).Append('\n'); continue; }
            var hm = Regex.Match(line, @"^\s{0,3}#{1,6}\s+(.+)$");
            if (hm.Success) { heads.Add(Plain(hm.Groups[1].Value)); continue; }
            prose.Append(line).Append('\n');
        }
        return (Plain(prose.ToString()), code.ToString().Trim(), heads);
    }

    /// <summary>Markdown to plain text: no emphasis marks, backticks, link targets, tags or table pipes.</summary>
    public static string Plain(string md)
    {
        var s = Regex.Replace(md, @"!?\[([^\]]*)\]\([^)]*\)", "$1");
        s = Regex.Replace(s, @"</?(?:br|b|i|em|strong|kbd|code|span|div|p|sub|sup|small|a|details|summary)\b[^>\n]{0,80}>", " ");
        s = s.Replace("**", "").Replace("__", "").Replace("`", "");
        s = Regex.Replace(s, @"(?m)^\s{0,3}(?:>|[-*+]|\d+\.)\s+", "");
        s = Regex.Replace(s, @"(?m)^\s*\|?\s*:?-{3,}.*$", "");
        s = s.Replace("|", " ");
        s = Regex.Replace(s, @"(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])", "$1");
        s = Regex.Replace(s, @"[ \t]+", " ");
        s = Regex.Replace(s, @"\n{2,}", "\n");
        return s.Trim();
    }

    /// <summary>A JavaScript single-quoted string's contents, unescaped.</summary>
    public static string JsString(string s) =>
        Regex.Replace(s, @"\\(u\{?[0-9a-fA-F]{4,5}\}?|.)", m =>
        {
            var c = m.Groups[1].Value;
            if (c.Length > 1 && c[0] == 'u') return char.ConvertFromUtf32(Convert.ToInt32(c.Trim('u', '{', '}'), 16));
            return c switch { "n" => "\n", "t" => "\t", _ => c };
        });

    public static string Slug(string s) => Regex.Replace(Regex.Replace(s.ToLowerInvariant().Replace("#", "sharp").Replace("+", "plus"), @"[^a-z0-9]+", "-"), "^-+|-+$", "");

    static string Norm(string s) => Regex.Replace(s.ToLowerInvariant().Replace("`", ""), @"[\s\-_]+", " ").Trim();

    static bool ContainsWord(string hay, string needle)
    {
        for (var at = hay.IndexOf(needle, StringComparison.Ordinal); at >= 0; at = hay.IndexOf(needle, at + 1, StringComparison.Ordinal))
        {
            var before = at == 0 || !char.IsLetterOrDigit(hay[at - 1]);
            var end = at + needle.Length;
            var after = end >= hay.Length || !char.IsLetterOrDigit(hay[end]) || (hay[end] == 's' && (end + 1 >= hay.Length || !char.IsLetterOrDigit(hay[end + 1])));
            if (before && after) return true;
        }
        return false;
    }

    static int Count(string hay, string needle)
    {
        var n = 0;
        for (var at = hay.IndexOf(needle, StringComparison.Ordinal); at >= 0 && n < 20; at = hay.IndexOf(needle, at + needle.Length, StringComparison.Ordinal)) n++;
        return n;
    }

    static string? Str(JsonObject o, string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
}
