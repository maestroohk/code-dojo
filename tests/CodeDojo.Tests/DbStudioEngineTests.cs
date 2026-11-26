using System.Text.Json;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// The Database studio against real PostgreSQL, SQL Server and MySQL containers. Each test returns early
/// (passes without checking anything) when Docker is not running or the engine's image is not downloaded:
/// tests never download images. The containers and volumes are test-only (their own names and ports) and
/// are removed afterwards, so the learner's own databases are never touched.
/// </summary>
public abstract class DbEngineFixture : IAsyncLifetime
{
    public const string Prefix = "code-dojo-test-db-";
    public const int PortShift = 1000;

    public abstract string EngineId { get; }
    public DbStudio Studio { get; private set; } = null!;
    public string? SkipReason { get; private set; }
    public string StateDir { get; } = Path.Combine(Path.GetTempPath(), "dojo-dbengine-tests-" + Guid.NewGuid().ToString("N"));
    public bool Ready => SkipReason is null;

    public DbStudio.EngineSpec Spec => DbStudio.Specs.Single(s => s.Id == EngineId);

    public DbStudio NewStudio(string stateDir) => new(Path.Combine(StateDir, "sqlite"), stateDir, Prefix, PortShift);

    public async Task InitializeAsync()
    {
        var info = await NetLabs.Docker(["info", "--format", "{{.ServerVersion}}"], TimeSpan.FromSeconds(15));
        if (!info.Ok) { SkipReason = "Docker is not running."; return; }
        var images = await NetLabs.Docker(["images", "--format", "{{.Repository}}:{{.Tag}}"], TimeSpan.FromSeconds(15));
        if (!images.Out.Split('\n').Any(i => i.Trim().StartsWith(Spec.Repo + ":", StringComparison.Ordinal) && !i.Trim().EndsWith(":<none>")))
        { SkipReason = $"No {Spec.Repo} image is downloaded."; return; }
        await RemoveContainer();
        Studio = NewStudio(Path.Combine(StateDir, "state"));
        await StartAndWait(Studio);
    }

    public async Task StartAndWait(DbStudio studio)
    {
        await studio.Engines();                 // loads the list of local images, as the page does first
        studio.Start(EngineId);
        var until = DateTime.UtcNow.AddMinutes(6);
        while (DateTime.UtcNow < until)
        {
            var engine = Engine(await studio.Engines());
            var status = (string?)engine["status"];
            if (status == "running") return;
            if (status == "failed") throw new InvalidOperationException($"{EngineId} failed to start: {engine["error"]} {engine["log"]?.ToJsonString()}");
            await Task.Delay(1000);
        }
        throw new TimeoutException($"{EngineId} did not start in 6 minutes.");
    }

    public JsonNode Engine(object engines) =>
        JsonSerializer.SerializeToNode(engines, new JsonSerializerOptions(JsonSerializerDefaults.Web))!["engines"]!.AsArray().Single(e => (string?)e!["id"] == EngineId)!;

    async Task RemoveContainer()
    {
        await NetLabs.Docker(["rm", "-f", Prefix + EngineId], TimeSpan.FromMinutes(2));
        await NetLabs.Docker(["volume", "rm", "-f", Prefix + EngineId + "-data"], TimeSpan.FromMinutes(1));
    }

    public async Task DisposeAsync()
    {
        if (SkipReason is null) await RemoveContainer();
        try { Directory.Delete(StateDir, true); } catch { }
    }
}

public sealed class PostgresFixture : DbEngineFixture { public override string EngineId => "postgres"; }
public sealed class SqlServerFixture : DbEngineFixture { public override string EngineId => "sqlserver"; }
public sealed class MySqlFixture : DbEngineFixture { public override string EngineId => "mysql"; }

/// <summary>One engine at a time: three database servers starting at once is a lot for a laptop.</summary>
[CollectionDefinition("Docker databases", DisableParallelization = true)]
public sealed class DockerDatabases;

/// <summary>What every server engine must do. Each engine's class supplies its dialect's SQL.</summary>
public abstract class DbEngineTests<TFixture>(TFixture fx) where TFixture : DbEngineFixture
{
    protected readonly TFixture Fx = fx;
    protected string Id => Fx.EngineId;
    static JsonNode J(object o) => JsonSerializer.SerializeToNode(o, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    protected async Task<JsonNode> Run(string db, string sql, bool explain = false) => J(await Fx.Studio.Query(new(Id, db, sql, explain)));

    protected async Task<string> NewDb()
    {
        var name = "t" + Guid.NewGuid().ToString("N")[..8];
        await Fx.Studio.CreateServerDatabase(Id, name);
        return name;
    }

    protected static string Cell(JsonNode r, int set, int row, int col) => (string?)r["results"]![set]!["rows"]![row]![col] ?? "NULL";
    protected static void NoError(JsonNode r) => Assert.True(r["error"] is null || (string?)r["error"] is null, (string?)r["error"]);

    /// <summary>owners(id PK, name) and pets(id PK, owner_id FK, name), one owner with two pets.</summary>
    protected abstract string CreateOwnersAndPets { get; }
    /// <summary>One row: a DATETIME at midnight, a DATE, a DECIMAL(10,2) 12.50, a true boolean/bit, bytes DEADBEEF, NULL.</summary>
    protected abstract string TypesQuery { get; }
    protected abstract string FirstRows(string table);

    [Fact]
    public async Task Create_insert_query_and_schema()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var dbs = JsonSerializer.SerializeToNode(await Fx.Studio.ServerDatabases(Id))!["databases"]!.AsArray().Select(d => (string?)d).ToList();
        Assert.Contains(db, dbs);

        var r = await Run(db, CreateOwnersAndPets + "\nSELECT p.name, o.name AS owner FROM pets p JOIN owners o ON o.id = p.owner_id ORDER BY p.name;");
        NoError(r);
        Assert.Equal("Rex", Cell(r, 0, 0, 0));
        Assert.Equal("Ada", Cell(r, 0, 0, 1));
        Assert.Equal(2, r["results"]![0]!["rows"]!.AsArray().Count);

        var schema = JsonSerializer.SerializeToNode(await Fx.Studio.Schema(new(Id, db)), new JsonSerializerOptions(JsonSerializerDefaults.Web))!["tables"]!.AsArray();
        var pets = schema.Single(t => (string?)t!["name"] == "pets")!;
        Assert.Equal("owners", (string?)pets["foreignKeys"]![0]!["table"]);
        Assert.Equal("owner_id", (string?)pets["foreignKeys"]![0]!["from"]);
        Assert.True((bool)pets["columns"]![0]!["pk"]!);
        Assert.Equal(2, (long)pets["rows"]!);
        Assert.Contains("(40)", (string?)pets["columns"]![2]!["type"]);   // varchar(40): the length is shown

        // The ▶ button's query for a table works in this dialect.
        NoError(await Run(db, FirstRows("pets")));
    }

    [Fact]
    public async Task Errors_name_the_right_line()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var r = await Run(db, "SELECT 1 AS one;\nSELECT 2 AS two;\n\nSELECT nmae FROM no_such_table;");
        Assert.Equal(4, (int)r["errorLine"]!);
        Assert.StartsWith("Line 4: ", (string?)r["error"]);
    }

    [Fact]
    public async Task Values_render_cleanly()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var r = await Run(db, TypesQuery);
        NoError(r);
        var row = r["results"]!.AsArray()[^1]!["rows"]![0]!.AsArray().Select(v => (string?)v).ToList();
        Assert.Equal(["2024-06-01 00:00:00", "2024-06-01", "12.50", "true", "0xDEADBEEF", null], row);
    }

    [Fact]
    public async Task Explain_shows_a_plan_for_the_last_statement_only()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        NoError(await Run(db, CreateOwnersAndPets));
        var r = await Run(db, "SELECT * FROM owners;\nSELECT * FROM pets WHERE name = 'Rex';", explain: true);
        NoError(r);
        var text = r["results"]!.ToJsonString();
        Assert.Contains("pets", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Ada", text);     // the first SELECT did not run as a query
    }

    [Fact]
    public async Task Stop_and_start_keeps_the_data_and_finds_the_password_again()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        NoError(await Run(db, CreateOwnersAndPets));

        var watch = System.Diagnostics.Stopwatch.StartNew();
        var stop = JsonSerializer.SerializeToNode(await Fx.Studio.Stop(Id))!;
        var took = watch.Elapsed;
        var status = (string?)Fx.Engine(await Fx.Studio.Engines())["status"];
        var exit = (await NetLabs.Docker(["container", "inspect", "--format", "{{.State.ExitCode}}", DbEngineFixture.Prefix + Id], TimeSpan.FromSeconds(20))).Out.Trim();

        // A copy of the app with no saved password (a new state folder) starts the same container and still gets in.
        // (Started before the checks below, so a failed check does not leave the engine stopped for the other tests.)
        var fresh = Fx.NewStudio(Path.Combine(Fx.StateDir, "state-" + Guid.NewGuid().ToString("N")[..6]));
        await Fx.StartAndWait(fresh);
        var r = J(await fresh.Query(new(Id, db, "SELECT COUNT(*) FROM pets;")));
        NoError(r);
        Assert.Equal("2", Cell(r, 0, 0, 0));

        Assert.True((bool)stop["stopped"]!, (string?)stop["message"]);
        Assert.Equal("stopped", status);
        // A clean shutdown: the server exited by itself. 137 means Docker gave up waiting and killed it.
        Assert.NotEqual("137", exit);
        Assert.True(took < TimeSpan.FromSeconds(45), $"Stopping took {took.TotalSeconds:0} s.");
    }
}

[Collection("Docker databases")]
public sealed class PostgresEngineTests(PostgresFixture fx) : DbEngineTests<PostgresFixture>(fx), IClassFixture<PostgresFixture>
{
    protected override string CreateOwnersAndPets => """
        CREATE TABLE owners (id int PRIMARY KEY, name varchar(40) NOT NULL);
        CREATE TABLE pets (id int PRIMARY KEY, owner_id int REFERENCES owners(id), name varchar(40));
        INSERT INTO owners VALUES (1, 'Ada');
        INSERT INTO pets VALUES (1, 1, 'Rex'), (2, 1, 'Tom');
        """;
    protected override string TypesQuery => "SELECT timestamp '2024-06-01 00:00', date '2024-06-01', 12.50::numeric(10,2), true, '\\xDEADBEEF'::bytea, NULL";
    protected override string FirstRows(string table) => $"SELECT * FROM {table} LIMIT 100;";

    [Fact]
    public async Task An_error_does_not_undo_the_statements_before_it()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        // Sent as one command, PostgreSQL would roll the whole script back.
        var r = await Run(db, "CREATE TABLE kept (a int);\nINSERT INTO kept VALUES (1);\nSELECT nmae FROM kept;");
        Assert.Equal(3, (int)r["errorLine"]!);
        Assert.Contains("Line 2: INSERT changed 1 row.", r["messages"]!.ToJsonString());
        NoError(await Run(db, "SELECT * FROM kept;"));
    }

    [Fact]
    public async Task Dollar_quoted_functions_and_arrays()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var r = await Run(db, """
            CREATE FUNCTION add_one(x int) RETURNS int AS $$
            BEGIN
              RETURN x + 1;
            END;
            $$ LANGUAGE plpgsql;
            SELECT add_one(41), ARRAY[1, 2, 3];
            """);
        NoError(r);
        Assert.Equal("42", Cell(r, 0, 0, 0));
        Assert.Equal("{1,2,3}", Cell(r, 0, 0, 1));
    }
}

[Collection("Docker databases")]
public sealed class SqlServerEngineTests(SqlServerFixture fx) : DbEngineTests<SqlServerFixture>(fx), IClassFixture<SqlServerFixture>
{
    protected override string CreateOwnersAndPets => """
        CREATE TABLE owners (id INT PRIMARY KEY, name NVARCHAR(40) NOT NULL);
        CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT REFERENCES owners(id), name NVARCHAR(40));
        INSERT INTO owners VALUES (1, N'Ada');
        INSERT INTO pets VALUES (1, 1, N'Rex'), (2, 1, N'Tom');
        """;
    protected override string TypesQuery => "SELECT CAST('2024-06-01' AS DATETIME), CAST('2024-06-01' AS DATE), CAST(12.5 AS DECIMAL(10,2)), CAST(1 AS BIT), 0xDEADBEEF, NULL";
    protected override string FirstRows(string table) => $"SELECT TOP 100 * FROM {table};";

    [Fact]
    public async Task Go_batches_print_and_row_counts()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var r = await Run(db, """
            CREATE TABLE t (a INT);
            GO
            CREATE VIEW v AS SELECT a FROM t;
            GO
            INSERT INTO t VALUES (1);
            GO 3
            PRINT 'hello';
            SELECT COUNT(*) AS n FROM v;
            """);
        NoError(r);
        Assert.Equal("3", Cell(r, 0, 0, 0));
        var messages = r["messages"]!.ToJsonString();
        Assert.Contains("hello", messages);
        Assert.Contains("(1 row affected)", messages);

        // An error in the third batch points at its line in the whole script.
        var bad = await Run(db, "SELECT 1;\nGO\nSELECT 2;\nGO\n\nSELECT nmae FROM t;");
        Assert.Equal(6, (int)bad["errorLine"]!);
    }

    [Fact]
    public async Task Limit_gets_a_hint_and_spatial_values_do_not_break_the_grid()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var r = await Run(db, "SELECT name FROM sys.databases LIMIT 5;");
        Assert.Contains("SQL Server has no LIMIT", (string?)r["error"]);

        var geo = await Run(db, "SELECT geography::Point(51.5, -0.12, 4326) AS place, geography::Point(51.5, -0.12, 4326).ToString() AS text;");
        NoError(geo);
        Assert.Contains(".ToString()", Cell(geo, 0, 0, 0));
        Assert.Equal("POINT (-0.12 51.5)", Cell(geo, 0, 0, 1));
    }
}

[Collection("Docker databases")]
public sealed class MySqlEngineTests(MySqlFixture fx) : DbEngineTests<MySqlFixture>(fx), IClassFixture<MySqlFixture>
{
    protected override string CreateOwnersAndPets => """
        CREATE TABLE owners (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL);
        CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, name VARCHAR(40), FOREIGN KEY (owner_id) REFERENCES owners(id));
        INSERT INTO owners VALUES (1, 'Ada');
        INSERT INTO pets VALUES (1, 1, 'Rex'), (2, 1, 'Tom');
        """;
    protected override string TypesQuery => """
        CREATE TABLE types (dt DATETIME, d DATE, dec_ DECIMAL(10,2), flag BOOLEAN, data BLOB, nothing INT);
        INSERT INTO types VALUES ('2024-06-01 00:00:00', '2024-06-01', 12.5, TRUE, X'DEADBEEF', NULL);
        SELECT * FROM types;
        """;
    protected override string FirstRows(string table) => $"SELECT * FROM {table} LIMIT 100;";

    [Fact]
    public async Task Procedures_with_delimiter_and_several_result_sets()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var r = await Run(db, """
            CREATE TABLE t (a INT, flags BIT(3));
            INSERT INTO t VALUES (1, b'101'), (2, NULL);
            DELIMITER $$
            CREATE PROCEDURE two_sets()
            BEGIN
              SELECT a, flags FROM t ORDER BY a;
              SELECT COUNT(*) AS n FROM t;
            END$$
            DELIMITER ;
            CALL two_sets();
            """);
        NoError(r);
        var sets = r["results"]!.AsArray();
        Assert.Equal(2, sets.Count);
        Assert.Equal("b'101'", Cell(r, 0, 0, 1));
        Assert.Equal("2", Cell(r, 1, 0, 0));
        Assert.Equal(10, (int)sets[0]!["line"]!);
        Assert.Contains("Line 2: INSERT changed 2 rows.", r["messages"]!.ToJsonString());
    }

    [Fact]
    public async Task Syntax_errors_point_inside_the_statement_and_top_gets_a_hint()
    {
        if (!Fx.Ready) return;
        var db = await NewDb();
        var r = await Run(db, "SELECT 1;\nSELECT *\nFROM dual\nWHER 1 = 1;");
        Assert.Equal(4, (int)r["errorLine"]!);

        var top = await Run(db, "SELECT TOP 5 * FROM information_schema.tables;");
        Assert.Contains("MySQL has no TOP", (string?)top["error"]);
    }
}
