using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeDojo;

/// <summary>
/// Reads a minimal-API Program.cs and lists what the request pipeline is made of, in source order:
/// services registered, middleware added, endpoints mapped (with route group prefixes resolved).
/// The Workbench draws this as a map of the learner's own code and lights up the path each request takes.
/// It is a reading of the syntax, not of the running app, so it is a good picture, not a proof.
/// </summary>
public static class CodeOutline
{
    public record Item(string Kind, string Name, string? Method, string? Route, int Line, string? Detail);

    static readonly Dictionary<string, string> MapVerbs = new()
    {
        ["MapGet"] = "GET", ["MapPost"] = "POST", ["MapPut"] = "PUT", ["MapDelete"] = "DELETE", ["MapPatch"] = "PATCH",
    };

    public static List<Item> Read(string code)
    {
        var root = CSharpSyntaxTree.ParseText(code, new CSharpParseOptions(LanguageVersion.Latest)).GetRoot();
        var items = new List<Item>();
        var groups = new Dictionary<string, string>();   // variable name -> route prefix

        foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (inv.Expression is not MemberAccessExpressionSyntax ma) continue;
            var name = ma.Name.Identifier.Text;
            var line = inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
            var args = inv.ArgumentList.Arguments;
            var first = args.FirstOrDefault()?.Expression is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression)
                ? lit.Token.ValueText : null;
            var receiver = ma.Expression.ToString();

            if (name == "MapGroup" && first is not null)
            {
                var prefix = Prefix(receiver, groups) + first;
                if (inv.Parent is EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax v })
                    groups[v.Identifier.Text] = prefix;
                // Fluent use: app.MapGroup("/x").MapGet(...) is handled through the receiver text below.
                continue;
            }
            if (MapVerbs.TryGetValue(name, out var verb) || name is "MapMethods" or "Map")
            {
                var route = Prefix(receiver, groups) + (first ?? "");
                var handler = args.Count > 1 ? Summarize(args[^1].Expression) : null;
                items.Add(new("endpoint", name, verb ?? (name == "Map" ? "ANY" : "…"), route.Length == 0 ? "/" : route, line, handler));
                continue;
            }
            if (receiver is "app" or "builder.Services" or "services" || receiver.EndsWith(".Services"))
            {
                if (receiver.EndsWith("Services") && name.StartsWith("Add"))
                {
                    var generic = ma.Name is GenericNameSyntax g ? $"<{string.Join(", ", g.TypeArgumentList.Arguments)}>" : "";
                    items.Add(new("service", name + generic, null, null, line, Lifetime(name)));
                }
                else if (receiver == "app" && (name.StartsWith("Use") || name == "Run" && args.Count > 0))
                {
                    var detail = name == "Use" && args.Count > 0 ? Summarize(args[0].Expression) : null;
                    items.Add(new("middleware", name, null, null, line, detail));
                }
            }
        }
        return items;
    }

    /// <summary>Route prefix for a receiver such as "app", "tasks" (a group variable), or app.MapGroup("/api").</summary>
    static string Prefix(string receiver, Dictionary<string, string> groups)
    {
        if (groups.TryGetValue(receiver, out var p)) return p;
        var m = System.Text.RegularExpressions.Regex.Matches(receiver, "MapGroup\\(\\s*\"([^\"]*)\"");
        return string.Concat(m.Select(x => x.Groups[1].Value));
    }

    static string? Lifetime(string name) =>
        name.StartsWith("AddSingleton") ? "one instance for the whole app" :
        name.StartsWith("AddScoped") ? "one instance per request" :
        name.StartsWith("AddTransient") ? "a new instance every time it is asked for" : null;

    /// <summary>What a handler takes in, in a few words: (int id, ITaskStore store) => …</summary>
    static string? Summarize(ExpressionSyntax e) => e switch
    {
        ParenthesizedLambdaExpressionSyntax l => $"({string.Join(", ", l.ParameterList.Parameters.Select(p => p.ToString().Trim()))}) => …",
        SimpleLambdaExpressionSyntax l => $"{l.Parameter} => …",
        IdentifierNameSyntax id => id.Identifier.Text,
        MemberAccessExpressionSyntax m => m.ToString(),
        _ => null,
    };
}
