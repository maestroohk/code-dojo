using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// `dojo validate [filter]` — the content self-test. Lints every step and proves every
/// code exercise is solvable by running its reference solution through the real checker.
/// </summary>
public static class Validator
{
    public static async Task<int> Run(Content content, Checker checker, CSharpRunner runner, string? filter, bool puzzles = false)
    {
        int lessons = 0, steps = 0, code = 0, errors = 0, warnings = 0, puzzlesChecked = 0, unverifiable = 0;

        void Error(string where, string msg) { errors++; Console.WriteLine($"  ERROR {where}: {msg}"); }
        void Warn(string where, string msg) { warnings++; Console.WriteLine($"  warn  {where}: {msg}"); }

        foreach (var track in content.Tracks().OfType<JsonObject>())
        foreach (var module in (track["modules"] as JsonArray ?? []).OfType<JsonObject>())
        foreach (var meta in (module["lessons"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var key = $"{track["id"]}/{module["id"]}/{meta["id"]}";
            if (filter is not null && !key.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            lessons++;
            Console.WriteLine(key);

            JsonObject? lesson;
            try { lesson = content.Lesson((string)track["id"]!, (string)module["id"]!, (string)meta["id"]!); }
            catch (Exception e) { Error(key, "cannot parse: " + e.Message); continue; }
            if (lesson is null) { Error(key, "bad file name (use lowercase letters, digits and dashes)"); continue; }
            if ((string?)lesson["title"] is null) Error(key, "missing title");

            var list = lesson["steps"] as JsonArray ?? [];
            if (list.Count == 0) Error(key, "no steps");
            for (var i = 0; i < list.Count; i++)
            {
                steps++;
                var where = $"step {i + 1}";
                if (list[i] is not JsonObject step) { Error(where, "not an object"); continue; }
                var type = (string?)step["type"] ?? "";
                where += $" ({type})";
                try
                {
                    switch (type)
                    {
                        case "learn":
                            Need(step, "body");
                            // Visualizers on a card run for real in the app, so they must run here too.
                            if (step["trace"] is JsonObject trace)
                            {
                                var traceCode = trace["code"] is JsonArray arr ? string.Join("\n", arr.Select(l => (string?)l)) : (string?)trace["code"];
                                var t = await CodeTrace.Run(runner, new(traceCode, (string?)trace["stdin"]));
                                if (t.Error is not null) Error(where, "trace: " + t.Error + " " + string.Join(" ", t.Diagnostics.Where(d => d.Severity == "error").Select(d => $"line {d.Line}: {d.Message}")));
                                else if (t.Truncated) Warn(where, "trace: stopped after the step limit; use a smaller example");
                            }
                            if (step["linq"] is JsonObject linq)
                            {
                                var q = await LinqViz.Run(runner, new((string?)linq["source"], (string?)linq["query"], (string?)linq["setup"]));
                                if (q.Error is not null) Error(where, "linq: " + q.Error);
                            }
                            break;
                        case "mcq":
                            Need(step, "prompt");
                            var options = Arr(step, "options");
                            if (options.Count < 2) throw new("needs at least 2 options");
                            foreach (var a in step["answer"] is JsonArray many ? many.Select(x => (int)x!) : [(int)step["answer"]!])
                                if (a < 0 || a >= options.Count) throw new($"answer {a} is out of range");
                            break;
                        case "predict":
                            var snippet = Need(step, "code");
                            var answer = Need(step, "answer");
                            if ((bool?)step["verify"] == false) break;       // snippet is a fragment, not a program
                            var (prog, pdiags) = runner.Compile(snippet);
                            if (prog is null)
                            {
                                Warn(where, "predict code does not compile, so the answer is unchecked (add \"verify\": false if that is intended): "
                                    + pdiags.FirstOrDefault(d => d.Severity == "error")?.Message);
                                break;
                            }
                            using (prog)
                            {
                                var run = await runner.Run(prog, (string?)step["stdin"]);
                                var printed = Checker.Tidy(run.Stdout);
                                if (run.ExitCode != 0) Error(where, "predict code crashes: " + run.Stderr.Split('\n')[0]);
                                else if (printed != Checker.Tidy(answer))
                                    Error(where, $"predict answer is wrong: says [{answer.Replace("\n", "\\n")}] but the code prints [{printed.Replace("\n", "\\n")}]");
                            }
                            break;
                        case "order":
                            if (Arr(step, "lines").Count < 3) throw new("needs at least 3 lines");
                            if (puzzles)
                            {
                                var alts = await AltOrders(runner, step);
                                if (alts is null) unverifiable++;
                                else { puzzlesChecked++; foreach (var a in alts.Take(4)) Warn(where, "another order behaves the same -> " + a.Replace("\n", " ⏎ ")); }
                            }
                            break;
                        case "blanks":
                            var blanks = Arr(step, "blanks");
                            var src = Need(step, "code");
                            var slots = Regex.Matches(src, @"__(\d+)__").Select(m => int.Parse(m.Groups[1].Value)).Distinct().Order().ToList();
                            if (!slots.SequenceEqual(Enumerable.Range(1, blanks.Count)))
                                throw new($"code has slots [{string.Join(",", slots)}] but there are {blanks.Count} blanks");
                            if (puzzles)
                            {
                                var fills = await AltBlanks(runner, step);
                                if (fills is null) unverifiable++;
                                else { puzzlesChecked++; foreach (var a in fills.Take(4)) Warn(where, "another filling behaves the same -> " + a); }
                            }
                            break;
                        case "match":
                            if (Arr(step, "pairs").Count < 2) throw new("needs at least 2 pairs");
                            if (Arr(step, "pairs").Select(p => (string)p![1]!).Distinct().Count() != Arr(step, "pairs").Count)
                                throw new("right-hand sides must be unique");
                            break;
                        case "sort":
                            var buckets = Arr(step, "buckets");
                            foreach (var item in Arr(step, "items"))
                                if ((int)item![1]! < 0 || (int)item[1]! >= buckets.Count) throw new($"item '{item[0]}' has a bad bucket");
                            break;
                        case "code":
                            code++;
                            Need(step, "prompt");
                            var solution = Need(step, "solution");
                            var good = await checker.Check(step, solution);
                            if (!good.Passed)
                            {
                                var why = !good.Compiled
                                    ? string.Join("; ", good.Diagnostics.Where(d => d.Severity == "error").Select(d => $"{d.File}({d.Line}) {d.Id} {d.Message}"))
                                    : string.Join("; ", good.Tests.Where(t => !t.Pass).Select(t => $"{t.Name}: {t.Detail}")) + " " + good.Stderr;
                                Error(where, "reference solution does not pass -> " + why.Replace("\n", " | "));
                            }
                            var starter = (string?)step["starter"] ?? "";
                            if ((await checker.Check(step, starter)).Passed) Warn(where, "the starter code already passes");
                            break;
                        default:
                            throw new($"unknown step type '{type}'");
                    }
                }
                catch (Exception e) { Error(where, e.Message); }
            }
        }

        Console.WriteLine();
        Console.WriteLine($"{lessons} lessons, {steps} steps, {code} code exercises run. {errors} errors, {warnings} warnings.");
        if (puzzles)
            Console.WriteLine($"Puzzles: {puzzlesChecked} order/blanks steps checked for a second right answer, {unverifiable} could not be run on their own.");
        return errors == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------ puzzle ambiguity (`--puzzles`)
    // A drag puzzle is unfair if an arrangement the app marks wrong works just as well. For puzzles
    // whose code is a runnable program we try the other arrangements and report any that compile
    // and print the same thing. Slow and CPU-heavy, so it is opt-in and throttled.

    static async Task<string?> Output(CSharpRunner runner, string code, string? stdin)
    {
        var (prog, _) = runner.Compile(code);
        if (prog is null) return null;
        using (prog)
        {
            var run = await runner.Run(prog, stdin, wallMs: 6000, cpuMs: 2000);
            // A snippet that prints nothing gives us nothing to compare arrangements by.
            return run.ExitCode == 0 && Checker.Tidy(run.Stdout) is { Length: > 0 } text ? text : null;
        }
    }

    static IEnumerable<int[]> Arrangements(int n, int k)
    {
        var pick = new int[k];
        var used = new bool[n];
        IEnumerable<int[]> Go(int depth)
        {
            if (depth == k) { yield return (int[])pick.Clone(); yield break; }
            for (var i = 0; i < n; i++)
            {
                if (used[i]) continue;
                used[i] = true; pick[depth] = i;
                foreach (var r in Go(depth + 1)) yield return r;
                used[i] = false;
            }
        }
        return Go(0);
    }

    static async Task<List<string>?> AltOrders(CSharpRunner runner, JsonObject step)
    {
        var lines = Arr(step, "lines").Select(l => (string)l!).ToList();
        if (lines.Count > 6) return null;
        var stdin = (string?)step["stdin"];
        var expected = await Output(runner, string.Join("\n", lines), stdin);
        if (expected is null) return null;

        var accepted = new HashSet<string> { string.Join("\n", lines) };
        foreach (var also in (step["also"] as JsonArray ?? []).OfType<JsonArray>())
            accepted.Add(string.Join("\n", also.Select(l => (string)l!)));

        var found = new List<string>();
        foreach (var order in Arrangements(lines.Count, lines.Count))
        {
            var text = string.Join("\n", order.Select(i => lines[i]));
            if (!accepted.Add(text)) continue;
            Thread.Sleep(4);
            if (runner.CompilesClean(text) && await Output(runner, text, stdin) == expected) found.Add(text);
        }
        return found;
    }

    static async Task<List<string>?> AltBlanks(CSharpRunner runner, JsonObject step)
    {
        var accept = Arr(step, "blanks").Select(b => b is JsonArray many ? many.Select(x => (string)x!).ToList() : [(string)b!]).ToList();
        var tokens = accept.Select(a => a[0]).Concat((step["bank"] as JsonArray ?? []).Select(t => (string)t!)).ToList();
        var template = (string)step["code"]!;
        string Fill(IReadOnlyList<string> chosen) => Regex.Replace(template, @"__(\d+)__", m => chosen[int.Parse(m.Groups[1].Value) - 1]);

        var stdin = (string?)step["stdin"];
        var expected = await Output(runner, Fill(accept.Select(a => a[0]).ToList()), stdin);
        if (expected is null) return null;

        var seen = new HashSet<string>();
        var found = new List<string>();
        var tried = 0;
        foreach (var pick in Arrangements(tokens.Count, accept.Count))
        {
            var chosen = pick.Select(i => tokens[i]).ToList();
            if (chosen.Select((t, i) => accept[i].Contains(t)).All(ok => ok)) continue;
            var text = Fill(chosen);
            if (!seen.Add(text)) continue;
            if (++tried > 2500) break;
            Thread.Sleep(4);
            if (runner.CompilesClean(text) && await Output(runner, text, stdin) == expected) found.Add(string.Join("  ", chosen));
        }
        return found;
    }

    static string Need(JsonObject step, string key) =>
        (string?)(step[key] as JsonValue) is { Length: > 0 } s ? s : throw new($"missing '{key}'");

    static JsonArray Arr(JsonObject step, string key) =>
        step[key] as JsonArray ?? throw new($"missing '{key}' array");
}
