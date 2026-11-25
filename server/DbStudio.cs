using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace CodeDojo;

/// <summary>
/// The Database studio: SQLite databases as files in %USERPROFILE%\code-dojo\databases (DOJO_DATABASES
/// overrides), and PostgreSQL, SQL Server and MySQL as Docker containers bound to 127.0.0.1 only.
/// One query UI for all of them: multi-statement runs, result grids, schema, EXPLAIN, CSV import.
/// Passwords for the containers are generated here and kept only in .state/db-engines.json.
/// </summary>
public sealed partial class DbStudio
{
    public const int MaxRows = 2000;
    public const int SqliteTimeoutMs = 10_000;
    public const int ServerTimeoutSeconds = 20;

    public string Dir { get; }
    readonly string _stateFile;
    readonly object _lock = new();
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public DbStudio(string dir, string stateDir)
    {
        Dir = dir;
        _stateFile = Path.Combine(stateDir, "db-engines.json");
    }

    public static string DefaultDir() =>
        Environment.GetEnvironmentVariable("DOJO_DATABASES") is { Length: > 0 } env ? env
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "code-dojo", "databases");

    public static void Map(WebApplication app, string stateDir)
    {
        var studio = new DbStudio(DefaultDir(), stateDir);
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        IResult Ok(object o) => Results.Json(o, json);
        IResult Fail(string message) => Results.Json(new { error = message }, json, statusCode: 400);
        IResult Guard(Func<IResult> f) { try { return f(); } catch (StudioException e) { return Fail(e.Message); } }
        async Task<IResult> GuardAsync(Func<Task<IResult>> f) { try { return await f(); } catch (StudioException e) { return Fail(e.Message); } }

        app.MapGet("/api/db/list", () => Guard(() => Ok(studio.List())));
        app.MapPost("/api/db/create", (NameRequest r) => Guard(() => { studio.Create(r.Name); return Ok(studio.List()); }));
        app.MapPost("/api/db/rename", (NameRequest r) => Guard(() => { studio.Rename(r.Name, r.To ?? ""); return Ok(studio.List()); }));
        app.MapPost("/api/db/delete", (NameRequest r) => Guard(() => { studio.Delete(r.Name); return Ok(studio.List()); }));
        app.MapPost("/api/db/samples", () => Guard(() => { studio.MakeSamples(force: true); return Ok(studio.List()); }));
        app.MapPost("/api/db/schema", (Target t) => GuardAsync(async () => Ok(await studio.Schema(t))));
        app.MapPost("/api/db/query", (QueryRequest q) => GuardAsync(async () => Ok(await studio.Query(q))));
        app.MapPost("/api/db/import", (ImportRequest r) => Guard(() => Ok(studio.Import(r))));
        app.MapGet("/api/db/engines", async () => Ok(await studio.Engines()));
        app.MapPost("/api/db/engines/{id}/start", (string id) => Guard(() => Ok(studio.Start(id))));
        app.MapPost("/api/db/engines/{id}/stop", (string id) => GuardAsync(async () => Ok(await studio.Stop(id))));
        app.MapGet("/api/db/engines/{id}/databases", (string id) => GuardAsync(async () => Ok(await studio.ServerDatabases(id))));
        app.MapPost("/api/db/engines/{id}/create", (string id, NameRequest r) => GuardAsync(async () => { await studio.CreateServerDatabase(id, r.Name); return Ok(await studio.ServerDatabases(id)); }));
    }

    public record NameRequest(string Name, string? To = null);
    public record Target(string? Engine, string? Db);
    public record QueryRequest(string? Engine, string? Db, string? Sql, bool Explain = false);
    public record ImportRequest(string? Db, string? Table, string? Csv);

    public sealed class StudioException(string message) : Exception(message);

    // ---------------------------------------------------------------- SQLite files

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]
    private static partial Regex SafeName();

    static string CheckName(string? name, string what = "database") =>
        name is { } n && SafeName().IsMatch(n) ? n : throw new StudioException($"A {what} name uses letters, digits, - and _ (up to 64 characters), starting with a letter or digit.");

    string PathOf(string name)
    {
        var path = Path.GetFullPath(Path.Combine(Dir, CheckName(name) + ".db"));
        if (!path.StartsWith(Path.GetFullPath(Dir), StringComparison.OrdinalIgnoreCase)) throw new StudioException("Bad database name.");
        return path;
    }

    SqliteConnection OpenFile(string name, bool create = false)
    {
        var path = PathOf(name);
        if (!create && !File.Exists(path)) throw new StudioException($"There is no database called {name}.");
        var conn = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = create ? SqliteOpenMode.ReadWriteCreate : SqliteOpenMode.ReadWrite, Pooling = false, ForeignKeys = true,
        }.ToString());
        conn.Open();
        SqlChecker.Harden(conn);
        return conn;
    }

    public object List()
    {
        Directory.CreateDirectory(Dir);
        MakeSamples(force: false);
        var dbs = new DirectoryInfo(Dir).GetFiles("*.db").OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
            .Select(f => new { name = Path.GetFileNameWithoutExtension(f.Name), size = f.Length, modified = f.LastWriteTimeUtc, sample = Samples.ContainsKey(Path.GetFileNameWithoutExtension(f.Name)) })
            .ToList();
        return new { dir = Dir, databases = dbs };
    }

    public void Create(string name)
    {
        Directory.CreateDirectory(Dir);
        if (File.Exists(PathOf(name))) throw new StudioException($"{name} already exists.");
        using var c = OpenFile(name, create: true);
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA user_version = 1";       // writes the file header, so it is a real database file
        cmd.ExecuteNonQuery();
    }

    public void Rename(string name, string to)
    {
        var (from, dest) = (PathOf(name), PathOf(to));
        if (!File.Exists(from)) throw new StudioException($"There is no database called {name}.");
        if (File.Exists(dest)) throw new StudioException($"{to} already exists.");
        SqliteConnection.ClearAllPools();
        File.Move(from, dest);
    }

    /// <summary>Not gone for good: moved to .trash next to the databases.</summary>
    public void Delete(string name)
    {
        var path = PathOf(name);
        if (!File.Exists(path)) throw new StudioException($"There is no database called {name}.");
        var trash = Path.Combine(Dir, ".trash");
        Directory.CreateDirectory(trash);
        SqliteConnection.ClearAllPools();
        File.Move(path, Path.Combine(trash, $"{name}-{DateTime.Now:yyyyMMdd-HHmmss}.db"));
    }

    // ---------------------------------------------------------------- schema

    public record Column(string Name, string Type, bool NotNull, bool Pk, string? Default);
    public record ForeignKey(string From, string Table, string To);
    public record Index(string Name, bool Unique, string Columns);
    public record Table(string Name, string Kind, List<Column> Columns, List<ForeignKey> ForeignKeys, List<Index> Indexes, long? Rows, string? Sql);

    public async Task<object> Schema(Target t)
    {
        if (Engine(t.Engine) is { } e) return new { tables = await ServerSchema(e, t.Db) };
        using var c = OpenFile(t.Db ?? "");
        var tables = new List<Table>();
        var list = new List<(string Name, string Type, string? Sql)>();
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";
            using var r = cmd.ExecuteReader();
            while (r.Read()) list.Add((r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)));
        }
        string Q(string s) => "'" + s.Replace("'", "''") + "'";
        List<object?[]> Rows(string sql)
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            using var r = cmd.ExecuteReader();
            var rows = new List<object?[]>();
            while (r.Read()) { var row = new object?[r.FieldCount]; for (var i = 0; i < row.Length; i++) row[i] = r.IsDBNull(i) ? null : r.GetValue(i); rows.Add(row); }
            return rows;
        }
        foreach (var (name, type, sql) in list)
        {
            var cols = Rows($"SELECT name, type, \"notnull\", pk, dflt_value FROM pragma_table_info({Q(name)})")
                .Select(r => new Column((string)r[0]!, (string?)r[1] ?? "", (long)r[2]! == 1, (long)r[3]! > 0, r[4]?.ToString())).ToList();
            var fks = Rows($"SELECT \"from\", \"table\", \"to\" FROM pragma_foreign_key_list({Q(name)})")
                .Select(r => new ForeignKey((string)r[0]!, (string)r[1]!, r[2] as string ?? "")).ToList();
            var idx = Rows($"SELECT il.name, il.\"unique\", (SELECT group_concat(name, ', ') FROM pragma_index_info(il.name)) FROM pragma_index_list({Q(name)}) il")
                .Select(r => new Index((string)r[0]!, (long)r[1]! == 1, r[2] as string ?? "")).ToList();
            long? count = null;
            try { count = (long?)Rows($"SELECT count(*) FROM \"{name.Replace("\"", "\"\"")}\"")[0][0]; } catch (SqliteException) { }
            tables.Add(new(name, type, cols, fks, idx, count, sql));
        }
        return new { tables };
    }

    // ---------------------------------------------------------------- queries

    public record Grid(List<string> Columns, List<string> Types, List<string?[]> Rows, bool Truncated, int Line, long Ms);

    public async Task<object> Query(QueryRequest q)
    {
        var sql = q.Sql ?? "";
        if (SqlChecker.StripComments(sql).Trim().Trim(';').Trim().Length == 0) throw new StudioException("Write a query first.");
        if (Engine(q.Engine) is { } e) return await ServerQuery(e, q.Db, sql, q.Explain);

        using var c = OpenFile(q.Db ?? "");
        if (q.Explain)
        {
            var last = SqlChecker.Split(sql).LastOrDefault();
            var plan = SqlChecker.Execute(c, "EXPLAIN QUERY PLAN " + last.Sql, SqliteTimeoutMs, 500);
            if (plan.Error is not null) return new { error = plan.Error.Replace("Line 1: ", ""), errorLine = last.Line };
            return new
            {
                plan = plan.Last?.Rows.Select(r => new { id = Convert.ToInt64(r[0]), parent = Convert.ToInt64(r[1]), detail = r[3]?.ToString() ?? "" }),
                statement = last.Sql, line = last.Line,
            };
        }
        var batch = SqlChecker.Execute(c, sql, SqliteTimeoutMs, MaxRows);
        return new
        {
            results = batch.Sets.Select(s => new Grid(s.Columns, s.Types, s.Rows.Select(r => r.Select(v => v is null ? null : SqlChecker.Render(v)).ToArray()).ToList(), s.Truncated, s.Line, s.Ms)),
            messages = batch.Messages, error = batch.Error, errorLine = batch.ErrorLine, timedOut = batch.TimedOut, ms = batch.Ms, statements = batch.Statements,
        };
    }

    // ---------------------------------------------------------------- CSV import

    public object Import(ImportRequest r)
    {
        var table = CheckName(r.Table, "table");
        var rows = ParseCsv(r.Csv ?? "");
        if (rows.Count < 2) throw new StudioException("The CSV needs a header row and at least one data row.");
        var header = rows[0].Select((h, i) => Regex.Replace(h.Trim(), @"[^A-Za-z0-9_]+", "_").Trim('_') is { Length: > 0 } n ? n : $"col{i + 1}").ToList();
        for (var i = 0; i < header.Count; i++)          // de-duplicate names
            if (header.Take(i).Contains(header[i], StringComparer.OrdinalIgnoreCase)) header[i] += "_" + (i + 1);
        var data = rows.Skip(1).Where(row => row.Any(v => v.Length > 0)).ToList();
        var types = header.Select((_, i) => Infer(data.Select(row => i < row.Count ? row[i] : ""))).ToList();

        using var c = OpenFile(r.Db ?? "");
        using var tx = c.BeginTransaction();
        using (var exists = c.CreateCommand())
        {
            exists.CommandText = "SELECT count(*) FROM sqlite_schema WHERE name = $n COLLATE NOCASE";
            exists.Parameters.AddWithValue("$n", table);
            if ((long)exists.ExecuteScalar()! > 0) throw new StudioException($"{table} already exists. Pick a new table name.");
        }
        using (var create = c.CreateCommand())
        {
            create.CommandText = $"CREATE TABLE \"{table}\" ({string.Join(", ", header.Select((h, i) => $"\"{h}\" {types[i]}"))})";
            create.ExecuteNonQuery();
        }
        using var insert = c.CreateCommand();
        insert.CommandText = $"INSERT INTO \"{table}\" VALUES ({string.Join(", ", header.Select((_, i) => "$p" + i))})";
        var ps = header.Select((_, i) => insert.Parameters.Add("$p" + i, SqliteType.Text)).ToList();
        foreach (var row in data)
        {
            for (var i = 0; i < header.Count; i++)
            {
                var v = i < row.Count ? row[i].Trim() : "";
                ps[i].Value = v.Length == 0 ? DBNull.Value
                    : types[i] == "INTEGER" ? long.Parse(v, Inv)
                    : types[i] == "REAL" ? double.Parse(v, Inv) : row[i];
            }
            insert.ExecuteNonQuery();
        }
        tx.Commit();
        return new { table, rows = data.Count, columns = header.Select((h, i) => new { name = h, type = types[i] }) };
    }

    static string Infer(IEnumerable<string> values)
    {
        var present = values.Select(v => v.Trim()).Where(v => v.Length > 0).ToList();
        // A leading zero ("0113", a phone or zip code) means the text matters: keep it as TEXT.
        if (present.Count == 0 || present.Any(v => Regex.IsMatch(v, @"^-?0\d"))) return "TEXT";
        if (present.All(v => long.TryParse(v, NumberStyles.AllowLeadingSign, Inv, out _))) return "INTEGER";
        if (present.All(v => double.TryParse(v, NumberStyles.Float, Inv, out _))) return "REAL";
        return "TEXT";
    }

    /// <summary>RFC 4180: quoted fields, doubled quotes, newlines inside quotes. Comma, semicolon or tab, whichever the header uses most.</summary>
    public static List<List<string>> ParseCsv(string text)
    {
        var firstLine = text.Split('\n')[0];
        var sep = new[] { ',', ';', '\t' }.OrderByDescending(s => firstLine.Count(ch => ch == s)).First();
        var rows = new List<List<string>>();
        var row = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (quoted)
            {
                if (ch == '"' && i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                else if (ch == '"') quoted = false;
                else field.Append(ch);
            }
            else if (ch == '"' && field.Length == 0) quoted = true;
            else if (ch == sep) { row.Add(field.ToString()); field.Clear(); }
            else if (ch == '\n') { row.Add(field.ToString().TrimEnd('\r')); field.Clear(); rows.Add(row); row = []; }
            else field.Append(ch);
        }
        if (field.Length > 0 || row.Count > 0) { row.Add(field.ToString().TrimEnd('\r')); rows.Add(row); }
        return rows;
    }

    // ---------------------------------------------------------------- server engines (Docker)

    public sealed record EngineSpec(string Id, string Name, string Repo, string DefaultTag, int Port, int Inner, string Size, string DefaultDb, string Note);

    public static readonly EngineSpec[] Specs =
    [
        new("postgres", "PostgreSQL", "postgres", "18", 55432, 5432, "about 450 MB", "dojo", "The official postgres image."),
        new("sqlserver", "SQL Server", "mcr.microsoft.com/mssql/server", "2022-latest", 51433, 1433, "about 1.6 GB", "dojo",
            "Microsoft's SQL Server 2022 Developer edition image. Starting it accepts the SQL Server EULA (https://go.microsoft.com/fwlink/?linkid=857698)."),
        new("mysql", "MySQL", "mysql", "8.4", 53306, 3306, "about 800 MB", "dojo", "The official mysql image."),
    ];

    static EngineSpec? Engine(string? id) => id is null or "" or "sqlite" ? null
        : Specs.FirstOrDefault(s => s.Id == id) ?? throw new StudioException($"Unknown engine {id}.");

    static string Container(EngineSpec e) => "code-dojo-db-" + e.Id;
    static string Volume(EngineSpec e) => "code-dojo-db-" + e.Id + "-data";

    sealed class Job { public string Status = "starting"; public readonly List<string> Log = []; public string? Error; }
    readonly Dictionary<string, Job> _jobs = [];
    List<string>? _images;

    /// <summary>Use a locally present image of the engine when there is one (no download), else the default tag.</summary>
    string ImageFor(EngineSpec e)
    {
        var local = (_images ?? []).Where(i => i.StartsWith(e.Repo + ":", StringComparison.Ordinal) && !i.EndsWith(":<none>")).ToList();
        var preferred = e.Repo + ":" + e.DefaultTag;
        if (local.Contains(preferred) || local.Count == 0) return preferred;
        return local.OrderByDescending(i => i).First();
    }

    string Password(EngineSpec e)
    {
        lock (_lock)
        {
            var state = File.Exists(_stateFile) ? JsonNode.Parse(File.ReadAllText(_stateFile)) as JsonObject ?? [] : [];
            if ((string?)state[e.Id]?["password"] is { Length: > 0 } pw) return pw;
            // Letters and digits only (safe in every connection string), with each class present for SQL Server's policy.
            const string chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            var fresh = "Dj" + new string(RandomNumberGenerator.GetItems<char>(chars, 22)) + "7q";
            state[e.Id] = new JsonObject { ["password"] = fresh };
            Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
            File.WriteAllText(_stateFile, state.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            return fresh;
        }
    }

    public async Task<object> Engines()
    {
        var info = await NetLabs.Docker(["info", "--format", "{{.ServerVersion}}"], TimeSpan.FromSeconds(15));
        if (!info.Ok)
            return new
            {
                docker = false,
                message = info.Code == 127 ? "Docker is not installed. Install Docker Desktop to run PostgreSQL, SQL Server and MySQL here; SQLite works without it."
                    : info.Code == 124 ? "Docker did not answer in time. If Docker Desktop is starting, wait a moment and refresh."
                    : "Docker Desktop is not running. Start it to run PostgreSQL, SQL Server and MySQL here; SQLite works without it.",
                engines = Array.Empty<object>(),
            };
        var images = await NetLabs.Docker(["images", "--format", "{{.Repository}}:{{.Tag}}"], TimeSpan.FromSeconds(15));
        _images = images.Out.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        var ps = await NetLabs.Docker(["ps", "-a", "--filter", "label=code-dojo=db", "--format", "{{.Names}}\t{{.State}}\t{{.Image}}"], TimeSpan.FromSeconds(15));
        var states = ps.Out.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim().Split('\t')).Where(p => p.Length >= 3).ToDictionary(p => p[0], p => (State: p[1], Image: p[2]));
        return new
        {
            docker = true, version = info.Out.Trim(),
            engines = Specs.Select(e =>
            {
                states.TryGetValue(Container(e), out var c);
                Job? job;
                lock (_lock) _jobs.TryGetValue(e.Id, out job);
                var image = c.Image ?? ImageFor(e);
                var status = job is { Status: "starting" } ? "starting" : c.State switch { "running" => job?.Status == "failed" ? "failed" : "running", null => job?.Status == "failed" ? "failed" : "absent", _ => "stopped" };
                List<string> log;
                lock (_lock) log = job?.Log.TakeLast(12).ToList() ?? [];
                return new
                {
                    id = e.Id, name = e.Name, image, imagePresent = _images.Contains(image), size = e.Size, note = e.Note,
                    port = e.Port, status, container = Container(e), volume = Volume(e), log, error = job?.Error,
                    user = e.Id switch { "postgres" => "postgres", "sqlserver" => "sa", _ => "root" },
                };
            }),
        };
    }

    /// <summary>Start (and if needed pull and create) the container in the background; poll Engines() for progress.</summary>
    public object Start(string id)
    {
        var e = Engine(id)!;
        Job job;
        lock (_lock)
        {
            if (_jobs.TryGetValue(id, out var running) && running.Status == "starting") return new { started = true };
            _jobs[id] = job = new Job();
        }
        void Log(string line) { lock (_lock) { job.Log.Add(line.Length > 200 ? line[..200] : line); if (job.Log.Count > 200) job.Log.RemoveAt(0); } }
        _ = Task.Run(async () =>
        {
            try
            {
                var exists = await NetLabs.Docker(["container", "inspect", Container(e)], TimeSpan.FromSeconds(20));
                if (exists.Ok)
                {
                    Log($"Starting the existing {e.Name} container…");
                    var s = await NetLabs.Docker(["start", Container(e)], TimeSpan.FromMinutes(2));
                    if (!s.Ok) throw new StudioException(s.Err.Trim());
                }
                else
                {
                    var image = ImageFor(e);
                    var have = await NetLabs.Docker(["image", "inspect", image], TimeSpan.FromSeconds(20));
                    if (!have.Ok)
                    {
                        Log($"Downloading {image} ({e.Size}). This happens once.");
                        var pull = await NetLabs.Docker(["pull", image], TimeSpan.FromMinutes(40), onLine: l => { if (!l.Contains("Waiting") && !l.Contains("Downloading") && !l.Contains("Extracting")) Log(l); });
                        if (!pull.Ok) throw new StudioException("Download failed: " + pull.Err.Trim());
                    }
                    var pw = Password(e);
                    var args = new List<string> { "run", "-d", "--name", Container(e), "--label", "code-dojo=db", "-p", $"127.0.0.1:{e.Port}:{e.Inner}" };
                    switch (e.Id)
                    {
                        case "postgres":
                            // PostgreSQL 18+ images keep data under /var/lib/postgresql/<major>; older ones under .../data.
                            var tag = image[(image.LastIndexOf(':') + 1)..];
                            var major = int.TryParse(new string(tag.TakeWhile(char.IsDigit).ToArray()), out var m) ? m : 99;
                            args.AddRange(["-v", $"{Volume(e)}:{(major >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data")}", "-e", "POSTGRES_PASSWORD=" + pw, "-e", "POSTGRES_DB=" + e.DefaultDb]);
                            break;
                        case "sqlserver":
                            args.AddRange(["-v", $"{Volume(e)}:/var/opt/mssql", "-e", "ACCEPT_EULA=Y", "-e", "MSSQL_SA_PASSWORD=" + pw, "-e", "MSSQL_PID=Developer"]);
                            break;
                        default:
                            args.AddRange(["-v", $"{Volume(e)}:/var/lib/mysql", "-e", "MYSQL_ROOT_PASSWORD=" + pw, "-e", "MYSQL_DATABASE=" + e.DefaultDb]);
                            break;
                    }
                    args.Add(image);
                    Log($"Creating the {e.Name} container (data volume {Volume(e)}, port 127.0.0.1:{e.Port})…");
                    var run = await NetLabs.Docker(args, TimeSpan.FromMinutes(3));
                    if (!run.Ok) throw new StudioException(run.Err.Trim());
                }
                Log($"Waiting for {e.Name} to accept connections (the first start can take a minute)…");
                var until = DateTime.UtcNow.AddMinutes(3);
                string? last = null;
                while (DateTime.UtcNow < until)
                {
                    try
                    {
                        await using var c = await OpenServer(e, null);
                        if (e.Id == "sqlserver") await Exec(c, $"IF DB_ID('{e.DefaultDb}') IS NULL CREATE DATABASE [{e.DefaultDb}]");
                        Log($"{e.Name} is ready.");
                        lock (_lock) job.Status = "running";
                        return;
                    }
                    catch (Exception ex) when (ex is DbException or InvalidOperationException or IOException or TimeoutException)
                    { last = ex.Message; await Task.Delay(2000); }
                }
                throw new StudioException($"{e.Name} did not accept connections in time: {last}");
            }
            catch (Exception ex)
            {
                Log("Failed: " + ex.Message);
                lock (_lock) { job.Status = "failed"; job.Error = ex.Message; }
            }
        });
        return new { started = true };
    }

    public async Task<object> Stop(string id)
    {
        var e = Engine(id)!;
        var r = await NetLabs.Docker(["stop", Container(e)], TimeSpan.FromMinutes(2));
        lock (_lock) _jobs.Remove(id);
        return new { stopped = r.Ok, message = r.Ok ? "" : r.Err.Trim() };
    }

    string ConnectionString(EngineSpec e, string? db)
    {
        var pw = Password(e);
        if (db is not null) CheckName(db);
        return e.Id switch
        {
            "postgres" => $"Host=127.0.0.1;Port={e.Port};Username=postgres;Password={pw};Database={db ?? e.DefaultDb};Timeout=5;Command Timeout={ServerTimeoutSeconds};Pooling=false",
            "sqlserver" => $"Server=127.0.0.1,{e.Port};User ID=sa;Password={pw};Database={db ?? "master"};TrustServerCertificate=True;Encrypt=False;Connect Timeout=5;Pooling=false",
            _ => $"Server=127.0.0.1;Port={e.Port};User ID=root;Password={pw};Database={db ?? e.DefaultDb};Pooling=false;Connection Timeout=5;Default Command Timeout={ServerTimeoutSeconds};AllowUserVariables=true",
        };
    }

    async Task<DbConnection> OpenServer(EngineSpec e, string? db)
    {
        DbConnection c = e.Id switch
        {
            "postgres" => new Npgsql.NpgsqlConnection(ConnectionString(e, db)),
            "sqlserver" => new Microsoft.Data.SqlClient.SqlConnection(ConnectionString(e, db)),
            _ => new MySqlConnector.MySqlConnection(ConnectionString(e, db)),
        };
        try { await c.OpenAsync(); }
        catch { await c.DisposeAsync(); throw; }
        return c;
    }

    async Task<DbConnection> Connect(EngineSpec e, string? db)
    {
        try { return await OpenServer(e, db); }
        catch (Exception ex) when (ex is DbException or InvalidOperationException or IOException or TimeoutException)
        { throw new StudioException($"Cannot connect to {e.Name}: {ex.Message} Is it started?"); }
    }

    static async Task Exec(DbConnection c, string sql)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = ServerTimeoutSeconds;
        await cmd.ExecuteNonQueryAsync();
    }

    static async Task<List<object?[]>> Rows(DbConnection c, string sql)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = ServerTimeoutSeconds;
        await using var r = await cmd.ExecuteReaderAsync();
        var rows = new List<object?[]>();
        while (await r.ReadAsync()) { var row = new object?[r.FieldCount]; for (var i = 0; i < row.Length; i++) row[i] = r.IsDBNull(i) ? null : r.GetValue(i); rows.Add(row); }
        return rows;
    }

    public async Task<object> ServerDatabases(string id)
    {
        var e = Engine(id)!;
        await using var c = await Connect(e, null);
        var sql = e.Id switch
        {
            "postgres" => "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
            "sqlserver" => "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name",
            _ => "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY schema_name",
        };
        return new { databases = (await Rows(c, sql)).Select(r => r[0]?.ToString()).Where(n => n is not null && SafeName().IsMatch(n)) };
    }

    public async Task CreateServerDatabase(string id, string name)
    {
        var e = Engine(id)!;
        CheckName(name);
        await using var c = await Connect(e, null);
        try
        {
            await Exec(c, e.Id switch { "postgres" => $"CREATE DATABASE \"{name}\"", "sqlserver" => $"CREATE DATABASE [{name}]", _ => $"CREATE DATABASE `{name}`" });
        }
        catch (DbException ex) { throw new StudioException(ex.Message); }
    }

    /// <summary>The 1-based line, within a batch, of the error Postgres reports.</summary>
    static int PgLine(string batch, Npgsql.PostgresException pe)
    {
        var stmt = pe.BatchCommand?.CommandText;
        if (stmt is { Length: > 0 } && batch.IndexOf(stmt.Trim(), StringComparison.Ordinal) is var start and >= 0 && pe.Position > 0)
            return batch.AsSpan(0, Math.Min(batch.Length, start + pe.Position - 1)).Count('\n') + 1;
        // A plain multi-statement command does not say which statement failed: find the name the message quotes.
        if (Regex.Match(pe.MessageText, "\"([^\"]+)\"") is { Success: true } m)
        {
            var name = m.Groups[1].Value;
            var at = Regex.Match(batch, $@"(?<![\w""]){Regex.Escape(name)}(?![\w""])|""{Regex.Escape(name)}""", RegexOptions.IgnoreCase);
            if (at.Success) return batch.AsSpan(0, at.Index).Count('\n') + 1;
        }
        return 1;
    }

    static string Show(object? v) => v switch
    {
        null => "NULL",
        DateOnly d => d.ToString("yyyy-MM-dd", Inv),
        TimeOnly t => t.ToString("HH:mm:ss.FFF", Inv),
        TimeSpan t => t.ToString("c", Inv),
        DateTime d => d.TimeOfDay == TimeSpan.Zero ? d.ToString("yyyy-MM-dd", Inv) : d.ToString("yyyy-MM-dd HH:mm:ss.FFF", Inv),
        DateTimeOffset d => d.ToString("yyyy-MM-dd HH:mm:ss.FFF zzz", Inv),
        bool b => b ? "true" : "false",
        byte[] b => "0x" + Convert.ToHexString(b.Length > 64 ? b[..64] : b) + (b.Length > 64 ? "…" : ""),
        double d => d.ToString("R", Inv),
        float f => f.ToString("R", Inv),
        _ => Convert.ToString(v, Inv) ?? "",
    };

    async Task<object> ServerQuery(EngineSpec e, string? db, string sql, bool explain)
    {
        await using var c = await Connect(e, db);
        var started = System.Diagnostics.Stopwatch.StartNew();
        // SQL Server tools split scripts into batches on GO lines; do the same.
        var batches = e.Id == "sqlserver" ? Regex.Split(sql, @"^\s*GO\s*;?\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase).Where(b => b.Trim().Length > 0).ToList() : [sql];
        var lineOffsets = new List<int>();
        { var at = 0; foreach (var b in batches) { var i = sql.IndexOf(b, at, StringComparison.Ordinal); lineOffsets.Add(i < 0 ? 0 : sql.AsSpan(0, i).Count('\n')); at = Math.Max(at, i); } }
        if (explain)
        {
            var last = batches[^1];
            batches = e.Id switch
            {
                "postgres" => ["EXPLAIN " + last],
                "mysql" => ["EXPLAIN FORMAT=TREE " + last],
                _ => ["SET SHOWPLAN_TEXT ON", last],
            };
            lineOffsets = [.. batches.Select(_ => 0)];
        }
        var grids = new List<Grid>();
        var messages = new List<string>();
        for (var bi = 0; bi < batches.Count; bi++)
        {
            try
            {
                await using var cmd = c.CreateCommand();
                cmd.CommandText = batches[bi];
                cmd.CommandTimeout = ServerTimeoutSeconds;
                var t = System.Diagnostics.Stopwatch.StartNew();
                await using var r = await cmd.ExecuteReaderAsync();
                do
                {
                    if (r.FieldCount == 0) continue;
                    var cols = Enumerable.Range(0, r.FieldCount).Select(r.GetName).ToList();
                    var types = Enumerable.Range(0, r.FieldCount).Select(i => { try { return r.GetDataTypeName(i); } catch { return ""; } }).ToList();
                    var rows = new List<string?[]>();
                    var truncated = false;
                    while (await r.ReadAsync())
                    {
                        if (rows.Count >= MaxRows) { truncated = true; break; }
                        var row = new string?[r.FieldCount];
                        for (var i = 0; i < row.Length; i++) row[i] = r.IsDBNull(i) ? null : Show(r.GetValue(i));
                        rows.Add(row);
                    }
                    grids.Add(new(cols, types, rows, truncated, 0, t.ElapsedMilliseconds));   // line unknown: the server runs the batch as a whole
                    if (truncated) break;
                } while (await r.NextResultAsync());
                await r.DisposeAsync();
                if (r.RecordsAffected > 0) messages.Add($"{r.RecordsAffected} row{(r.RecordsAffected == 1 ? "" : "s")} changed.");
            }
            catch (Exception ex) when (ex is DbException or InvalidOperationException)
            {
                var line = lineOffsets[bi] + (ex switch
                {
                    // Npgsql splits a batch into statements; Position counts from the start of the failing one.
                    Npgsql.PostgresException pe => PgLine(batches[bi], pe),
                    Microsoft.Data.SqlClient.SqlException se => Math.Max(1, se.LineNumber),
                    _ => 1,
                });
                var message = ex is Npgsql.PostgresException p ? p.MessageText + (p.Hint is { Length: > 0 } hint ? " Hint: " + hint : "") : ex.Message;
                var timedOut = ex.Message.Contains("timeout", StringComparison.OrdinalIgnoreCase);
                if (explain && e.Id == "sqlserver") { try { await Exec(c, "SET SHOWPLAN_TEXT OFF"); } catch { } }
                return new { results = grids, messages, error = $"Line {line}: {message}", errorLine = line, timedOut, ms = started.ElapsedMilliseconds };
            }
        }
        if (explain && e.Id == "sqlserver") { try { await Exec(c, "SET SHOWPLAN_TEXT OFF"); } catch { } }
        return new { results = grids, messages, error = (string?)null, errorLine = 0, timedOut = false, ms = started.ElapsedMilliseconds, explained = explain };
    }

    async Task<List<Table>> ServerSchema(EngineSpec e, string? db)
    {
        await using var c = await Connect(e, db);
        var (scope, deflt) = e.Id switch
        {
            "postgres" => ("t.table_schema NOT IN ('pg_catalog', 'information_schema')", "public"),
            "sqlserver" => ("t.table_catalog = DB_NAME()", "dbo"),
            _ => ("t.table_schema = DATABASE()", ""),
        };
        string Key(object? schema, object? name) => e.Id == "mysql" || schema?.ToString() == deflt ? name?.ToString() ?? "" : $"{schema}.{name}";
        var tables = (await Rows(c, $"SELECT t.table_schema, t.table_name, t.table_type FROM information_schema.tables t WHERE {scope} ORDER BY t.table_type, t.table_schema, t.table_name"))
            .Select(r => (Key: Key(r[0], r[1]), Kind: r[2]?.ToString()?.Contains("VIEW") == true ? "view" : "table")).ToList();
        var cols = await Rows(c, $"SELECT t.table_schema, t.table_name, t.column_name, t.data_type, t.is_nullable, t.column_default FROM information_schema.columns t WHERE {scope} ORDER BY t.table_schema, t.table_name, t.ordinal_position");
        var pks = (await Rows(c, $"SELECT t.table_schema, t.table_name, k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON k.constraint_name = t.constraint_name AND k.table_schema = t.table_schema AND k.table_name = t.table_name WHERE t.constraint_type = 'PRIMARY KEY' AND {scope}"))
            .Select(r => Key(r[0], r[1]) + "\u001f" + r[2]).ToHashSet();
        var fkSql = e.Id switch
        {
            "postgres" => "SELECT n.nspname, cl.relname, a.attname, fn.nspname, fc.relname, af.attname FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace JOIN pg_class fc ON fc.oid = c.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(col, fcol) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.fcol WHERE c.contype = 'f'",
            "sqlserver" => "SELECT OBJECT_SCHEMA_NAME(fk.parent_object_id), OBJECT_NAME(fk.parent_object_id), COL_NAME(fkc.parent_object_id, fkc.parent_column_id), OBJECT_SCHEMA_NAME(fk.referenced_object_id), OBJECT_NAME(fk.referenced_object_id), COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id",
            _ => "SELECT table_schema, table_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL",
        };
        var fks = await Rows(c, fkSql);
        var idxSql = e.Id switch
        {
            "postgres" => "SELECT schemaname, tablename, indexname, indexdef LIKE 'CREATE UNIQUE%', substring(indexdef from '\\((.*)\\)') FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
            "sqlserver" => "SELECT OBJECT_SCHEMA_NAME(i.object_id), OBJECT_NAME(i.object_id), i.name, i.is_unique, STRING_AGG(col.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id WHERE i.name IS NOT NULL AND OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1 GROUP BY i.object_id, i.name, i.is_unique",
            _ => "SELECT table_schema, table_name, index_name, MIN(non_unique) = 0, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') FROM information_schema.statistics WHERE table_schema = DATABASE() GROUP BY table_schema, table_name, index_name",
        };
        var idx = await Rows(c, idxSql);
        return tables.Select(t => new Table(t.Key, t.Kind,
            cols.Where(r => Key(r[0], r[1]) == t.Key).Select(r => new Column(r[2]?.ToString() ?? "", r[3]?.ToString() ?? "", r[4]?.ToString() == "NO", pks.Contains(t.Key + "\u001f" + r[2]), r[5]?.ToString())).ToList(),
            fks.Where(r => Key(r[0], r[1]) == t.Key).Select(r => new ForeignKey(r[2]?.ToString() ?? "", Key(r[3], r[4]), r[5]?.ToString() ?? "")).ToList(),
            idx.Where(r => Key(r[0], r[1]) == t.Key).Select(r => new Index(r[2]?.ToString() ?? "", Convert.ToBoolean(r[3]), r[4]?.ToString() ?? "")).ToList(),
            null, null)).ToList();
    }

    // ---------------------------------------------------------------- sample databases

    static readonly Dictionary<string, Action<SqliteConnection, Random>> Samples = new()
    {
        ["bookshop"] = SampleData.Bookshop,
        ["company"] = SampleData.Company,
        ["movies"] = SampleData.Movies,
    };

    /// <summary>Made once, the first time the studio opens (a marker file remembers); force rebuilds missing ones.</summary>
    public void MakeSamples(bool force)
    {
        lock (_lock)
        {
            Directory.CreateDirectory(Dir);
            var marker = Path.Combine(Dir, ".samples-made");
            if (!force && File.Exists(marker)) return;
            foreach (var (name, build) in Samples)
            {
                var path = PathOf(name);
                if (File.Exists(path)) continue;
                var tmp = path + ".tmp";
                if (File.Exists(tmp)) File.Delete(tmp);
                using (var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = tmp, Pooling = false }.ToString()))
                {
                    c.Open();
                    using var tx = c.BeginTransaction();
                    build(c, new Random(42));
                    tx.Commit();
                }
                File.Move(tmp, path);
            }
            File.WriteAllText(marker, "Sample databases were created here once. Delete this file to have missing samples made again.\n");
        }
    }
}
