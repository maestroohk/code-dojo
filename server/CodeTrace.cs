using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace CodeDojo;

/// <summary>
/// Code in motion: run a program one statement at a time, as far as the learner can tell.
/// The code is rewritten (with Roslyn) so that before every statement, and before every loop
/// condition is tested, it reports the line about to run, every local variable that has a value
/// at that point, the call stack (so recursion shows as frames), and anything printed since the
/// last step. The UI replays the steps like a debugger you can scrub backwards.
/// </summary>
public static class CodeTrace
{
    public const int MaxSteps = 800;

    public record Request(string? Code, string? Stdin);
    public record Response(string[] Lines, JsonArray Steps, string Output, bool Truncated, List<Diag> Diagnostics, string? Error);

    const string Support = """
        static class __DojoTrace
        {
            static readonly System.IO.TextWriter Real;
            static readonly System.IO.StringWriter Buf = new();
            static int _n;
            static bool _busy;

            static __DojoTrace()
            {
                Real = System.Console.Out;
                System.Console.SetOut(Buf);
                System.AppDomain.CurrentDomain.ProcessExit += (_, _) => Emit(0, System.Array.Empty<object?>(), true);
            }

            public static bool C(int line, params object?[] kv) { T(line, kv); return true; }

            public static void T(int line, params object?[] kv) => Emit(line, kv, false);

            static void Emit(int line, object?[] kv, bool end)
            {
                if (_busy) return;          // showing a value must not trace code it happens to run
                _busy = true;
                try
                {
                    var vars = new System.Collections.Generic.List<object>();
                    for (var i = 0; i + 1 < kv.Length; i += 2)
                    {
                        var v = kv[i + 1];
                        string[]? items = null;
                        string text;
                        if (v is not string && v is System.Collections.ICollection col)
                        {
                            items = col.Cast<object?>().Take(40).Select(Dojo.Show).ToArray();
                            text = Dojo.Show(v);
                        }
                        else if (v is not string && v is System.Collections.IEnumerable)
                            text = "(a query: it has not run)";
                        else text = Dojo.Show(v);
                        vars.Add(new { n = (string)kv[i]!, t = text, items });
                    }
                    var frames = new System.Diagnostics.StackTrace(0, false).GetFrames()
                        .Select(f => f.GetMethod())
                        .Where(m => m?.DeclaringType?.Name == "Program")
                        .Select(m => Name(m!.Name)).Reverse().ToArray();
                    var output = Buf.ToString();
                    Buf.GetStringBuilder().Clear();
                    var json = System.Text.Json.JsonSerializer.Serialize(new { l = line, v = vars, s = frames, o = output, end });
                    Real.WriteLine("\u0002T|" + json);
                    Real.Flush();
                    if (!end && ++_n >= 800)
                    {
                        Real.WriteLine("\u0002STOP");
                        Real.Flush();
                        System.Environment.Exit(0);
                    }
                }
                finally { _busy = false; }
            }

            static string Name(string raw)
            {
                if (raw == "<Main>$") return "top level";
                var at = raw.IndexOf("g__", System.StringComparison.Ordinal);
                if (at >= 0) { var end = raw.IndexOf('|', at); return raw.Substring(at + 3, (end < 0 ? raw.Length : end) - at - 3); }
                return raw;
            }
        }
        """;

    public static async Task<Response> Run(CSharpRunner runner, Request req)
    {
        var code = (req.Code ?? "").Replace("\r\n", "\n");
        var lines = code.Split('\n');

        // First, the plain program: real compiler errors with the learner's own line numbers.
        var (plain, diags) = runner.Compile(code);
        if (plain is null) return new(lines, [], "", false, diags, "Your code does not compile yet.");
        plain.Dispose();

        var tree = CSharpSyntaxTree.ParseText(code, CSharpRunner.ParseOptions);
        var model = runner.Analyze(tree).GetSemanticModel(tree);
        var rewritten = new Tracer(model).Visit(tree.GetRoot());
        var traced = rewritten.ToFullString() + "\n" + Support;

        var (program, tdiags) = runner.Compile(traced);
        if (program is null)
            return new(lines, [], "", false, diags, "This code cannot be traced (" + tdiags.FirstOrDefault(d => d.Severity == "error")?.Message + "). Try the Playground to run it normally.");
        using (program)
        {
            var run = await runner.Run(program, req.Stdin);
            var steps = new JsonArray();
            var truncated = false;
            foreach (var line in run.Stdout.Replace("\r\n", "\n").Split('\n'))
            {
                if (line.StartsWith("\u0002T|")) steps.Add(JsonNode.Parse(line[3..]));
                else if (line.StartsWith("\u0002STOP")) truncated = true;
            }
            var output = string.Concat(steps.Select(s => (string?)s?["o"] ?? ""));
            string? error = run.TimedOut ? "It ran too long and was stopped."
                : run.ExitCode != 0 && !truncated ? "It crashed: " + run.Stderr.Split('\n').FirstOrDefault()?.Trim() : null;
            return new(lines, steps, output, truncated, diags, error);
        }
    }

    /// <summary>Inserts __DojoTrace.T(line, "name", value, ...) before statements and into loop conditions.</summary>
    sealed class Tracer(SemanticModel model) : CSharpSyntaxRewriter
    {
        static int Line(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

        /// <summary>Locals and parameters that can be read at this point without a compiler error.</summary>
        IEnumerable<ISymbol> Visible(SyntaxNode at)
        {
            DataFlowAnalysis? flow = null;
            try { flow = at is ExpressionSyntax e ? model.AnalyzeDataFlow(e) : at is StatementSyntax s ? model.AnalyzeDataFlow(s) : null; } catch { }
            if (flow is null || !flow.Succeeded) return [];
            var assigned = flow.DefinitelyAssignedOnEntry;
            return model.LookupSymbols(at.SpanStart)
                .Where(s => s is ILocalSymbol or IParameterSymbol)
                .Where(s => s.Locations.FirstOrDefault() is { IsInSource: true } loc && loc.SourceSpan.Start < at.SpanStart)
                .Where(s => assigned.Contains(s, SymbolEqualityComparer.Default))
                .Where(s => (s as ILocalSymbol)?.Type.IsRefLikeType != true && (s as IParameterSymbol)?.Type.IsRefLikeType != true)
                .Where(s => (s as ILocalSymbol)?.IsRef != true && (s as IParameterSymbol)?.RefKind is null or RefKind.None)
                .Where(s => !s.Name.StartsWith("__"))
                .OrderBy(s => s.Locations[0].SourceSpan.Start);
        }

        ArgumentListSyntax Args(SyntaxNode at)
        {
            var args = new List<ArgumentSyntax> { Argument(LiteralExpression(SyntaxKind.NumericLiteralExpression, Literal(Line(at)))) };
            foreach (var s in Visible(at))
            {
                args.Add(Argument(LiteralExpression(SyntaxKind.StringLiteralExpression, Literal(s.Name))));
                args.Add(Argument(CastExpression(PredefinedType(Token(SyntaxKind.ObjectKeyword)).WithTrailingTrivia(), IdentifierName(s.Name))));
            }
            return ArgumentList(SeparatedList(args));
        }

        StatementSyntax Trace(SyntaxNode at) => ExpressionStatement(InvocationExpression(
            ParseExpression("__DojoTrace.T"), Args(at)));

        static bool Skip(StatementSyntax s) => s is LocalFunctionStatementSyntax or BlockSyntax or EmptyStatementSyntax;

        public override SyntaxNode? VisitCompilationUnit(CompilationUnitSyntax node)
        {
            var members = new List<MemberDeclarationSyntax>();
            foreach (var m in node.Members)
            {
                if (m is GlobalStatementSyntax g && !Skip(g.Statement)) members.Add(GlobalStatement(Trace(g.Statement)));
                members.Add((MemberDeclarationSyntax)Visit(m)!);
            }
            return node.WithMembers(List(members));
        }

        public override SyntaxNode? VisitBlock(BlockSyntax node)
        {
            var list = new List<StatementSyntax>();
            foreach (var s in node.Statements)
            {
                if (!Skip(s)) list.Add(Trace(s));
                list.Add((StatementSyntax)Visit(s)!);
            }
            return node.WithStatements(List(list));
        }

        public override SyntaxNode? Visit(SyntaxNode? node)
        {
            // Bodies without braces (if (x) y++;) get a block, so there is room for the trace call.
            if (node is StatementSyntax s && !Skip(s) &&
                s.Parent is IfStatementSyntax or ElseClauseSyntax or ForStatementSyntax or ForEachStatementSyntax
                    or WhileStatementSyntax or DoStatementSyntax or UsingStatementSyntax or LockStatementSyntax)
                return Block(Trace(s), (StatementSyntax)base.Visit(s)!);
            return base.Visit(node);
        }

        // Loop conditions: show every test of i <= n, including the last one that ends the loop.
        public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
        {
            var visited = (ForStatementSyntax)base.VisitForStatement(node)!;
            return node.Condition is null ? visited : visited.WithCondition(Probe(node.Condition, (ExpressionSyntax)Visit(node.Condition)!));
        }

        public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
        {
            var visited = (WhileStatementSyntax)base.VisitWhileStatement(node)!;
            return visited.WithCondition(Probe(node.Condition, (ExpressionSyntax)Visit(node.Condition)!));
        }

        ExpressionSyntax Probe(ExpressionSyntax original, ExpressionSyntax visited) =>
            BinaryExpression(SyntaxKind.LogicalAndExpression,
                InvocationExpression(ParseExpression("__DojoTrace.C"), Args(original)),
                ParenthesizedExpression(visited));
    }
}
