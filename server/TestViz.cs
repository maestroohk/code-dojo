using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// `dojo validate` for the testing topic's learn-card visuals (<c>"testviz"</c>, drawn by ui/testviz.js):
///   pyramid   the test pyramid and the testing trophy, side by side, layer by layer
///   doubles   dummy, stub, spy, mock and fake around one class under test
///   mutation  a Stryker-style mutation report: code lines, each mutant killed or survived, the score (and coverage)
///   tdd       a kata replayed red, green, refactor: the test list, the test, the code, a note per step
///   flaky     a grid of repeated runs, one row per test, so the flaky ones stand out
/// </summary>
public static class TestViz
{
    static readonly string[] Kinds = ["pyramid", "doubles", "mutation", "tdd", "flaky"];
    static readonly string[] Statuses = ["killed", "survived", "timeout", "nocoverage"];
    static readonly string[] Phases = ["red", "green", "refactor"];

    static string? Text(JsonNode? n) => Builds.Text(n)?.TrimEnd('\n');

    public static IEnumerable<string> Check(JsonObject step)
    {
        if (step["testviz"] is not { } node) yield break;
        if ((string?)step["type"] != "learn") yield return "\"testviz\" only works on learn cards";
        if (node is not JsonObject viz) { yield return "\"testviz\" must be an object"; yield break; }
        var kind = (string?)viz["kind"] ?? "";
        if (!Kinds.Contains(kind)) { yield return $"testviz kind \"{kind}\" is unknown (use {string.Join(", ", Kinds)})"; yield break; }
        switch (kind)
        {
            case "mutation":
                var code = Text(viz["code"]);
                if (code is null) { yield return "testviz mutation needs \"code\" (a string or lines)"; yield break; }
                var lines = code.Split('\n');
                var mutants = viz["mutants"] as JsonArray ?? [];
                if (mutants.Count == 0) yield return "testviz mutation needs \"mutants\"";
                foreach (var m in mutants.OfType<JsonObject>())
                {
                    var line = (int?)m["line"] ?? 0;
                    var from = (string?)m["from"] ?? "";
                    if (line < 1 || line > lines.Length) { yield return $"testviz mutant line {line} is outside the code (1-{lines.Length})"; continue; }
                    if (from.Length == 0 || !lines[line - 1].Contains(from, StringComparison.Ordinal)) yield return $"testviz mutant on line {line}: \"{from}\" is not on that line";
                    if (m["to"] is null) yield return $"testviz mutant on line {line} needs \"to\" (the mutated text, may be empty)";
                    if (!Statuses.Contains((string?)m["status"] ?? "")) yield return $"testviz mutant on line {line}: status must be one of {string.Join(", ", Statuses)}";
                }
                if (viz["covered"] is JsonArray covered)
                    foreach (var c in covered)
                        if ((int?)c is not { } cl || cl < 1 || cl > lines.Length) yield return "testviz \"covered\" holds line numbers inside the code";
                break;
            case "tdd":
                var steps = viz["steps"] as JsonArray ?? [];
                if (steps.Count < 2) yield return "testviz tdd needs at least 2 \"steps\"";
                foreach (var s in steps.OfType<JsonObject>())
                {
                    if (!Phases.Contains((string?)s["phase"] ?? "")) yield return "every testviz tdd step has a \"phase\": red, green or refactor";
                    if (Text(s["code"]) is null) yield return "every testviz tdd step has \"code\"";
                    if (Text(s["note"]) is null) yield return "every testviz tdd step has a \"note\" saying why";
                }
                break;
            case "flaky":
                var tests = viz["tests"] as JsonArray ?? [];
                if (tests.Count == 0) yield return "testviz flaky needs \"tests\": [{ \"name\", \"runs\": \"PPFP...\" }]";
                int? width = null;
                foreach (var t in tests.OfType<JsonObject>())
                {
                    var runs = (string?)t["runs"] ?? "";
                    if ((string?)t["name"] is not { Length: > 0 }) yield return "every testviz flaky test has a \"name\"";
                    if (runs.Length == 0 || runs.Any(ch => ch is not ('P' or 'F' or 'S'))) yield return "testviz flaky \"runs\" is a string of P (pass), F (fail) and S (skipped)";
                    if (width is { } w && w != runs.Length) yield return "every testviz flaky test has the same number of runs";
                    width ??= runs.Length;
                }
                break;
        }
    }
}
