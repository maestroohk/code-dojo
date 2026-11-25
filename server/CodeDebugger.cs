using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Emit;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace CodeDojo;

/// <summary>
/// A time-travel debugger. The whole program (every .cs file of a project and the projects it references)
/// is rewritten with the Code-in-motion tracer, so before every statement and every loop test it records
/// the file and line, the locals that have a value there (collections as count + first items, objects as
/// their members one level deep), the call stack with a location per frame, and what was printed since.
/// Exceptions are recorded where they were thrown. The run is recorded once; the UI then moves through it
/// like a live debugger, backwards as well as forwards.
///
/// Recording format (one line per record, written to a file so big runs never hit a pipe cap):
///   V\t{id}\t{json}   a variable value {n,t,ty,c?,items?,keys?,iprops?,props?}, interned
///   S\t{id}\t{json}   a call stack [{m,f,l}], interned
///   E\t{json}         a step {f,l,v:[value ids],s:stack id,o:output since the previous step}
///   X\t{json}         an exception {k:"throw"|"crash",ty,msg,f,l,v,s,o}
///   END\t{json}       the program finished {o}
///   STOP              the step cap was reached
/// </summary>
public static class CodeDebugger
{
    public const int DefaultMaxEvents = 20_000, MaxEventsCap = 100_000;
    public const int WallLimitMs = 60_000, CpuLimitMs = 30_000;
    const int StderrCap = 20_000, StdoutCap = 200_000;
    internal const long SinkCap = 200_000_000;

    public record SourceFile(string Path, string Code);
    public record Breakpoint(string? File, int Line);
    public record Input
    {
        public required List<SourceFile> Files { get; init; }
        /// <summary>Compile-time reference assemblies (packages); the base framework is always added.</summary>
        public List<string> References { get; init; } = [];
        /// <summary>Assemblies to load at run time by simple name (package runtime DLLs).</summary>
        public List<string> RuntimeLibs { get; init; } = [];
        public string GlobalUsings { get; init; } = "";
        public string? Stdin { get; init; }
        public string? WorkingDir { get; init; }
        public string AssemblyName { get; init; } = "DebugApp";
        public bool Nullable { get; init; } = true;
        public bool Unsafe { get; init; }
        /// <summary>Also reference ASP.NET Core's shared framework (some Microsoft.Extensions packages live there) and run on it.</summary>
        public bool AspNetFramework { get; init; }
        public int MaxEvents { get; init; } = DefaultMaxEvents;
        public List<Breakpoint>? Breakpoints { get; init; }
        public List<string> Notes { get; init; } = [];
        /// <summary>An ASP.NET Core app: requests are tagged so steps group per request (CodeDebugger.Live.cs).</summary>
        public bool Web { get; init; }
    }

    public sealed class Result
    {
        public string? Error { get; set; }
        public List<Diag> Diagnostics { get; set; } = [];
        public List<string> Files { get; set; } = [];
        public JsonArray Values { get; set; } = [];
        public JsonArray Stacks { get; set; } = [];
        public JsonArray Events { get; set; } = [];
        public bool Truncated { get; set; }
        public bool TimedOut { get; set; }
        public JsonObject? Exception { get; set; }
        public string Output { get; set; } = "";
        public string Stderr { get; set; } = "";
        public int ExitCode { get; set; }
        public long Ms { get; set; }
        public List<int> Hits { get; set; } = [];
        public List<string> Notes { get; set; } = [];
        public int MaxEvents { get; set; }
    }

    static readonly SemaphoreSlim Gate = new(1, 1);
    static readonly Lazy<(List<MetadataReference> Core, List<MetadataReference> Web, string WebDir)> Framework = new(() =>
    {
        var coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var webDir = Path.GetDirectoryName(typeof(Microsoft.AspNetCore.Builder.WebApplication).Assembly.Location)!;
        var tpa = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        List<MetadataReference> In(string dir) => tpa.Where(p => string.Equals(Path.GetDirectoryName(p), dir, StringComparison.OrdinalIgnoreCase))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        return (In(coreDir), In(webDir), webDir);
    });

    /// <summary>The usings an SDK console project gets from ImplicitUsings.</summary>
    public const string DefaultImplicitUsings = """
        global using global::System;
        global using global::System.Collections.Generic;
        global using global::System.IO;
        global using global::System.Linq;
        global using global::System.Net.Http;
        global using global::System.Threading;
        global using global::System.Threading.Tasks;
        """;

    public static async Task<Result> Run(string dotnet, Input input)
    {
        var result = NewResult(input);
        if (Build(input, result) is not { } built) return result;
        try
        {
            await Gate.WaitAsync();
            try { await Execute(dotnet, built.Dll, built.Dir, built.Sink, result.MaxEvents, input, result); }
            finally { Gate.Release(); }
            Read(built.Sink, result);
        }
        finally
        {
            try { Directory.Delete(built.Dir, true); } catch { }
        }
        AddHits(result, input.Breakpoints);
        if (result.TimedOut) result.Notes.Add("It ran longer than the debugger allows and was stopped; the steps up to then are here.");
        return result;
    }

    internal static Result NewResult(Input input) => new()
    {
        Files = input.Files.Select(f => f.Path).ToList(), Notes = [.. input.Notes],
        MaxEvents = Math.Clamp(input.MaxEvents <= 0 ? DefaultMaxEvents : input.MaxEvents, 100, MaxEventsCap),
    };

    /// <summary>The step indexes that sit on a breakpoint.</summary>
    internal static void AddHits(Result result, List<Breakpoint>? bps)
    {
        result.Hits.Clear();
        if (bps is not { Count: > 0 } || result.Files.Count == 0) return;
        var set = bps.Select(b => (File: b.File ?? result.Files[0], b.Line)).ToHashSet();
        for (var i = 0; i < result.Events.Count; i++)
            if (result.Events[i] is JsonObject e && (string?)e["k"] is null && e["f"] is { } f && (int)f >= 0 && (int)f < result.Files.Count
                && set.Contains((result.Files[(int)f], (int)e["l"]!)))
                result.Hits.Add(i);
    }

    /// <summary>A compiled, rewritten program in its own temp folder, ready to start.</summary>
    internal sealed record Built(string Dir, string Dll, string Sink);

    /// <summary>Compiles the program twice (as written, then rewritten with stops) and emits it. Null with result.Error on failure.</summary>
    internal static Built? Build(Input input, Result result)
    {
        if (input.Files.Count == 0) { result.Error = "There are no C# files to debug."; return null; }

        var parse = CSharpRunner.ParseOptions.WithPreprocessorSymbols("DEBUG", "TRACE", "NET", "NETCOREAPP");
        var originals = input.Files.Select(f => CSharpSyntaxTree.ParseText(f.Code.Replace("\r\n", "\n"), parse, path: f.Path, encoding: Encoding.UTF8)).ToList();
        var usings = CSharpSyntaxTree.ParseText(input.GlobalUsings, parse, path: "GlobalUsings.g.cs", encoding: Encoding.UTF8);
        var fw = Framework.Value;
        var refs = new List<MetadataReference>(input.AspNetFramework ? [.. fw.Core, .. fw.Web] : fw.Core);
        foreach (var r in input.References.Distinct(StringComparer.OrdinalIgnoreCase))
            try { refs.Add(MetadataReference.CreateFromFile(r)); } catch { result.Notes.Add($"Could not load the reference {Path.GetFileName(r)}."); }
        var options = new CSharpCompilationOptions(OutputKind.ConsoleApplication,
            nullableContextOptions: input.Nullable ? NullableContextOptions.Enable : NullableContextOptions.Disable,
            optimizationLevel: OptimizationLevel.Debug, allowUnsafe: input.Unsafe, concurrentBuild: true);

        // 1. The program as written: real errors with real file names and lines.
        var plain = CSharpCompilation.Create(input.AssemblyName, [.. originals, usings], refs, options);
        var errors = plain.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        if (errors.Count > 0)
        {
            result.Diagnostics = errors.Take(50).Select(ToDiag).ToList();
            result.Error = "The program does not compile, so it cannot be debugged yet. Fix the errors (Build shows them all) and try again.";
            return null;
        }

        // 2. Every file rewritten with trace calls. A file the rewriter cannot handle runs untraced.
        var traced = new List<SyntaxTree>();
        for (var i = 0; i < originals.Count; i++)
        {
            try
            {
                var model = plain.GetSemanticModel(originals[i]);
                var root = new DebugTracer(model, i).Visit(originals[i].GetRoot());
                traced.Add(CSharpSyntaxTree.ParseText(root.ToFullString(), parse, path: originals[i].FilePath, encoding: Encoding.UTF8));
            }
            catch (Exception e)
            {
                traced.Add(originals[i]);
                result.Notes.Add($"{originals[i].FilePath} could not be prepared for stepping ({e.Message}); it runs without stops.");
            }
        }
        var support = new List<SyntaxTree> { CSharpSyntaxTree.ParseText(Support, parse, path: "__DojoDbg.cs", encoding: Encoding.UTF8) };
        if (input.Web) support.Add(CSharpSyntaxTree.ParseText(WebSupport, parse, path: "__DojoWeb.cs", encoding: Encoding.UTF8));
        CSharpCompilation comp = null!;
        for (var attempt = 0; attempt < 4; attempt++)
        {
            comp = CSharpCompilation.Create(input.AssemblyName, [.. traced, usings, .. support], refs, options);
            var bad = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            if (bad.Count == 0) break;
            var files = bad.Select(d => d.Location.SourceTree?.FilePath).OfType<string>().ToHashSet();
            var replaced = false;
            for (var i = 0; i < traced.Count; i++)
                if (files.Contains(traced[i].FilePath) && !ReferenceEquals(traced[i], originals[i]))
                {
                    traced[i] = originals[i];
                    replaced = true;
                    result.Notes.Add($"{originals[i].FilePath} uses something the step recorder cannot handle ({bad.First(d => d.Location.SourceTree?.FilePath == originals[i].FilePath).GetMessage()}); it runs without stops.");
                }
            if (!replaced || attempt == 3)
            {
                result.Error = "This program cannot be recorded for debugging (" + bad[0].GetMessage() + "). Use Run instead.";
                return null;
            }
        }

        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "debug-" + Guid.NewGuid().ToString("N")[..12]);
        Directory.CreateDirectory(dir);
        var dll = Path.Combine(dir, input.AssemblyName + ".dll");
        EmitResult emit;
        using (var pe = File.Create(dll)) emit = comp.Emit(pe);
        if (!emit.Success)
        {
            result.Error = "The recorder could not build this program: " + emit.Diagnostics.FirstOrDefault(d => d.Severity == DiagnosticSeverity.Error)?.GetMessage();
            try { Directory.Delete(dir, true); } catch { }
            return null;
        }
        File.WriteAllText(Path.Combine(dir, input.AssemblyName + ".runtimeconfig.json"), RuntimeConfig(input.AspNetFramework, fw.WebDir));
        File.WriteAllLines(Path.Combine(dir, "dojo-libs.txt"), input.RuntimeLibs.Where(File.Exists));
        return new Built(dir, dll, Path.Combine(dir, "steps.txt"));
    }

    static string RuntimeConfig(bool web, string webDir) => System.Text.Json.JsonSerializer.Serialize(new
    {
        runtimeOptions = new
        {
            tfm = $"net{Environment.Version.Major}.0",
            frameworks = web
                ? new object[] { new { name = "Microsoft.NETCore.App", version = Environment.Version.ToString() }, new { name = "Microsoft.AspNetCore.App", version = Path.GetFileName(webDir) } }
                : [new { name = "Microsoft.NETCore.App", version = Environment.Version.ToString() }],
        },
    });

    static Diag ToDiag(Diagnostic d)
    {
        var span = d.Location.GetMappedLineSpan();
        return new Diag(d.Severity == DiagnosticSeverity.Error ? "error" : "warning", d.Id, d.GetMessage(),
            span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1, d.Location.SourceTree?.FilePath ?? "");
    }

    static async Task Execute(string dotnet, string dll, string dir, string sink, int max, Input input, Result result)
    {
        var psi = StartInfo(dotnet, dll, dir, sink, max, input);
        var sw = Stopwatch.StartNew();
        using var proc = Process.Start(psi)!;
        try { proc.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        void Kill() { try { proc.Kill(entireProcessTree: true); } catch { } }
        var outTask = Pump(proc.StandardOutput, StdoutCap);
        var errTask = Pump(proc.StandardError, StderrCap);
        try
        {
            if (!string.IsNullOrEmpty(input.Stdin)) await proc.StandardInput.WriteAsync(input.Stdin.Replace("\r\n", "\n"));
            proc.StandardInput.Close();
        }
        catch (IOException) { }

        var exit = proc.WaitForExitAsync();
        while (await Task.WhenAny(exit, Task.Delay(100)) != exit)
        {
            TimeSpan cpu;
            try { cpu = proc.TotalProcessorTime; } catch { continue; }
            long size = 0;
            try { size = new FileInfo(sink).Length; } catch { }
            if (cpu.TotalMilliseconds <= CpuLimitMs && sw.ElapsedMilliseconds <= WallLimitMs && size <= SinkCap) continue;
            result.TimedOut = true;
            Kill();
            break;
        }
        await exit;
        var stdout = await outTask;
        result.Stderr = (await errTask).Trim();
        result.ExitCode = result.TimedOut ? -1 : proc.ExitCode;
        result.Ms = sw.ElapsedMilliseconds;
        if (stdout.Length > 0) result.Notes.Add("Some output bypassed Console.Out and is not attached to steps: " + Clip(stdout.Trim(), 400));
    }

    internal static async Task<string> Pump(StreamReader reader, int cap)
    {
        var sb = new StringBuilder();
        var buf = new char[4096];
        int n;
        while ((n = await reader.ReadAsync(buf)) > 0)
            if (sb.Length < cap) sb.Append(buf, 0, Math.Min(n, cap - sb.Length));
        return sb.ToString();
    }

    /// <summary>dotnet {dll} with a clean environment and the recorder's settings.</summary>
    internal static ProcessStartInfo StartInfo(string dotnet, string dll, string dir, string sink, int max, Input input)
    {
        var psi = new ProcessStartInfo(dotnet)
        {
            WorkingDirectory = input.WorkingDir is { } wd && Directory.Exists(wd) ? wd : dir,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, StandardInputEncoding = new UTF8Encoding(false),
        };
        psi.ArgumentList.Add(dll);
        foreach (var key in psi.Environment.Keys.ToList())
            if (key.StartsWith("MSBuild", StringComparison.OrdinalIgnoreCase) || key.StartsWith("ASPNETCORE_", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("DOJO_", StringComparison.OrdinalIgnoreCase) || key is "DOTNET_STARTUP_HOOKS")
                psi.Environment.Remove(key);
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["DOTNET_TieredPGO"] = "0";
        psi.Environment["DOTNET_ENVIRONMENT"] = "Development";
        psi.Environment["DOJO_DEBUG_OUT"] = sink;
        psi.Environment["DOJO_DEBUG_MAX"] = max.ToString();

        return psi;
    }

    static string Clip(string s, int n) => s.Length > n ? s[..n] + "…" : s;

    /// <summary>Turns the recording into tables the UI can index: values[id], stacks[id], events[i].</summary>
    internal static void Read(string sink, Result result)
    {
        if (!File.Exists(sink)) { result.Error ??= result.TimedOut ? "It ran too long before reaching any code." : "The program did not start (" + Clip(result.Stderr, 400) + ")"; return; }
        var values = new Dictionary<int, JsonNode?>();
        var stacks = new Dictionary<int, JsonNode?>();
        var output = new StringBuilder();
        using (var reader = new StreamReader(new FileStream(sink, FileMode.Open, FileAccess.Read, FileShare.ReadWrite), Encoding.UTF8))
        {
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                try
                {
                    if (line.StartsWith("V\t") || line.StartsWith("S\t"))
                    {
                        var tab = line.IndexOf('\t', 2);
                        if (tab < 0) continue;
                        var id = int.Parse(line.AsSpan(2, tab - 2));
                        (line[0] == 'V' ? values : stacks)[id] = JsonNode.Parse(line[(tab + 1)..]);
                    }
                    else if (line.StartsWith("E\t") || line.StartsWith("X\t") || line.StartsWith("END\t") || line.StartsWith("W\t"))
                    {
                        if (JsonNode.Parse(line[(line.IndexOf('\t') + 1)..]) is not JsonObject e) continue;
                        if (line[0] == 'X') result.Exception = e.DeepClone().AsObject();
                        if (line[0] == 'X' && (string?)e["k"] == "throw") result.Exception = null;   // a thrown exception may still be caught
                        output.Append((string?)e["o"] ?? "");
                        result.Events.Add(e);
                    }
                    else if (line == "STOP") result.Truncated = true;
                }
                catch { /* a half-written last line after a kill */ }
            }
        }
        // A crash is the last record; a "throw" that was never caught shows up as a crash too.
        if (result.Events.LastOrDefault() is JsonObject last && (string?)last["k"] == "crash") result.Exception = last.DeepClone().AsObject();
        else result.Exception = null;
        result.Output = output.ToString();
        var vmax = values.Count == 0 ? -1 : values.Keys.Max();
        for (var i = 0; i <= vmax; i++) result.Values.Add(values.TryGetValue(i, out var v) ? v : null);
        var smax = stacks.Count == 0 ? -1 : stacks.Keys.Max();
        for (var i = 0; i <= smax; i++) result.Stacks.Add(stacks.TryGetValue(i, out var s) ? s : null);
        if (result.Events.Count == 0 && result.Error is null && result.ExitCode != 0)
            result.Error = "The program stopped before its first statement: " + Clip(result.Stderr, 600);
    }

    // ================================================================ the rewriter

    /// <summary>
    /// The Code-in-motion tracer plus what a project debugger needs: a file index in every call, "this" in
    /// instance members of classes, and expression-bodied members turned into blocks so they get a stop.
    /// </summary>
    sealed class DebugTracer(SemanticModel model, int file) : CodeTrace.Tracer(model, "__DojoDbg", file)
    {
        /// <summary>The method (or lambda / local function) chain around a position, innermost first, up to the member.</summary>
        List<IMethodSymbol> Chain(SyntaxNode at)
        {
            var list = new List<IMethodSymbol>();
            var cur = Model.GetEnclosingSymbol(at.SpanStart);
            while (cur is IMethodSymbol m)
            {
                list.Add(m);
                if (m.MethodKind is not (MethodKind.LocalFunction or MethodKind.AnonymousFunction)) break;
                cur = m.ContainingSymbol;
            }
            return list;
        }

        protected override IEnumerable<ISymbol> Visible(SyntaxNode at)
        {
            // Inside a static lambda or static local function, outer locals are in scope but cannot be read.
            var chain = Chain(at);
            var boundary = chain.FindIndex(m => m.IsStatic && m.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction);
            var allowed = boundary < 0 ? null : chain.Take(boundary + 1).ToList<ISymbol>();
            return base.Visible(at)
                .Where(s => allowed is null || s.ContainingSymbol is null || allowed.Contains(s.ContainingSymbol, SymbolEqualityComparer.Default))
                .Where(s => (s as ILocalSymbol)?.Type is not (IPointerTypeSymbol or IFunctionPointerTypeSymbol)
                         && (s as IParameterSymbol)?.Type is not (IPointerTypeSymbol or IFunctionPointerTypeSymbol));
        }

        protected override IEnumerable<ArgumentSyntax> Extra(SyntaxNode at)
        {
            var chain = Chain(at);
            if (chain.Count == 0) yield break;
            if (chain.Any(m => m.IsStatic && m.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction)) yield break;
            var member = chain[^1];
            if (member.IsStatic || member.ContainingType?.TypeKind != TypeKind.Class) yield break;
            if (member.MethodKind is MethodKind.StaticConstructor or MethodKind.LocalFunction or MethodKind.AnonymousFunction) yield break;
            yield return Argument(LiteralExpression(SyntaxKind.StringLiteralExpression, Literal("this")));
            yield return Argument(CastExpression(PredefinedType(Token(SyntaxKind.ObjectKeyword)), ThisExpression()));
        }

        static bool VoidLike(IMethodSymbol m) =>
            m.ReturnsVoid || (m.IsAsync && m.ReturnType is INamedTypeSymbol { IsGenericType: false, Name: "Task" or "ValueTask" });

        /// <summary>{ trace; return expr; } (or expr; for void members) for an expression body.</summary>
        BlockSyntax ArrowBlock(ArrowExpressionClauseSyntax original, ExpressionSyntax visited, bool isVoid, SyntaxToken semicolon)
        {
            StatementSyntax body = visited is ThrowExpressionSyntax t ? ThrowStatement(t.Expression)
                : isVoid ? ExpressionStatement(visited) : ReturnStatement(visited.WithLeadingTrivia(Space));
            return Block(Trace(original.Expression), body).WithTrailingTrivia(semicolon.TrailingTrivia);
        }

        static bool Simple(IMethodSymbol? m) => m is not null && !m.ReturnsByRef && !m.ReturnsByRefReadonly;

        public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            var visited = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node)!;
            if (node.ExpressionBody is null || visited.ExpressionBody is null || Model.GetDeclaredSymbol(node) is not { } m || !Simple(m)) return visited;
            return visited.WithExpressionBody(null).WithSemicolonToken(Token(SyntaxKind.None))
                .WithBody(ArrowBlock(node.ExpressionBody, visited.ExpressionBody.Expression, VoidLike(m), node.SemicolonToken));
        }

        // Expression lambdas (minimal API handlers, callbacks) get a stop of their own, except where they
        // become expression trees (LINQ to a database), which cannot hold a block.
        public override SyntaxNode? VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node) =>
            LambdaBlock(node, (LambdaExpressionSyntax)base.VisitParenthesizedLambdaExpression(node)!);

        public override SyntaxNode? VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node) =>
            LambdaBlock(node, (LambdaExpressionSyntax)base.VisitSimpleLambdaExpression(node)!);

        SyntaxNode LambdaBlock(LambdaExpressionSyntax node, LambdaExpressionSyntax visited)
        {
            if (node.ExpressionBody is null || visited.ExpressionBody is null) return visited;
            if (node.ExpressionBody is ThrowExpressionSyntax || node.Ancestors().Any(a => a is AttributeSyntax or QueryExpressionSyntax)) return visited;
            if (Model.GetTypeInfo(node).ConvertedType is INamedTypeSymbol { Name: "Expression", ContainingNamespace: { } ns } && ns.ToDisplayString() == "System.Linq.Expressions") return visited;
            if (Model.GetSymbolInfo(node).Symbol is not IMethodSymbol m || !Simple(m)) return visited;
            if (!m.ReturnsVoid && m.ReturnType.IsRefLikeType) return visited;
            var isVoid = VoidLike(m);
            StatementSyntax body = isVoid ? ExpressionStatement(visited.ExpressionBody) : ReturnStatement(visited.ExpressionBody.WithLeadingTrivia(Space));
            var block = Block(Trace(node.ExpressionBody), body);
            return visited.WithExpressionBody(null).WithBlock(block);
        }

        public override SyntaxNode? VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
        {
            var visited = (LocalFunctionStatementSyntax)base.VisitLocalFunctionStatement(node)!;
            if (node.ExpressionBody is null || visited.ExpressionBody is null || Model.GetDeclaredSymbol(node) is not IMethodSymbol m || !Simple(m)) return visited;
            return visited.WithExpressionBody(null).WithSemicolonToken(Token(SyntaxKind.None))
                .WithBody(ArrowBlock(node.ExpressionBody, visited.ExpressionBody.Expression, VoidLike(m), node.SemicolonToken));
        }

        public override SyntaxNode? VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
        {
            var visited = (ConstructorDeclarationSyntax)base.VisitConstructorDeclaration(node)!;
            if (node.ExpressionBody is null || visited.ExpressionBody is null) return visited;
            return visited.WithExpressionBody(null).WithSemicolonToken(Token(SyntaxKind.None))
                .WithBody(ArrowBlock(node.ExpressionBody, visited.ExpressionBody.Expression, true, node.SemicolonToken));
        }

        public override SyntaxNode? VisitPropertyDeclaration(PropertyDeclarationSyntax node)
        {
            var visited = (PropertyDeclarationSyntax)base.VisitPropertyDeclaration(node)!;
            if (node.ExpressionBody is null || visited.ExpressionBody is null || Model.GetDeclaredSymbol(node) is not { ReturnsByRef: false, ReturnsByRefReadonly: false }) return visited;
            var getter = AccessorDeclaration(SyntaxKind.GetAccessorDeclaration,
                ArrowBlock(node.ExpressionBody, visited.ExpressionBody.Expression, false, default));
            return visited.WithExpressionBody(null).WithSemicolonToken(Token(SyntaxKind.None))
                .WithAccessorList(AccessorList(SingletonList(getter)).WithTrailingTrivia(node.SemicolonToken.TrailingTrivia));
        }

        public override SyntaxNode? VisitAccessorDeclaration(AccessorDeclarationSyntax node)
        {
            var visited = (AccessorDeclarationSyntax)base.VisitAccessorDeclaration(node)!;
            if (node.ExpressionBody is null || visited.ExpressionBody is null) return visited;
            if (node.Parent?.Parent is IndexerDeclarationSyntax or EventDeclarationSyntax) return visited;
            if (node.Parent?.Parent is PropertyDeclarationSyntax p && Model.GetDeclaredSymbol(p) is { ReturnsByRef: true } or { ReturnsByRefReadonly: true }) return visited;
            var isVoid = !node.IsKind(SyntaxKind.GetAccessorDeclaration);
            return visited.WithExpressionBody(null).WithSemicolonToken(Token(SyntaxKind.None))
                .WithBody(ArrowBlock(node.ExpressionBody, visited.ExpressionBody.Expression, isVoid, node.SemicolonToken));
        }
    }

    // ================================================================ compiled into the program

    const string Support = """
        #nullable disable
        static class __DojoDbg
        {
            static readonly System.IO.TextWriter Real;
            static readonly System.IO.StringWriter Buf = new System.IO.StringWriter();
            static readonly System.IO.TextWriter SyncBuf;
            static readonly System.IO.StreamWriter Sink;
            static readonly object Gate = new object();
            static readonly System.Reflection.Module Mine = typeof(__DojoDbg).Module;
            static readonly System.Collections.Generic.Dictionary<string, int> Values = new System.Collections.Generic.Dictionary<string, int>();
            static readonly System.Collections.Generic.Dictionary<string, int> Stacks = new System.Collections.Generic.Dictionary<string, int>();
            static readonly System.Collections.Generic.Dictionary<System.Type, int> Kinds = new System.Collections.Generic.Dictionary<System.Type, int>();
            static readonly System.Collections.Generic.Dictionary<System.Type, bool> OwnToString = new System.Collections.Generic.Dictionary<System.Type, bool>();
            static readonly int Max;
            static int _n, _reqSeq;
            static volatile bool _done;
            static bool _full;
            static System.Exception _thrown;
            static int _thrownF = -1, _thrownL, _thrownS = -1;
            static string _thrownV = "[]";
            [System.ThreadStatic] static bool _busy;
            const int MaxItems = 30, MaxPropItems = 10, MaxMembers = 25, MaxText = 200;
            const long WebSinkCap = 150000000;

            /// <summary>Web mode (DOJO_DEBUG_WEB=1): steps are tagged with the request they run for. Live mode: Console.ReadLine reports when it waits.</summary>
            static readonly bool Web, Live;
            /// <summary>The request the current code runs for (0: startup or background work).</summary>
            public static readonly System.Threading.AsyncLocal<int> Req = new System.Threading.AsyncLocal<int>();
            static System.Threading.Timer _tick;

            /// <summary>Where one flow of execution is: the program (console), startup, or one HTTP request.</summary>
            sealed class Ctx
            {
                public int Id, N, F = -1, L, S = -1;
                public string V = "[]";
                public bool Full, Failed;
                public System.Exception Thrown;
                public readonly System.Collections.Generic.List<(System.Reflection.MethodBase M, int F, int L)> Last = new System.Collections.Generic.List<(System.Reflection.MethodBase M, int F, int L)>();
            }
            static readonly Ctx Prog = new Ctx();
            static readonly System.Collections.Generic.Dictionary<int, Ctx> Reqs = new System.Collections.Generic.Dictionary<int, Ctx>();

            static Ctx Cur()
            {
                if (!Web) return Prog;
                var r = Req.Value;
                return r != 0 && Reqs.TryGetValue(r, out var c) ? c : Prog;
            }

            static bool IsSupport(System.Reflection.MethodBase m) => m.DeclaringType?.FullName?.StartsWith("__Dojo", System.StringComparison.Ordinal) == true;

            [System.Runtime.CompilerServices.ModuleInitializer]
            internal static void Init() { }

            static __DojoDbg()
            {
                var map = new System.Collections.Generic.Dictionary<string, string>(System.StringComparer.OrdinalIgnoreCase);
                try
                {
                    var libs = System.IO.Path.Combine(System.AppContext.BaseDirectory, "dojo-libs.txt");
                    if (System.IO.File.Exists(libs))
                        foreach (var p in System.IO.File.ReadAllLines(libs))
                            if (p.Length > 0) map[System.IO.Path.GetFileNameWithoutExtension(p)] = p;
                }
                catch { }
                System.Runtime.Loader.AssemblyLoadContext.Default.Resolving += (ctx, name) =>
                    name.Name != null && map.TryGetValue(name.Name, out var path) ? ctx.LoadFromAssemblyPath(path) : null;

                int.TryParse(System.Environment.GetEnvironmentVariable("DOJO_DEBUG_MAX"), out Max);
                if (Max <= 0) Max = 20000;
                Web = System.Environment.GetEnvironmentVariable("DOJO_DEBUG_WEB") == "1";
                Live = Web || System.Environment.GetEnvironmentVariable("DOJO_DEBUG_LIVE") == "1";
                var file = System.Environment.GetEnvironmentVariable("DOJO_DEBUG_OUT") ?? System.IO.Path.Combine(System.AppContext.BaseDirectory, "steps.txt");
                Sink = new System.IO.StreamWriter(new System.IO.FileStream(file, System.IO.FileMode.Create, System.IO.FileAccess.Write, System.IO.FileShare.Read, 1 << 16), new System.Text.UTF8Encoding(false), 1 << 16);
                Real = System.Console.Out;
                SyncBuf = System.IO.TextWriter.Synchronized(Buf);
                System.Console.SetOut(SyncBuf);
                if (Live && !Web) System.Console.SetIn(new __DojoIn(System.Console.In));
                // A running web app prints between steps (logging): pass that on, and keep the file current for the live reader.
                if (Web) _tick = new System.Threading.Timer(_ => Tick(), null, 200, 200);
                System.AppDomain.CurrentDomain.ProcessExit += (_, _) => End();
                System.AppDomain.CurrentDomain.UnhandledException += (_, e) => Crash(e.ExceptionObject as System.Exception);
                System.AppDomain.CurrentDomain.FirstChanceException += (_, e) => Thrown(e.Exception);
            }

            public static bool C(int file, int line, params object[] kv) { T(file, line, kv); return true; }

            public static void T(int file, int line, params object[] kv)
            {
                if (_busy || _done) return;          // showing a value must not record the code it happens to run
                _busy = true;
                var stop = false;
                var abort = false;
                try
                {
                    lock (Gate)
                    {
                        var c = Cur();
                        if (_done || _full) { }
                        else if (c.Full) abort = c.Id > 0;
                        else
                        {
                            var v = Vars(kv);
                            var s = Stack(c, new System.Diagnostics.StackTrace(1, false), file, line);
                            c.F = file; c.L = line; c.S = s; c.V = v;
                            Sink.Write("E\t{\"f\":"); Sink.Write(file); Sink.Write(",\"l\":"); Sink.Write(line);
                            Sink.Write(",\"v\":"); Sink.Write(v); Sink.Write(",\"s\":"); Sink.Write(s);
                            if (c.Id > 0) { Sink.Write(",\"r\":"); Sink.Write(c.Id); }
                            Out();
                            Sink.Write("}\n");
                            if (++_n % 256 == 0) Sink.Flush();
                            if (++c.N >= Max)
                            {
                                if (!Web)
                                {
                                    Sink.Write("STOP\n");
                                    End();
                                    stop = true;
                                }
                                else
                                {
                                    // A web app keeps running: this request (or startup) just stops being recorded.
                                    c.Full = true;
                                    Sink.Write("RT\t{\"r\":"); Sink.Write(c.Id); Sink.Write("}\n");
                                    Sink.Flush();
                                }
                            }
                            if (Web && Sink.BaseStream.Position > WebSinkCap)
                            {
                                _full = true;
                                Sink.Write("FULL\n");
                                Sink.Flush();
                            }
                        }
                    }
                }
                finally { _busy = false; }
                // Outside the lock: ProcessExit handlers may run on another thread and take it.
                if (stop) System.Environment.Exit(0);
                // A request past its cap is stopped, so an endless loop in a handler does not spin forever.
                if (abort) throw new System.OperationCanceledException("The debugger stopped this request after " + Max + " steps (is a loop endless?).");
            }

            static void Out()
            {
                string o;
                lock (SyncBuf) { o = Buf.ToString(); Buf.GetStringBuilder().Clear(); }
                if (o.Length == 0) return;
                Sink.Write(",\"o\":"); Sink.Write(Q(o));
            }

            static void Tick()
            {
                if (_done) return;
                try
                {
                    lock (Gate)
                    {
                        if (_done) return;
                        string o;
                        lock (SyncBuf) { o = Buf.ToString(); Buf.GetStringBuilder().Clear(); }
                        if (o.Length > 0) { Sink.Write("O\t{\"o\":"); Sink.Write(Q(o)); Sink.Write("}\n"); }
                        Sink.Flush();
                    }
                }
                catch { }
            }

            // ------------------------------------------------------------ interactive input (live console sessions)

            /// <summary>Console.ReadLine is about to block: record where, with the output so far, and tell the dojo.</summary>
            internal static void Waiting()
            {
                if (_done || _busy) return;
                _busy = true;
                try
                {
                    lock (Gate)
                    {
                        if (_done) return;
                        var c = Prog;
                        Sink.Write("W\t{\"k\":\"input\",\"f\":"); Sink.Write(c.F); Sink.Write(",\"l\":"); Sink.Write(c.L);
                        Sink.Write(",\"s\":"); Sink.Write(c.S); Sink.Write(",\"v\":"); Sink.Write(c.V);
                        Out();
                        Sink.Write("}\n");
                        Sink.Flush();
                    }
                    Real.Write("\u0002WAIT\n");
                    Real.Flush();
                }
                catch { }
                finally { _busy = false; }
            }

            /// <summary>Show a line that was typed in the output, as a terminal would.</summary>
            internal static void Echo(string line)
            {
                if (line != null) SyncBuf.Write(line + "\n");
            }

            // ------------------------------------------------------------ requests (web mode; called by __DojoWeb's middleware)

            public static int BeginRequest(string method, string path)
            {
                int id;
                lock (Gate)
                {
                    id = ++_reqSeq;
                    Reqs[id] = new Ctx { Id = id };
                    if (!_done && !_full)
                    {
                        Sink.Write("R\t{\"r\":"); Sink.Write(id); Sink.Write(",\"m\":"); Sink.Write(Q(method ?? ""));
                        Sink.Write(",\"p\":"); Sink.Write(Q(Clip(path ?? "", 400))); Sink.Write("}\n");
                        Sink.Flush();
                    }
                }
                Req.Value = id;
                return id;
            }

            public static bool Failed(int id)
            {
                lock (Gate) if (Reqs.TryGetValue(id, out var c)) c.Failed = true;
                return false;
            }

            public static void EndRequest(int id, int status, long ms)
            {
                lock (Gate)
                {
                    var failed = Reqs.TryGetValue(id, out var c) && c.Failed;
                    Reqs.Remove(id);
                    if (_done) return;
                    try
                    {
                        Sink.Write("RE\t{\"r\":"); Sink.Write(id); Sink.Write(",\"st\":"); Sink.Write(failed && status < 500 ? 500 : status);
                        Sink.Write(",\"ms\":"); Sink.Write(ms); Sink.Write(",\"failed\":"); Sink.Write(failed ? "true" : "false"); Sink.Write("}\n");
                        Sink.Flush();
                    }
                    catch { }
                }
            }

            static void End()
            {
                if (_done) return;
                lock (Gate)
                {
                    if (_done) return;
                    _done = true;
                    try
                    {
                        Sink.Write("END\t{\"k\":\"end\""); Out(); Sink.Write("}\n");
                        Sink.Flush();
                    }
                    catch { }
                }
            }

            static void Thrown(System.Exception ex)
            {
                if (_busy || _done || ex == null) return;
                _busy = true;
                try
                {
                    lock (Gate)
                    {
                        // Only exceptions thrown by the program's own code: the runtime throws and catches many inside itself.
                        var frame = new System.Diagnostics.StackTrace(ex, false).GetFrame(0)?.GetMethod();
                        if (frame == null || frame.Module != Mine || IsSupport(frame)) return;
                        var c = Cur();
                        // An exception that travels up through awaits is thrown again at each one: record it once.
                        if (ReferenceEquals(c.Thrown, ex) || c.Full || _full) return;
                        c.Thrown = ex;
                        _thrown = ex; _thrownF = c.F; _thrownL = c.L; _thrownS = c.S; _thrownV = c.V;
                        Exc("throw", ex, c.F, c.L, c.S, c.V, c.Id);
                    }
                }
                catch { }
                finally { _busy = false; }
            }

            static void Crash(System.Exception ex)
            {
                _busy = true;
                lock (Gate)
                {
                    if (_done) return;
                    try
                    {
                        var inner = ex;
                        while (inner is System.AggregateException { InnerExceptions.Count: 1 } a) inner = a.InnerException;
                        while (inner is System.Reflection.TargetInvocationException { InnerException: not null } t) inner = t.InnerException;
                        var mine = ReferenceEquals(_thrown, ex) || ReferenceEquals(_thrown, inner);
                        var c = Cur();
                        Exc("crash", inner ?? ex, mine ? _thrownF : c.F, mine ? _thrownL : c.L, mine ? _thrownS : c.S, mine ? _thrownV : c.V, c.Id);
                    }
                    catch { }
                    _done = true;
                    try { Sink.Flush(); } catch { }
                }
            }

            static void Exc(string kind, System.Exception ex, int f, int l, int s, string v, int r)
            {
                Sink.Write("X\t{\"k\":\""); Sink.Write(kind); Sink.Write("\",\"ty\":"); Sink.Write(Q(ex?.GetType().FullName ?? "Exception"));
                Sink.Write(",\"msg\":"); Sink.Write(Q(Clip(ex?.Message ?? "", 2000)));
                Sink.Write(",\"f\":"); Sink.Write(f); Sink.Write(",\"l\":"); Sink.Write(l);
                Sink.Write(",\"s\":"); Sink.Write(s); Sink.Write(",\"v\":"); Sink.Write(v);
                if (r > 0) { Sink.Write(",\"r\":"); Sink.Write(r); }
                Out();
                Sink.Write("}\n");
                Sink.Flush();
            }

            // ------------------------------------------------------------ call stack

            static int Stack(Ctx c, System.Diagnostics.StackTrace st, int file, int line)
            {
                var mine = new System.Collections.Generic.List<System.Reflection.MethodBase>();
                foreach (var fr in st.GetFrames())
                {
                    var m = fr.GetMethod();
                    if (m == null || m.Module != Mine || IsSupport(m)) continue;
                    mine.Add(m);
                }
                mine.Reverse();
                if (mine.Count == 0) mine.Add(null);
                var n = mine.Count;
                var Last = c.Last;
                if (Last.Count > n) Last.RemoveRange(n, Last.Count - n);
                for (var i = 0; i < n - 1; i++)
                    if (i >= Last.Count) Last.Add((mine[i], -1, 0));
                    else if (Last[i].M != mine[i]) Last[i] = (mine[i], -1, 0);
                if (Last.Count < n) Last.Add((mine[n - 1], file, line)); else Last[n - 1] = (mine[n - 1], file, line);
                var sb = new System.Text.StringBuilder("[");
                for (var i = 0; i < n; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append("{\"m\":").Append(Q(Name(mine[i]))).Append(",\"f\":").Append(Last[i].F).Append(",\"l\":").Append(Last[i].L).Append('}');
                }
                sb.Append(']');
                var json = sb.ToString();
                if (!Stacks.TryGetValue(json, out var id))
                {
                    id = Stacks.Count;
                    Stacks[json] = id;
                    Sink.Write("S\t"); Sink.Write(id); Sink.Write('\t'); Sink.Write(json); Sink.Write('\n');
                }
                return id;
            }

            static string Name(System.Reflection.MethodBase m)
            {
                if (m == null) return "top level";
                var raw = m.Name;
                var type = m.DeclaringType;
                string inner = null;
                // async methods and iterators run as MoveNext of a generated <Name>d__N class
                if (type != null && type.Name.StartsWith("<") && type.Name.Contains(">d__")) { inner = type.Name.Substring(1, type.Name.IndexOf('>') - 1); raw = inner; }
                while (type != null && type.Name.StartsWith("<") && type.DeclaringType != null) type = type.DeclaringType;
                var owner = type == null ? "" : Clean(type.Name);
                if (raw == "<Main>$") return "top level";
                var g = raw.IndexOf(">g__", System.StringComparison.Ordinal);
                if (g >= 0) { var end = raw.IndexOf('|', g); var fn = raw.Substring(g + 4, (end < 0 ? raw.Length : end) - g - 4); return owner == "Program" ? fn : owner + "." + fn; }
                var b = raw.IndexOf(">b__", System.StringComparison.Ordinal);
                if (raw.StartsWith("<") && b > 0) { var host = raw.Substring(1, b - 1); return "lambda in " + (host == "<Main>$" || host == "Main>$" ? "top level" : owner + "." + host.Replace("<", "")); }
                if (raw.StartsWith("<")) raw = raw.Substring(1, System.Math.Max(0, raw.IndexOf('>') - 1));
                if (raw == "Main>$" || raw == "<Main>$") return "top level";
                if (raw == ".ctor") raw = "new " + owner;
                if (raw == ".cctor") raw = "static " + owner;
                return raw.StartsWith("new ") || raw.StartsWith("static ") ? raw : owner + "." + raw;
            }

            static string Clean(string n) { var t = n.IndexOf('`'); return t >= 0 ? n.Substring(0, t) : n; }

            // ------------------------------------------------------------ values

            static string Vars(object[] kv)
            {
                var sb = new System.Text.StringBuilder("[");
                for (var i = 0; i + 1 < kv.Length; i += 2)
                {
                    string json;
                    try { json = Describe((string)kv[i], kv[i + 1]); }
                    catch (System.Exception e) { json = "{\"n\":" + Q((string)kv[i]) + ",\"t\":" + Q("(could not read: " + e.GetType().Name + ")") + "}"; }
                    if (!Values.TryGetValue(json, out var id))
                    {
                        id = Values.Count;
                        Values[json] = id;
                        Sink.Write("V\t"); Sink.Write(id); Sink.Write('\t'); Sink.Write(json); Sink.Write('\n');
                    }
                    if (i > 0) sb.Append(',');
                    sb.Append(id);
                }
                return sb.Append(']').ToString();
            }

            // 0 scalar, 1 dictionary, 2 collection, 3 lazy sequence, 4 framework object (ToString only), 5 program object
            static int Kind(System.Type t)
            {
                if (Kinds.TryGetValue(t, out var k)) return k;
                if (t.IsPrimitive || t.IsEnum || t == typeof(string) || t == typeof(decimal) || t == typeof(System.DateTime) || t == typeof(System.DateTimeOffset)
                    || t == typeof(System.TimeSpan) || t == typeof(System.Guid) || t == typeof(System.DateOnly) || t == typeof(System.TimeOnly)
                    || t == typeof(System.Text.StringBuilder) || typeof(System.Delegate).IsAssignableFrom(t) || typeof(System.Type).IsAssignableFrom(t)
                    || t.FullName?.StartsWith("System.ValueTuple") == true || t.FullName?.StartsWith("System.Tuple") == true) k = 0;
                else if (typeof(System.Collections.IDictionary).IsAssignableFrom(t)) k = 1;
                else if (typeof(System.Collections.ICollection).IsAssignableFrom(t) || System.Linq.Enumerable.Any(t.GetInterfaces(), i => i.IsGenericType &&
                    (i.GetGenericTypeDefinition() == typeof(System.Collections.Generic.ICollection<>) || i.GetGenericTypeDefinition() == typeof(System.Collections.Generic.IReadOnlyCollection<>)))) k = 2;
                else if (typeof(System.Collections.IEnumerable).IsAssignableFrom(t) && t.Module != Mine) k = 3;
                else if (t.Module != Mine) k = 4;
                else k = 5;
                Kinds[t] = k;
                return k;
            }

            static bool HasOwnToString(System.Type t)
            {
                if (OwnToString.TryGetValue(t, out var b)) return b;
                var d = t.GetMethod("ToString", System.Type.EmptyTypes)?.DeclaringType;
                b = d != null && d != typeof(object) && d != typeof(System.ValueType);
                OwnToString[t] = b;
                return b;
            }

            static string Describe(string name, object v)
            {
                var sb = new System.Text.StringBuilder("{\"n\":").Append(Q(name));
                if (v == null) return sb.Append(",\"t\":\"null\"}").ToString();
                var t = v.GetType();
                sb.Append(",\"ty\":").Append(Q(TypeName(t)));
                switch (Kind(t))
                {
                    case 1:
                    {
                        var d = (System.Collections.IDictionary)v;
                        var keys = new System.Collections.Generic.List<string>();
                        var vals = new System.Collections.Generic.List<string>();
                        foreach (System.Collections.DictionaryEntry e in d) { if (keys.Count >= MaxItems) break; keys.Add(Short(e.Key, 1)); vals.Add(Short(e.Value, 1)); }
                        var text = new System.Text.StringBuilder("{");
                        for (var i = 0; i < keys.Count && text.Length < MaxText; i++) text.Append(i > 0 ? ", " : "").Append(keys[i]).Append(": ").Append(vals[i]);
                        text.Append(keys.Count < d.Count || text.Length >= MaxText ? ", …}" : "}");
                        sb.Append(",\"t\":").Append(Q(Clip(text.ToString(), MaxText + 4))).Append(",\"c\":").Append(d.Count);
                        sb.Append(",\"keys\":").Append(Arr(keys)).Append(",\"items\":").Append(Arr(vals));
                        break;
                    }
                    case 2:
                    {
                        var items = new System.Collections.Generic.List<string>();
                        var props = new System.Collections.Generic.List<string>();
                        var any = false;
                        var count = Count(v);
                        foreach (var item in (System.Collections.IEnumerable)v)
                        {
                            if (items.Count >= MaxItems) break;   // only the first ones: never walk a big collection
                            items.Add(Short(item, 1));
                            if (item != null && Kind(item.GetType()) == 5 && props.Count < MaxPropItems) { props.Add(Members(item)); any = true; }
                            else if (props.Count < MaxPropItems) props.Add("null");
                        }
                        var text = new System.Text.StringBuilder("[");
                        for (var i = 0; i < items.Count && text.Length < MaxText; i++) text.Append(i > 0 ? ", " : "").Append(items[i]);
                        text.Append(items.Count < count || text.Length >= MaxText ? (items.Count > 0 ? ", …]" : "…]") : "]");
                        sb.Append(",\"t\":").Append(Q(Clip(text.ToString(), MaxText + 4))).Append(",\"c\":").Append(count).Append(",\"items\":").Append(Arr(items));
                        if (any) sb.Append(",\"iprops\":[").Append(string.Join(",", props)).Append(']');
                        break;
                    }
                    case 3:
                        sb.Append(",\"t\":").Append(Q("(a query: it runs when something reads it)"));
                        break;
                    case 5:
                    {
                        var members = Members(v);
                        var text = HasOwnToString(t) ? Clip(SafeToString(v), MaxText) : Summary(v, t);
                        sb.Append(",\"t\":").Append(Q(text)).Append(",\"props\":").Append(members);
                        break;
                    }
                    default:
                        sb.Append(",\"t\":").Append(Q(Short(v, 0)));
                        if (v is System.Exception ex) sb.Append(",\"props\":[{\"n\":\"Message\",\"t\":").Append(Q(Clip(ex.Message, MaxText))).Append(",\"ty\":\"string\"}]");
                        break;
                }
                return sb.Append('}').ToString();
            }

            static string Summary(object v, System.Type t)
            {
                var sb = new System.Text.StringBuilder(TypeName(t)).Append(" { ");
                var first = true;
                foreach (var (n, val, _) in Read(v, 6))
                {
                    if (!first) sb.Append(", ");
                    first = false;
                    sb.Append(n).Append(" = ").Append(val);
                    if (sb.Length > MaxText) break;
                }
                return Clip(sb.Append(first ? "}" : " }").ToString(), MaxText);
            }

            static string Members(object v)
            {
                var sb = new System.Text.StringBuilder("[");
                var first = true;
                foreach (var (n, val, ty) in Read(v, MaxMembers))
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"n\":").Append(Q(n)).Append(",\"t\":").Append(Q(val)).Append(",\"ty\":").Append(Q(ty)).Append('}');
                }
                return sb.Append(']').ToString();
            }

            /// <summary>Public properties, then fields (private ones too: this is a debugger), one level deep.</summary>
            static readonly System.Collections.Generic.Dictionary<System.Type, System.Collections.Generic.List<(string Name, System.Reflection.MemberInfo Member, string Ty)>> Shape =
                new System.Collections.Generic.Dictionary<System.Type, System.Collections.Generic.List<(string Name, System.Reflection.MemberInfo Member, string Ty)>>();

            /// <summary>Public properties, then fields (private ones too: this is a debugger), worked out once per type.</summary>
            static System.Collections.Generic.List<(string Name, System.Reflection.MemberInfo Member, string Ty)> MembersOf(System.Type t)
            {
                if (Shape.TryGetValue(t, out var list)) return list;
                list = new System.Collections.Generic.List<(string Name, System.Reflection.MemberInfo Member, string Ty)>();
                var seen = new System.Collections.Generic.HashSet<string>();
                const System.Reflection.BindingFlags inst = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
                foreach (var p in t.GetProperties(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public))
                {
                    if (list.Count >= MaxMembers) break;
                    if (p.GetIndexParameters().Length > 0 || !p.CanRead || p.PropertyType.IsByRefLike || p.Name == "EqualityContract") continue;
                    list.Add((p.Name, p, TypeName(p.PropertyType)));
                    seen.Add(p.Name);
                }
                for (var bt = t; bt != null && bt != typeof(object) && bt.Module == Mine; bt = bt.BaseType)
                    foreach (var f in bt.GetFields(inst | System.Reflection.BindingFlags.DeclaredOnly))
                    {
                        if (list.Count >= MaxMembers) break;
                        var n = f.Name;
                        if (n.StartsWith("<"))
                        {
                            var close = n.IndexOf('>');
                            var prop = close > 1 ? n.Substring(1, close - 1) : n;
                            if (seen.Contains(prop) || !n.EndsWith("k__BackingField")) continue;   // auto-properties already shown
                            n = prop;
                        }
                        if (f.FieldType.IsByRefLike || f.FieldType.IsPointer || !seen.Add(n)) continue;
                        list.Add((n, f, TypeName(f.FieldType)));
                    }
                Shape[t] = list;
                return list;
            }

            static System.Collections.Generic.IEnumerable<(string, string, string)> Read(object v, int max)
            {
                var result = new System.Collections.Generic.List<(string, string, string)>();
                foreach (var (name, member, ty) in MembersOf(v.GetType()))
                {
                    if (result.Count >= max) break;
                    string text;
                    try { text = Short(member is System.Reflection.PropertyInfo p ? p.GetValue(v) : ((System.Reflection.FieldInfo)member).GetValue(v), 1); }
                    catch (System.Reflection.TargetInvocationException e) { text = "(threw " + e.InnerException?.GetType().Name + ")"; }
                    catch { text = "(could not read)"; }
                    result.Add((name, text, ty));
                }
                return result;
            }

            static string SafeToString(object v)
            {
                try { return v.ToString() ?? ""; } catch (System.Exception e) { return "(ToString threw " + e.GetType().Name + ")"; }
            }

            /// <summary>A one-line display of any value.</summary>
            static string Short(object v, int depth)
            {
                if (v == null) return "null";
                switch (v)
                {
                    case string s: return "\"" + Clip(s, MaxText) + "\"";
                    case char c: return "'" + c + "'";
                    case bool b: return b ? "true" : "false";
                    case System.IFormattable f when !(v is System.Collections.IEnumerable):
                        try { return f.ToString(null, System.Globalization.CultureInfo.InvariantCulture); } catch { return SafeToString(v); }
                    case System.Exception e: return e.GetType().Name + ": " + Clip(e.Message, 120);
                    case System.Delegate d: return "delegate " + (d.Method?.Name ?? "");
                }
                var t = v.GetType();
                var k = Kind(t);
                if (k == 1 || k == 2)
                {
                    if (depth > 1) return TypeName(t) + " (" + Count(v) + ")";
                    var sb = new System.Text.StringBuilder(k == 1 ? "{" : "[");
                    var n = 0;
                    if (v is System.Collections.IDictionary dict)
                        foreach (System.Collections.DictionaryEntry e in dict) { if (n++ >= 8 || sb.Length > 100) { sb.Append(", …"); break; } sb.Append(n > 1 ? ", " : "").Append(Short(e.Key, depth + 1)).Append(": ").Append(Short(e.Value, depth + 1)); }
                    else
                        foreach (var item in (System.Collections.IEnumerable)v) { if (n++ >= 8 || sb.Length > 100) { sb.Append(", …"); break; } sb.Append(n > 1 ? ", " : "").Append(Short(item, depth + 1)); }
                    return sb.Append(k == 1 ? "}" : "]").ToString();
                }
                if (k == 3) return "(query)";
                if (HasOwnToString(t)) return Clip(SafeToString(v), MaxText);
                return k == 5 ? "{" + TypeName(t) + "}" : TypeName(t);
            }

            static readonly System.Collections.Generic.Dictionary<System.Type, System.Reflection.PropertyInfo> CountProps = new System.Collections.Generic.Dictionary<System.Type, System.Reflection.PropertyInfo>();

            static int Count(object v)
            {
                if (v is System.Collections.ICollection c) return c.Count;
                var t = v.GetType();
                if (!CountProps.TryGetValue(t, out var prop))
                {
                    prop = t.GetProperty("Count", System.Type.EmptyTypes);
                    if (prop != null && prop.PropertyType != typeof(int)) prop = null;
                    CountProps[t] = prop;
                }
                if (prop != null) try { return (int)prop.GetValue(v); } catch { }
                var n = 0;
                foreach (var _ in (System.Collections.IEnumerable)v) n++;
                return n;
            }

            static readonly System.Collections.Generic.Dictionary<System.Type, string> Names = new System.Collections.Generic.Dictionary<System.Type, string>
            {
                [typeof(int)] = "int", [typeof(long)] = "long", [typeof(short)] = "short", [typeof(byte)] = "byte", [typeof(sbyte)] = "sbyte",
                [typeof(uint)] = "uint", [typeof(ulong)] = "ulong", [typeof(ushort)] = "ushort", [typeof(bool)] = "bool", [typeof(char)] = "char",
                [typeof(string)] = "string", [typeof(double)] = "double", [typeof(float)] = "float", [typeof(decimal)] = "decimal", [typeof(object)] = "object",
            };

            static string TypeName(System.Type t)
            {
                if (Names.TryGetValue(t, out var n)) return n;
                if (t.IsArray) return TypeName(t.GetElementType()) + "[" + new string(',', t.GetArrayRank() - 1) + "]";
                if (t.Name.StartsWith("<>f__AnonymousType")) return "anonymous";
                if (t.IsGenericType)
                {
                    var args = t.GetGenericArguments();
                    if (t.GetGenericTypeDefinition() == typeof(System.Nullable<>)) return TypeName(args[0]) + "?";
                    if (t.FullName?.StartsWith("System.ValueTuple") == true) return "(" + string.Join(", ", System.Linq.Enumerable.Select(args, TypeName)) + ")";
                    return Clean(t.Name) + "<" + string.Join(", ", System.Linq.Enumerable.Select(args, TypeName)) + ">";
                }
                n = t.Name;
                Names[t] = n;
                return n;
            }

            static string Arr(System.Collections.Generic.List<string> items)
            {
                var sb = new System.Text.StringBuilder("[");
                for (var i = 0; i < items.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Q(items[i])); }
                return sb.Append(']').ToString();
            }

            static string Clip(string s, int n) => s.Length > n ? s.Substring(0, n) + "…" : s;

            static string Q(string s)
            {
                var sb = new System.Text.StringBuilder(s.Length + 2).Append('"');
                foreach (var c in s)
                {
                    switch (c)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        default:
                            if (c < ' ' || (c >= '\uD800' && c <= '\uDFFF')) sb.Append("\\u").Append(((int)c).ToString("x4"));
                            else sb.Append(c);
                            break;
                    }
                }
                return sb.Append('"').ToString();
            }
        }

        /// <summary>Console.In for a live session: says when ReadLine is about to wait, and echoes what it read.</summary>
        sealed class __DojoIn : System.IO.TextReader
        {
            readonly System.IO.TextReader _real;
            public __DojoIn(System.IO.TextReader real) { _real = real; }
            public override string ReadLine()
            {
                __DojoDbg.Waiting();
                var line = _real.ReadLine();
                __DojoDbg.Echo(line);
                return line;
            }
            public override int Peek() => _real.Peek();
            public override int Read() => _real.Read();
            public override string ReadToEnd() => _real.ReadToEnd();
        }
        """;

    /// <summary>
    /// Compiled into a web app being debugged: a hosting startup (found by ASP.NET Core in the app's own assembly)
    /// adds a startup filter whose middleware runs first for every request. It tags the request (an AsyncLocal id the
    /// recorder reads), records method, path, status and duration, and names the request in an X-Dojo-Request header.
    /// </summary>
    const string WebSupport = """
        #nullable disable
        [assembly: Microsoft.AspNetCore.Hosting.HostingStartup(typeof(__DojoWebStartup))]

        sealed class __DojoWebStartup : Microsoft.AspNetCore.Hosting.IHostingStartup
        {
            public void Configure(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
            {
                builder.ConfigureServices(services => services.Insert(0,
                    Microsoft.Extensions.DependencyInjection.ServiceDescriptor.Transient<Microsoft.AspNetCore.Hosting.IStartupFilter, __DojoWebFilter>()));
            }
        }

        sealed class __DojoWebFilter : Microsoft.AspNetCore.Hosting.IStartupFilter
        {
            public System.Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> Configure(System.Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> next)
            {
                return app =>
                {
                    app.Use(inner => ctx => Handle(ctx, inner));
                    next(app);
                };
            }

            static async System.Threading.Tasks.Task Handle(Microsoft.AspNetCore.Http.HttpContext ctx, Microsoft.AspNetCore.Http.RequestDelegate inner)
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var id = __DojoDbg.BeginRequest(ctx.Request.Method, ctx.Request.Path.ToString() + ctx.Request.QueryString.ToString());
                ctx.Response.OnStarting(() =>
                {
                    ctx.Response.Headers["X-Dojo-Request"] = id.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    return System.Threading.Tasks.Task.CompletedTask;
                });
                try { await inner(ctx); }
                catch (System.Exception) when (__DojoDbg.Failed(id)) { }
                finally { __DojoDbg.EndRequest(id, ctx.Response.StatusCode, sw.ElapsedMilliseconds); }
            }
        }
        """;
}
