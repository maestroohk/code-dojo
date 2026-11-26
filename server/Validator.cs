using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// `dojo validate [filter]` — the content self-test. Lints every step and proves every
/// code exercise is solvable by running its reference solution through the real checker.
/// </summary>
public static class Validator
{
    public static async Task<int> Run(Content content, Checker checker, CSharpRunner runner, LangRunner langs, string? filter, bool puzzles = false, bool noDocker = false)
    {
        await using var terminals = new TerminalProof(content, noDocker);
        int lessons = 0, steps = 0, code = 0, errors = 0, warnings = 0, puzzlesChecked = 0, unverifiable = 0;

        void Error(string where, string msg) { errors++; Console.WriteLine($"  ERROR {where}: {msg}"); }
        void Warn(string where, string msg) { warnings++; Console.WriteLine($"  warn  {where}: {msg}"); }

        // Artifacts ("Your builds") and the build markers on code steps: checked per track.
        var allTracks = content.Tracks();
        foreach (var issue in Builds.Check(allTracks, content.TracksDir))
        {
            if (filter is not null && !issue.Where.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            if (issue.Error) Error(issue.Where, issue.Message); else Warn(issue.Where, issue.Message);
        }

        // Pacing: module gates name real lessons (Pacing.cs).
        foreach (var issue in Pacing.CheckGates(allTracks))
        {
            if (filter is not null && !issue.Where.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            if (issue.Error) Error(issue.Where, issue.Message); else Warn(issue.Where, issue.Message);
        }

        // Learning paths (content/paths): every module, lab and live lab they name must exist (Paths.cs).
        var contentRoot = Path.GetDirectoryName(content.TracksDir)!;
        foreach (var issue in Paths.Check(Paths.Load(contentRoot), allTracks, Paths.NetlabIds(contentRoot)))
        {
            if (filter is not null && !issue.Where.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            if (issue.Error) Error(issue.Where, issue.Message); else Warn(issue.Where, issue.Message);
        }

        foreach (var track in allTracks.OfType<JsonObject>())
        foreach (var module in (track["modules"] as JsonArray ?? []).OfType<JsonObject>())
        foreach (var meta in (module["lessons"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var key = $"{track["id"]}/{module["id"]}/{meta["id"]}";
            var language = (string?)module["language"] ?? (string?)track["language"] ?? "csharp";   // a module may run another language
            if (filter is not null && !key.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            lessons++;
            Console.WriteLine(key);

            JsonObject? lesson;
            try { lesson = content.Lesson((string)track["id"]!, (string)module["id"]!, (string)meta["id"]!); }
            catch (Exception e) { Error(key, "cannot parse: " + e.Message); continue; }
            if (lesson is null) { Error(key, "bad file name (use lowercase letters, digits and dashes)"); continue; }
            if ((string?)lesson["title"] is null) Error(key, "missing title");
            foreach (var msg in Flashcards.Check(lesson)) Error(key, msg);   // hand-written flashcards

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
                    foreach (var issue in Pacing.CheckStep(lesson, step, where))
                        if (issue.Error) Error(issue.Where, issue.Message); else Warn(issue.Where, issue.Message);
                    foreach (var msg in SqlViz.Check(step)) Error(where, msg);   // sqlflow / sqlplan / pgplan / txtimeline visuals
                    foreach (var msg in XunitCheck.Lint(step)) Error(where, msg);   // "xunit": tests against planted bugs
                    foreach (var msg in TestViz.Check(step)) Error(where, msg);     // "testviz" learn-card visuals
                    if (step["build"] is { } build)
                    {
                        if (type != "code") throw new("\"build\" only works on code steps");
                        if (build is not JsonObject b) throw new("\"build\" must be an object");
                        if (b["transform"] is { } tf && Builds.Text(tf) is not { } tfText) throw new("build \"transform\" must be a string or an array of lines");
                        else if (b["transform"] is not null && !Builds.Text(b["transform"])!.Contains("{{CODE}}")) throw new("build \"transform\" needs {{CODE}} where the learner's code goes");
                    }
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
                            if (step["interleave"] is JsonObject ilCard)
                                foreach (var (isError, msg) in await Interleave.Validate(runner, ilCard)) if (isError) Error(where, msg); else Warn(where, msg);
                            if (step["regex"] is JsonObject rxCard)
                            {
                                var (rxOptions, rxFlagError) = RegexLab.ParseFlags((string?)rxCard["flags"]);
                                var rxBuilt = rxFlagError is null ? RegexLab.Build((string?)rxCard["pattern"] ?? "", rxOptions, 1000) : default;
                                if (rxFlagError is not null) Error(where, "regex card: " + rxFlagError);
                                else if (rxBuilt.Regex is null) Error(where, "regex card: the pattern does not parse in .NET: " + rxBuilt.Error);
                            }
                            foreach (var (isError, msg) in await PolyViz.Validate(langs, step)) if (isError) Error(where, msg); else Warn(where, msg);
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
                            if (language == "sql")
                            {
                                var (sqlText, sqlError) = SqlChecker.PredictText(SqlChecker.Text(step["setup"]), snippet);
                                if (sqlError is not null) Error(where, "predict SQL fails: " + sqlError);
                                else if (Checker.Tidy(sqlText!) != Checker.Tidy(answer))
                                    Error(where, $"predict answer is wrong: says [{answer.Replace("\n", "\\n")}] but the query returns [{Checker.Tidy(sqlText!).Replace("\n", "\\n")}]");
                                break;
                            }
                            if (language != "csharp")
                            {
                                if (langs.Find(language) is not { } plang) { Warn(where, $"{language} is not installed, so the answer is unchecked"); break; }
                                var pr = await langs.Run(plang, snippet, (string?)step["stdin"]);
                                var pprinted = Checker.Tidy(pr.Stdout);
                                if (!pr.Compiled || pr.ExitCode != 0) Error(where, "predict code fails: " + (pr.CompileOutput + pr.Stderr).Trim().Split('\n').LastOrDefault());
                                else if (pprinted != Checker.Tidy(answer))
                                    Error(where, $"predict answer is wrong: says [{answer.Replace("\n", "\\n")}] but the code prints [{pprinted.Replace("\n", "\\n")}]");
                                break;
                            }
                            var (prog, pdiags) = runner.Compile(snippet, efCore: CSharpRunner.Frameworks((string?)step["framework"]).EfCore);
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
                            if (puzzles && language != "csharp") unverifiable++;
                            else if (puzzles)
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
                            if (puzzles && language != "csharp") unverifiable++;
                            else if (puzzles)
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
                            // A step with "variants" (one per dream) is several exercises: prove every one is solvable.
                            // In a track with dreams, every step is checked once per dream (variant + lexicon applied).
                            var trackDreams = (track["dreams"] as JsonArray ?? []).OfType<JsonObject>().Where(d => d["id"] is JsonValue && !Builds.IsSoon(d)).ToList();
                            var versions = new List<(string Label, JsonObject Step)>();
                            if (trackDreams.Count > 0)
                                foreach (var d in trackDreams)
                                    versions.Add(($" [dream {d["id"]}]", Content.ForDream(step, (string)d["id"]!, d["lexicon"] as JsonObject)));
                            else
                            {
                                versions.Add(("", step));
                                foreach (var dreamId in (step["variants"] as JsonObject ?? []).Select(p => p.Key))
                                    versions.Add(($" [dream {dreamId}]", Content.ApplyVariant(step, dreamId)));
                            }
                            foreach (var (label, version) in versions)
                            {
                                code++;
                                Need(version, "prompt");
                                var solution = Need(version, "solution");
                                // "uses": earlier pieces compiled with the step, always the reference versions here.
                                var used = Pacing.UsesOf(version).Count > 0
                                    ? Pacing.Resolve(content, allTracks, (string)track["id"]!, key, i, version, (string?)version["variant"], null)
                                    : null;
                                foreach (var problem in used?.Problems ?? []) Error(where + label, problem);
                                async Task<CheckResult> Grade(string c) => await Pacing.Grade(checker, langs, language, version, c, used?.Files);
                                var good = await Grade(solution);
                                if (!good.Passed)
                                {
                                    var why = !good.Compiled
                                        ? string.Join("; ", good.Diagnostics.Where(d => d.Severity == "error").Select(d => $"{d.File}({d.Line}) {d.Id} {d.Message}"))
                                        : string.Join("; ", good.Tests.Where(t => !t.Pass).Select(t => $"{t.Name}: {t.Detail}")) + " " + good.Stderr;
                                    Error(where + label, "reference solution does not pass -> " + why.Replace("\n", " | "));
                                }
                                var starter = (string?)version["starter"] ?? "";
                                if ((await Grade(starter)).Passed) Warn(where + label, "the starter code already passes");
                            }
                            break;
                        case "terminal":
                            // A real shell scenario: lint it, then prove it in a container (checks fail, solution, checks pass).
                            foreach (var (isError, msg) in await terminals.Prove(step, key, i, (string)track["id"]!, (string)module["id"]!))
                                if (isError) Error(where, msg); else Warn(where, msg);
                            break;
                        case "lab":
                            foreach (var msg in LabSteps.Check(step, Path.GetDirectoryName(content.TracksDir)!)) Error(where, msg);
                            break;
                        case "regex":
                            // Graded by .NET's Regex (RegexLab.cs): the reference passes, an empty or naive pattern does not.
                            code++;
                            foreach (var (isError, message) in RegexLab.Validate(step))
                                if (isError) Error(where, message); else Warn(where, message);
                            break;
                        default:
                            throw new($"unknown step type '{type}'");
                    }
                }
                catch (Exception e) { Error(where, e.Message); }
            }
        }

        // Katas (content/katas) and the error knowledge base (content/errors): `dojo validate katas`, `dojo validate errors`.
        // (contentRoot is declared above, for the learning paths.)
        var (katasChecked, kataRuns) = await new Katas(contentRoot).Validate(checker, langs, filter, Error, Warn);
        code += kataRuns;
        var kbEntries = 0;
        if (filter is null || filter.StartsWith("errors", StringComparison.OrdinalIgnoreCase))
        {
            var (entries, kbProblems) = new ErrorKb(Path.Combine(contentRoot, "content", "errors")).Load();
            kbEntries = entries.Count;
            foreach (var p in kbProblems) Error("errors", p);
            Console.WriteLine($"errors: {entries.Count} knowledge base entries ({string.Join(", ", entries.GroupBy(e => e.Language).Select(g => $"{g.Key} {g.Count()}"))})");
        }

        Console.WriteLine();
        if (katasChecked > 0) Console.WriteLine($"Katas: {katasChecked} checked.");
        if (kbEntries > 0) Console.WriteLine($"Error knowledge base: {kbEntries} entries.");
        Console.WriteLine($"{lessons} lessons, {steps} steps, {code} code exercises run. {errors} errors, {warnings} warnings.");
        if (puzzles)
            Console.WriteLine($"Puzzles: {puzzlesChecked} order/blanks steps checked for a second right answer, {unverifiable} could not be run on their own.");
        if (terminals.Seen > 0)
            Console.WriteLine($"Terminal steps: {terminals.Proven} proven in a container, {terminals.Skipped} skipped{(terminals.Skipped > 0 ? $" ({terminals.SkipReason})" : "")}.");
        return errors == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------ terminal steps (TermSteps.cs)

    /// <summary>
    /// Proves terminal steps for real: one container per step, started, set up, checked before (the checks must fail),
    /// solved with the step's own "solution" as the learner, checked again (all must pass), removed. Without Docker
    /// (or with --no-docker / DOJO_NO_DOCKER=1) each step is only linted and skipped with a warning.
    /// </summary>
    sealed class TerminalProof(Content content, bool noDocker) : IAsyncDisposable
    {
        TermSteps? _steps;
        bool? _docker;
        public int Seen, Proven, Skipped;
        public string SkipReason = "";

        public async Task<List<(bool Error, string Message)>> Prove(JsonObject step, string key, int idx, string trackId, string moduleId)
        {
            Seen++;
            var issues = new List<(bool, string)>();
            TermSteps.Spec spec;
            try { spec = TermSteps.Parse(step, $"{key}#{idx}", TermSteps.ModuleDir(content, step, trackId, moduleId)); }
            catch (InvalidDataException e) { issues.Add((true, e.Message)); return issues; }
            var root = Path.GetDirectoryName(content.TracksDir)!;
            _steps ??= new TermSteps(Path.Combine(root, "netlabs", "images"), $"validate-{Environment.ProcessId}", sweep: false);
            if (!_steps.ImageExists(spec.Image)) { issues.Add((true, $"there is no image folder netlabs/images/{spec.Image}")); return issues; }
            if (spec.Solution.Trim().Length == 0) issues.Add((true, "missing 'solution' (the commands an expert would type)"));
            if (step["hints"] is not JsonArray { Count: > 0 } && !Pacing.IsCold(step)) issues.Add((false, "no hints: give two or three, from a nudge to near the answer"));
            if (noDocker) { Skip("--no-docker"); issues.Add((false, "terminal step not run in a container (--no-docker)")); return issues; }
            _docker ??= (await NetLabs.Probe()).Ok;
            if (_docker != true) { Skip("Docker is not running"); issues.Add((false, "terminal step not run: Docker is not running (start Docker Desktop to prove it)")); return issues; }
            var image = _steps.ImageFor(spec.Image);
            if (!await image.Ready())
            {
                if (!await image.Ensure(Console.WriteLine)) { issues.Add((true, $"the {image.Tag} image does not build")); return issues; }
                if (await image.Size() is { } bytes) Console.WriteLine($"  built {image.Tag}: {bytes / 1_000_000} MB");
            }
            foreach (var p in await _steps.Prove(spec)) issues.Add((true, p));
            if (issues.All(x => !x.Item1)) Proven++;
            return issues;
        }

        void Skip(string why) { Skipped++; SkipReason = why; }

        public async ValueTask DisposeAsync()
        {
            if (_steps is not null) await _steps.DisposeAsync();   // removes every container this run started
        }
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
