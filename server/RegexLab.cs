using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// Regular expressions, run for real by System.Text.RegularExpressions (the .NET flavour is the authoritative one):
///   POST /api/regex         the regex lab: matches with every group, replace, split, timings, real timeouts
///   POST /api/regex/check   grades a lesson's "regex" step (tracks/AUTHORING.md, "regex — write a pattern")
/// Every regex is built with a match timeout, so a catastrophic pattern costs a fraction of a second, never the server.
/// </summary>
public static class RegexLab
{
    public const int LabTimeoutMs = 1000;
    public const int GradeTimeoutMs = 250;
    const int MaxInput = 200_000;
    const int MaxMatches = 1000;
    const int MaxPattern = 5000;

    public record RunRequest(string? Pattern, string? Flags, string? Input, string? Replacement, bool NonBacktracking = false, int? TimeoutMs = null);
    public record CaptureOut(int Index, int Length, string Value);
    public record GroupOut(int Number, string Name, bool Success, int Index, int Length, string Value, List<CaptureOut> Captures);
    public record MatchOut(int Index, int Length, string Value, List<GroupOut> Groups);
    public record RunResult(string? Error, int ErrorOffset, string? ErrorCode, bool TimedOut, double Ms, List<MatchOut> Matches, bool Truncated,
        List<string> GroupNames, string Options, string? Replaced, List<string>? Split, string? Note);

    /// <summary>Flags as letters, the way regex101 and most tools show them. g is accepted and ignored: .NET's Matches always finds them all.</summary>
    public static (RegexOptions Options, string? Error) ParseFlags(string? flags, bool nonBacktracking = false)
    {
        var o = RegexOptions.None;
        foreach (var c in flags ?? "")
        {
            switch (c)
            {
                case 'i': o |= RegexOptions.IgnoreCase; break;
                case 'm': o |= RegexOptions.Multiline; break;
                case 's': o |= RegexOptions.Singleline; break;
                case 'x': o |= RegexOptions.IgnorePatternWhitespace; break;
                case 'n': o |= RegexOptions.ExplicitCapture; break;
                case 'c': o |= RegexOptions.CultureInvariant; break;
                case 'r': o |= RegexOptions.RightToLeft; break;
                case 'e': o |= RegexOptions.ECMAScript; break;
                case 'g': case 'u': case ' ': break;
                default: return (o, $"Unknown flag '{c}'. .NET flags: i (IgnoreCase), m (Multiline), s (Singleline), x (IgnorePatternWhitespace), n (ExplicitCapture), c (CultureInvariant), r (RightToLeft).");
            }
        }
        if (nonBacktracking) o |= RegexOptions.NonBacktracking;
        return (o, null);
    }

    /// <summary>Builds the regex, or explains in plain words why it does not parse (with the offset of the problem).</summary>
    public static (Regex? Regex, string? Error, int Offset, string? Code) Build(string pattern, RegexOptions options, int timeoutMs)
    {
        if (pattern.Length > MaxPattern) return (null, $"The pattern is longer than {MaxPattern} characters.", -1, "TooLong");
        try { return (new Regex(pattern, options, TimeSpan.FromMilliseconds(timeoutMs)), null, -1, null); }
        catch (RegexParseException e) { return (null, Plain(e), e.Offset, e.Error.ToString()); }
        catch (NotSupportedException e) { return (null, e.Message, -1, "NotSupported"); }
        catch (ArgumentException e) { return (null, e.Message, -1, "Invalid"); }
    }

    /// <summary>.NET's parse errors, without the "Invalid pattern '...' at offset N." preamble the page already shows.</summary>
    static string Plain(RegexParseException e)
    {
        var msg = e.Message;
        var at = msg.IndexOf(". ", msg.IndexOf("at offset", StringComparison.Ordinal) is var k and >= 0 ? k : 0, StringComparison.Ordinal);
        var tail = at >= 0 ? msg[(at + 2)..] : msg;
        return e.Error switch
        {
            RegexParseError.InsufficientClosingParentheses => "A group is opened with ( but never closed with ).",
            RegexParseError.InsufficientOpeningParentheses => "There is a ) with no ( to close. Escape it as \\) to match a literal bracket.",
            RegexParseError.UnterminatedBracket => "A character class [ is never closed with ].",
            RegexParseError.QuantifierAfterNothing => "A quantifier (*, +, ? or {n}) has nothing before it to repeat. Escape it (\\*, \\+, \\?) to match the character itself.",
            RegexParseError.NestedQuantifiersNotParenthesized => "Two quantifiers in a row (like a**). Put the first in a group if you mean to repeat a repetition.",
            RegexParseError.UndefinedNumberedReference => "A backreference names a group number that does not exist.",
            RegexParseError.UndefinedNamedReference => "A backreference names a group that does not exist.",
            RegexParseError.ReversedCharacterRange => "A range in a class goes backwards, like [z-a]. Write the smaller character first.",
            RegexParseError.ReversedQuantifierRange => "A {min,max} quantifier has min bigger than max.",
            RegexParseError.UnescapedEndingBackslash => "The pattern ends with a lone backslash. Write \\\\ for a literal backslash.",
            RegexParseError.UnrecognizedEscape => "An escape that .NET does not know. " + tail,
            RegexParseError.InvalidUnicodePropertyEscape or RegexParseError.UnrecognizedUnicodeProperty => "Unknown Unicode category in \\p{...}. Try \\p{L} (letters), \\p{Lu}, \\p{N}, \\p{P}, or a block such as \\p{IsGreek}.",
            _ => tail,
        };
    }

    public static RunResult Run(RunRequest req)
    {
        var pattern = req.Pattern ?? "";
        var input = (req.Input ?? "").Replace("\r\n", "\n");
        var empty = new List<MatchOut>();
        if (input.Length > MaxInput) return new($"The test text is longer than {MaxInput:N0} characters.", -1, "TooLong", false, 0, empty, false, [], "", null, null, null);
        var (options, flagError) = ParseFlags(req.Flags, req.NonBacktracking);
        if (flagError is not null) return new(flagError, -1, "Flags", false, 0, empty, false, [], "", null, null, null);
        var timeout = Math.Clamp(req.TimeoutMs ?? LabTimeoutMs, 50, 2000);
        var (regex, error, offset, code) = Build(pattern, options, timeout);
        if (regex is null) return new(error, offset, code, false, 0, empty, false, [], options.ToString(), null, null, null);

        var names = regex.GetGroupNames().ToList();
        var numbers = regex.GetGroupNumbers();
        var sw = Stopwatch.StartNew();
        var matches = new List<MatchOut>();
        bool timedOut = false, truncated = false;
        string? replaced = null;
        List<string>? split = null;
        try
        {
            for (var m = regex.Match(input); m.Success; m = m.NextMatch())
            {
                if (matches.Count >= MaxMatches || sw.ElapsedMilliseconds > 4000) { truncated = true; break; }
                matches.Add(new(m.Index, m.Length, m.Value, numbers.Select(n =>
                {
                    var g = m.Groups[n];
                    return new GroupOut(n, regex.GroupNameFromNumber(n), g.Success, g.Index, g.Length, g.Value,
                        g.Captures.Take(50).Select(c => new CaptureOut(c.Index, c.Length, c.Value)).ToList());
                }).ToList()));
            }
            if (req.Replacement is not null) replaced = regex.Replace(input, req.Replacement);
            if (!truncated && input.Length <= 20_000) split = regex.Split(input).Take(500).ToList();
        }
        catch (RegexMatchTimeoutException) { timedOut = true; }
        sw.Stop();
        string? note = null;
        if (timedOut)
            note = $"Stopped by the match timeout ({timeout} ms). With backtracking, some patterns take exponential time on text that almost matches. " +
                   "Try the NonBacktracking engine, an atomic group (?>...) or a possessive-style rewrite.";
        return new(null, -1, null, timedOut, Math.Round(sw.Elapsed.TotalMilliseconds, 3), matches, truncated, names, options.ToString(), replaced, split, note);
    }

    // ================================================================ graded "regex" steps

    public record CheckRequest(string Track, string Module, string Lesson, int Step, string? Pattern, string? Flags, string? Replacement, string? Dream = null);

    /// <summary>One check. Spans are [index, length, group] of what the pattern found in Input (group 0 = the whole match), for highlighting.</summary>
    public record RegexTest(string Kind, string Name, bool Pass, string Detail, string Input, List<int[]> Spans, string? Expected = null, string? Actual = null);

    public record GradeResult(bool Passed, bool Compiled, string? Error, int ErrorOffset, List<RegexTest> Tests, bool TimedOut, double Ms)
    {
        /// <summary>The same shape as a code step's results, so Practice and the validator can read it.</summary>
        public List<TestResult> Rows => Tests.Select(t => new TestResult(t.Name, t.Pass, t.Detail)).ToList();
    }

    /// <summary>Reads a test input: a string, or { "repeat": "a", "times": 30, "prefix": "", "suffix": "!" } for long generated text.</summary>
    public static string InputOf(JsonNode? node)
    {
        if (node is JsonValue v && v.TryGetValue<string>(out var s)) return s;
        if (node is JsonObject o)
        {
            if (o["input"] is { } inner) return InputOf(inner);
            var times = Math.Clamp((int?)o["times"] ?? 1, 0, 100_000);
            return ((string?)o["prefix"] ?? "") + string.Concat(Enumerable.Repeat((string?)o["repeat"] ?? "", times)) + ((string?)o["suffix"] ?? "");
        }
        if (node is JsonArray lines) return string.Join("\n", lines.Select(l => (string?)l ?? ""));
        return "";
    }

    static string Show(string s, int max = 48)
    {
        var flat = s.Replace("\n", "\\n").Replace("\t", "\\t");
        return "\"" + (flat.Length > max ? flat[..(max - 1)] + "…" : flat) + "\"";
    }

    static string ShowList(IEnumerable<string> items) => "[" + string.Join(", ", items.Select(i => Show(i, 30))) + "]";

    /// <summary>The pattern wrapped so it must match the whole input (like Python's re.fullmatch), checked after the pattern parses on its own.</summary>
    static string Whole(string pattern, RegexOptions options)
    {
        // In x mode a trailing # comment would swallow the closing parenthesis, so end the pattern's last line first.
        var x = options.HasFlag(RegexOptions.IgnorePatternWhitespace) || Regex.IsMatch(pattern, @"\(\?[imnsx]*x");
        return @"\A(?:" + pattern + (x ? "\n" : "") + @")\z";
    }

    static List<int[]> SpansOf(Regex regex, string input, int max = 40)
    {
        var spans = new List<int[]>();
        var count = 0;
        for (var m = regex.Match(input); m.Success && count < max; m = m.NextMatch(), count++)
        {
            spans.Add([m.Index, m.Length, 0]);
            for (var g = 1; g < m.Groups.Count; g++)
                if (m.Groups[g].Success) spans.Add([m.Groups[g].Index, m.Groups[g].Length, g]);
        }
        return spans;
    }

    /// <summary>Grades a pattern (plus flags and replacement) against a "regex" step's tests.</summary>
    public static GradeResult Grade(JsonObject step, string pattern, string? flags, string? replacement)
    {
        var sw = Stopwatch.StartNew();
        var tests = new List<RegexTest>();
        var fixedFlags = (bool?)step["lockFlags"] == true;
        var useFlags = fixedFlags ? (string?)step["flags"] ?? "" : flags ?? (string?)step["flags"] ?? "";
        var (options, flagError) = ParseFlags(useFlags, (bool?)step["nonBacktracking"] == true);
        if (flagError is not null) return new(false, false, flagError, -1, tests, false, 0);
        if (pattern.Length == 0) return new(false, false, "Write a pattern first.", -1, tests, false, 0);
        var timeout = Math.Clamp((int?)step["timeoutMs"] ?? GradeTimeoutMs, 50, 2000);
        var (regex, error, offset, _) = Build(pattern, options, timeout);
        if (regex is null) return new(false, false, error, offset, tests, false, 0);
        // A step may fix the replacement ("replacement") so only the pattern is the learner's.
        var repl = step["replacement"] is JsonValue fixedRepl && fixedRepl.TryGetValue<string>(out var fr) ? fr : replacement ?? "";
        Regex? whole = null;
        var timedOut = false;

        // Rules about the pattern text itself: "use a lazy quantifier", "no .* allowed", golf limits.
        foreach (var (key, want) in new[] { ("require", true), ("forbid", false) })
            foreach (var rule in (step[key] as JsonArray ?? []).OfType<JsonObject>())
            {
                var ok = Regex.IsMatch(pattern, (string?)rule["pattern"] ?? "", RegexOptions.None, TimeSpan.FromSeconds(1)) == want;
                tests.Add(new(key, (string?)rule["message"] ?? key, ok, ok ? "" : want ? "Your pattern needs this to count as solved." : "This exercise asks you to solve it another way.", "", []));
            }
        if ((int?)step["maxLength"] is int max)
            tests.Add(new("length", $"The pattern is at most {max} characters", pattern.Length <= max, $"Yours is {pattern.Length} characters.", "", []));

        var t = step["tests"] as JsonObject ?? [];
        void Add(string kind, string name, Func<string, (bool Pass, string Detail, string? Expected, string? Actual)> check, string input, Regex? spansFrom = null)
        {
            try
            {
                var (pass, detail, expected, actual) = check(input);
                List<int[]> spans;
                try { spans = SpansOf(spansFrom ?? regex!, input); } catch (RegexMatchTimeoutException) { spans = []; }
                tests.Add(new(kind, name, pass, detail, input, spans, expected, actual));
            }
            catch (RegexMatchTimeoutException)
            {
                timedOut = true;
                tests.Add(new(kind, name, false, $"Timed out after {timeout} ms on this input. The engine is backtracking through too many ways to match: look for nested or overlapping quantifiers such as (a+)+ or (\\w|\\d)*.", input, []));
            }
            catch (ArgumentException e)
            {
                tests.Add(new(kind, name, false, e.Message, input, []));
            }
        }
        Regex WholeRegex() => whole ??= new Regex(Whole(pattern, options), options, TimeSpan.FromMilliseconds(timeout));

        foreach (var n in t["match"] as JsonArray ?? [])
        {
            var input = InputOf(n);
            Add("match", $"Matches all of {Show(input)}", s =>
            {
                if (WholeRegex().IsMatch(s)) return (true, "", null, null);
                var m = regex.Match(s);
                return (false, m.Success ? $"It only matches part of it: {Show(m.Value)} at position {m.Index}. The whole text should match: check the ends, or add ^ and $." : "It does not match this at all.", null, null);
            }, input);
        }
        foreach (var n in t["reject"] as JsonArray ?? [])
        {
            var input = InputOf(n);
            Add("reject", $"Does not match {Show(input)}", s =>
                WholeRegex().IsMatch(s) ? (false, "It matches, but it should not: this text is invalid.", null, null) : (true, "", null, null), input);
        }
        foreach (var n in t["find"] as JsonArray ?? [])
        {
            var input = InputOf(n);
            Add("find", $"Finds a match in {Show(input)}", s =>
                regex.IsMatch(s) ? (true, "", null, null) : (false, "It finds nothing in this text.", null, null), input);
        }
        foreach (var n in t["noFind"] as JsonArray ?? [])
        {
            var input = InputOf(n);
            Add("noFind", $"Finds nothing in {Show(input)}", s =>
            {
                var m = regex.Match(s);
                return m.Success ? (false, $"It finds {Show(m.Value)} at position {m.Index}, but should find nothing here.", null, null) : (true, "", null, null);
            }, input);
        }
        foreach (var o in (t["all"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var input = InputOf(o["input"]);
            var want = (o["matches"] as JsonArray ?? []).Select(x => (string?)x ?? "").ToList();
            Add("all", (string?)o["name"] ?? $"Finds exactly {ShowList(want)} in {Show(input, 36)}", s =>
            {
                var got = regex.Matches(s).Select(m => m.Value).ToList();
                var ok = got.SequenceEqual(want);
                return (ok, ok ? "" : $"Expected {want.Count} match{(want.Count == 1 ? "" : "es")}: {ShowList(want)}\nFound {got.Count}: {ShowList(got.Take(12))}", string.Join("\n", want), string.Join("\n", got));
            }, input);
        }
        foreach (var o in (t["captures"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var input = InputOf(o["input"]);
            var which = (int?)o["match"] ?? 0;
            var groups = o["groups"] as JsonObject ?? [];
            var label = string.Join(", ", groups.Select(g => $"{(int.TryParse(g.Key, out _) ? "$" + g.Key : g.Key)} = {(g.Value is null ? "(no match)" : Show((string?)g.Value ?? "", 24))}"));
            Add("captures", (string?)o["name"] ?? $"In {Show(input, 34)}{(which > 0 ? $" (match {which + 1})" : "")}: {label}", s =>
            {
                var ms = regex.Matches(s);
                if (ms.Count <= which) return (false, ms.Count == 0 ? "It finds no match here." : $"It finds only {ms.Count} match{(ms.Count == 1 ? "" : "es")}.", null, null);
                var m = ms[which];
                var wrong = new List<string>();
                foreach (var (key, value) in groups)
                {
                    var g = int.TryParse(key, out var num) ? m.Groups[num] : m.Groups[key];
                    var exists = int.TryParse(key, out num) ? regex.GetGroupNumbers().Contains(num) : regex.GetGroupNames().Contains(key);
                    var expect = (string?)value;
                    var name = int.TryParse(key, out _) ? $"group {key}" : $"group '{key}'";
                    if (!exists) wrong.Add($"{name} does not exist in your pattern{(int.TryParse(key, out _) ? "" : $": name it with (?<{key}>...)")}.");
                    else if (expect is null && g.Success) wrong.Add($"{name} should not take part, but captured {Show(g.Value)}.");
                    else if (expect is not null && (!g.Success || g.Value != expect)) wrong.Add($"{name} should be {Show(expect)} but is {(g.Success ? Show(g.Value) : "not set (it did not take part in the match)")}.");
                }
                return (wrong.Count == 0, string.Join("\n", wrong), null, null);
            }, input);
        }
        foreach (var o in (t["replace"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var input = InputOf(o["input"]);
            var want = InputOf(o["output"]);
            Add("replace", (string?)o["name"] ?? $"Turns {Show(input, 30)} into {Show(want, 30)}", s =>
            {
                var got = regex.Replace(s, repl);
                return got == want ? (true, "", want, got) : (false, $"Expected: {Show(want, 80)}\nGot:      {Show(got, 80)}", want, got);
            }, input);
        }
        foreach (var o in (t["split"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var input = InputOf(o["input"]);
            var want = (o["parts"] as JsonArray ?? []).Select(x => (string?)x ?? "").ToList();
            Add("split", (string?)o["name"] ?? $"Regex.Split gives {ShowList(want)}", s =>
            {
                var got = regex.Split(s).ToList();
                var ok = got.SequenceEqual(want);
                return (ok, ok ? "" : $"Expected {ShowList(want)}\nGot      {ShowList(got.Take(12))}", null, null);
            }, input);
        }
        foreach (var n in t["fast"] as JsonArray ?? [])
        {
            var input = InputOf(n);
            Add("fast", $"Answers quickly on a {input.Length:N0}-character input", s =>
            {
                regex.Matches(s).Count.ToString();   // force the whole scan
                WholeRegex().IsMatch(s);
                return (true, "", null, null);
            }, input);
        }
        sw.Stop();
        var passed = tests.Count > 0 && tests.All(x => x.Pass);
        return new(passed, true, null, -1, tests, timedOut, Math.Round(sw.Elapsed.TotalMilliseconds, 2));
    }

    /// <summary>The reference answer of a step: (pattern, flags, replacement).</summary>
    public static (string Pattern, string? Flags, string? Replacement) Solution(JsonObject step) =>
        ((string?)step["solution"] ?? "", (string?)step["solutionFlags"] ?? (string?)step["flags"], (string?)step["solutionReplacement"] ?? (string?)step["replacement"]);

    /// <summary>Lint for `dojo validate`: the reference passes, and an empty or naive pattern does not.</summary>
    public static List<(bool Error, string Message)> Validate(JsonObject step)
    {
        var issues = new List<(bool, string)>();
        if (step["prompt"] is null) issues.Add((true, "missing 'prompt'"));
        if (step["tests"] is not JsonObject tests || tests.Count == 0) { issues.Add((true, "missing 'tests' object (match, reject, find, noFind, all, captures, replace, split, fast)")); return issues; }
        var known = new HashSet<string> { "match", "reject", "find", "noFind", "all", "captures", "replace", "split", "fast" };
        foreach (var (k, _) in tests) if (!known.Contains(k)) issues.Add((true, $"unknown test kind '{k}' (use {string.Join(", ", known)})"));
        foreach (var k in new[] { "require", "forbid" })
            foreach (var r in (step[k] as JsonArray ?? []).OfType<JsonObject>())
                try { _ = new Regex((string?)r["pattern"] ?? ""); } catch (ArgumentException e) { issues.Add((true, $"{k} rule does not parse: {e.Message}")); }
        var (pattern, flags, replacement) = Solution(step);
        if (pattern.Length == 0) { issues.Add((true, "missing 'solution' (the reference pattern)")); return issues; }
        var good = Grade(step, pattern, flags, replacement);
        if (!good.Passed)
            issues.Add((true, "reference solution does not pass -> " + (good.Error ?? string.Join("; ", good.Tests.Where(x => !x.Pass).Select(x => $"{x.Name}: {x.Detail}"))).Replace("\n", " | ")));
        // An empty pattern matches the empty string everywhere, and .* matches anything: a step must tell them apart.
        foreach (var (naive, fatal) in new[] { ("(?:)", true), (".*", true), (".+", false), (@"\w+", false) })
            if (naive != pattern && Grade(step, naive, flags, replacement).Passed)
                issues.Add((fatal, $"the naive pattern {naive} also passes: add tests it fails (reject, noFind or exact captures)"));
        if ((string?)step["starter"] is { Length: > 0 } starter && Grade(step, starter, (string?)step["flags"], (string?)step["starterReplacement"] ?? replacement).Passed)
            issues.Add((false, "the starter pattern already passes"));
        return issues;
    }

    public static void Map(WebApplication app, Content content)
    {
        app.MapPost("/api/regex", (RunRequest req) => Results.Json(Run(req), JsonOpts));
        app.MapPost("/api/regex/check", (CheckRequest req) =>
        {
            var lesson = content.Lesson(req.Track, req.Module, req.Lesson, req.Dream);
            if ((lesson?["steps"] as JsonArray)?.ElementAtOrDefault(req.Step) is not JsonObject step || (string?)step["type"] != "regex")
                return Results.NotFound();
            var r = Grade(step, req.Pattern ?? "", req.Flags, req.Replacement);
            return Results.Json(new { passed = r.Passed, compiled = r.Compiled, error = r.Error, errorOffset = r.ErrorOffset, tests = r.Tests, timedOut = r.TimedOut, ms = r.Ms }, JsonOpts);
        });
        // The lab's challenges: the checks live in the page (nothing to hide), graded the same way as lesson steps.
        app.MapPost("/api/regex/grade", (GradeRequest req) =>
        {
            if (req.Step is not JsonObject step) return Results.BadRequest("missing step");
            var r = Grade(step, req.Pattern ?? "", req.Flags, req.Replacement);
            return Results.Json(new { passed = r.Passed, compiled = r.Compiled, error = r.Error, errorOffset = r.ErrorOffset, tests = r.Tests, timedOut = r.TimedOut, ms = r.Ms }, JsonOpts);
        });
        // Live highlighting for a lesson step: what .NET finds in each sample while the learner types.
        app.MapPost("/api/regex/preview", (PreviewRequest req) => Results.Json(Preview(req), JsonOpts));
    }

    public record GradeRequest(JsonObject? Step, string? Pattern, string? Flags, string? Replacement);
    public record PreviewRequest(string? Pattern, string? Flags, List<string>? Inputs, string? Replacement, bool NonBacktracking = false);
    public record PreviewItem(List<int[]> Spans, string? Replaced, bool TimedOut);

    public static object Preview(PreviewRequest req)
    {
        var (options, flagError) = ParseFlags(req.Flags, req.NonBacktracking);
        if (flagError is not null) return new { error = flagError, errorOffset = -1, items = Array.Empty<PreviewItem>() };
        var (regex, error, offset, _) = Build(req.Pattern ?? "", options, GradeTimeoutMs);
        if (regex is null) return new { error, errorOffset = offset, items = Array.Empty<PreviewItem>() };
        var items = new List<PreviewItem>();
        foreach (var input in (req.Inputs ?? []).Take(40))
        {
            var text = input.Length > 20_000 ? input[..20_000] : input;
            try { items.Add(new(SpansOf(regex, text), req.Replacement is null ? null : regex.Replace(text, req.Replacement), false)); }
            catch (RegexMatchTimeoutException) { items.Add(new([], null, true)); }
        }
        return new { error = (string?)null, errorOffset = -1, items };
    }

    static readonly System.Text.Json.JsonSerializerOptions JsonOpts = new(System.Text.Json.JsonSerializerDefaults.Web);
}
