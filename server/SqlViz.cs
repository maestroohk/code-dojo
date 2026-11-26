using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using SQLitePCL;

namespace CodeDojo;

/// <summary>
/// SQL visualizers for learn cards (ui/sqlviz.js). Everything shown is computed by real SQLite:
///
///   "sqlflow"  rows flowing through a query, clause by clause in logical order: FROM, each JOIN (which rows pair,
///              which drop, LEFT JOIN NULLs), WHERE (TRUE / FALSE / NULL per row), GROUP BY buckets with their
///              aggregates, HAVING, a window function (partition, order, the frame for every row), ORDER BY, LIMIT.
///              The query is given in parts; each stage is answered by a real query on the same database, and the
///              final rows are checked against the real full query.
///   "sqlplan"  EXPLAIN QUERY PLAN as a tree, before and after a change (an index, or a rewritten query), with the
///              work SQLite really did (full-scan steps, sorts, automatic indexes, virtual machine steps).
///   "pgplan"   a PostgreSQL EXPLAIN (ANALYZE, BUFFERS) text to read; parsed in the page, only linted here.
///   "txtimeline" two sessions side by side over time; authored data, only linted here.
/// </summary>
public static partial class SqlViz
{
    public static void Map(WebApplication app, JsonSerializerOptions json)
    {
        app.MapPost("/api/sqlflow", (JsonObject spec) => Results.Json(Flow(spec), json));
        app.MapPost("/api/sqlplan", (JsonObject spec) => Results.Json(Plan(spec), json));
    }

    /// <summary>For `dojo validate`: every SQL visual on a step must run (sqlflow, sqlplan) or parse (pgplan, txtimeline).</summary>
    public static IEnumerable<string> Check(JsonObject step)
    {
        if (step["sqlflow"] is JsonObject flow && Flow(flow) is { Error: { } fe }) yield return "sqlflow: " + fe;
        if (step["sqlplan"] is JsonObject plan && Plan(plan) is { Error: { } pe }) yield return "sqlplan: " + pe;
        if (step["pgplan"] is JsonObject pg)
        {
            var text = SqlChecker.Text(pg["text"]);
            if (!PgNode().IsMatch(text)) yield return "pgplan: no plan node like 'Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=... rows=... loops=1)' found";
        }
        if (step["txtimeline"] is JsonObject tl)
        {
            var rows = tl["rows"] as JsonArray;
            if (rows is not { Count: > 1 }) yield return "txtimeline: needs \"rows\" (at least 2)";
            else
                for (var i = 0; i < rows.Count; i++)
                    if (rows[i] is not JsonObject r || (r["a"] is null && r["b"] is null && r["db"] is null))
                        yield return $"txtimeline: row {i + 1} needs \"a\", \"b\" or \"db\"";
        }
    }

    [GeneratedRegex(@"\(cost=[\d.]+\.\.[\d.]+ rows=\d+ width=\d+\)")]
    private static partial Regex PgNode();

    // ------------------------------------------------------------------ helpers

    sealed record Rows(List<string> Columns, List<object?[]> Data);

    static Rows Query(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        using var r = cmd.ExecuteReader();
        var cols = Enumerable.Range(0, r.FieldCount).Select(r.GetName).ToList();
        var data = new List<object?[]>();
        while (r.Read())
        {
            var row = new object?[r.FieldCount];
            for (var c = 0; c < row.Length; c++) row[c] = r.IsDBNull(c) ? null : r.GetValue(c);
            data.Add(row);
            if (data.Count > 500) throw new InvalidDataException("a stage returned more than 500 rows: keep visual examples small");
        }
        return new(cols, data);
    }

    static string? V(object? v) => v is null ? null : SqlChecker.Render(v);
    static string Key(IEnumerable<object?> ids) => string.Join(",", ids.Select(i => i is null ? "~" : SqlChecker.Render(i)));
    static List<string> Strings(JsonNode? n) => n switch
    {
        JsonArray a => a.Select(x => (string?)x ?? "").Where(s => s.Length > 0).ToList(),
        JsonValue v when v.TryGetValue<string>(out var s) && s.Length > 0 => [s],
        _ => [],
    };
    static bool? Truth(object? v) => v switch { null => null, long l => l != 0, double d => d != 0, _ => true };

    [GeneratedRegex(@"^\s*(?<t>[A-Za-z_][\w]*)(?:\s+(?:AS\s+)?(?<a>[A-Za-z_][\w]*))?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex TableRef();

    [GeneratedRegex(@"^(?<e>.*?)(?<d>\s+(?:ASC|DESC))?(?<n>\s+NULLS\s+(?:FIRST|LAST))?\s*$", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex OrderTerm();

    [GeneratedRegex(@"^\s*(ROW_NUMBER|RANK|DENSE_RANK|NTILE|PERCENT_RANK|CUME_DIST)\s*\(", RegexOptions.IgnoreCase)]
    private static partial Regex RankFn();

    [GeneratedRegex(@"^\s*(?<f>LAG|LEAD)\s*\((?:[^,()]|\([^()]*\))+(?:,\s*(?<n>\d+))?", RegexOptions.IgnoreCase)]
    private static partial Regex OffsetFn();

    sealed record Source(string Table, string Alias, List<string> Columns);

    // ------------------------------------------------------------------ sqlflow

    public sealed record FlowResult
    {
        public string? Error { get; init; }
        public object? Data { get; init; }
    }

    public static FlowResult Flow(JsonObject spec)
    {
        try { return new() { Data = FlowData(spec) }; }
        catch (SqliteException e) { return new() { Error = SqlChecker.Readable(e) }; }
        catch (InvalidDataException e) { return new() { Error = e.Message }; }
    }

    static object FlowData(JsonObject spec)
    {
        using var conn = SqlChecker.OpenMemory();
        var setup = SqlChecker.Text(spec["setup"]);
        if (SqlChecker.Execute(conn, setup) is { Error: { } setupError }) throw new InvalidDataException("setup fails: " + setupError);

        // ---- the query, in parts
        var from = (string?)spec["from"] ?? throw new InvalidDataException("needs \"from\" (for example \"riders r\")");
        var joinSpecs = (spec["joins"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        var where = ((string?)spec["where"])?.Trim();
        var groupBy = Strings(spec["groupBy"]);
        var having = ((string?)spec["having"])?.Trim();
        var select = Strings(spec["select"]);
        if (select.Count == 0) throw new InvalidDataException("needs \"select\": an array of expressions");
        var orderBy = Strings(spec["orderBy"]);
        var limit = (int?)spec["limit"];
        var offset = (int?)spec["offset"];
        var win = spec["window"] as JsonObject;
        if (win is not null && groupBy.Count > 0) throw new InvalidDataException("a window and GROUP BY in one visual is not supported: show them separately");
        if (having is { Length: > 0 } && groupBy.Count == 0) throw new InvalidDataException("HAVING needs \"groupBy\"");
        if (joinSpecs.Count > 3) throw new InvalidDataException("at most 3 joins");

        Source Resolve(string text)
        {
            var m = TableRef().Match(text);
            if (!m.Success) throw new InvalidDataException($"cannot read the table \"{text}\": write it as \"table alias\"");
            var table = m.Groups["t"].Value;
            var alias = m.Groups["a"].Success ? m.Groups["a"].Value : table;
            var info = Query(conn, $"SELECT name FROM pragma_table_info('{table.Replace("'", "''")}')");
            if (info.Data.Count == 0) throw new InvalidDataException($"there is no table \"{table}\" after the setup");
            var all = info.Data.Select(r => (string)r[0]!).ToList();
            var chosen = Strings((spec["columns"] as JsonObject)?[alias]);
            foreach (var c in chosen) if (!all.Contains(c, StringComparer.OrdinalIgnoreCase)) throw new InvalidDataException($"\"columns\" names {alias}.{c}, but {table} has no such column");
            return new(table, alias, chosen.Count > 0 ? chosen : all);
        }

        var sources = new List<Source> { Resolve(from) };
        var joins = new List<(string Kind, Source Src, string? On)>();
        foreach (var j in joinSpecs)
        {
            var kind = ((string?)j["kind"] ?? "INNER").Trim().ToUpperInvariant();
            if (kind is not ("INNER" or "LEFT" or "RIGHT" or "FULL" or "CROSS")) throw new InvalidDataException($"join kind \"{kind}\": use INNER, LEFT, RIGHT, FULL or CROSS");
            var src = Resolve((string?)j["table"] ?? throw new InvalidDataException("every join needs \"table\""));
            var on = ((string?)j["on"])?.Trim();
            if (kind != "CROSS" && string.IsNullOrEmpty(on)) throw new InvalidDataException($"{kind} JOIN {src.Alias} needs \"on\"");
            joins.Add((kind, src, on));
            sources.Add(src);
        }
        if (sources.Select(s => s.Alias.ToLowerInvariant()).Distinct().Count() != sources.Count) throw new InvalidDataException("every table needs its own alias");

        string JoinText(int i) => joins[i].Kind switch
        {
            "CROSS" => $"CROSS JOIN {joins[i].Src.Table} {joins[i].Src.Alias}",
            "FULL" => $"FULL OUTER JOIN {joins[i].Src.Table} {joins[i].Src.Alias} ON {joins[i].On}",
            var k => $"{(k == "INNER" ? "" : k + " ")}JOIN {joins[i].Src.Table} {joins[i].Src.Alias} ON {joins[i].On}",
        };
        string FromText(int upto) =>   // upto = how many joins to include
            $"FROM {sources[0].Table}{(sources[0].Alias == sources[0].Table ? "" : " " + sources[0].Alias)}" + string.Concat(Enumerable.Range(0, upto).Select(i => " " + JoinText(i)));
        string Ids(int upto) => string.Join(", ", Enumerable.Range(0, upto + 1).Select(i => $"{sources[i].Alias}.rowid AS __i{i}"));
        string Cols(int upto) => string.Join(", ", Enumerable.Range(0, upto + 1).SelectMany(i => sources[i].Columns.Select(c => $"{sources[i].Alias}.\"{c}\"")));
        var full = FromText(joins.Count);
        var whereText = where is { Length: > 0 } ? $" WHERE {where}" : "";
        var n = sources.Count;
        static object?[] Take(object?[] row, int count) => row[..count];

        // ---- the base tables, as stored
        var tables = sources.Select(s =>
        {
            var rows = Query(conn, $"SELECT rowid, {string.Join(", ", s.Columns.Select(c => $"\"{c}\""))} FROM {s.Table} ORDER BY rowid");
            if (rows.Data.Count > 30) throw new InvalidDataException($"{s.Table} has {rows.Data.Count} rows: keep visual tables to 30 rows or fewer");
            return new { alias = s.Alias, name = s.Table, columns = s.Columns, rows = rows.Data.Select(r => new { id = V(r[0]), v = r.Skip(1).Select(V).ToArray() }).ToList() };
        }).ToList();

        // ---- every join prefix: which row combinations it produces, with their columns
        var prefixes = new List<object>();
        var prefixKeys = new List<List<object?[]>>();      // id tuples per prefix (prefix 0 = the first table)
        var prefixRows = new List<Dictionary<string, string?[]>>();
        for (var p = 0; p <= joins.Count; p++)
        {
            var q = Query(conn, $"SELECT {Ids(p)}, {Cols(p)} {FromText(p)}");
            var ids = q.Data.Select(r => Take(r, p + 1)).ToList();
            prefixKeys.Add(ids);
            var map = new Dictionary<string, string?[]>();
            foreach (var r in q.Data) map[Key(Take(r, p + 1))] = r.Skip(p + 1).Select(V).ToArray();
            prefixRows.Add(map);
            prefixes.Add(new { columns = Enumerable.Range(0, p + 1).SelectMany(i => sources[i].Columns.Select(c => joins.Count == 0 && sources[i].Alias == sources[i].Table ? c : $"{sources[i].Alias}.{c}")).ToList(), rows = map });
        }

        // Order of rows for the story: the first table by rowid, then each join keeps its left row's place and lists its
        // matches in the right table's order, with unmatched right rows (RIGHT / FULL) at the end.
        var order = prefixKeys[0].OrderBy(k => Convert.ToInt64(k[0])).Select(k => Key(k)).ToList();
        var joinSteps = new List<object>();
        for (var j = 0; j < joins.Count; j++)
        {
            var right = sources[j + 1];
            var rightPos = tables[j + 1].rows.Select((r, i) => (r.id, i)).ToDictionary(x => x.id ?? "", x => x.i);
            var outs = prefixKeys[j + 1];
            var byLeft = outs.GroupBy(o => Key(Take(o, j + 1))).ToDictionary(g => g.Key, g => g.ToList());
            var steps = new List<object>();
            var next = new List<string>();
            var matchedRight = new HashSet<string>();
            foreach (var left in order)
            {
                var mine = byLeft.TryGetValue(left, out var list) ? list : [];
                var hits = mine.Where(o => o[j + 1] is not null).OrderBy(o => rightPos.GetValueOrDefault(V(o[j + 1]) ?? "", 0)).ToList();
                var nulls = mine.Where(o => o[j + 1] is null).ToList();
                foreach (var hit in hits) matchedRight.Add(V(hit[j + 1])!);
                var produced = hits.Concat(nulls).Select(o => Key(o)).ToList();
                steps.Add(new { left, matches = hits.Select(o => V(o[j + 1])).ToList(), outs = produced, kept = nulls.Count > 0 });
                next.AddRange(produced);
            }
            // RIGHT / FULL: right rows that matched nothing come out with NULLs on the left.
            var orphans = outs.Where(o => Enumerable.Range(0, j + 1).All(i => o[i] is null) && o[j + 1] is not null)
                .OrderBy(o => rightPos.GetValueOrDefault(V(o[j + 1]) ?? "", 0)).ToList();
            next.AddRange(orphans.Select(o => Key(o)));
            joinSteps.Add(new
            {
                kind = joins[j].Kind, alias = right.Alias, table = right.Table, on = joins[j].On, text = JoinText(j),
                steps, unmatched = orphans.Select(o => new { right = V(o[j + 1]), key = Key(o) }).ToList(),
            });
            order = next;
        }
        var baseOrder = order;

        // ---- WHERE: TRUE, FALSE or NULL for every row
        Dictionary<string, bool?>? verdict = null;
        if (where is { Length: > 0 })
        {
            verdict = [];
            foreach (var r in Query(conn, $"SELECT {Ids(joins.Count)}, ({where}) AS __keep {full}").Data)
                verdict[Key(Take(r, n))] = Truth(r[n]);
        }
        var survivors = baseOrder.Where(k => verdict is null || verdict.GetValueOrDefault(k) == true).ToList();

        // ---- GROUP BY: which bucket each row falls into, then one row per bucket with the aggregates and HAVING
        object? groups = null;
        var bucketOrder = new List<string>();
        var keptBuckets = new HashSet<string>();
        var bucketValues = new Dictionary<string, (string?[] Values, bool? Keep)>();
        if (groupBy.Count > 0)
        {
            var gCols = string.Join(", ", groupBy.Select((g, i) => $"({g}) AS __g{i}"));
            var assign = new Dictionary<string, string>();
            var labels = new Dictionary<string, string?[]>();
            foreach (var r in Query(conn, $"SELECT {Ids(joins.Count)}, {gCols} {full}{whereText}").Data)
            {
                var gk = Key(r.Skip(n));
                assign[Key(Take(r, n))] = gk;
                labels[gk] = r.Skip(n).Select(V).ToArray();
            }
            foreach (var k in survivors) if (assign.TryGetValue(k, out var gk) && !bucketOrder.Contains(gk)) bucketOrder.Add(gk);
            var agg = Query(conn, $"SELECT {gCols}, {string.Join(", ", select)}{(having is { Length: > 0 } ? $", ({having}) AS __keep" : "")} {full}{whereText} GROUP BY {string.Join(", ", groupBy)}");
            var values = bucketValues;
            foreach (var r in agg.Data)
            {
                var gk = Key(r.Take(groupBy.Count));
                var vals = r.Skip(groupBy.Count).Take(select.Count).Select(V).ToArray();
                values[gk] = (vals, having is { Length: > 0 } ? Truth(r[groupBy.Count + select.Count]) : true);
            }
            foreach (var gk in bucketOrder) if (values.TryGetValue(gk, out var v) && v.Keep == true) keptBuckets.Add(gk);
            groups = new
            {
                by = groupBy, columns = agg.Columns.Skip(groupBy.Count).Take(select.Count).ToList(),
                assign = survivors.ToDictionary(k => k, k => assign.GetValueOrDefault(k)),
                buckets = bucketOrder.Select(gk => new
                {
                    key = gk, label = labels.GetValueOrDefault(gk), members = survivors.Where(k => assign.GetValueOrDefault(k) == gk).ToList(),
                    values = values.TryGetValue(gk, out var v) ? v.Values : null, keep = values.TryGetValue(gk, out var v2) ? v2.Keep : null,
                }).ToList(),
            };
        }

        // ---- a window function: partition, position, frame and value for every surviving row
        object? window = null;
        string? winSql = null;
        string? winAs = null;
        if (win is not null)
        {
            var fn = (string?)win["fn"] ?? throw new InvalidDataException("window needs \"fn\", for example \"SUM(d.minutes)\"");
            winAs = (string?)win["as"] ?? "w";
            var part = Strings(win["partitionBy"]);
            var wOrder = Strings(win["orderBy"]);
            var frame = ((string?)win["frame"])?.Trim();
            var terms = wOrder.Select(t => OrderTerm().Match(t)).ToList();
            var over = string.Join(" ", new[]
            {
                part.Count > 0 ? "PARTITION BY " + string.Join(", ", part) : "",
                wOrder.Count > 0 ? "ORDER BY " + string.Join(", ", wOrder) : "",
                frame ?? "",
            }.Where(s => s.Length > 0));
            winSql = $"{fn} OVER ({over})";
            var pCols = part.Count > 0 ? string.Join(", ", part.Select((p, i) => $"({p}) AS __p{i}")) : "1 AS __p0";
            var pNames = part.Count > 0 ? string.Join(", ", part.Select((_, i) => $"__p{i}")) : "__p0";
            var oCols = string.Join("", terms.Select((t, i) => $", ({t.Groups["e"].Value}) AS __o{i}"));
            var oOuter = terms.Count > 0 ? "ORDER BY " + string.Join(", ", terms.Select((t, i) => $"__o{i}{t.Groups["d"].Value}{t.Groups["n"].Value}")) : "";
            var inner = $"SELECT {Ids(joins.Count)}, {pCols}{oCols}, row_number() OVER ({(part.Count > 0 ? "PARTITION BY " + string.Join(", ", part) : "")} {(wOrder.Count > 0 ? "ORDER BY " + string.Join(", ", wOrder) : "")}) AS __pos, {winSql} AS __val {full}{whereText}";
            var outer = $"SELECT *, min(__pos) OVER (PARTITION BY {pNames} {oOuter} {frame}) AS __lo, max(__pos) OVER (PARTITION BY {pNames} {oOuter} {frame}) AS __hi FROM ({inner})";
            var q = Query(conn, outer);
            int Col(string name) => q.Columns.IndexOf(name);
            var kind = RankFn().IsMatch(fn) ? "rank" : OffsetFn().Match(fn) is { Success: true } ? "offset" : "frame";
            var off = OffsetFn().Match(fn) is { Success: true } om ? (om.Groups["f"].Value.Equals("LAG", StringComparison.OrdinalIgnoreCase) ? -1 : 1) * (om.Groups["n"].Success ? int.Parse(om.Groups["n"].Value) : 1) : 0;
            var rows = new Dictionary<string, object>();
            foreach (var r in q.Data)
            {
                var pk = Key(Enumerable.Range(0, Math.Max(1, part.Count)).Select(i => r[Col($"__p{i}")]));
                rows[Key(Take(r, n))] = new
                {
                    p = pk, plabel = Enumerable.Range(0, Math.Max(1, part.Count)).Select(i => V(r[Col($"__p{i}")])).ToArray(),
                    pos = Convert.ToInt64(r[Col("__pos")]), lo = r[Col("__lo")] is null ? (long?)null : Convert.ToInt64(r[Col("__lo")]),
                    hi = r[Col("__hi")] is null ? (long?)null : Convert.ToInt64(r[Col("__hi")]), val = V(r[Col("__val")]),
                };
            }
            window = new { fn, @as = winAs, partitionBy = part, orderBy = wOrder, frame, over, sql = winSql, kind, offset = off, rows };
        }

        // ---- SELECT: the projected values, per row (or per bucket)
        var selectList = string.Join(", ", select) + (winSql is not null ? $", {winSql} AS {winAs}" : "");
        object? projected = null;
        Dictionary<string, string?[]>? projRows = null;
        if (groupBy.Count == 0)
        {
            var q = Query(conn, $"SELECT {Ids(joins.Count)}, {selectList} {full}{whereText}");
            projRows = q.Data.ToDictionary(r => Key(Take(r, n)), r => r.Skip(n).Select(V).ToArray());
            projected = new { columns = q.Columns.Skip(n).ToList(), rows = projRows };
        }

        // ---- ORDER BY: the order rows (or buckets) come out in
        List<string>? sorted = null;
        var groupTail = groupBy.Count > 0 ? $" GROUP BY {string.Join(", ", groupBy)}{(having is { Length: > 0 } ? $" HAVING {having}" : "")}" : "";
        if (orderBy.Count > 0)
        {
            var head = groupBy.Count > 0 ? string.Join(", ", groupBy.Select((g, i) => $"({g}) AS __g{i}")) : Ids(joins.Count);
            var width = groupBy.Count > 0 ? groupBy.Count : n;
            sorted = Query(conn, $"SELECT {head}, {selectList} {full}{whereText}{groupTail} ORDER BY {string.Join(", ", orderBy)}").Data
                .Select(r => Key(Take(r, width))).ToList();
        }

        // ---- the real query, run whole: the story must end where SQLite does
        var sql = string.Join("\n", new[]
        {
            "SELECT " + selectList,
            FromText(0),
        }.Concat(Enumerable.Range(0, joins.Count).Select(JoinText)).Concat(new[]
        {
            where is { Length: > 0 } ? "WHERE " + where : null,
            groupBy.Count > 0 ? "GROUP BY " + string.Join(", ", groupBy) : null,
            having is { Length: > 0 } ? "HAVING " + having : null,
            orderBy.Count > 0 ? "ORDER BY " + string.Join(", ", orderBy) : null,
            limit is not null ? $"LIMIT {limit}" + (offset is not null ? $" OFFSET {offset}" : "") : null,
        }).Where(s => s is not null));
        var real = Query(conn, sql);
        var result = new { columns = real.Columns, rows = real.Data.Select(r => r.Select(V).ToArray()).ToList() };

        // Cross-check: replay the story's final rows and compare with SQLite's.
        var finalKeys = groupBy.Count > 0 ? (sorted ?? bucketOrder).Where(keptBuckets.Contains).ToList() : (sorted ?? survivors);
        var cut = finalKeys.Skip(offset ?? 0).Take(limit ?? int.MaxValue).ToList();
        var story = groupBy.Count > 0
            ? cut.Select(k => bucketValues[k].Values).ToList()
            : cut.Select(k => projRows![k]).ToList();
        var realText = result.rows.Select(r => string.Join("|", r)).ToList();
        var storyText = story.Select(r => string.Join("|", r)).ToList();
        if (orderBy.Count > 0 ? !realText.SequenceEqual(storyText) : !realText.Order().SequenceEqual(storyText.Order()))
            throw new InvalidDataException("the step-by-step rows do not match the real query's result (are there ties in ORDER BY with LIMIT? add a tie-breaker)");

        var clauses = new List<object> { new { key = "select", text = "SELECT " + selectList }, new { key = "from", text = FromText(0) } };
        for (var j = 0; j < joins.Count; j++) clauses.Add(new { key = $"join{j}", text = JoinText(j) });
        if (where is { Length: > 0 }) clauses.Add(new { key = "where", text = "WHERE " + where });
        if (groupBy.Count > 0) clauses.Add(new { key = "group", text = "GROUP BY " + string.Join(", ", groupBy) });
        if (having is { Length: > 0 }) clauses.Add(new { key = "having", text = "HAVING " + having });
        if (orderBy.Count > 0) clauses.Add(new { key = "order", text = "ORDER BY " + string.Join(", ", orderBy) });
        if (limit is not null) clauses.Add(new { key = "limit", text = $"LIMIT {limit}" + (offset is not null ? $" OFFSET {offset}" : "") });

        return new
        {
            sql, clauses, tables, prefixes, joins = joinSteps, order = baseOrder,
            where = where is { Length: > 0 } ? new { text = where, verdict } : null,
            survivors, groups, having, window, projected, select, sorted, limit, offset, result,
            note = (string?)spec["note"],
        };
    }

    // ------------------------------------------------------------------ sqlplan

    public sealed record PlanResult
    {
        public string? Error { get; init; }
        public List<PlanSide> Sides { get; init; } = [];
    }

    public sealed record PlanNode(long Id, long Parent, string Detail);
    public sealed record PlanSide(string Label, string Sql, string? Change, List<PlanNode> Plan, long Rows, long FullScanSteps, long Sorts, long AutoIndexes, long VmSteps, double Ms);

    /// <summary>
    /// spec: { setup, query, index?: "CREATE INDEX ..." (applied for the "after" side), after?: "a rewritten query",
    ///         labels?: ["Before", "After"] }. With neither index nor after, only one plan is shown.
    /// </summary>
    public static PlanResult Plan(JsonObject spec)
    {
        try
        {
            var setup = SqlChecker.Text(spec["setup"]);
            var query = LastStatement(SqlChecker.Text(spec["query"]));
            if (query.Length == 0) return new() { Error = "needs \"query\"" };
            var change = SqlChecker.Text(spec["index"]);
            var after = LastStatement(SqlChecker.Text(spec["after"]));
            var labels = Strings(spec["labels"]);
            var sides = new List<PlanSide> { Side(labels.ElementAtOrDefault(0) ?? "Before", setup, null, query) };
            if (change.Trim().Length > 0 || after.Length > 0)
                sides.Add(Side(labels.ElementAtOrDefault(1) ?? "After", setup, change.Trim().Length > 0 ? change.Trim() : null, after.Length > 0 ? after : query));
            return new() { Sides = sides };
        }
        catch (SqliteException e) { return new() { Error = SqlChecker.Readable(e) }; }
        catch (InvalidDataException e) { return new() { Error = e.Message }; }
    }

    static string LastStatement(string script) => SqlChecker.Split(script) is { Count: > 0 } parts ? parts[^1].Sql.Trim().TrimEnd(';') : "";

    static PlanSide Side(string label, string setup, string? change, string query)
    {
        using var conn = SqlChecker.OpenMemory();
        if (SqlChecker.Execute(conn, setup, timeoutMs: 8000) is { Error: { } se }) throw new InvalidDataException("setup fails: " + se);
        if (change is not null && SqlChecker.Execute(conn, change) is { Error: { } ce }) throw new InvalidDataException("the change fails: " + ce);
        if (!Regex.IsMatch(SqlChecker.StripComments(query), @"^\s*(SELECT|WITH|UPDATE|DELETE|INSERT)\b", RegexOptions.IgnoreCase))
            throw new InvalidDataException("the plan is for one SELECT, WITH, UPDATE, DELETE or INSERT statement");
        var plan = Query(conn, "EXPLAIN QUERY PLAN " + query).Data
            .Select(r => new PlanNode(Convert.ToInt64(r[0]), Convert.ToInt64(r[1]), (string)r[3]!)).ToList();

        // Run it once through the raw API to read the statement's own counters (sqlite3_stmt_status).
        long rows = 0;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var deadline = new System.Threading.Timer(_ => { try { raw.sqlite3_interrupt(conn.Handle); } catch { } }, null, 4000, Timeout.Infinite);
        try
        {
            if (raw.sqlite3_prepare_v2(conn.Handle, query, out sqlite3_stmt stmt) != raw.SQLITE_OK)
                throw new InvalidDataException(raw.sqlite3_errmsg(conn.Handle).utf8_to_string());
            using (stmt)
            {
                int rc;
                while ((rc = raw.sqlite3_step(stmt)) == raw.SQLITE_ROW) rows++;
                if (rc != raw.SQLITE_DONE) throw new InvalidDataException(raw.sqlite3_errmsg(conn.Handle).utf8_to_string());
                return new(label, query, change, plan, rows,
                    raw.sqlite3_stmt_status(stmt, raw.SQLITE_STMTSTATUS_FULLSCAN_STEP, 0),
                    raw.sqlite3_stmt_status(stmt, raw.SQLITE_STMTSTATUS_SORT, 0),
                    raw.sqlite3_stmt_status(stmt, raw.SQLITE_STMTSTATUS_AUTOINDEX, 0),
                    raw.sqlite3_stmt_status(stmt, raw.SQLITE_STMTSTATUS_VM_STEP, 0),
                    Math.Round(clock.Elapsed.TotalMilliseconds, 1));
            }
        }
        finally { deadline.Dispose(); }
    }
}
