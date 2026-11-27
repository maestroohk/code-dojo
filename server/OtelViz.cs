using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// `dojo validate` for the observability topic's learn-card visuals (<c>"otelviz"</c>, drawn by ui/otelviz.js):
/// a trace waterfall, a metrics panel, a Collector pipeline and the sampling simulator. Catches the mistakes that
/// would draw a wrong picture: duplicate span ids, logs pointing at spans that do not exist, unsorted series,
/// a pipeline that names a component nobody declared.
/// </summary>
public static class OtelViz
{
    static readonly string[] Kinds = ["trace", "metrics", "pipeline", "sampling"];
    static readonly string[] Statuses = ["unset", "ok", "error"];
    static readonly string[] SpanKinds = ["internal", "server", "client", "producer", "consumer", "unspecified"];
    static readonly string[] Units = ["", "s", "ms", "%", "x", "reqps"];
    static readonly string[] Signals = ["traces", "metrics", "logs"];

    public static IEnumerable<string> Check(JsonObject step)
    {
        if (step["otelviz"] is not { } node) yield break;
        if ((string?)step["type"] != "learn") yield return "\"otelviz\" only works on learn cards";
        if (node is not JsonObject viz) { yield return "\"otelviz\" must be an object"; yield break; }
        var kind = (string?)viz["kind"] ?? "";
        if (!Kinds.Contains(kind)) { yield return $"otelviz kind \"{kind}\" is unknown (use {string.Join(", ", Kinds)})"; yield break; }
        var issues = kind switch
        {
            "trace" => Trace(viz),
            "metrics" => Metrics(viz),
            "pipeline" => Pipeline(viz),
            _ => Sampling(viz),
        };
        foreach (var i in issues) yield return "otelviz " + kind + ": " + i;
    }

    static IEnumerable<string> Trace(JsonObject viz)
    {
        var spans = (viz["spans"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        if (spans.Count == 0) { yield return "needs \"spans\""; yield break; }
        var ids = new HashSet<string>();
        foreach (var s in spans)
        {
            var id = (string?)s["id"];
            if (id is not { Length: > 0 }) { yield return "every span needs an \"id\""; continue; }
            if (!ids.Add(id)) yield return $"span id {id} is used twice";
            if ((string?)s["name"] is not { Length: > 0 }) yield return $"span {id} needs a \"name\"";
            if (Num(s["start"]) is null || Num(s["dur"]) is not { } d || d < 0) yield return $"span {id} needs a numeric \"start\" and a \"dur\" of at least 0 (milliseconds)";
            if ((string?)s["status"] is { } st && !Statuses.Contains(st)) yield return $"span {id}: status must be unset, ok or error";
            if ((string?)s["kind"] is { } k && !SpanKinds.Contains(k)) yield return $"span {id}: kind must be one of {string.Join(", ", SpanKinds)}";
            if (s["attrs"] is { } a && a is not JsonObject) yield return $"span {id}: \"attrs\" must be an object";
        }
        if (!spans.Any(s => s["parent"] is null || !ids.Contains((string?)s["parent"] ?? ""))) yield return "no root span (every span has a parent in the trace: a cycle)";
        foreach (var l in (viz["logs"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if ((string?)l["body"] is not { Length: > 0 } && (string?)l["template"] is not { Length: > 0 }) yield return "every log needs a \"body\"";
            if ((string?)l["spanId"] is { Length: > 0 } sid && !ids.Contains(sid)) yield return $"a log points at span {sid}, which is not in the trace";
        }
    }

    static IEnumerable<string> Metrics(JsonObject viz)
    {
        if ((string?)viz["unit"] is { } u && !Units.Contains(u)) yield return $"unit must be one of: {string.Join(", ", Units.Select(x => x.Length == 0 ? "\"\"" : x))}";
        var series = (viz["series"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        if (series.Count == 0) { yield return "needs \"series\""; yield break; }
        foreach (var s in series)
        {
            var name = (string?)s["name"];
            if (name is not { Length: > 0 }) yield return "every series needs a \"name\"";
            var pts = (s["points"] as JsonArray ?? []).ToList();
            if (pts.Count < 2) { yield return $"series {name} needs at least 2 points [t, value]"; continue; }
            double? last = null;
            foreach (var p in pts)
            {
                if (p is not JsonArray pair || pair.Count != 2 || Num(pair[0]) is not { } t || (pair[1] is not null && Num(pair[1]) is null))
                { yield return $"series {name}: every point is [seconds, value] (value may be null)"; break; }
                if (last is { } l && t <= l) { yield return $"series {name}: points must be in time order"; break; }
                last = t;
            }
        }
        foreach (var t in (viz["thresholds"] as JsonArray ?? []).OfType<JsonObject>())
            if (Num(t["value"]) is null) yield return "every threshold needs a numeric \"value\"";
        if ((string?)viz["clock"] is { } c && !System.Text.RegularExpressions.Regex.IsMatch(c, @"^\d{2}:\d{2}$")) yield return "clock is \"HH:MM\"";
    }

    static IEnumerable<string> Pipeline(JsonObject viz)
    {
        var declared = new Dictionary<string, HashSet<string>>
        {
            ["receivers"] = Names(viz["receivers"]), ["processors"] = Names(viz["processors"]), ["exporters"] = Names(viz["exporters"]),
        };
        if (viz["pipelines"] is not JsonObject pipes || pipes.Count == 0) { yield return "needs \"pipelines\": { \"traces\": { receivers, processors, exporters } }"; yield break; }
        foreach (var (name, p) in pipes)
        {
            if (!Signals.Contains(name.Split('/')[0])) yield return $"pipeline {name}: the name starts with traces, metrics or logs";
            if (p is not JsonObject po) { yield return $"pipeline {name} must be an object"; continue; }
            foreach (var part in new[] { "receivers", "exporters" })
                if (Names(po[part]).Count == 0) yield return $"pipeline {name} needs at least one of its {part}";
            foreach (var part in new[] { "receivers", "processors", "exporters" })
                foreach (var c in Names(po[part]))
                    if (!declared[part].Contains(c)) yield return $"pipeline {name} uses {part[..^1]} {c}, which is not declared in \"{part}\"";
        }
    }

    static IEnumerable<string> Sampling(JsonObject viz)
    {
        foreach (var key in new[] { "errorRate", "slowRate", "ratio", "rest" })
            if (viz[key] is { } v && (Num(v) is not { } x || x < 0 || x > 1)) yield return $"{key} is a fraction between 0 and 1";
        if (viz["traces"] is { } n && (Num(n) is not { } c || c < 100 || c > 2000)) yield return "traces is 100 to 2000";
        if ((string?)viz["mode"] is { } m && m is not ("head" or "tail")) yield return "mode is head or tail";
    }

    static HashSet<string> Names(JsonNode? n) => (n as JsonArray ?? []).Select(x => (string?)x).Where(x => x is { Length: > 0 }).Select(x => x!).ToHashSet();

    static double? Num(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<long>(out var l)) return l;
        if (v.TryGetValue<int>(out var i)) return i;
        return null;
    }
}
