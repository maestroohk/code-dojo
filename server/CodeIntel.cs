using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeDojo;

/// <summary>
/// C# code intelligence for the editors, from the real compiler: completion that knows types,
/// go to definition, find references and hover. Works over one file or many (code spaces pass
/// every file of the project, plus the assemblies its NuGet packages restored).
/// </summary>
public static class CodeIntel
{
    public record FileText(string Path, string Code);
    public record Request(string Action, FileText[] Files, string Path, int Position, string[]? References);
    public record Item(string Label, string Kind, string? Detail);
    public record Location(string Path, int Line, int Column, int Length, string Preview);
    public record Response(List<Item>? Items, Location? Definition, string? External, List<Location>? References, string? Hover);

    static readonly ConcurrentDictionary<string, MetadataReference> ExtraRefs = new();

    public static Response Run(CSharpRunner runner, Request req)
    {
        var files = req.Files ?? [];
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Code ?? "", CSharpRunner.ParseOptions, path: f.Path)).ToList();
        var tree = trees.FirstOrDefault(t => t.FilePath == req.Path);
        if (tree is null) return new(null, null, null, null, null);

        var refs = runner.IntelReferences.ToList();
        foreach (var path in req.References ?? [])
            if (File.Exists(path)) refs.Add(ExtraRefs.GetOrAdd(path, p => MetadataReference.CreateFromFile(p)));
        var comp = CSharpCompilation.Create("Intel", [.. trees, .. runner.SupportTrees], refs,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication, nullableContextOptions: NullableContextOptions.Enable));
        var model = comp.GetSemanticModel(tree);
        var pos = Math.Clamp(req.Position, 0, tree.Length);

        return req.Action switch
        {
            "complete" => new(Complete(model, tree, pos), null, null, null, null),
            "definition" => Definition(comp, model, tree, pos),
            "references" => new(null, null, null, References(comp, trees, model, tree, pos), null),
            "hover" => new(null, null, null, null, Hover(model, tree, pos)),
            _ => new(null, null, null, null, null),
        };
    }

    // ---------------------------------------------------------------- completion

    static List<Item> Complete(SemanticModel model, SyntaxTree tree, int pos)
    {
        var root = tree.GetRoot();
        var token = root.FindToken(Math.Max(0, pos - 1));
        // After "x." (possibly with a partial name typed): members of x's type, namespace or type.
        var dot = token.IsKind(SyntaxKind.DotToken) ? token : token.GetPreviousToken().IsKind(SyntaxKind.DotToken) && token.Span.End >= pos ? token.GetPreviousToken() : default;
        if (dot.Parent is MemberAccessExpressionSyntax ma || dot.Parent is QualifiedNameSyntax)
        {
            var left = dot.Parent switch { MemberAccessExpressionSyntax m => m.Expression, QualifiedNameSyntax q => (SyntaxNode)q.Left, _ => null };
            if (left is null) return [];
            var symbol = model.GetSymbolInfo(left).Symbol;
            var type = model.GetTypeInfo(left).Type;
            IEnumerable<ISymbol> members;
            bool staticOnly;
            if (symbol is INamespaceSymbol ns) { members = ns.GetMembers(); staticOnly = false; }
            else if (symbol is ITypeSymbol t) { members = model.LookupStaticMembers(pos, t); staticOnly = true; }        // Console.  Math.
            else if (type is not null) { members = model.LookupSymbols(pos, type, includeReducedExtensionMethods: true); staticOnly = false; }   // list.
            else return [];
            return members
                .Where(s => s.CanBeReferencedByName && !s.IsImplicitlyDeclared)
                .Where(s => s is not IMethodSymbol m || m.MethodKind is MethodKind.Ordinary or MethodKind.ReducedExtension)
                .Where(s => !staticOnly || s.IsStatic || s is INamedTypeSymbol)
                .Where(s => staticOnly || !s.IsStatic || s is IMethodSymbol { MethodKind: MethodKind.ReducedExtension })
                .GroupBy(s => s.Name)
                .Select(g => ToItem(g.First(), g.Count()))
                .OrderBy(i => i.Label)
                .ToList();
        }
        // Otherwise: everything in scope (locals, members, types, namespaces) plus keywords.
        var scope = model.LookupSymbols(pos)
            .Where(s => s.CanBeReferencedByName && !s.Name.StartsWith("__") && s.Name != "Dojo" && s.Name != "DojoWeb")
            .GroupBy(s => s.Name).Select(g => ToItem(g.First(), g.Count()));
        var keywords = "abstract as async await base bool break case catch char class const continue decimal default do double else enum false finally float for foreach if int interface internal is long namespace new null object out override private protected public readonly record return sealed static string struct switch this throw true try var void while using yield"
            .Split(' ').Select(k => new Item(k, "keyword", null));
        return [.. scope.OrderBy(i => i.Kind == "local" || i.Kind == "parameter" ? 0 : 1).ThenBy(i => i.Label), .. keywords];
    }

    static Item ToItem(ISymbol s, int overloads) => new(s.Name, Kind(s),
        s switch
        {
            IMethodSymbol m => m.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) + (overloads > 1 ? $"  (+{overloads - 1} overloads)" : ""),
            IPropertySymbol p => $"{p.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)} {p.Name}",
            IFieldSymbol f => $"{f.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)} {f.Name}",
            ILocalSymbol l => $"{l.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)} {l.Name}",
            IParameterSymbol p => $"{p.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)} {p.Name}",
            INamedTypeSymbol t => t.ToDisplayString(),
            _ => null,
        });

    static string Kind(ISymbol s) => s switch
    {
        IMethodSymbol => "method", IPropertySymbol => "property", IFieldSymbol f => f.IsConst ? "constant" : "field",
        IEventSymbol => "event", ILocalSymbol => "local", IParameterSymbol => "parameter", INamespaceSymbol => "namespace",
        INamedTypeSymbol t => t.TypeKind switch { TypeKind.Interface => "interface", TypeKind.Enum => "enum", TypeKind.Struct => "struct", _ => t.IsRecord ? "record" : "class" },
        _ => "symbol",
    };

    // ---------------------------------------------------------------- definition / references / hover

    static ISymbol? SymbolAt(SemanticModel model, SyntaxTree tree, int pos)
    {
        var token = tree.GetRoot().FindToken(pos);
        if (!token.IsKind(SyntaxKind.IdentifierToken) && pos > 0) token = tree.GetRoot().FindToken(pos - 1);
        if (token.Parent is null) return null;
        for (var node = token.Parent; node is not null; node = node.Parent)
        {
            var declared = model.GetDeclaredSymbol(node);
            if (declared is not null && node.ChildTokens().Contains(token)) return declared;
            var info = model.GetSymbolInfo(node);
            var s = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
            if (s is not null) return s is IMethodSymbol { ReducedFrom: { } from } ? from : s;
            if (node is StatementSyntax or MemberDeclarationSyntax) break;
        }
        return null;
    }

    static Response Definition(Compilation comp, SemanticModel model, SyntaxTree tree, int pos)
    {
        var symbol = SymbolAt(model, tree, pos);
        if (symbol is null) return new(null, null, null, null, null);
        var src = symbol.Locations.FirstOrDefault(l => l.IsInSource && l.SourceTree?.FilePath is { } p && !p.StartsWith("Dojo"));
        if (src is not null) return new(null, Loc(src), null, null, Describe(symbol));
        // Declared in a library: say exactly what it is, since there is no source to open.
        return new(null, null, $"{Describe(symbol)}\n\nDeclared in {symbol.ContainingAssembly?.Name ?? "a library"} (no source to open).", null, null);
    }

    static List<Location> References(Compilation comp, List<SyntaxTree> trees, SemanticModel model, SyntaxTree tree, int pos)
    {
        var target = SymbolAt(model, tree, pos);
        if (target is null) return [];
        var wanted = target.OriginalDefinition;
        var found = new List<Location>();
        foreach (var t in trees)
        {
            var m = comp.GetSemanticModel(t);
            foreach (var id in t.GetRoot().DescendantTokens().Where(k => k.IsKind(SyntaxKind.IdentifierToken) && k.ValueText == target.Name))
            {
                var node = id.Parent!;
                var s = m.GetDeclaredSymbol(node) ?? m.GetSymbolInfo(node).Symbol;
                if (s is IMethodSymbol { ReducedFrom: { } from }) s = from;
                if (s is not null && SymbolEqualityComparer.Default.Equals(s.OriginalDefinition, wanted)) found.Add(Loc(id.GetLocation()));
            }
        }
        return found;
    }

    static string? Hover(SemanticModel model, SyntaxTree tree, int pos)
    {
        var symbol = SymbolAt(model, tree, pos);
        return symbol is null ? null : Describe(symbol);
    }

    static string Describe(ISymbol s)
    {
        var text = s.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
        var type = s switch { ILocalSymbol l => l.Type, IParameterSymbol p => p.Type, IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => null };
        var kind = Kind(s);
        return type is not null && !text.Contains(type.ToDisplayString()) ? $"({kind}) {type.ToDisplayString()} {s.Name}" : $"({kind}) {text}";
    }

    static Location Loc(Microsoft.CodeAnalysis.Location l)
    {
        var span = l.GetLineSpan();
        var line = l.SourceTree!.GetText().Lines[span.StartLinePosition.Line].ToString().Trim();
        return new(span.Path, span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1, l.SourceSpan.Length, line.Length > 120 ? line[..120] + "…" : line);
    }
}
