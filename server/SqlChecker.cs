using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using SQLitePCL;

namespace CodeDojo;

/// <summary>A result grid as the UI shows it: values rendered as text, NULL as null.</summary>
public sealed record SqlTable(List<string> Columns, List<string?[]> Rows, List<string>? Types = null, bool Truncated = false, string? Title = null);

/// <summary>A graded SQL step: the usual check result plus the learner's result as a table.</summary>
public sealed record SqlCheckResult : CheckResult
{
    public SqlCheckResult(CheckResult result, SqlTable? table) : base(result) { Table = table; }
    public SqlTable? Table { get; }
    public bool Sql => true;
}

/// <summary>
/// Runs and grades SQL (track "language": "sql") on SQLite. Every check builds a fresh in-memory
/// database from the step's "setup", runs the learner's SQL and the reference solution on separate
/// copies, and compares what they return (or, with "check": "state", what a "stateQuery" sees afterwards).
///
///   check "rows"     same rows in any order (default)
///   check "ordered"  same rows in the same order
///   check "state"    for INSERT / UPDATE / DELETE / DDL: compare "stateQuery" after each
///
/// Numbers compare by value (1 == 1.0), NULL equals NULL, text compares exactly.
/// </summary>
public static partial class SqlChecker
{
    public const int GradeTimeoutMs = 4000;
    public const int MaxRows = 10_000;      // read at most this many rows of any result
    public const int ShowRows = 200;        // ...and show at most this many

    static SqlChecker() => Batteries_V2.Init();

    public static bool Handles(string language) => language == "sql";

    // ---------------------------------------------------------------- running

    /// <summary>One statement's result: raw values (long, double, string, byte[], null).</summary>
    public sealed class ResultSet
    {
        public List<string> Columns { get; init; } = [];
        public List<string> Types { get; init; } = [];
        public List<object?[]> Rows { get; init; } = [];
        public bool Truncated { get; set; }
        public int Line { get; init; }
        public string Sql { get; init; } = "";
        public long Ms { get; set; }
    }

    public sealed class Batch
    {
        public List<ResultSet> Sets { get; } = [];
        public List<string> Messages { get; } = [];
        public string? Error { get; set; }
        public int ErrorLine { get; set; }
        public bool TimedOut { get; set; }
        public long Ms { get; set; }
        public int Statements { get; set; }
        public ResultSet? Last => Sets.LastOrDefault();
    }

    /// <summary>A fresh in-memory database that cannot reach the file system.</summary>
    public static SqliteConnection OpenMemory()
    {
        var conn = new SqliteConnection("Data Source=:memory:");
        conn.Open();
        Harden(conn);
        return conn;
    }

    // Kept in a static field so the native side never calls a collected delegate.
    static readonly delegate_authorizer Authorizer = (_, action, _, _, _, _) =>
        action is raw.SQLITE_ATTACH or raw.SQLITE_DETACH ? raw.SQLITE_DENY : raw.SQLITE_OK;

    /// <summary>No ATTACH (it creates files anywhere) and no extensions.</summary>
    public static void Harden(SqliteConnection conn)
    {
        raw.sqlite3_limit(conn.Handle, raw.SQLITE_LIMIT_ATTACHED, 0);
        raw.sqlite3_set_authorizer(conn.Handle, Authorizer, null);
    }

    /// <summary>
    /// Split a script into statements: semicolons inside strings, quoted names, comments and
    /// trigger bodies do not count (SQLite's own sqlite3_complete decides where a statement ends).
    /// </summary>
    public static List<(string Sql, int Line)> Split(string script)
    {
        var list = new List<(string, int)>();
        var start = 0;
        void Add(int end)
        {
            var text = script[start..end];
            if (StripComments(text).Trim().Trim(';').Trim().Length > 0)
            {
                var lead = start + (text.Length - text.TrimStart().Length);
                // Skip leading comment lines so the line number points at the statement itself.
                var body = text.TrimStart();
                while (true)
                {
                    if (body.StartsWith("--")) { var nl = body.IndexOf('\n'); if (nl < 0) break; lead += nl + 1; body = body[(nl + 1)..]; }
                    else if (body.StartsWith("/*")) { var e = body.IndexOf("*/", 2); if (e < 0) break; lead += e + 2; body = body[(e + 2)..]; }
                    else break;
                    var trimmed = body.TrimStart(); lead += body.Length - trimmed.Length; body = trimmed;
                }
                list.Add((text.Trim(), 1 + script.AsSpan(0, Math.Min(lead, script.Length)).Count('\n')));
            }
            start = end;
        }
        for (var i = 0; i < script.Length; i++)
        {
            var c = script[i];
            if (c is '\'' or '"' or '`' || c == '[')
            {
                var close = c == '[' ? ']' : c;
                for (i++; i < script.Length; i++)
                {
                    if (script[i] != close) continue;
                    if (close != ']' && i + 1 < script.Length && script[i + 1] == close) { i++; continue; }   // '' escapes a quote
                    break;
                }
            }
            else if (c == '-' && i + 1 < script.Length && script[i + 1] == '-')
            {
                var nl = script.IndexOf('\n', i);
                i = nl < 0 ? script.Length : nl;
            }
            else if (c == '/' && i + 1 < script.Length && script[i + 1] == '*')
            {
                var e = script.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = e < 0 ? script.Length : e + 1;
            }
            else if (c == ';' && raw.sqlite3_complete(script[start..(i + 1)]) != 0)
                Add(i + 1);
        }
        if (start < script.Length) Add(script.Length);
        return list;
    }

    /// <summary>Run a script statement by statement. Stops at the first error.</summary>
    public static Batch Execute(SqliteConnection conn, string script, int timeoutMs = GradeTimeoutMs, int maxRows = MaxRows)
    {
        var batch = new Batch();
        var clock = Stopwatch.StartNew();
        var deadline = new System.Threading.Timer(_ => { try { raw.sqlite3_interrupt(conn.Handle); } catch { } }, null, timeoutMs, Timeout.Infinite);
        try
        {
            foreach (var (sql, line) in Split(script))
            {
                batch.Statements++;
                var t = Stopwatch.StartNew();
                try
                {
                    using var cmd = conn.CreateCommand();
                    cmd.CommandText = sql;
                    using var reader = cmd.ExecuteReader();
                    if (reader.FieldCount > 0)
                    {
                        var set = new ResultSet { Line = line, Sql = sql };
                        for (var c = 0; c < reader.FieldCount; c++) set.Columns.Add(reader.GetName(c));
                        while (reader.Read())
                        {
                            if (set.Rows.Count == 0)
                                for (var c = 0; c < reader.FieldCount; c++) set.Types.Add(TypeName(reader, c));
                            if (set.Rows.Count >= maxRows) { set.Truncated = true; break; }
                            var row = new object?[reader.FieldCount];
                            for (var c = 0; c < row.Length; c++) row[c] = reader.IsDBNull(c) ? null : reader.GetValue(c);
                            set.Rows.Add(row);
                        }
                        if (set.Types.Count == 0) for (var c = 0; c < reader.FieldCount; c++) set.Types.Add(TypeName(reader, c));
                        set.Ms = t.ElapsedMilliseconds;
                        batch.Sets.Add(set);
                    }
                    else
                    {
                        var verb = FirstWord(sql);
                        var n = reader.RecordsAffected;
                        batch.Messages.Add(verb is "INSERT" or "UPDATE" or "DELETE" or "REPLACE" || n > 0
                            ? $"Line {line}: {verb} changed {n} row{(n == 1 ? "" : "s")}."
                            : $"Line {line}: {verb} done.");
                    }
                }
                catch (SqliteException e)
                {
                    if (e.SqliteErrorCode == raw.SQLITE_INTERRUPT)
                    {
                        batch.TimedOut = true;
                        batch.Error = $"Stopped: the statement on line {line} ran for more than {timeoutMs / 1000.0:0.#} seconds. Is a recursive query missing its stopping condition?";
                    }
                    else batch.Error = Readable(e);
                    batch.ErrorLine = line + LineInStatement(sql, batch.Error);
                    batch.Error = $"Line {batch.ErrorLine}: {batch.Error}";
                    break;
                }
            }
        }
        finally { deadline.Dispose(); }
        batch.Ms = clock.ElapsedMilliseconds;
        return batch;
    }

    /// <summary>The declared type of a column (INTEGER, TEXT, ...), or the type of its value in the current row.</summary>
    static string TypeName(SqliteDataReader r, int c)
    {
        try { return r.GetDataTypeName(c).ToUpperInvariant(); } catch { return ""; }
    }

    internal static string FirstWord(string sql) =>
        Regex.Match(StripComments(sql), @"[A-Za-z]+") is { Success: true } m ? m.Value.ToUpperInvariant() : "Statement";

    [GeneratedRegex(@"^SQLite Error \d+: '(?<m>.*)'\.?$", RegexOptions.Singleline)]
    private static partial Regex SqliteMessage();

    /// <summary>"SQLite Error 1: 'no such column: nmae'." -> "no such column: nmae"</summary>
    public static string Readable(SqliteException e) =>
        SqliteMessage().Match(e.Message) is { Success: true } m ? m.Groups["m"].Value : e.Message;

    /// <summary>Which line of a statement the error is about, found by the name the message mentions.</summary>
    static int LineInStatement(string sql, string message)
    {
        var token = Regex.Match(message, @"near ""(?<t>[^""]+)""") is { Success: true } near ? near.Groups["t"].Value
            : Regex.Match(message, @":\s*(?<t>[\w.]+)\s*$") is { Success: true } name ? name.Groups["t"].Value : null;
        if (token is null) return 0;
        var at = sql.IndexOf(token, StringComparison.OrdinalIgnoreCase);
        if (at < 0 && token.Contains('.')) at = sql.IndexOf(token[(token.LastIndexOf('.') + 1)..], StringComparison.OrdinalIgnoreCase);
        return at < 0 ? 0 : sql.AsSpan(0, at).Count('\n');
    }

    // ---------------------------------------------------------------- values

    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>A value the way SQLite's own shell prints it: 3, 2.5, 3.0, NULL.</summary>
    public static string Render(object? v) => v switch
    {
        null => "NULL",
        long l => l.ToString(Inv),
        double d => Real(d),
        string s => s,
        byte[] b => "x'" + Convert.ToHexString(b) + "'",
        _ => Convert.ToString(v, Inv) ?? "",
    };

    static string Real(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return d.ToString(Inv);
        if (Math.Floor(d) == d && Math.Abs(d) < 1e15) return d.ToString("0", Inv) + ".0";
        var s = d.ToString("G15", Inv);
        return s.Contains('.') || s.Contains('E') ? s : s + ".0";
    }

    /// <summary>A comparison key: numbers by value (1 == 1.0, tolerant of rounding noise), text exact.</summary>
    static string Key(object? v) => v switch
    {
        null => "␀",
        long l => "n:" + l.ToString(Inv),
        double d when Math.Floor(d) == d && Math.Abs(d) < 9e15 => "n:" + ((long)d).ToString(Inv),
        double d => "n:" + d.ToString("G12", Inv),
        string s => "s:" + s,
        byte[] b => "b:" + Convert.ToHexString(b),
        _ => "o:" + v,
    };

    static string RowKey(object?[] row) => string.Join("\u001f", row.Select(Key));
    static string RowText(object?[] row) => string.Join(" | ", row.Select(Render));

    public static SqlTable ToTable(ResultSet set, int show = ShowRows, string? title = null) =>
        new(set.Columns, set.Rows.Take(show).Select(r => r.Select(v => v is null ? null : Render(v)).ToArray()).ToList(),
            set.Types, set.Truncated || set.Rows.Count > show, title);

    /// <summary>The text a predict step expects: one line per row, values joined by " | ", no header.</summary>
    public static string AsText(ResultSet set) => string.Join("\n", set.Rows.Select(RowText));

    // ---------------------------------------------------------------- grading

    /// <summary>A step field written as one string or as an array of lines.</summary>
    public static string Text(JsonNode? node) => node switch
    {
        JsonArray lines => string.Join("\n", lines.Select(l => (string?)l)),
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        _ => "",
    };

    record Fresh(Batch? Setup, Batch Run, ResultSet? State);

    /// <summary>Setup, then the SQL, then (optionally) a state query, all on one fresh database.</summary>
    static Fresh RunFresh(string setup, string sql, string? stateQuery = null)
    {
        using var conn = OpenMemory();
        if (setup.Trim().Length > 0)
        {
            var s = Execute(conn, setup);
            if (s.Error is not null) return new(s, new Batch(), null);
        }
        var run = Execute(conn, sql);
        ResultSet? state = null;
        if (run.Error is null && stateQuery is { Length: > 0 })
        {
            var q = Execute(conn, stateQuery);
            if (q.Error is not null) run.Error = "The step's state query failed: " + q.Error;
            state = q.Last;
        }
        return new(null, run, state);
    }

    public static SqlCheckResult Check(JsonObject step, string code)
    {
        var results = new List<TestResult>();
        var bare = StripComments(code);
        foreach (var (pattern, message) in Rules(step, "require"))
            results.Add(new(message, Regex.IsMatch(bare, pattern, RegexOptions.Singleline | RegexOptions.IgnoreCase), "Your SQL needs this to count as solved."));
        foreach (var (pattern, message) in Rules(step, "forbid"))
            results.Add(new(message, !Regex.IsMatch(bare, pattern, RegexOptions.Singleline | RegexOptions.IgnoreCase), "This exercise asks you to solve it another way."));

        SqlCheckResult Done(SqlTable? table, string stdout = "", string stderr = "", bool timedOut = false, long ms = 0, List<Diag>? diags = null) =>
            new(new CheckResult(diags is null && results.Count > 0 && results.All(r => r.Pass), diags is null, diags ?? [], results, stdout, stderr, timedOut, ms), table);

        if (bare.Trim().Trim(';').Trim().Length == 0)
        {
            results.Add(new("Runs your SQL", false, "Write some SQL first."));
            return Done(null);
        }

        var setup = Text(step["setup"]);
        var solution = Text(step["solution"]);
        var mode = (string?)step["check"] ?? "rows";
        var stateQuery = mode == "state" ? Text(step["stateQuery"]) : null;
        if (mode == "state" && string.IsNullOrWhiteSpace(stateQuery))
        {
            results.Add(new("The exercise is set up", false, "This step checks the data afterwards but has no \"stateQuery\"."));
            return Done(null);
        }

        var mine = RunFresh(setup, code, stateQuery);
        if (mine.Setup?.Error is { } setupError)
        {
            results.Add(new("The exercise is set up", false, "The exercise's own setup SQL fails: " + setupError));
            return Done(null);
        }
        var stdout = string.Join("\n", mine.Run.Messages);
        if (mine.Run.Error is { } error)
            return Done(mine.Run.Last is { } partial ? ToTable(partial) : null, stdout, error, mine.Run.TimedOut, mine.Run.Ms,
                [new Diag("error", "SQL", error, mine.Run.ErrorLine, 1, "")]);

        var want = RunFresh(setup, solution, stateQuery);
        if (want.Run.Error is { } bad)
        {
            results.Add(new("The exercise is set up", false, "The reference solution fails (tell the author): " + bad));
            return Done(null, stdout, ms: mine.Run.Ms);
        }

        ResultSet? got, expected;
        string colsName, rowsName;
        SqlTable? shown;
        if (mode == "state")
        {
            (got, expected) = (mine.State, want.State);
            (colsName, rowsName) = ("Leaves the right columns", "Leaves the right rows");
            shown = got is null ? null : ToTable(got, title: "After your SQL: " + stateQuery!.Trim());
        }
        else
        {
            (got, expected) = (mine.Run.Last, want.Run.Last);
            (colsName, rowsName) = ("Returns the right columns", "Returns the right rows");
            shown = got is null ? null : ToTable(got);
            if (got is null)
            {
                results.Add(new(rowsName, false, "Your SQL ran, but no statement returned rows. The last statement that returns rows (usually a SELECT) is the one that is checked."));
                return Done(null, stdout, ms: mine.Run.Ms);
            }
        }
        if (got is null || expected is null)
        {
            results.Add(new(rowsName, false, "Nothing to compare: the query returned no result."));
            return Done(shown, stdout, ms: mine.Run.Ms);
        }

        Compare(expected, got, mode == "ordered", colsName, rowsName, results);
        return Done(shown, stdout, ms: mine.Run.Ms);
    }

    /// <summary>Columns, then rows (as a multiset), then, when asked, their order.</summary>
    public static void Compare(ResultSet want, ResultSet got, bool ordered, string colsName, string rowsName, List<TestResult> results)
    {
        string Cols(ResultSet s) => $"{s.Columns.Count} column{(s.Columns.Count == 1 ? "" : "s")} ({string.Join(", ", s.Columns)})";
        if (want.Columns.Count != got.Columns.Count)
        {
            results.Add(new(colsName, false, $"Expected {Cols(want)}, but yours has {Cols(got)}."));
            results.Add(new(rowsName, false, "Get the columns right first."));
            return;
        }
        results.Add(new(colsName, true, ""));

        var wantKeys = want.Rows.Select(RowKey).ToList();
        var gotKeys = got.Rows.Select(RowKey).ToList();
        var missing = Except(want.Rows, wantKeys, gotKeys);
        var extra = Except(got.Rows, gotKeys, wantKeys);
        if (missing.Count == 0 && extra.Count == 0)
            results.Add(new(rowsName, true, ""));
        else
        {
            var sb = new StringBuilder();
            sb.Append($"Expected {Count(want.Rows.Count)}, yours has {Count(got.Rows.Count)}.");
            if (missing.Count > 0) { sb.Append("\nMissing (expected but not in yours):"); foreach (var r in missing.Take(5)) sb.Append("\n  " + RowText(r)); if (missing.Count > 5) sb.Append($"\n  ... and {missing.Count - 5} more"); }
            if (extra.Count > 0) { sb.Append("\nNot expected (in yours but should not be):"); foreach (var r in extra.Take(5)) sb.Append("\n  " + RowText(r)); if (extra.Count > 5) sb.Append($"\n  ... and {extra.Count - 5} more"); }
            results.Add(new(rowsName, false, sb.ToString()));
        }

        if (!ordered) return;
        if (missing.Count > 0 || extra.Count > 0) { results.Add(new("Row order", false, "Get the right rows first, then put them in order.")); return; }
        var diffs = Enumerable.Range(0, wantKeys.Count).Where(i => wantKeys[i] != gotKeys[i]).ToList();
        if (diffs.Count == 0) { results.Add(new("Row order", true, "")); return; }
        var detail = new StringBuilder("The rows are right but in a different order. Is ORDER BY sorting by the right column, in the right direction?");
        foreach (var i in diffs.Take(3))
            detail.Append($"\n  row {i + 1}: expected {RowText(want.Rows[i])}\n          yours    {RowText(got.Rows[i])}");
        results.Add(new("Row order", false, detail.ToString()));
    }

    static string Count(int n) => $"{n} row{(n == 1 ? "" : "s")}";

    /// <summary>Rows of `rows` (keys `keys`) that `other` does not have, counting duplicates.</summary>
    static List<object?[]> Except(List<object?[]> rows, List<string> keys, List<string> other)
    {
        var pool = other.GroupBy(k => k).ToDictionary(g => g.Key, g => g.Count());
        var left = new List<object?[]>();
        for (var i = 0; i < rows.Count; i++)
        {
            if (pool.TryGetValue(keys[i], out var n) && n > 0) pool[keys[i]] = n - 1;
            else left.Add(rows[i]);
        }
        return left;
    }

    // ---------------------------------------------------------------- free runs (Run button)

    /// <summary>Run setup and code for the Run button: the last result as a table, and a peek at every table afterwards.</summary>
    public static object Run(string setup, string code)
    {
        using var conn = OpenMemory();
        if (setup.Trim().Length > 0 && Execute(conn, setup) is { Error: { } setupError })
            return new { compiled = false, sql = true, diagnostics = new[] { new Diag("error", "SQL", "The exercise's own setup SQL fails: " + setupError, 0, 0, "") } };
        var run = Execute(conn, code);
        var tables = Snapshot(conn);
        var diags = run.Error is { } e ? new[] { new Diag("error", "SQL", e, run.ErrorLine, 1, "") } : [];
        return new
        {
            compiled = run.Error is null, sql = true, diagnostics = diags,
            stdout = string.Join("\n", run.Messages), stderr = "", timedOut = run.TimedOut, ms = run.Ms,
            table = run.Last is { } last ? ToTable(last) : null, tables,
        };
    }

    /// <summary>Every table in the database with its first rows.</summary>
    public static List<SqlTable> Snapshot(SqliteConnection conn, int rows = 50)
    {
        var list = new List<SqlTable>();
        var names = new List<string>();
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
            using var r = cmd.ExecuteReader();
            while (r.Read()) names.Add(r.GetString(0));
        }
        foreach (var name in names.Take(20))
        {
            var b = Execute(conn, $"SELECT * FROM \"{name.Replace("\"", "\"\"")}\" LIMIT {rows + 1}", 2000, rows + 1);
            if (b.Last is { } set) list.Add(ToTable(set, rows, name));
        }
        return list;
    }

    /// <summary>For `dojo validate`: what a predict step's code prints, or why it fails.</summary>
    public static (string? Text, string? Error) PredictText(string setup, string code)
    {
        var r = RunFresh(setup, code);
        if (r.Setup?.Error is { } s) return (null, "setup fails: " + s);
        if (r.Run.Error is { } e) return (null, e);
        return r.Run.Last is { } last ? (AsText(last), null) : (null, "no statement returns rows");
    }

    // ---------------------------------------------------------------- rules

    // Comments go; string literals and quoted names are stepped over so '--' inside them survives.
    [GeneratedRegex(@"('(?:''|[^'])*'|""(?:""""|[^""])*"")|--[^\n]*|/\*[\s\S]*?\*/")]
    private static partial Regex Comment();

    public static string StripComments(string sql) => Comment().Replace(sql, m => m.Groups[1].Success ? m.Value : " ");

    static IEnumerable<(string Pattern, string Message)> Rules(JsonObject step, string key) =>
        (step[key] as JsonArray ?? []).OfType<JsonObject>().Select(r => ((string?)r["pattern"] ?? "", (string?)r["message"] ?? key));
}
