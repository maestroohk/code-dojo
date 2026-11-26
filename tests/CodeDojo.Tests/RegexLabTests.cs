using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

public class RegexLabTests
{
    static JsonObject Step(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void Run_reports_matches_groups_and_names()
    {
        var r = RegexLab.Run(new(@"(?<year>\d{4})-(\d{2})", "", "on 2026-11 and 1999-01", null));
        Assert.Null(r.Error);
        Assert.Equal(2, r.Matches.Count);
        Assert.Equal("2026-11", r.Matches[0].Value);
        Assert.Equal(3, r.Matches[0].Index);
        // .NET numbers unnamed groups first, then named ones: (\d{2}) is 1, year is 2.
        Assert.Equal("11", r.Matches[0].Groups.Single(g => g.Number == 1).Value);
        Assert.Equal("year", r.Matches[0].Groups.Single(g => g.Number == 2).Name);
        Assert.Equal("1999", r.Matches[1].Groups.Single(g => g.Name == "year").Value);
    }

    [Fact]
    public void Run_replaces_and_splits()
    {
        var r = RegexLab.Run(new(@"(\w+)@(\w+)", "", "ann@x, bob@y", "$2:$1"));
        Assert.Equal("x:ann, y:bob", r.Replaced);
        var s = RegexLab.Run(new(@"\s*,\s*", "", "a , b,c", null));
        Assert.Equal(["a", "b", "c"], s.Split);
    }

    [Fact]
    public void Parse_errors_are_plain_and_carry_the_offset()
    {
        var r = RegexLab.Run(new("(abc", "", "abc", null));
        Assert.NotNull(r.Error);
        Assert.Contains("never closed", r.Error);
        Assert.Equal("InsufficientClosingParentheses", r.ErrorCode);
        Assert.True(r.ErrorOffset >= 0);
        Assert.Contains("Unknown flag", RegexLab.Run(new("a", "q", "a", null)).Error);
    }

    [Fact]
    public void Catastrophic_backtracking_hits_the_timeout_and_nonbacktracking_does_not()
    {
        var input = new string('a', 40) + "!";
        var slow = RegexLab.Run(new(@"^(a+)+$", "", input, null, TimeoutMs: 100));
        Assert.True(slow.TimedOut);
        Assert.NotNull(slow.Note);
        var fast = RegexLab.Run(new(@"^(a+)+$", "", input, null, NonBacktracking: true, TimeoutMs: 100));
        Assert.False(fast.TimedOut);
        Assert.Empty(fast.Matches);
        var atomic = RegexLab.Run(new(@"^(?>a+)+$", "", input, null, TimeoutMs: 100));
        Assert.False(atomic.TimedOut);
    }

    [Fact]
    public void NonBacktracking_explains_what_it_cannot_do()
    {
        var r = RegexLab.Run(new(@"(?<=\$)\d+", "", "$5", null, NonBacktracking: true));
        Assert.NotNull(r.Error);
    }

    const string TicketStep = """
        { "type": "regex", "prompt": "Ticket ids", "solution": "\\b[A-Z]{2,5}-\\d+\\b",
          "tests": {
            "match": ["ABC-12", "OPS-7"],
            "reject": ["abc-12", "ABC-", "TOOLONG-1"],
            "noFind": ["no ticket here"],
            "all": [{ "input": "fix ABC-12 and OPS-7 today", "matches": ["ABC-12", "OPS-7"] }]
          } }
        """;

    [Fact]
    public void Grade_passes_the_reference_and_names_each_failure()
    {
        var step = Step(TicketStep);
        Assert.True(RegexLab.Grade(step, @"\b[A-Z]{2,5}-\d+\b", null, null).Passed);
        var loose = RegexLab.Grade(step, @"[A-Z]+-\d*", null, null);
        Assert.False(loose.Passed);
        Assert.Contains(loose.Tests, t => !t.Pass && t.Kind == "reject" && t.Input == "ABC-");
        Assert.Contains(loose.Tests, t => !t.Pass && t.Kind == "reject" && t.Input == "TOOLONG-1");
        // Highlights: where the pattern matched, so the page can colour it.
        var all = loose.Tests.First(t => t.Kind == "all");
        Assert.Contains(all.Spans, s => s[2] == 0 && s[0] == 4);
    }

    [Fact]
    public void Full_match_means_the_whole_string_even_with_alternation()
    {
        // a|ab finds "a" first in "ab", but "ab" as a whole is still a full match (like Python's re.fullmatch).
        var step = Step("""{ "type": "regex", "prompt": "p", "solution": "a|ab", "tests": { "match": ["ab"], "reject": ["abc"] } }""");
        Assert.True(RegexLab.Grade(step, "a|ab", null, null).Passed);
        // x mode: a trailing comment must not swallow the wrapper.
        var x = Step("""{ "type": "regex", "prompt": "p", "solution": "a  # letter a", "flags": "x", "tests": { "match": ["a"], "reject": ["aa"] } }""");
        Assert.True(RegexLab.Grade(x, "a  # letter a", "x", null).Passed);
    }

    [Fact]
    public void Grade_checks_captures_by_number_and_name_and_replacements()
    {
        var step = Step("""
            { "type": "regex", "prompt": "p", "solution": "(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})", "solutionReplacement": "${d}/${m}/${y}",
              "tests": {
                "captures": [{ "input": "due 2026-03-09", "groups": { "y": "2026", "m": "03", "d": "09" } }],
                "replace": [{ "input": "2026-03-09 and 2025-12-31", "output": "09/03/2026 and 31/12/2025" }]
              } }
            """);
        var (p, f, rep) = RegexLab.Solution(step);
        Assert.True(RegexLab.Grade(step, p, f, rep).Passed);
        var wrongName = RegexLab.Grade(step, @"(\d{4})-(\d{2})-(\d{2})", null, "$3/$2/$1");
        Assert.False(wrongName.Passed);
        Assert.Contains("does not exist", wrongName.Tests.First(t => t.Kind == "captures").Detail);
        Assert.True(wrongName.Tests.First(t => t.Kind == "replace").Pass);
    }

    [Fact]
    public void A_catastrophic_pattern_fails_the_fast_test_instead_of_hanging()
    {
        var step = Step("""
            { "type": "regex", "prompt": "p", "solution": "^\\w+(?:\\.\\w+)*$",
              "tests": { "match": ["a.b.c"], "reject": ["a..b"], "fast": [{ "repeat": "a", "times": 3000, "suffix": "!" }] } }
            """);
        Assert.True(RegexLab.Grade(step, @"^\w+(?:\.\w+)*$", null, null).Passed);
        var bad = RegexLab.Grade(step, @"^(\w+\.?)*$", null, null);
        Assert.False(bad.Passed);
        Assert.True(bad.TimedOut);
        Assert.Contains("Timed out", bad.Tests.First(t => !t.Pass).Detail);
    }

    [Fact]
    public void Validate_rejects_a_step_that_naive_patterns_pass()
    {
        var weak = Step("""{ "type": "regex", "prompt": "p", "solution": "\\d+", "tests": { "find": ["a1"] } }""");
        Assert.Contains(RegexLab.Validate(weak), i => i.Error && i.Message.Contains("naive"));
        var broken = Step("""{ "type": "regex", "prompt": "p", "solution": "\\d", "tests": { "match": ["12"] } }""");
        Assert.Contains(RegexLab.Validate(broken), i => i.Error && i.Message.Contains("reference solution does not pass"));
        Assert.DoesNotContain(RegexLab.Validate(Step(TicketStep)), i => i.Error);
    }

    [Fact]
    public void Rules_and_golf_limits_apply_to_the_pattern_text()
    {
        var step = Step("""
            { "type": "regex", "prompt": "p", "solution": "<.+?>", "maxLength": 6,
              "forbid": [{ "pattern": "\\[\\^", "message": "Uses a lazy quantifier, not a negated class" }],
              "tests": { "all": [{ "input": "<b>x</b>", "matches": ["<b>", "</b>"] }] } }
            """);
        Assert.True(RegexLab.Grade(step, "<.+?>", null, null).Passed);
        Assert.False(RegexLab.Grade(step, "<[^>]+>", null, null).Passed);
    }

    [Fact]
    public void Generated_input_builds_long_text()
    {
        Assert.Equal("xaaa!", RegexLab.InputOf(JsonNode.Parse("""{ "prefix": "x", "repeat": "a", "times": 3, "suffix": "!" }""")));
    }

    [Fact]
    public async Task GeneratedRegex_compiles_with_the_sdk_source_generator()
    {
        var runner = new CSharpRunner();
        var code = """
            using System.Text.RegularExpressions;
            Console.WriteLine(Patterns.Ticket().IsMatch("OPS-42"));
            static partial class Patterns
            {
                [GeneratedRegex(@"^[A-Z]{2,5}-\d+$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 250)]
                public static partial Regex Ticket();
            }
            """;
        var (program, diags) = runner.Compile(code);
        Assert.True(program is not null, string.Join("; ", diags.Select(d => d.Message)));
        using (program)
        {
            var run = await runner.Run(program!, null);
            Assert.Equal("True", run.Stdout.Trim());
        }
    }
}
