using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace CodeDojo;

/// <summary>
/// Threads in motion: run real C# threads under a deterministic scheduler and record every interleaving step.
///
/// The learner's (or the lesson's) thread bodies and shared classes are rewritten with Roslyn so that every
/// statement, every loop test, every lock enter/exit and the read and the write of a read-modify-write on shared
/// state (count++, balance -= x) become switch points. The program then runs on real threads, but only one of
/// them may move at a time: a scheduler in the program hands out turns, either following a schedule (a list of
/// thread numbers, the "interleaving") or a default policy. Locks and SemaphoreSlim are modelled by the scheduler,
/// so a thread that cannot take a lock is blocked, and "every thread blocked" is a detected deadlock.
///
/// Modes: "trace" runs one schedule and returns every step (who ran, what it did, the shared values, who holds
/// which lock). "explore" runs every distinct interleaving of shared-memory operations (partial-order reduced:
/// statements that touch only locals are not switch points) and returns each distinct outcome with an example
/// schedule; when there are too many, it falls back to preemption bounding, the search CHESS and Coyote use.
/// Code steps with "interleavings" are graded this way: every interleaving must give the expected result.
/// </summary>
public static class Interleave
{
    public record ThreadSpec(string? Name, string? Code);
    public record Request(string? Setup, List<ThreadSpec>? Threads, string? Code, List<string>? Watch, string? Result,
        string? Mode, List<int>? Schedule, int? Bound);

    public const string CodeFile = "Program.cs";
    const string Marker = "\u0002R|";

    // Kinds of step, shared with the program's scheduler and the UI (ui/interleave.js).
    // 0 local statement, 1 read, 2 write, 3 lock, 4 unlock, 5 shared statement, 6 atomic, 7 loop test (local),
    // 8 loop test (shared), 9 semaphore wait, 10 semaphore release, 11 read and compute
    static bool Visible(int k) => k is not (0 or 7);

    // ------------------------------------------------------------------ requests

    public static Request FromJson(JsonObject o, string? code = null) => new(
        Text(o["setup"]),
        (o["threads"] as JsonArray ?? []).OfType<JsonObject>().Select((t, i) => new ThreadSpec((string?)t["name"] ?? $"T{i + 1}", Text(t["code"]))).ToList(),
        code ?? Text(o["code"]),
        (o["watch"] as JsonArray)?.Select(w => (string?)w ?? "").ToList(),
        (string?)o["result"], null, null, (int?)o["bound"]);

    public static string? Text(JsonNode? n) => n is JsonArray a ? string.Join("\n", a.Select(l => (string?)l)) : (string?)n;

    // ------------------------------------------------------------------ compile (cached)

    sealed class Built(Compiled program, string[] regions, string[][] lines, string[] watchNames)
    {
        public Compiled Program { get; } = program;
        public string[] Regions { get; } = regions;
        public string[][] Lines { get; } = lines;
        public string[] WatchNames { get; } = watchNames;
        public int Uses;
        public long Last;
    }

    static readonly Dictionary<string, Built> Cache = [];
    static readonly object CacheLock = new();
    static long _clock;

    static string Key(Request r) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(
        new { r.Setup, Threads = r.Threads?.Select(t => new[] { t.Name, t.Code }), r.Code, r.Watch, r.Result }))));

    /// <summary>Compile (or reuse) the instrumented program. Returns the error and diagnostics when it does not compile.</summary>
    static (Built? Built, string? Error, List<Diag> Diags) Build(CSharpRunner runner, Request r)
    {
        var key = Key(r);
        lock (CacheLock)
            if (Cache.TryGetValue(key, out var hit)) { hit.Uses++; hit.Last = ++_clock; return (hit, null, []); }

        var threads = r.Threads ?? [];
        if (threads.Count is < 1 or > 4) return (null, "Give 1 to 4 threads.", []);
        var composed = Compose(r);
        var (plain, diags) = runner.Compile(composed.Source);
        if (plain is null) return (null, "The code does not compile.", diags);
        plain.Dispose();

        var tree = CSharpSyntaxTree.ParseText(composed.Source, CSharpRunner.ParseOptions, path: "Source.cs");
        var model = runner.Analyze(tree).GetSemanticModel(tree);
        var names = composed.Regions;
        var rewritten = new Instrument(model, p => Array.IndexOf(names, p)).Visit(tree.GetRoot());
        var text = rewritten.ToFullString();
        if (Environment.GetEnvironmentVariable("DOJO_INTERLEAVE_DUMP") is { Length: > 0 } dump) File.WriteAllText(dump, text);
        var (program, tdiags) = runner.Compile(text);
        if (program is null)
            return (null, "This code cannot be run under the scheduler: " + tdiags.FirstOrDefault(d => d.Severity == "error")?.Message, diags);

        var built = new Built(program, names, composed.Lines, composed.WatchNames) { Uses = 1 };
        lock (CacheLock)
        {
            built.Last = ++_clock;
            Cache[key] = built;
            while (Cache.Count > 12 && Cache.Where(c => c.Value.Uses == 0).OrderBy(c => c.Value.Last).FirstOrDefault() is { Key: not null } old)
            {
                Cache.Remove(old.Key);
                old.Value.Program.Dispose();
            }
        }
        return (built, null, diags);
    }

    static void Done(Built b) { lock (CacheLock) b.Uses--; }

    // ------------------------------------------------------------------ run

    /// <summary>Run one mode and return the program's JSON plus the source regions (for the UI).</summary>
    public static async Task<JsonObject> Run(CSharpRunner runner, Request r)
    {
        var (built, error, diags) = Build(runner, r);
        if (built is null)
            return new JsonObject { ["error"] = error, ["diagnostics"] = JsonSerializer.SerializeToNode(diags, JsonOpts) };
        try
        {
            var mode = r.Mode == "explore" ? "explore" : "trace";
            var stdin = mode + "\n" + string.Join(",", r.Schedule ?? []) + "\n" + (r.Bound?.ToString() ?? "") + "\n";
            var run = await runner.Run(built.Program, stdin);
            var line = run.Stdout.Replace("\r\n", "\n").Split('\n').FirstOrDefault(l => l.StartsWith(Marker));
            JsonObject result;
            if (line is not null) result = JsonNode.Parse(line[Marker.Length..])!.AsObject();
            else result = new JsonObject
            {
                ["error"] = run.TimedOut ? "It ran too long and was stopped (a thread may be blocked outside the scheduler, or spinning)."
                    : "It crashed: " + run.Stderr.Split('\n').FirstOrDefault(l => l.Trim().Length > 0)?.Trim(),
            };
            result["regions"] = new JsonArray(built.Regions.Select((n, i) => (JsonNode)new JsonObject
            {
                ["name"] = n, ["lines"] = new JsonArray(built.Lines[i].Select(l => (JsonNode)JsonValue.Create(l)!).ToArray()),
            }).ToArray());
            result["threads"] = new JsonArray((r.Threads ?? []).Select(t => (JsonNode)JsonValue.Create(t.Name ?? "")!).ToArray());
            result["watchNames"] = new JsonArray(built.WatchNames.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray());
            result["diagnostics"] = JsonSerializer.SerializeToNode(diags.Where(d => d.Severity != "error"), JsonOpts);
            return result;
        }
        finally { Done(built); }
    }

    static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    public static void Map(WebApplication app, CSharpRunner runner, JsonSerializerOptions json) =>
        app.MapPost("/api/interleave", async (Request req) => Results.Json(await Run(runner, req), json));

    // ------------------------------------------------------------------ grading ("interleavings" on a code step)

    /// <summary>
    /// Grade a code step by systematic exploration: for each scenario, every interleaving must end with an expected
    /// result and none may deadlock. A failure shows the interleaving that breaks the code, step by step, and carries
    /// the request so the page can draw it (a line starting with \u0002interleave: in the detail).
    /// </summary>
    public static async Task<CheckResult> Grade(CSharpRunner runner, JsonNode spec, string code, List<TestResult> results)
    {
        var scenarios = spec is JsonArray arr ? arr.OfType<JsonObject>().ToList() : spec is JsonObject one ? [one] : [];
        var allDiags = new List<Diag>();
        long ms = 0;
        foreach (var sc in scenarios)
        {
            var req = FromJson(sc, code) with { Mode = "explore" };
            var title = (string?)sc["title"];
            var expect = sc["expect"] is JsonArray ea ? ea.Select(e => (string?)e ?? "").ToList() : sc["expect"] is { } e1 ? [(string?)e1 ?? ""] : [];
            var watch = System.Diagnostics.Stopwatch.StartNew();
            var res = await Run(runner, req);
            ms += watch.ElapsedMilliseconds;
            var diags = (res["diagnostics"] as JsonArray ?? []).Deserialize<List<Diag>>(JsonOpts) ?? [];
            allDiags.AddRange(diags.Where(d => !allDiags.Contains(d)));
            if (res["error"] is { } err && res["outcomes"] is null)
            {
                if (diags.Any(d => d.Severity == "error")) return new(false, false, allDiags, results, "", "", false, ms);
                results.Add(new(title ?? "Runs under the scheduler", false, (string?)err ?? "")); continue;
            }
            var outcomes = (res["outcomes"] as JsonArray ?? []).OfType<JsonObject>().ToList();
            var runs = (int?)res["runs"] ?? 0;
            var complete = (bool?)res["complete"] ?? false;
            var bound = (int?)res["bound"];
            var how = complete && bound is null ? $"all {runs} interleavings"
                : complete ? $"all {runs} interleavings with up to {bound} preemptions"
                : $"{runs} interleavings (a sample: there are too many to try them all)";
            var result = (string?)sc["result"] ?? "the result";
            var name = (title is null ? "" : title + ": ") + (expect.Count == 1 ? $"`{result}` is {expect[0]} in {how}" : $"`{result}` is one of {string.Join(", ", expect)} in {how}");
            var bad = outcomes.FirstOrDefault(o => !expect.Contains((string?)o["outcome"] ?? ""));
            if (bad is null) { results.Add(new(name, true, "")); continue; }

            var schedule = (bad["schedule"] as JsonArray ?? []).Select(x => (int)x!).ToList();
            var trace = await Run(runner, req with { Mode = "trace", Schedule = schedule });
            var story = Narrate(trace);
            var what = (string?)bad["outcome"];
            var count = (int?)bad["count"] ?? 1;
            var detail = $"{count} of the {runs} interleavings end with {what}. This is one of them:\n{story}"
                + "\n\u0002interleave:" + JsonSerializer.Serialize(new
                {
                    setup = req.Setup, threads = req.Threads, code = req.Code, watch = req.Watch, result = req.Result, schedule, expect,
                }, JsonOpts);
            results.Add(new(name, false, detail));
        }
        return new(results.Count > 0 && results.All(t => t.Pass), true, allDiags, results, "", "", false, ms);
    }

    /// <summary>A trace as text: one line per shared step, the way a reviewer would explain the bug.</summary>
    public static string Narrate(JsonObject trace)
    {
        var names = (trace["threads"] as JsonArray ?? []).Select(n => (string?)n ?? "").ToList();
        var regions = (trace["regions"] as JsonArray ?? []).OfType<JsonObject>().Select(r => (r["lines"] as JsonArray ?? []).Select(l => (string?)l ?? "").ToList()).ToList();
        var sb = new StringBuilder();
        var shown = 0;
        foreach (var s in (trace["steps"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var k = (int?)s["k"] ?? 0;
            if (!Visible(k) && s["e"] is null) continue;
            if (++shown > 24) { sb.Append("  ...\n"); break; }
            var t = (int?)s["t"] ?? 0;
            var g = (int?)s["g"] ?? 0;
            var l = (int?)s["l"] ?? 0;
            var src = g >= 0 && g < regions.Count && l >= 1 && l <= regions[g].Count ? regions[g][l - 1].Trim() : "";
            var x = (string?)s["x"];
            var what = k switch
            {
                1 => $"reads {x} = {(string?)s["r"]}",
                11 => $"reads {x} and computes {(string?)s["r"]}",
                2 => $"writes {x} = {(string?)s["w"] ?? "?"}",
                3 => $"takes lock {x}",
                4 => $"releases lock {x}",
                9 => $"enters semaphore {x}",
                10 => $"releases semaphore {x}",
                _ => src,
            };
            sb.Append("  ").Append((t < names.Count ? names[t] : "T" + t).PadRight(4)).Append("  ").Append(what);
            if (s["e"] is { } e) sb.Append("  -> throws ").Append((string?)e);
            sb.Append('\n');
        }
        if ((string?)trace["deadlock"] is { } dl) sb.Append("  deadlock: ").Append(dl).Append('\n');
        sb.Append("  result: ").Append((string?)trace["outcome"]);
        return sb.ToString();
    }

    // ------------------------------------------------------------------ validation of lesson cards

    public static async Task<List<(bool Error, string Message)>> Validate(CSharpRunner runner, JsonObject card)
    {
        var issues = new List<(bool, string)>();
        var req = FromJson(card);
        var trace = await Run(runner, req with { Mode = "trace" });
        if (trace["error"] is { } err)
        {
            var d = (trace["diagnostics"] as JsonArray ?? []).Deserialize<List<Diag>>(JsonOpts) ?? [];
            issues.Add((true, "interleave: " + (string?)err + " " + string.Join(" ", d.Where(x => x.Severity == "error").Select(x => $"{x.File} line {x.Line}: {x.Message}"))));
            return issues;
        }
        if ((string?)trace["status"] == "limit") issues.Add((false, "interleave: the default run hits the step limit; use a smaller example"));
        foreach (var s in (card["schedules"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var pick = (s["pick"] as JsonArray ?? []).Select(x => (int)x!).ToList();
            if (pick.Any(p => p < 0 || p >= (req.Threads?.Count ?? 0))) { issues.Add((true, $"interleave: schedule '{s["name"]}' names a thread that does not exist")); continue; }
            var t = await Run(runner, req with { Mode = "trace", Schedule = pick });
            var chosen = (t["chosen"] as JsonArray ?? []).Select(x => (int)x!).ToList();
            if (chosen.Take(pick.Count).SequenceEqual(pick) is false)
                issues.Add((true, $"interleave: schedule '{s["name"]}' cannot be followed (a thread it picks is blocked or finished at step {chosen.Zip(pick).TakeWhile(p => p.First == p.Second).Count() + 1})"));
            if ((string?)s["expect"] is { } want && (string?)t["outcome"] != want)
                issues.Add((true, $"interleave: schedule '{s["name"]}' ends with [{t["outcome"]}], not [{want}]"));
        }
        if (card["outcomes"] is JsonArray want2)
        {
            var ex = await Run(runner, req with { Mode = "explore" });
            var got = (ex["outcomes"] as JsonArray ?? []).OfType<JsonObject>().Select(o => (string?)o["outcome"] ?? "").Order().ToList();
            var expected = want2.Select(w => (string?)w ?? "").Order().ToList();
            if (!got.SequenceEqual(expected))
                issues.Add((true, $"interleave: \"outcomes\" says [{string.Join(", ", expected)}] but exploring finds [{string.Join(", ", got)}]"));
        }
        return issues;
    }

    // ------------------------------------------------------------------ composing the program

    sealed record Composed(string Source, string[] Regions, string[][] Lines, string[] WatchNames);

    static string Norm(string? s) => (s ?? "").Replace("\r\n", "\n").TrimEnd();

    static Composed Compose(Request r)
    {
        var threads = r.Threads ?? [];
        var setup = Norm(r.Setup);
        var code = Norm(r.Code);
        var regions = threads.Select((_, i) => "T" + i).Append(CodeFile).ToArray();
        var lines = threads.Select(t => Norm(t.Code).Split('\n')).Append(code.Length == 0 ? [] : code.Split('\n')).ToArray();

        // Setup locals: the shared state. Lock and semaphore objects are not worth watching.
        var setupRoot = CSharpSyntaxTree.ParseText(setup, CSharpRunner.ParseOptions).GetCompilationUnitRoot();
        var locals = setupRoot.Members.OfType<GlobalStatementSyntax>().Select(g => g.Statement).OfType<LocalDeclarationStatementSyntax>()
            .SelectMany(d => d.Declaration.Variables.Select(v => (v.Identifier.Text, v.Initializer?.Value))).ToList();
        static bool Plumbing(ExpressionSyntax? init) => init is ImplicitObjectCreationExpressionSyntax
            || init is ObjectCreationExpressionSyntax oc && oc.Type.ToString() is "object" or "Lock" or "System.Threading.Lock" or "SemaphoreSlim" or "Barrier";
        var watch = r.Watch is { Count: > 0 } w ? w : locals.Where(l => !Plumbing(l.Value)).Select(l => l.Text).ToList();

        // Learner code: its top-level statements (local functions) first, its types after everything else.
        var (stmts, types, typesLine) = SplitCode(code);

        var sb = new StringBuilder();
        if (stmts.Length > 0) sb.Append($"#line 1 \"{CodeFile}\"\n").Append(stmts).Append('\n');
        sb.Append("#line hidden\n__Sched.Start(() =>\n{\n");
        sb.Append("#line 1 \"setup\"\n").Append(setup).Append("\n#line hidden\n");
        sb.Append("return new __Sched.Spec(new System.Action[] {\n");
        for (var i = 0; i < threads.Count; i++)
            sb.Append("() =>\n{\n").Append($"#line 1 \"T{i}\"\n").Append(lines[i].Length == 0 ? "" : string.Join("\n", lines[i])).Append("\n#line hidden\n},\n");
        sb.Append("},\n");
        sb.Append("() => new object?[] {\n#line 1 \"watch\"\n");
        foreach (var e in watch) sb.Append($"(object?)({e}),\n");
        sb.Append("#line hidden\n},\n");
        sb.Append(r.Result is { Length: > 0 } res ? $"() => (object?)(\n#line 1 \"result\"\n{res}\n#line hidden\n),\n" : "null,\n");
        sb.Append("() => new object?[] {").Append(string.Join(", ", locals.Select(l => $"\"{l.Text}\", (object?){l.Text}"))).Append("});\n");
        sb.Append("});\n");
        if (types.Length > 0) sb.Append($"#line {typesLine} \"{CodeFile}\"\n").Append(types).Append('\n');
        sb.Append("#line default\n").Append(Support);
        return new(sb.ToString(), regions, lines, [.. watch]);
    }

    /// <summary>Split learner code into its top-level statements and the type declarations after them (by whole lines).</summary>
    static (string Stmts, string Types, int TypesLine) SplitCode(string code)
    {
        if (code.Length == 0) return ("", "", 1);
        var root = CSharpSyntaxTree.ParseText(code, CSharpRunner.ParseOptions).GetCompilationUnitRoot();
        var first = root.Members.FirstOrDefault(m => m is not GlobalStatementSyntax);
        if (first is null) return (code, "", 1);
        var line = first.GetLocation().GetLineSpan().StartLinePosition.Line;   // 0-based
        // Attributes and doc comments belong to the type: start at the first line of its leading trivia, if any.
        var all = code.Split('\n');
        return (string.Join("\n", all.Take(line)), string.Join("\n", all.Skip(line)), line + 1);
    }

    // ------------------------------------------------------------------ the rewriter

    /// <summary>
    /// Inserts switch points into the thread bodies and the learner's code. Decisions are taken on the original
    /// nodes (which have the semantic model and #line-mapped locations); new code is generated as text on the
    /// same line, so line numbers of the remaining code do not move.
    /// </summary>
    sealed class Instrument(SemanticModel model, Func<string, int> regionOf) : CSharpSyntaxRewriter
    {
        int _tmp;

        int Region(SyntaxNode n)
        {
            var s = n.GetLocation().GetMappedLineSpan();
            return s.HasMappedPath ? regionOf(s.Path) : -1;
        }

        static int Line(SyntaxNode n) => n.GetLocation().GetMappedLineSpan().StartLinePosition.Line + 1;
        static int Line(SyntaxToken t) => t.GetLocation().GetMappedLineSpan().StartLinePosition.Line + 1;
        static string Lit(string s) => SymbolDisplay.FormatLiteral(s, true);

        static bool Skip(StatementSyntax s) => s is LocalFunctionStatementSyntax or BlockSyntax or EmptyStatementSyntax;

        static StatementSyntax Stmt(string text) => ParseStatement(text);
        static List<StatementSyntax> Stmts(string text) => [.. ((BlockSyntax)ParseStatement("{" + text + "}")).Statements.Select(s => s.WithLeadingTrivia(Space).WithTrailingTrivia())];

        // ---------- which names are shared

        static SyntaxNode? Body(SyntaxNode n) => n.Ancestors().FirstOrDefault(a => a is AnonymousFunctionExpressionSyntax
            or LocalFunctionStatementSyntax or BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or PropertyDeclarationSyntax);

        bool Shared(IdentifierNameSyntax id)
        {
            var sym = model.GetSymbolInfo(id).Symbol;
            // c.Add() on the learner's own class: reading the reference c is not the interesting part; Add's own
            // statements are switch points. (A write to c elsewhere is still a shared step.)
            if (sym is ILocalSymbol or IParameterSymbol or IFieldSymbol && id.Parent is MemberAccessExpressionSyntax ma && ma.Expression == id
                && model.GetSymbolInfo(ma.Name).Symbol is IMethodSymbol { } m && m.Locations.Any(l => l.IsInSource))
                return false;
            switch (sym)
            {
                case IFieldSymbol f: return !f.IsConst;
                case IPropertySymbol p: return p.Locations.Any(l => l.IsInSource);
                case IParameterSymbol { RefKind: not RefKind.None }: return true;    // ref int max aliases shared memory
                case ILocalSymbol or IParameterSymbol:
                    var decl = sym.DeclaringSyntaxReferences.FirstOrDefault();
                    if (decl is null || decl.SyntaxTree != id.SyntaxTree) return false;
                    var body = Body(id);
                    return body is null || !body.Span.Contains(decl.Span);   // captured from outside: shared
                default: return false;
            }
        }

        bool Touches(SyntaxNode? n) => n is not null && (n.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>().Any(Shared)
            || n.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>().Any(i => Type(i) == "System.Console"));

        string? Type(InvocationExpressionSyntax inv) => (model.GetSymbolInfo(inv).Symbol as IMethodSymbol)?.ContainingType?.ToDisplayString();

        bool Atomic(SyntaxNode n) => n.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()
            .Any(i => Type(i) is "System.Threading.Interlocked" or "System.Threading.Volatile");

        static SyntaxNode? Probe(StatementSyntax s) => s switch
        {
            ExpressionStatementSyntax e => e.Expression,
            LocalDeclarationStatementSyntax d => d.Declaration,
            ReturnStatementSyntax r => r.Expression,
            IfStatementSyntax i => i.Condition,
            SwitchStatementSyntax w => w.Expression,
            ThrowStatementSyntax t => t.Expression,
            UsingStatementSyntax u => (SyntaxNode?)u.Declaration ?? u.Expression,
            ForEachStatementSyntax f => f.Expression,
            YieldStatementSyntax y => y.Expression,
            TryStatementSyntax or CheckedStatementSyntax or UnsafeStatementSyntax or FixedStatementSyntax => null,
            BreakStatementSyntax or ContinueStatementSyntax or GotoStatementSyntax => null,
            _ => s,
        };

        int KindOf(StatementSyntax s)
        {
            var probe = Probe(s);
            if (probe is null || !Touches(probe)) return 0;
            return Atomic(probe) ? 6 : 5;
        }

        // ---------- statement expansion

        public override SyntaxNode? Visit(SyntaxNode? node)
        {
            // Bodies without braces (if (x) y++;) get a block, so there is room for switch points.
            if (node is StatementSyntax s && s is not BlockSyntax && Region(s) >= 0 &&
                s.Parent is IfStatementSyntax or ElseClauseSyntax or ForStatementSyntax or ForEachStatementSyntax
                    or WhileStatementSyntax or DoStatementSyntax or UsingStatementSyntax or LockStatementSyntax)
                return Block(Moved(s, Expand(s)));
            return base.Visit(node);
        }

        public override SyntaxNode? VisitBlock(BlockSyntax node)
        {
            var list = new List<StatementSyntax>();
            foreach (var s in node.Statements)
            {
                if (Region(s) < 0 || Skip(s)) list.Add((StatementSyntax)Visit(s)!);
                else list.AddRange(Moved(s, Expand(s)));
            }
            return node.WithStatements(List(list));
        }

        /// <summary>The original statement's leading trivia (newlines, #line directives) goes before the first new statement.</summary>
        static List<StatementSyntax> Moved(StatementSyntax s, List<StatementSyntax> list)
        {
            if (list.Count == 0) return list;
            var lead = s.GetLeadingTrivia();
            for (var i = 0; i < list.Count; i++)
                list[i] = i == 0 ? list[i].WithLeadingTrivia(lead) : list[i].WithLeadingTrivia(Space);
            list[^1] = list[^1].WithTrailingTrivia(s.GetTrailingTrivia());
            return list;
        }

        List<StatementSyntax> Expand(StatementSyntax s)
        {
            var g = Region(s);
            var l = Line(s);
            switch (s)
            {
                case LockStatementSyntax ls:
                {
                    var name = ls.Expression.ToString();
                    var tmp = "__lk" + ++_tmp;
                    var expr = ((ExpressionSyntax)Visit(ls.Expression)!).ToString();
                    var body = ((StatementSyntax)Visit(ls.Statement)!).ToString();
                    var end = Line(ls.Statement.GetLastToken());
                    return [Stmt($"{{ var {tmp} = (object)({expr}); __Sched.Enter({tmp}, {Lit(name)}, {g}, {l}); try {body} finally {{ __Sched.Exit({tmp}, {Lit(name)}, {g}, {end}); }} }}")
                        .WithLeadingTrivia(s.GetLeadingTrivia())];
                }
                case ExpressionStatementSyntax es when Split(es.Expression, g, l) is { } split:
                    return split;
                case ExpressionStatementSyntax es when Semaphore(es.Expression, g, l) is { } sem:
                    return [sem.WithLeadingTrivia(s.GetLeadingTrivia())];
                case WhileStatementSyntax or ForStatementSyntax or DoStatementSyntax:
                    return [(StatementSyntax)base.Visit(s)!];    // the loop test is the switch point
                default:
                    return [Stmt($"__Sched.Y({g}, {l}, {KindOf(s)});"), (StatementSyntax)base.Visit(s)!];
            }
        }

        /// <summary>count++, balance -= x, total = total + x on shared state: a read step, then a write step.</summary>
        List<StatementSyntax>? Split(ExpressionSyntax e, int g, int l)
        {
            ExpressionSyntax? target = null;
            string? next = null;
            var r = "__r" + (_tmp + 1);
            var simple = false;
            switch (e)
            {
                case PostfixUnaryExpressionSyntax p when p.Kind() is SyntaxKind.PostIncrementExpression or SyntaxKind.PostDecrementExpression:
                    target = p.Operand; next = r + (p.Kind() == SyntaxKind.PostIncrementExpression ? " + 1" : " - 1"); break;
                case PrefixUnaryExpressionSyntax p when p.Kind() is SyntaxKind.PreIncrementExpression or SyntaxKind.PreDecrementExpression:
                    target = p.Operand; next = r + (p.Kind() == SyntaxKind.PreIncrementExpression ? " + 1" : " - 1"); break;
                case AssignmentExpressionSyntax a when a.Kind() != SyntaxKind.SimpleAssignmentExpression:
                    var op = a.OperatorToken.Text[..^1];
                    target = a.Left; next = $"{r} {op} ({((ExpressionSyntax)Visit(a.Right)!).ToString()})"; break;
                case AssignmentExpressionSyntax a when a.Right.DescendantNodesAndSelf().Any(n => SyntaxFactory.AreEquivalent(n, a.Left)):
                    target = a.Left; simple = true; next = ((ExpressionSyntax)Visit(a.Right)!).ToString(); break;
            }
            if (target is null || !Touches(target)) return null;
            if (target is not (IdentifierNameSyntax or MemberAccessExpressionSyntax or ElementAccessExpressionSyntax)) return null;
            var type = model.GetTypeInfo(target).Type;
            if (type is null || type.TypeKind == TypeKind.Error) return null;
            _tmp++;
            var t = type.ToDisplayString();
            var x = target.ToString();
            var lit = Lit(x);
            return simple
                ? Stmts($"__Sched.Y({g}, {l}, 11, {lit}); {t} {r} = ({t})({next}); __Sched.Y({g}, {l}, 2, {lit}, {r}); {x} = {r}; __Sched.Note({x});")
                : Stmts($"__Sched.Y({g}, {l}, 1, {lit}); {t} {r} = {x}; __Sched.Y({g}, {l}, 2, {lit}, {r}); {x} = ({t})({next}); __Sched.Note({x});");
        }

        /// <summary>gate.Wait(); and gate.Release(); on a SemaphoreSlim: modelled by the scheduler.</summary>
        StatementSyntax? Semaphore(ExpressionSyntax e, int g, int l)
        {
            if (e is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma, ArgumentList.Arguments.Count: 0 } inv) return null;
            if (Type(inv) != "System.Threading.SemaphoreSlim") return null;
            var method = ma.Name.Identifier.Text;
            if (method is not ("Wait" or "Release")) return null;
            var recv = ((ExpressionSyntax)Visit(ma.Expression)!).ToString();
            return Stmt($"__Sched.{(method == "Wait" ? "SemWait" : "SemRelease")}({recv}, {Lit(ma.Expression.ToString())}, {g}, {l});");
        }

        // ---------- loop tests

        ExpressionSyntax Test(SyntaxNode at, ExpressionSyntax? original)
        {
            var k = original is not null && Touches(original) ? 8 : 7;
            var probe = ParseExpression($"__Sched.C({Region(at)}, {Line(original ?? at)}, {k})");
            return original is null ? probe
                : BinaryExpression(SyntaxKind.LogicalAndExpression, probe, ParenthesizedExpression((ExpressionSyntax)Visit(original)!));
        }

        // while (true) and for (;;) keep their condition (the compiler relies on it for definite returns); the
        // switch point goes at the top of the body instead.
        static bool Forever(ExpressionSyntax? c) => c is null || c.IsKind(SyntaxKind.TrueLiteralExpression);

        StatementSyntax TopOfBody(SyntaxNode at, StatementSyntax body)
        {
            var y = Stmt($"__Sched.Y({Region(at)}, {Line(at)}, 7);");
            return body is BlockSyntax b ? b.WithStatements(b.Statements.Insert(0, y)) : Block(y, body);
        }

        public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
        {
            var visited = (WhileStatementSyntax)base.VisitWhileStatement(node)!;
            if (Region(node) < 0) return visited;
            return Forever(node.Condition) ? visited.WithStatement(TopOfBody(node, visited.Statement)) : visited.WithCondition(Test(node, node.Condition));
        }

        public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
        {
            var visited = (DoStatementSyntax)base.VisitDoStatement(node)!;
            if (Region(node) < 0) return visited;
            return Forever(node.Condition) ? visited.WithStatement(TopOfBody(node, visited.Statement)) : visited.WithCondition(Test(node, node.Condition));
        }

        public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
        {
            var visited = (ForStatementSyntax)base.VisitForStatement(node)!;
            if (Region(node) < 0) return visited;
            return Forever(node.Condition) ? visited.WithStatement(TopOfBody(node, visited.Statement)) : visited.WithCondition(Test(node, node.Condition));
        }

        // ---------- expression-bodied methods get a block, so void Add() => _count++; is split too

        public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            if (node.ExpressionBody is null || Region(node) < 0) return base.VisitMethodDeclaration(node);
            var block = ExprBody(node.ExpressionBody.Expression, node.ReturnType.ToString() == "void");
            return ((MethodDeclarationSyntax)base.VisitMethodDeclaration(node)!).WithExpressionBody(null).WithSemicolonToken(default).WithBody(block);
        }

        public override SyntaxNode? VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
        {
            if (node.ExpressionBody is null || Region(node) < 0) return base.VisitLocalFunctionStatement(node);
            var block = ExprBody(node.ExpressionBody.Expression, node.ReturnType.ToString() == "void");
            return ((LocalFunctionStatementSyntax)base.VisitLocalFunctionStatement(node)!).WithExpressionBody(null).WithSemicolonToken(default).WithBody(block);
        }

        BlockSyntax ExprBody(ExpressionSyntax e, bool isVoid)
        {
            var g = Region(e);
            var l = Line(e);
            if (isVoid && Split(e, g, l) is { } split) return Block(split);
            var k = Touches(e) ? Atomic(e) ? 6 : 5 : 0;
            var visited = ((ExpressionSyntax)Visit(e)!).ToString();
            return Block(Stmt($"__Sched.Y({g}, {l}, {k});"), Stmt(isVoid ? visited + ";" : "return " + visited + ";"));
        }
    }

    // ------------------------------------------------------------------ the scheduler, compiled into the program

    const string Support = """

        #nullable enable
        static class __Sched
        {
            public sealed record Spec(System.Action[] Threads, System.Func<object?[]> Watch, System.Func<object?>? Result, System.Func<object?[]> Named);

            sealed class Abort : System.Exception { }

            sealed class Th
            {
                public int Id;
                public readonly System.Threading.SemaphoreSlim Start = new(0);
                public readonly System.Threading.SemaphoreSlim Go = new(0);
                public System.Action? Body;
                public volatile bool Active, Done;
                public int G = -1, L, K = -1;
                public string? X;
                public object? Need; public bool NeedSem;     // a lock or semaphore the next step needs
                public object? Free; public bool FreeSem;     // a lock or semaphore the next step gives back
                public object? Carried; public bool HasCarried;
                public object? Written; public bool HasWritten;
                public string? Error;
            }

            sealed class RunInfo
            {
                public readonly List<int> Chosen = new();
                public readonly List<int[]> Runnable = new();
                public readonly List<bool> Branch = new();
                public List<object>? Steps;
                public object? Init;
                public string Status = "done";
                public string Outcome = "";
                public string? Deadlock;
            }

            [System.ThreadStatic] static Th? _me;
            static readonly List<Th> Pool = new();
            static readonly System.Threading.SemaphoreSlim Back = new(0);
            static volatile bool _aborting;
            static readonly Dictionary<object, (int Owner, int Depth)> Locks = new(System.Collections.Generic.ReferenceEqualityComparer.Instance);
            static readonly Dictionary<object, int> Sems = new(System.Collections.Generic.ReferenceEqualityComparer.Instance);
            static readonly Dictionary<object, string> Names = new(System.Collections.Generic.ReferenceEqualityComparer.Instance);
            static readonly List<object> Order = new();
            static Spec? _spec;
            static readonly System.IO.StringWriter Out = new();
            const int MaxSteps = 240;
            const int Fair = 60;
            const int StuckMs = 3000;

            // ---------- called from the instrumented code

            public static void Y(int g, int l, int k) { var t = _me; if (t is null || !t.Active) return; Arrive(t, g, l, k, null); }
            public static void Y(int g, int l, int k, string x) { var t = _me; if (t is null || !t.Active) return; Arrive(t, g, l, k, x); }
            public static void Y(int g, int l, int k, string x, object? carried)
            {
                var t = _me; if (t is null || !t.Active) return;
                t.Carried = carried; t.HasCarried = true;
                Arrive(t, g, l, k, x);
            }
            public static bool C(int g, int l, int k) { Y(g, l, k); return true; }
            public static void Note(object? v) { var t = _me; if (t is null || !t.Active) return; t.Written = v; t.HasWritten = true; }

            public static void Enter(object o, string text, int g, int l)
            {
                var t = _me; if (t is null || !t.Active) return;
                t.Need = o; t.NeedSem = false;
                Arrive(t, g, l, 3, NameOf(o, text));
            }
            public static void Exit(object o, string text, int g, int l)
            {
                var t = _me; if (t is null || !t.Active || _aborting) return;
                t.Free = o; t.FreeSem = false;
                Arrive(t, g, l, 4, NameOf(o, text));
            }
            public static void SemWait(System.Threading.SemaphoreSlim s, string text, int g, int l)
            {
                var t = _me; if (t is null || !t.Active) { s.Wait(); return; }
                if (!Sems.ContainsKey(s)) Sems[s] = s.CurrentCount;
                t.Need = s; t.NeedSem = true;
                Arrive(t, g, l, 9, NameOf(s, text));
            }
            public static void SemRelease(System.Threading.SemaphoreSlim s, string text, int g, int l)
            {
                var t = _me; if (t is null || !t.Active) { s.Release(); return; }
                if (_aborting) return;
                if (!Sems.ContainsKey(s)) Sems[s] = s.CurrentCount;
                t.Free = s; t.FreeSem = true;
                Arrive(t, g, l, 10, NameOf(s, text));
            }

            static void Arrive(Th t, int g, int l, int k, string? x)
            {
                if (_aborting) throw new Abort();
                t.G = g; t.L = l; t.K = k; t.X = x;
                Back.Release();
                t.Go.Wait();
                if (_aborting) throw new Abort();
            }

            static string NameOf(object o, string text)
            {
                if (Names.TryGetValue(o, out var n)) return n;
                var named = _spec!.Named();
                for (var i = 0; i + 1 < named.Length; i += 2)
                    if (ReferenceEquals(named[i + 1], o)) { n = (string)named[i]!; break; }
                n ??= text;
                var baseName = n;
                for (var k = 2; Names.ContainsValue(n); k++) n = baseName + "#" + k;
                Names[o] = n;
                Order.Add(o);
                return n;
            }

            // ---------- the workers: one real thread per lane, reused between runs

            static Th Worker(int id)
            {
                while (Pool.Count <= id)
                {
                    var t = new Th { Id = Pool.Count };
                    var th = new System.Threading.Thread(() => Loop(t), 256 * 1024) { IsBackground = true, Name = "lane " + t.Id };
                    th.Start();
                    Pool.Add(t);
                }
                return Pool[id];
            }

            static void Loop(Th t)
            {
                _me = t;
                while (true)
                {
                    t.Start.Wait();
                    try { t.Body!(); }
                    catch (Abort) { }
                    catch (System.Exception e) { if (!_aborting) t.Error = e.GetType().Name + ": " + e.Message; }
                    finally { t.Done = true; Back.Release(); }
                }
            }

            static bool Visible(int k) => k is not (0 or 7);

            static bool CanRun(Th t)
            {
                if (t.Done) return false;
                if (t.Need is null) return true;
                if (t.NeedSem) return Sems.TryGetValue(t.Need, out var c) && c > 0;
                return !Locks.TryGetValue(t.Need, out var h) || h.Owner == t.Id;
            }

            static string[] Snap(Spec spec)
            {
                try { return spec.Watch().Select(Dojo.Show).ToArray(); }
                catch (System.Exception e) { return new[] { "(" + e.GetType().Name + ")" }; }
            }

            static object[] States(Th[] ts) => ts.Select(t => (object)new object?[]
            {
                t.Done ? 2 : CanRun(t) ? 0 : 1, t.G, t.L, t.K, t.X, t.Error,
            }).ToArray();

            static object[] Held()
            {
                var list = new List<object>();
                foreach (var o in Order)
                {
                    if (Locks.TryGetValue(o, out var h)) list.Add(new object[] { Names[o], "lock", h.Owner, h.Depth });
                    else if (Sems.TryGetValue(o, out var c)) list.Add(new object[] { Names[o], "sem", c, 0 });
                    else list.Add(new object[] { Names[o], "lock", -1, 0 });
                }
                return list.ToArray();
            }

            static bool _stuck;

            static RunInfo RunOnce(Spec spec, IReadOnlyList<int> schedule, bool record)
            {
                _spec = spec; Locks.Clear(); Sems.Clear(); Names.Clear(); Order.Clear(); _aborting = false;
                Out.GetStringBuilder().Clear();
                var info = new RunInfo { Steps = record ? new List<object>() : null };
                var n = spec.Threads.Length;
                var ts = new Th[n];
                for (var i = 0; i < n; i++)
                {
                    var t = Worker(i);
                    t.Done = false; t.Error = null; t.Need = null; t.Free = null; t.HasCarried = false; t.HasWritten = false;
                    t.G = -1; t.K = -1; t.L = 0; t.X = null; t.Body = spec.Threads[i]; t.Active = true;
                    ts[i] = t;
                    t.Start.Release();
                    if (!Back.Wait(StuckMs)) { _stuck = true; info.Status = "stuck"; return Finish(spec, info, ts); }
                }
                string[] lastWatch = Snap(spec);
                var lastHeld = "";
                if (record) info.Init = new { v = lastWatch, s = States(ts), h = Held() };

                int prev = -1, streak = 0;
                while (true)
                {
                    var runnable = new List<int>();
                    for (var i = 0; i < n; i++) if (CanRun(ts[i])) runnable.Add(i);
                    if (runnable.Count == 0) { info.Status = ts.All(t => t.Done) ? "done" : "deadlock"; break; }
                    var at = info.Chosen.Count;
                    if (at >= MaxSteps) { info.Status = "limit"; break; }
                    int pick;
                    if (at < schedule.Count && runnable.Contains(schedule[at])) pick = schedule[at];
                    else if (prev >= 0 && runnable.Contains(prev) && streak < Fair) pick = prev;
                    else pick = runnable.FirstOrDefault(r => r > prev, runnable[0]);
                    var t = ts[pick];
                    info.Chosen.Add(pick);
                    info.Runnable.Add(runnable.ToArray());
                    info.Branch.Add(Visible(t.K));

                    if (t.Need is { } need)
                    {
                        if (t.NeedSem) Sems[need]--;
                        else Locks[need] = Locks.TryGetValue(need, out var h) ? (h.Owner, h.Depth + 1) : (pick, 1);
                        t.Need = null;
                    }
                    if (t.Free is { } free)
                    {
                        if (t.FreeSem) Sems[free]++;
                        else if (Locks.TryGetValue(free, out var h) && h.Owner == pick)
                        {
                            if (h.Depth <= 1) Locks.Remove(free); else Locks[free] = (h.Owner, h.Depth - 1);
                        }
                        t.Free = null;
                    }
                    int g = t.G, l = t.L, k = t.K;
                    var x = t.X;
                    t.HasCarried = false; t.HasWritten = false;
                    t.Go.Release();
                    if (!Back.Wait(StuckMs)) { _stuck = true; info.Status = "stuck"; break; }

                    if (record)
                    {
                        var snap = Snap(spec);
                        var changed = !snap.SequenceEqual(lastWatch);
                        lastWatch = snap;
                        var held = Held();
                        var heldText = System.Text.Json.JsonSerializer.Serialize(held);
                        var heldChanged = heldText != lastHeld;
                        lastHeld = heldText;
                        var output = Out.ToString();
                        Out.GetStringBuilder().Clear();
                        info.Steps!.Add(new
                        {
                            t = pick, g, l, k, x,
                            r = t.HasCarried ? Dojo.Show(t.Carried) : null,
                            w = t.HasWritten ? Dojo.Show(t.Written) : null,
                            v = changed ? snap : null,
                            h = heldChanged ? held : null,
                            o = output.Length > 0 ? output : null,
                            e = t.Done && t.Error is not null ? t.Error : null,
                            s = States(ts),
                        });
                    }
                    streak = pick == prev ? streak + 1 : 1;
                    prev = pick;
                }
                return Finish(spec, info, ts);
            }

            static RunInfo Finish(Spec spec, RunInfo info, Th[] ts)
            {
                ts = ts.Where(t => t is not null).ToArray();
                if (info.Status == "deadlock")
                {
                    var parts = new List<string>();
                    foreach (var t in ts.Where(t => !t.Done))
                    {
                        var holds = Locks.Where(p => p.Value.Owner == t.Id).Select(p => Names.TryGetValue(p.Key, out var nm) ? nm : "?").ToList();
                        var wants = t.Need is not null && Names.TryGetValue(t.Need, out var w) ? w : "?";
                        parts.Add("T" + t.Id + (holds.Count > 0 ? " holds " + string.Join(" and ", holds) + " and" : "") + " waits for " + wants);
                    }
                    info.Deadlock = string.Join("; ", parts);
                }
                var errors = ts.Where(t => t.Error is not null).Select(t => "T" + t.Id + " threw " + t.Error!.Split(':')[0]).ToList();
                info.Outcome = info.Status switch
                {
                    "deadlock" => "deadlock",
                    "limit" => "still running after " + MaxSteps + " steps",
                    "stuck" => "stuck: a thread blocked outside the scheduler",
                    _ when errors.Count > 0 => string.Join(", ", errors),
                    _ => Result(spec),
                };
                if (!_stuck)
                {
                    _aborting = true;
                    foreach (var t in ts)
                        if (!t.Done) { t.Go.Release(); if (!Back.Wait(StuckMs)) { _stuck = true; break; } }
                }
                foreach (var t in ts) t.Active = false;
                _aborting = false;
                return info;
            }

            static string Result(Spec spec)
            {
                try
                {
                    if (spec.Result is { } r) return r() is string text ? text : Dojo.Show(r());
                    return string.Join(", ", Snap(spec));
                }
                catch (System.Exception e) { return "the result threw " + e.GetType().Name; }
            }

            // ---------- entry point

            static void Emit(object o)
            {
                var json = System.Text.Json.JsonSerializer.Serialize(o, new System.Text.Json.JsonSerializerOptions
                {
                    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
                });
                Real.WriteLine("\u0002R|" + json);
                Real.Flush();
            }

            static System.IO.TextWriter Real = System.Console.Out;

            public static void Start(System.Func<Spec> make)
            {
                Real = System.Console.Out;
                System.Console.SetOut(System.IO.TextWriter.Synchronized(Out));
                var mode = System.Console.In.ReadLine() ?? "trace";
                var schedule = (System.Console.In.ReadLine() ?? "").Split(',', System.StringSplitOptions.RemoveEmptyEntries).Select(int.Parse).ToList();
                int? bound = int.TryParse(System.Console.In.ReadLine(), out var b) ? b : null;

                if (mode == "trace")
                {
                    var info = RunOnce(make(), schedule, true);
                    Emit(new { mode, status = info.Status, outcome = info.Outcome, deadlock = info.Deadlock, init = info.Init, steps = info.Steps, chosen = info.Chosen });
                    System.Environment.Exit(0);
                }

                var clock = System.Diagnostics.Stopwatch.StartNew();
                (Dictionary<string, (int Count, int[] Schedule, string Status)> Outcomes, int Runs, bool Pruned, bool Capped) Explore(int? limit, int cap, long untilMs)
                {
                    var outcomes = new Dictionary<string, (int, int[], string)>();
                    var stack = new Stack<int[]>();
                    stack.Push(System.Array.Empty<int>());
                    int runs = 0; bool pruned = false, capped = false;
                    while (stack.Count > 0)
                    {
                        if (runs >= cap || clock.ElapsedMilliseconds > untilMs) { capped = true; break; }
                        var prefix = stack.Pop();
                        var info = RunOnce(make(), prefix, false);
                        runs++;
                        outcomes[info.Outcome] = outcomes.TryGetValue(info.Outcome, out var seen)
                            ? (seen.Item1 + 1, seen.Item2, seen.Item3) : (1, info.Chosen.ToArray(), info.Status);
                        if (_stuck) { capped = true; break; }
                        var pre = 0;
                        for (var i = 0; i < info.Chosen.Count; i++)
                        {
                            bool Preempts(int c) => i > 0 && info.Runnable[i].Contains(info.Chosen[i - 1]) && c != info.Chosen[i - 1];
                            if (i >= prefix.Length && info.Branch[i])
                                foreach (var alt in info.Runnable[i])
                                {
                                    if (alt == info.Chosen[i]) continue;
                                    if (limit is { } lim && pre + (Preempts(alt) ? 1 : 0) > lim) { pruned = true; continue; }
                                    var next = new int[i + 1];
                                    for (var j = 0; j < i; j++) next[j] = info.Chosen[j];
                                    next[i] = alt;
                                    stack.Push(next);
                                }
                            if (Preempts(info.Chosen[i])) pre++;
                        }
                    }
                    return (outcomes, runs, pruned, capped);
                }

                int? usedBound = bound;
                var result = Explore(bound, bound is null ? 600 : 3000, 2600);
                if (bound is null && result.Capped && !_stuck)
                {
                    usedBound = 2;
                    var bounded = Explore(2, 3000, 2600 + 900);
                    foreach (var (k, v) in result.Outcomes)
                        if (!bounded.Outcomes.ContainsKey(k)) bounded.Outcomes[k] = v;
                    result = bounded;
                }
                Emit(new
                {
                    mode,
                    runs = result.Runs,
                    complete = !result.Capped,
                    bound = result.Pruned || usedBound != bound ? usedBound : null,
                    outcomes = result.Outcomes.OrderByDescending(o => o.Value.Count).Select(o => new { outcome = o.Key, count = o.Value.Count, schedule = o.Value.Schedule, status = o.Value.Status }),
                });
                System.Environment.Exit(0);
            }
        }
        """;
}
