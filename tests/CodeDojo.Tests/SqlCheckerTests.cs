using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>SQL steps graded on SQLite: row-set, ordered and state checks, NULLs, numbers, errors.</summary>
public class SqlCheckerTests
{
    static JsonObject Step(string json) => JsonNode.Parse(json)!.AsObject();
    static string Why(CheckResult r) => string.Join(" | ", r.Tests.Select(t => $"{t.Name}: {t.Detail}")) + " " + string.Join(" ", r.Diagnostics.Select(d => d.Message));

    const string People = """
        "setup": [
          "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, city TEXT);",
          "INSERT INTO people VALUES (1, 'Ada', 36, 'London'), (2, 'Linus', 28, NULL), (3, 'Grace', 45, 'New York'), (4, 'Alan', 41, 'London');"
        ]
        """;

    [Fact]
    public void Rows_any_order_passes_and_reports_columns_and_rows()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT name FROM people WHERE city = 'London' ORDER BY name;" }""");
        var r = SqlChecker.Check(step, "select name from people where city = 'London' order by name desc");
        Assert.True(r.Passed, Why(r));
        Assert.Contains(r.Tests, t => t.Name == "Returns the right columns" && t.Pass);
        Assert.Contains(r.Tests, t => t.Name == "Returns the right rows" && t.Pass);
        var table = ((SqlCheckResult)r).Table!;
        Assert.Equal(["name"], table.Columns);
        Assert.Equal(2, table.Rows.Count);
    }

    [Fact]
    public void Wrong_rows_show_a_readable_diff()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT name FROM people WHERE age > 30;" }""");
        var r = SqlChecker.Check(step, "SELECT name FROM people WHERE age > 40");
        Assert.False(r.Passed);
        var rows = r.Tests.Single(t => t.Name == "Returns the right rows");
        Assert.Contains("Expected 3 rows, yours has 2", rows.Detail);
        Assert.Contains("Missing", rows.Detail);
        Assert.Contains("Ada", rows.Detail);
    }

    [Fact]
    public void Column_count_must_match()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT name, age FROM people;" }""");
        var r = SqlChecker.Check(step, "SELECT * FROM people");
        Assert.False(r.Passed);
        Assert.Contains("Expected 2 columns (name, age)", r.Tests.Single(t => t.Name == "Returns the right columns").Detail);
    }

    [Fact]
    public void Ordered_checks_the_order_too()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "check": "ordered", "solution": "SELECT name, age FROM people ORDER BY age DESC;" }""");
        Assert.True(SqlChecker.Check(step, "SELECT name, age FROM people ORDER BY 2 DESC").Passed);
        var r = SqlChecker.Check(step, "SELECT name, age FROM people ORDER BY age");
        Assert.False(r.Passed);
        Assert.True(r.Tests.Single(t => t.Name == "Returns the right rows").Pass);
        var order = r.Tests.Single(t => t.Name == "Row order");
        Assert.False(order.Pass);
        Assert.Contains("row 1: expected Grace | 45", order.Detail);
    }

    [Fact]
    public void Nulls_equal_nulls_and_numbers_compare_by_value()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT city, 1 FROM people WHERE id = 2;" }""");
        Assert.True(SqlChecker.Check(step, "SELECT NULL, 1.0").Passed);
        Assert.False(SqlChecker.Check(step, "SELECT 'NULL', 1").Passed);      // text 'NULL' is not NULL

        var avg = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT AVG(age) FROM people;" }""");
        Assert.True(SqlChecker.Check(avg, "SELECT SUM(age) * 1.0 / COUNT(*) FROM people").Passed);
        Assert.False(SqlChecker.Check(avg, "SELECT SUM(age) / COUNT(*) FROM people").Passed);   // integer division: 37, not 37.5
    }

    [Fact]
    public void Text_compares_exactly()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT name FROM people WHERE id = 1;" }""");
        Assert.False(SqlChecker.Check(step, "SELECT 'ada'").Passed);
        Assert.False(SqlChecker.Check(step, "SELECT 1").Passed);
    }

    [Fact]
    public void Multi_statement_uses_the_last_result()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT COUNT(*) FROM people;" }""");
        var r = SqlChecker.Check(step, "SELECT name FROM people;\nINSERT INTO people (name) VALUES ('x; y');\nDELETE FROM people WHERE name = 'x; y';\nSELECT COUNT(*) FROM people;");
        Assert.True(r.Passed, Why(r));
        Assert.Contains("INSERT changed 1 row", r.Stdout);
    }

    [Fact]
    public void State_check_compares_the_data_afterwards()
    {
        var step = Step($$"""
            { "type": "code", {{People}}, "check": "state",
              "solution": "UPDATE people SET city = 'Helsinki' WHERE name = 'Linus';",
              "stateQuery": "SELECT id, name, city FROM people" }
            """);
        var good = SqlChecker.Check(step, "UPDATE people SET city = 'Helsinki' WHERE id = 2;");
        Assert.True(good.Passed, Why(good));
        Assert.StartsWith("After your SQL", ((SqlCheckResult)good).Table!.Title);

        var bad = SqlChecker.Check(step, "UPDATE people SET city = 'Helsinki';");
        Assert.False(bad.Passed);
        Assert.Contains("Not expected", bad.Tests.Single(t => t.Name == "Leaves the right rows").Detail);
    }

    [Fact]
    public void State_check_works_for_ddl()
    {
        var step = Step($$"""
            { "type": "code", {{People}}, "check": "state",
              "solution": "CREATE TABLE pets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
              "stateQuery": "SELECT name, type FROM pragma_table_info('pets')" }
            """);
        Assert.True(SqlChecker.Check(step, "create table pets (id integer primary key, name text not null)").Passed);
        Assert.False(SqlChecker.Check(step, "create table pets (id integer primary key, title text)").Passed);
    }

    [Fact]
    public void Errors_are_readable_and_point_at_the_line()
    {
        var step = Step($$"""{ "type": "code", {{People}}, "solution": "SELECT name FROM people;" }""");
        var r = SqlChecker.Check(step, "SELECT id\n  , nmae\nFROM people");
        Assert.False(r.Passed);
        Assert.False(r.Compiled);
        var d = Assert.Single(r.Diagnostics);
        Assert.Contains("no such column: nmae", d.Message);
        Assert.Equal(2, d.Line);
        Assert.DoesNotContain("SQLite Error", d.Message);
    }

    [Fact]
    public void Require_and_forbid_ignore_comments_and_case()
    {
        var step = Step($$"""
            { "type": "code", {{People}}, "solution": "SELECT p.name FROM people p JOIN people q ON p.id = q.id;",
              "require": [{ "pattern": "\\bJOIN\\b", "message": "Uses a JOIN" }],
              "forbid": [{ "pattern": "\\bWHERE\\b", "message": "No WHERE" }] }
            """);
        Assert.True(SqlChecker.Check(step, "-- a where clause is not needed\nselect a.name from people a join people b on a.id = b.id").Passed);
        Assert.False(SqlChecker.Check(step, "/* join */ SELECT name FROM people").Passed);
    }

    [Fact]
    public void Attach_is_refused_and_runaway_queries_stop()
    {
        var step = Step("""{ "type": "code", "solution": "SELECT 1;" }""");
        var path = Path.Combine(Path.GetTempPath(), "dojo-attach-" + Guid.NewGuid() + ".db");
        var r = SqlChecker.Check(step, $"ATTACH DATABASE '{path}' AS x; SELECT 1;");
        Assert.False(r.Passed);
        Assert.False(File.Exists(path));

        var loop = SqlChecker.Check(step, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n;");
        Assert.False(loop.Passed);
        Assert.True(loop.TimedOut);
    }

    [Fact]
    public void Splitter_keeps_triggers_and_strings_whole()
    {
        var parts = SqlChecker.Split("""
            CREATE TABLE t (a);
            -- a comment; with a semicolon
            CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = a + 1; SELECT ';'; END;
            INSERT INTO t VALUES ('x;y')
            """);
        Assert.Equal(3, parts.Count);
        Assert.Equal(3, parts[1].Line);
        Assert.Contains("END;", parts[1].Sql);
    }

    [Fact]
    public void Predict_text_is_one_line_per_row()
    {
        var (text, error) = SqlChecker.PredictText("CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 2.5), (NULL, 3.0), ('x', 7);", "SELECT a, b FROM t;");
        Assert.Null(error);
        Assert.Equal("1 | 2.5\nNULL | 3.0\nx | 7", text);
    }

    [Fact]
    public void Run_returns_a_table_and_a_peek_at_the_tables()
    {
        var r = System.Text.Json.JsonSerializer.SerializeToNode(SqlChecker.Run("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2);", "INSERT INTO t VALUES (3); SELECT a FROM t"))!;
        Assert.True((bool)r["compiled"]!);
        Assert.Equal(3, r["table"]!["Rows"]!.AsArray().Count);
        Assert.Equal("t", (string?)r["tables"]![0]!["Title"]);
    }
}
