using System.Diagnostics;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Flashcard generation, the error knowledge base's matching, and kata grading (Flashcards.cs, ErrorKb.cs, Katas.cs).</summary>
public class PracticeExtrasTests
{
    static string RepoRoot([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        for (var d = new DirectoryInfo(Path.GetDirectoryName(here)!); d is not null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "content", "katas")) && Directory.Exists(Path.Combine(d.FullName, "ui"))) return d.FullName;
        throw new DirectoryNotFoundException("repository root (content/katas)");
    }

    static readonly ErrorKb Kb = new(Path.Combine(RepoRoot(), "content", "errors"));

    // ------------------------------------------------------------ flashcards

    static JsonObject Lesson() => JsonNode.Parse("""
    {
      "title": "History",
      "steps": [
        { "type": "learn", "title": "Senior's toolkit: history", "body": "x",
          "toolkit": [ { "cmd": "git log --oneline --graph", "what": "See history; `git log` shows more with flags.",
                         "flags": [["--graph", "draw the branch lines"], ["--oneline", "one commit per line"]], "example": "git log --oneline --graph --all" } ] },
        { "type": "learn", "body": ["A **deadlock** is when two transactions wait for each other forever.", "```sql", "A **fake** is not a definition here.", "```",
                                    "- **Idempotent**: safe to repeat without changing the result again."] },
        { "type": "match", "prompt": "Match each flag.", "pairs": [["`-n`", "line numbers"], ["`-i`", "ignore case"]] }
      ],
      "cards": [ { "front": "Undo the last commit but keep the changes?", "back": "git reset --soft HEAD~1", "type": "command" } ]
    }
    """)!.AsObject();

    [Fact]
    public void Lesson_content_becomes_cards_of_every_kind()
    {
        var cards = Flashcards.FromLesson(Lesson(), "git/01-history/01-log");
        string[] Kinds(string k) => cards.Where(c => (string?)c["kind"] == k).Select(c => (string)c["front"]!).ToArray();
        Assert.Single(Kinds("command"));
        Assert.Single(Kinds("reverse"));
        Assert.Equal(2, Kinds("flag").Length);
        Assert.Equal(2, Kinds("match").Length);
        Assert.Equal(["**deadlock**", "**Idempotent**"], Kinds("term"));           // the bold line inside the code fence is not a term
        Assert.Single(Kinds("custom"));
        var reverse = cards.First(c => (string?)c["kind"] == "reverse");
        Assert.Equal("command", (string?)reverse["type"]);                          // shell commands can be typed
        Assert.DoesNotContain("git log", (string)reverse["front"]!);                // the answer is redacted from the question
        Assert.Equal("`git log --oneline --graph`", (string?)reverse["back"]);
        var term = cards.First(c => (string?)c["front"] == "**deadlock**");
        Assert.Equal("When two transactions wait for each other forever.", (string?)term["back"]);
        Assert.Equal(cards.Count, cards.Select(c => (string)c["id"]!).Distinct().Count());
        // Ids are stable: the same content gives the same ids.
        Assert.Equal(cards.Select(c => (string)c["id"]!), Flashcards.FromLesson(Lesson(), "git/01-history/01-log").Select(c => (string)c["id"]!));
    }

    [Fact]
    public void Hand_written_cards_are_validated()
    {
        var bad = JsonNode.Parse("""{ "cards": [ { "front": "a" }, { "front": "a", "back": "b", "type": "cloze" }, { "front": "c", "back": "x\ny", "type": "command" } ] }""")!.AsObject();
        var problems = Flashcards.Check(bad);
        Assert.Contains(problems, p => p.Contains("card 1") && p.Contains("\"back\""));
        Assert.Contains(problems, p => p.Contains("card 2") && p.Contains("same front"));
        Assert.Contains(problems, p => p.Contains("card 2") && p.Contains("\"type\""));
        Assert.Contains(problems, p => p.Contains("card 3") && p.Contains("one line"));
        Assert.Empty(Flashcards.Check(Lesson()));
    }

    [Fact]
    public void Real_lessons_give_cards()
    {
        var content = new Content(RepoRoot());
        var cards = Flashcards.ForLessons(content, ["git/02-history-and-undo/01-reading-history", "nope/../x", "git/xx/yy"]);
        // Whatever that lesson holds, bad keys are skipped without throwing; a toolkit lesson gives command cards.
        var toolkit = Directory.GetFiles(Path.Combine(RepoRoot(), "tracks", "git"), "*toolkit*.json", SearchOption.AllDirectories).First();
        var parts = Path.GetRelativePath(Path.Combine(RepoRoot(), "tracks"), toolkit).Replace('\\', '/').Replace(".json", "");
        var tk = Flashcards.ForLessons(content, [parts]);
        Assert.Contains(tk, c => (string?)c["kind"] == "command");
        Assert.Contains(tk, c => (string?)c["kind"] == "flag");
        Assert.NotNull(cards);
    }

    // ------------------------------------------------------------ error knowledge base

    [Fact]
    public void Knowledge_base_loads_cleanly_and_is_large()
    {
        var (entries, problems) = Kb.Load();
        Assert.Empty(problems);
        Assert.True(entries.Count >= 80, $"{entries.Count} entries");
        foreach (var lang in new[] { "csharp", "python", "typescript", "sql" }) Assert.Contains(entries, e => e.Language == lang);
    }

    static JsonObject First(JsonObject res) => (JsonObject)((JsonArray)res["problems"]!)[0]!;

    [Fact]
    public void Compiler_error_names_the_learners_variable_and_line()
    {
        var res = Kb.Explain(new("csharp", "var numbers = new[] { 1 };\nint total;\nforeach (var n in numbers) total += n;\nConsole.WriteLine(total);",
            [new Diag("error", "CS0165", "Use of unassigned local variable 'total'", 3, 30, "Program.cs")], "", []));
        var p = First(res);
        Assert.Equal("cs0165", (string?)p["entry"]!["id"]);
        Assert.Equal("`total` is read before it is assigned on line 3.", (string?)p["specific"]);
        Assert.Equal("foreach (var n in numbers) total += n;", (string?)p["lineText"]);
    }

    [Fact]
    public void Runtime_exception_in_stderr_is_matched_with_its_line()
    {
        var res = Kb.Explain(new("csharp", "var d = new Dictionary<string, int>();\nConsole.WriteLine(d[\"total\"]);", [],
            "Unhandled exception. System.Collections.Generic.KeyNotFoundException: The given key 'total' was not present in the dictionary.\n   at System.Collections.Generic.Dictionary`2.get_Item(TKey key)\n   at top-level code in Program.cs:line 2", []));
        var p = First(res);
        Assert.Equal("KeyNotFoundException", (string?)p["exception"]);
        Assert.Equal(2, (int)p["line"]!);
        Assert.NotNull(p["entry"]);
        Assert.Contains("total", (string?)p["specific"] ?? "");
    }

    [Fact]
    public void A_narrowed_entry_beats_the_generic_one_and_hunt_finds_the_line()
    {
        var code = "var xs = new List<int>();\nvar top = xs.Max();\nConsole.WriteLine(top);";
        var res = Kb.Explain(new("csharp", code, [], "", [new TestResult("Top score", false, "InvalidOperationException: Sequence contains no elements")]));
        var p = First(res);
        Assert.Contains("no elements", ((string?)p["entry"]!["title"] ?? "") + ((string?)p["entry"]!["explain"] ?? ""), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(2, (int)p["line"]!);
    }

    [Fact]
    public void Python_traceback_uses_the_innermost_learner_frame()
    {
        var res = Kb.Explain(new("python", "def f(x):\n    return x[\"a\"]\nprint(f({}))", [],
            "Traceback (most recent call last):\r\n  File \"main.py\", line 3, in <module>\r\n    print(f({}))\r\n  File \"main.py\", line 2, in f\r\n    return x[\"a\"]\r\nKeyError: 'a'\r\n", []));
        var p = First(res);
        Assert.Equal("KeyError", (string?)p["exception"]);
        Assert.Equal(2, (int)p["line"]!);
        Assert.NotNull(p["entry"]);
    }

    [Fact]
    public void Typescript_and_sql_errors_match()
    {
        var ts = First(Kb.Explain(new("typescript", "let n: number = \"x\";", [new Diag("error", "TS2322", "Type 'string' is not assignable to type 'number'.", 1, 5, "")], "", [])));
        Assert.Equal("TS2322", (string?)ts["code"]);
        Assert.NotNull(ts["entry"]);
        var sql = First(Kb.Explain(new("sql", "SELECT nope FROM t;", [new Diag("error", "SQL", "Line 1: no such column: nope", 1, 1, "")], "", [])));
        Assert.Equal("no such column: nope", (string?)sql["message"]);
        Assert.NotNull(sql["entry"]);
        Assert.Contains("nope", (string?)sql["specific"] ?? "");
    }

    [Fact]
    public void Wrong_output_is_not_an_error_to_explain()
    {
        var res = Kb.Explain(new("csharp", "Console.WriteLine(5);", [], "", [new TestResult("Prints 4", false, "expected\n4\nbut your program printed\n5")]));
        Assert.Empty((JsonArray)res["problems"]!);
    }

    // ------------------------------------------------------------ katas

    static readonly Katas AllKatas = new(RepoRoot());
    static readonly Checker Checker = new(new CSharpRunner());
    static readonly LangRunner Langs = new();

    [Fact]
    public void There_are_thirty_katas_in_four_languages_and_the_learner_never_sees_the_answers()
    {
        var all = AllKatas.Ids().Select(id => AllKatas.Get(id)!).ToList();
        Assert.True(all.Count >= 30, $"{all.Count} katas");
        foreach (var lang in Katas.Languages) Assert.True(all.Count(k => (string?)k["language"] == lang) >= 5, lang);
        foreach (var k in all)
        {
            var seen = Katas.ForLearner(k);
            foreach (var hidden in new[] { "solution", "template", "tests", "wrong" }) Assert.Null(seen[hidden]);
            Assert.NotNull(seen["prompt"]);
        }
    }

    [Fact]
    public async Task A_csharp_kata_passes_its_reference_and_fails_a_wrong_answer()
    {
        var k = AllKatas.Get("cs-parse-log-line")!;
        var good = await Katas.Grade(Checker, Langs, k, (string)k["solution"]!);
        Assert.True(good.Passed, string.Join("\n", good.Tests.Where(t => !t.Pass).Select(t => t.Name + ": " + t.Detail)));
        var wrong = await Katas.Grade(Checker, Langs, k, (string)((JsonArray)k["wrong"]!)[0]!);
        Assert.False(wrong.Passed);
        Assert.False((await Katas.Grade(Checker, Langs, k, (string)k["starter"]!)).Passed);
    }

    [Fact]
    public async Task A_sql_kata_compares_rows_with_the_reference()
    {
        var k = AllKatas.Get("sql-top-n-per-group")!;
        Assert.True((await Katas.Grade(Checker, Langs, k, (string)k["solution"]!)).Passed);
        var rowNumber = (string)((JsonArray)k["wrong"]!)[1]!;     // ROW_NUMBER drops a tie for second place
        var r = await Katas.Grade(Checker, Langs, k, rowNumber);
        Assert.False(r.Passed);
        Assert.Contains(r.Tests, t => !t.Pass);
    }

    // ------------------------------------------------------------ the scheduler (ui/srs.js, in Node)

    [Fact]
    public async Task Scheduler_and_type_it_pass_their_node_checks()
    {
        var node = CodeSpaces.NodeExe();
        if (node is null) return;
        var root = RepoRoot();
        var psi = new ProcessStartInfo(node) { WorkingDirectory = root, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        psi.ArgumentList.Add(Path.Combine(root, "tests", "CodeDojo.Tests", "srs.test.mjs"));
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        await p.WaitForExitAsync(cts.Token);
        var output = await stdout + await stderr;
        Assert.True(p.ExitCode == 0, output);
        Assert.Contains("checks passed", output);
    }
}
