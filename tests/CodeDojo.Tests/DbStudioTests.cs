using System.Text.Json;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>The Database studio's SQLite side: files, samples, queries, schema, CSV import.</summary>
public sealed class DbStudioTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "dojo-db-tests-" + Guid.NewGuid().ToString("N"));
    readonly DbStudio _studio;

    public DbStudioTests() => _studio = new DbStudio(Path.Combine(_dir, "dbs"), Path.Combine(_dir, "state"));
    public void Dispose() { Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools(); try { Directory.Delete(_dir, true); } catch { } }

    static JsonNode J(object o) => JsonSerializer.SerializeToNode(o, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    [Fact]
    public void First_visit_makes_the_sample_databases()
    {
        var list = J(_studio.List());
        var names = list["databases"]!.AsArray().Select(d => (string)d!["name"]!).ToList();
        Assert.Equal(["bookshop", "company", "movies"], names);

        // Deleted samples are not made again unless asked.
        _studio.Delete("movies");
        Assert.DoesNotContain(J(_studio.List())["databases"]!.AsArray(), d => (string)d!["name"]! == "movies");
        Assert.Single(Directory.GetFiles(Path.Combine(_dir, "dbs", ".trash")));
        _studio.MakeSamples(force: true);
        Assert.Contains(J(_studio.List())["databases"]!.AsArray(), d => (string)d!["name"]! == "movies");
    }

    [Fact]
    public async Task Samples_have_joinable_data()
    {
        _studio.List();
        var r = J(await _studio.Query(new("sqlite", "bookshop", "SELECT a.name, count(*) FROM books b JOIN authors a ON a.id = b.author_id GROUP BY a.name ORDER BY 2 DESC, 1 LIMIT 1")));
        Assert.Null((string?)r["error"]);
        Assert.Equal("Charles Dickens", (string?)r["results"]![0]!["rows"]![0]![0]);

        var hr = J(await _studio.Query(new("sqlite", "company", "SELECT count(*) FROM employees e JOIN employees m ON m.id = e.manager_id")));
        Assert.True(int.Parse((string)hr["results"]![0]!["rows"]![0]![0]!) > 40);

        var movies = J(await _studio.Query(new("sqlite", "movies", "SELECT count(*) FROM ratings")));
        Assert.True(int.Parse((string)movies["results"]![0]!["rows"]![0]![0]!) > 100);
    }

    [Fact]
    public async Task Create_query_multiple_statements_and_schema()
    {
        _studio.Create("scratch");
        var r = J(await _studio.Query(new("sqlite", "scratch", """
            CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE pets (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owners(id), name TEXT);
            CREATE INDEX idx_pets_owner ON pets(owner_id);
            INSERT INTO owners VALUES (1, 'Ada');
            INSERT INTO pets VALUES (1, 1, 'Rex'), (2, 1, 'Tom');
            SELECT * FROM owners;
            SELECT name FROM pets ORDER BY name;
            """)));
        Assert.Null((string?)r["error"]);
        Assert.Equal(2, r["results"]!.AsArray().Count);
        Assert.Contains("INSERT changed 2 rows", r["messages"]!.ToJsonString());
        Assert.Equal("INTEGER", (string?)r["results"]![0]!["types"]![0]);

        var schema = J(await _studio.Schema(new("sqlite", "scratch")));
        var pets = schema["tables"]!.AsArray().Single(t => (string)t!["name"]! == "pets")!;
        Assert.Equal("owners", (string?)pets["foreignKeys"]![0]!["table"]);
        Assert.Equal("idx_pets_owner", (string?)pets["indexes"]![0]!["name"]);
        Assert.True((bool)pets["columns"]![0]!["pk"]!);
        Assert.Equal(2, (long)pets["rows"]!);
    }

    [Fact]
    public async Task Errors_explain_and_names_are_checked()
    {
        _studio.Create("x");
        var bad = J(await _studio.Query(new("sqlite", "x", "SELECT 1;\nSELECT nmae FROM sqlite_schema;")));
        Assert.Contains("Line 2: no such column: nmae", (string?)bad["error"]);

        await _studio.Query(new("sqlite", "x", "CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)"));
        var plan = J(await _studio.Query(new("sqlite", "x", "SELECT * FROM t WHERE a = 3", Explain: true)));
        Assert.Contains("USING INTEGER PRIMARY KEY", plan["plan"]!.ToJsonString());

        Assert.Throws<DbStudio.StudioException>(() => _studio.Create("../evil"));
        Assert.Throws<DbStudio.StudioException>(() => _studio.Create("x"));
        _studio.Rename("x", "y");
        Assert.True(File.Exists(Path.Combine(_dir, "dbs", "y.db")));
    }

    [Fact]
    public void MySql_scripts_split_like_the_mysql_client()
    {
        var parts = DbStudio.SplitStatements("""
            -- a comment
            INSERT INTO t VALUES ('O\'Brien; x'), ("a \"b\"; c");  # trailing comment
            SELECT 5--1;
            DELIMITER $$
            CREATE PROCEDURE p()
            BEGIN
              SELECT 1; SELECT 2;
            END$$
            DELIMITER ;
            CALL p();
            """, mysql: true);
        Assert.Equal(4, parts.Count);
        Assert.Equal(("INSERT INTO t VALUES ('O\\'Brien; x'), (\"a \\\"b\\\"; c\")", 2), parts[0]);
        Assert.Equal(("SELECT 5--1", 3), parts[1]);     // -- needs a space after it to start a MySQL comment
        Assert.StartsWith("CREATE PROCEDURE p()", parts[2].Sql);
        Assert.EndsWith("END", parts[2].Sql);
        Assert.Equal(5, parts[2].Line);
        Assert.Equal(("CALL p()", 10), parts[3]);
    }

    [Fact]
    public void Postgres_scripts_split_like_psql()
    {
        var parts = DbStudio.SplitStatements("""
            CREATE FUNCTION f() RETURNS int AS $body$
            BEGIN RETURN 1; END;
            $body$ LANGUAGE plpgsql;
            SELECT E'it\'s; ok', 'plain''s; ok', $$a;b$$;
            /* block; comment */ SELECT 2
            """, mysql: false);
        Assert.Equal(3, parts.Count);
        Assert.EndsWith("LANGUAGE plpgsql", parts[0].Sql);
        Assert.Equal(4, parts[1].Line);
        Assert.Equal(("SELECT 2", 5), parts[2]);
    }

    [Fact]
    public void Sql_server_scripts_split_on_go_lines()
    {
        var batches = DbStudio.SqlServerBatches("CREATE TABLE t (a INT);\ngo\n\nINSERT INTO t VALUES (1);\nGO 3\nSELECT * FROM t -- not GO\nGO");
        Assert.Equal(3, batches.Count);
        Assert.Equal(("CREATE TABLE t (a INT);", 1, 1), batches[0]);
        Assert.Equal(3, batches[1].Line);                 // the batch keeps its blank first line, so error lines still match
        Assert.Equal(3, batches[1].Repeat);
        Assert.Equal(("SELECT * FROM t -- not GO", 6, 1), batches[2]);
    }

    [Fact]
    public async Task Csv_import_infers_column_types()
    {
        _studio.Create("imports");
        var r = J(_studio.Import(new("imports", "cities", "name,population,area km2,zip\n\"Leeds, UK\",812000,551.7,0113\nYork,,272,01904\n")));
        Assert.Equal(2, (int)r["rows"]!);
        Assert.Equal(["TEXT", "INTEGER", "REAL", "TEXT"], r["columns"]!.AsArray().Select(c => (string)c!["type"]!));
        var q = J(await _studio.Query(new("sqlite", "imports", "SELECT name, population, area_km2, zip FROM cities ORDER BY name")));
        Assert.Equal("""["Leeds, UK","812000","551.7","0113"]""", q["results"]![0]!["rows"]![0]!.ToJsonString());
        Assert.Null(q["results"]![0]!["rows"]![1]![1]);
    }
}
