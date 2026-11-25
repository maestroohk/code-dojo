using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeDojo;

/// <summary>
/// LINQ in motion. Takes a source expression and a method chain such as
///   source: new[] { 5, 3, 8 }      query: .Where(n => n > 2).OrderBy(n => n)
/// rewrites it to tap every stage, runs it for real, and returns each item in the order it
/// actually came out of each operator. Streaming operators (Where, Select) pass items one at a
/// time; buffering ones (OrderBy, GroupBy) swallow everything first. The UI replays the events.
/// </summary>
public static class LinqViz
{
    public record Request(string? Source, string? Query, string? Setup);
    public record Event(int Stage, string Text);
    public record Response(List<string> Stages, List<Event> Events, string? Result, bool Lazy, List<Diag> Diagnostics, string? Error);

    const string Marker = "\u0002VIZ|";
    const int MaxEvents = 400;

    const string TapSource = """
        static class __DojoViz
        {
            public static IEnumerable<T> __Tap<T>(this IEnumerable<T> items, int stage)
            {
                foreach (var item in items)
                {
                    Console.WriteLine("\u0002VIZ|" + stage + "|" + Dojo.Show(item).Replace("\n", " "));
                    yield return item;
                }
            }
        }
        """;

    public static async Task<Response> Run(CSharpRunner runner, Request req)
    {
        var source = (req.Source ?? "").Trim();
        var query = (req.Query ?? "").Trim();
        if (source.Length == 0) return Fail("Give a source, for example new[] { 1, 2, 3 }.");
        if (query.Length > 0 && !query.StartsWith('.')) query = "." + query;

        // Unwind the chain: __src.A(...).B(...) -> ["A(...)", "B(...)"]
        var expr = SyntaxFactory.ParseExpression("__src" + query);
        if (expr.ContainsDiagnostics) return Fail("The query does not parse. Write it as a chain of calls starting with a dot: .Where(x => ...).Select(x => ...)");
        var calls = new List<string>();
        ExpressionSyntax e = expr;
        while (e is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } inv)
        {
            calls.Insert(0, ma.Name + inv.ArgumentList.ToString());
            e = ma.Expression;
        }
        if (e.ToString() != "__src") return Fail("The query must be a chain of method calls, like .Where(...).Select(...).");
        if (calls.Count > 8) return Fail("Keep it to 8 operators or fewer.");

        var stages = new List<string> { "source" };
        stages.AddRange(calls.Select(c => "." + c));

        // Try tapping every stage. If the last operator returns a single value (Count, Sum, First...),
        // it cannot be tapped: run it as the terminal operation and show its result instead.
        foreach (var terminal in new[] { false, true })
        {
            if (terminal && calls.Count == 0) break;
            var chain = new System.Text.StringBuilder("__src.__Tap(0)");
            for (var i = 0; i < calls.Count; i++)
            {
                chain.Append('.').Append(calls[i]);
                if (!(terminal && i == calls.Count - 1)) chain.Append($".__Tap({i + 1})");
            }
            var code = $$"""
                var __src = {{source}};
                var __q = {{chain}};
                {{(terminal
                    ? "Console.WriteLine(\"\\u0002RESULT|\" + Dojo.Show(__q).Replace(\"\\n\", \" \"));"
                    : "Console.WriteLine(\"\\u0002LAZY|\"); var __n = 0; foreach (var __x in __q) { if (++__n > 200) break; }")}}
                {{req.Setup}}
                {{TapSource}}
                """;
            var (program, diags) = runner.Compile(code);
            if (program is null)
            {
                if (!terminal) continue;
                return new(stages, [], null, false, diags, "That does not compile. " + string.Join(" ", diags.Where(d => d.Severity == "error").Take(2).Select(d => d.Message)));
            }
            using (program)
            {
                var run = await runner.Run(program, null);
                if (run.TimedOut) return new(stages, [], null, false, diags, "It ran too long. Is the source endless (like an infinite iterator) without a Take?");
                var events = new List<Event>();
                string? result = null;
                var lazyAt = -1;
                foreach (var line in run.Stdout.Replace("\r\n", "\n").Split('\n'))
                {
                    if (line.StartsWith(Marker))
                    {
                        var parts = line[Marker.Length..].Split('|', 2);
                        if (events.Count < MaxEvents && int.TryParse(parts[0], out var st)) events.Add(new(st, parts.ElementAtOrDefault(1) ?? ""));
                    }
                    else if (line.StartsWith("\u0002RESULT|")) result = line[8..];
                    else if (line.StartsWith("\u0002LAZY|")) lazyAt = events.Count;
                }
                if (run.ExitCode != 0)
                    return new(stages, events, null, lazyAt == 0, diags, "It threw while running: " + run.Stderr.Split('\n').FirstOrDefault()?.Trim());
                // lazyAt == 0: nothing at all ran until the foreach started pulling. That is deferred execution.
                return new(stages, events, result, lazyAt == 0, diags, null);
            }
        }
        return Fail("Could not run that query.");
    }

    static Response Fail(string message) => new([], [], null, false, [], message);
}
