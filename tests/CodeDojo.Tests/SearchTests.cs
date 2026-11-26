using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>The search index (Search.cs): what it indexes, how it ranks, deep links, snippets and the glossary.</summary>
public sealed class SearchTests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "dojo-search-" + Guid.NewGuid().ToString("N"));
    readonly SearchIndex index;

    public SearchTests()
    {
        Write("tracks/net/track.json", """{ "title": "Networking", "language": "csharp", "tagline": "Packets and addresses", "category": "Infrastructure" }""");
        Write("tracks/net/01-ip/module.json", """{ "title": "IPv4 and subnetting", "summary": "Masks, CIDR and host ranges." }""");
        Write("tracks/net/01-ip/01-masks.json", """
            {
              "title": "Masks and CIDR",
              "summary": "Read a prefix length.",
              "steps": [
                { "type": "learn", "title": "Addresses", "body": "An address has 32 bits." },
                { "type": "learn", "title": "Prefixes", "body": ["**CIDR notation** is a way to write an address with its prefix length, like `10.0.0.0/8`.", "", "```bash", "ip -br addr", "```"] },
                { "type": "mcq", "prompt": "How many hosts does a /30 have?", "options": ["2", "4"], "answer": 0 }
              ]
            }
            """);
        Write("tracks/net/01-ip/02-backpressure.json", """
            {
              "title": "Queues under load",
              "steps": [
                { "type": "learn", "title": "Intro", "body": "Queues fill up." },
                { "type": "learn", "title": "Slowing producers", "body": "When consumers fall behind, backpressure tells producers to slow down instead of buffering forever." },
                { "type": "learn", "title": "Senior's toolkit", "body": "What people type.",
                  "toolkit": [ { "cmd": "kubectl get pods -o wide", "what": "List pods with their node and IP.", "flags": [["-o wide", "extra columns"]] } ] }
              ]
            }
            """);
        Write("netlabs/labs/01-ip-addressing/lab.json", """
            { "title": "IP addresses, subnets and ping", "module": "1 Â· Networking foundations", "summary": "Two PCs cannot talk.",
              "tasks": [ { "id": "t1", "type": "answer", "title": "Read an address", "text": "Look at eth0 on pc1." } ] }
            """);
        Write("netlabs/labs/11-first-day/lab.json", """{ "title": "First day", "module": "Linux missions Â· 1 Â· Survival", "tasks": [] }""");
        Write("ui/app.js", """
            const LABS = [
              { id: 'subnet', icon: 'â§–', title: 'Subnetting trainer', category: 'Networking',
                text: 'Endless subnetting questions with a bit-by-bit breakdown.' },
            ];
            """);
        Write("ui/kubesim.js", """
            export const CHALLENGES = [
              { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
                brief: 'A free board.' },

              { id: 'crashloop', title: 'Killed while starting', xp: 20,
                brief: 'The pod goes into **CrashLoopBackOff**: the liveness probe kills it before it is ready.' },
            ];
            """);
        Write("content/glossary.json", """
            { "terms": [
              { "term": "Idempotency", "aliases": ["idempotent"], "topic": "net", "def": "An operation is idempotent when doing it twice has the same effect as doing it once." },
              { "term": "Backpressure", "topic": "net", "def": "A way for a slow consumer to make a fast producer slow down." }
            ] }
            """);
        index = new SearchIndex(root, new Content(root)) { RecheckAfter = TimeSpan.Zero };
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
    public void Indexes_every_kind()
    {
        var kinds = index.Docs.Select(d => d.Kind).ToHashSet();
        Assert.Superset(new HashSet<string> { "topic", "module", "lesson", "command", "lab", "challenge", "livelab", "glossary" }, kinds);
        Assert.DoesNotContain(index.Docs, d => d.Kind == "challenge" && d.Title == "Sandbox");
    }

    [Fact]
    public void Title_match_ranks_first_and_links_to_the_lesson()
    {
        var hits = index.Search("masks cidr");
        Assert.Equal("Masks and CIDR", hits[0].Doc.Title);
        Assert.Equal("net/01-ip/01-masks", hits[0].Doc.Key);
        Assert.Null(hits[0].Step);   // the title answers it: open at the start
    }

    [Fact]
    public void Body_match_deep_links_to_its_step_with_a_highlighted_snippet()
    {
        var hit = index.Search("buffering forever").First(h => h.Doc.Kind == "lesson");
        Assert.Equal(1, hit.Step);
        Assert.Contains("buffering forever", hit.Snippet);
        var marked = hit.SnippetHl.Select(r => hit.Snippet.Substring(r[0], r[1]).ToLowerInvariant()).ToList();
        Assert.Contains("buffering", marked);
        Assert.Contains("forever", marked);
        var json = index.SearchJson("buffering forever");
        var item = json["groups"]!.AsArray().SelectMany(g => g!["items"]!.AsArray()).First(i => (string?)i!["kind"] == "lesson")!;
        Assert.Equal("#/lesson/net/01-ip/02-backpressure/2", (string?)item["href"]);
    }

    [Fact]
    public void Prefix_matches_as_you_type()
    {
        Assert.Contains(index.Search("subnett"), h => h.Doc.Title == "Subnetting trainer");
        Assert.Contains(index.Search("backpr"), h => h.Doc.Kind == "glossary" && h.Doc.Title == "Backpressure");
    }

    [Fact]
    public void Tolerates_a_typo_but_prefers_real_words()
    {
        Assert.Contains(index.Search("backpresure"), h => h.Doc.Title == "Backpressure");
        Assert.Contains(index.Search("idempotnecy"), h => h.Doc.Title == "Idempotency");
        // A real word is not drowned by its typo neighbours.
        Assert.DoesNotContain(index.Search("cidr"), h => h.Doc.Kind == "topic");
    }

    [Fact]
    public void Toolkit_commands_open_their_card()
    {
        var hit = index.Search("kubectl wide").First();
        Assert.Equal("command", hit.Doc.Kind);
        Assert.Equal("#/lesson/net/01-ip/02-backpressure/3", hit.Doc.Href);
    }

    [Fact]
    public void Challenges_and_live_labs_carry_their_targets()
    {
        var ch = index.Search("crashloopbackoff").First(h => h.Doc.Kind == "challenge");
        Assert.Equal("kubebuild", ch.Doc.Lab);
        Assert.Equal("crashloop", ch.Doc.Challenge);
        // CamelCase parts are searchable on their own.
        Assert.Contains(index.Search("crash loop"), h => h.Doc.Kind == "challenge");
        Assert.Contains(index.Search("read an address"), h => h.Doc.Kind == "livelab" && h.Doc.Href == "#/labs/net/01-ip-addressing");
        Assert.Contains(index.Docs, d => d.Kind == "livelab" && d.Href == "#/labs/linux/11-first-day");
    }

    [Fact]
    public void Glossary_has_curated_and_lesson_terms_with_links()
    {
        var g = index.GlossaryJson()["terms"]!.AsArray();
        var cidr = g.First(t => (string?)t!["term"] == "CIDR notation")!;
        Assert.Equal("lesson", (string?)cidr["source"]);
        Assert.StartsWith("CIDR notation is a way", (string?)cidr["def"]);
        Assert.Equal(1, (int?)cidr["lessons"]![0]!["step"]);
        var bp = g.First(t => (string?)t!["term"] == "Backpressure")!;
        Assert.Equal("curated", (string?)bp["source"]);
        Assert.Equal("net/01-ip/02-backpressure", (string?)bp["lessons"]![0]!["key"]);
        Assert.Equal(1, (int?)bp["lessons"]![0]!["step"]);
    }

    [Fact]
    public void Rebuilds_when_content_changes()
    {
        Assert.DoesNotContain(index.Search("zebrafish"), h => true);
        Write("tracks/net/01-ip/03-new.json", """{ "title": "Zebrafish routing", "steps": [] }""");
        File.SetLastWriteTimeUtc(Path.Combine(root, "tracks/net/01-ip/03-new.json"), DateTime.UtcNow.AddMinutes(1));
        Assert.Contains(index.Search("zebrafish"), h => h.Doc.Title == "Zebrafish routing");
    }

    [Theory]
    [InlineData("subnet", "subnet", 1.0)]
    [InlineData("sub", "subnet", 0.75)]
    [InlineData("cidr", "from", 0)]
    [InlineData("cidr", "first", 0)]
    public void Quality_scores_words(string query, string word, double atLeast)
    {
        var q = SearchIndex.Quality(query, word);
        if (atLeast == 0) Assert.Equal(0, q); else Assert.True(q >= atLeast, $"{q}");
    }

    [Fact]
    public void Edit_distance_is_bounded()
    {
        Assert.Equal(1, SearchIndex.Edits("backpresure", "backpressure", 2));
        Assert.Equal(1, SearchIndex.Edits("teh", "the", 1));
        Assert.True(SearchIndex.Edits("cidr", "from", 1) > 1);
    }

    [Fact]
    public void Plain_strips_markdown()
    {
        Assert.Equal("Use kubectl and the docs now.", SearchIndex.Plain("Use `kubectl` and **the [docs](http://x)** *now*."));
    }
}
