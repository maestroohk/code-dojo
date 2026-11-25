using System.Diagnostics;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// "framework": "efcore" steps: learner programs compile against EF Core + SQLite and run with the
/// assemblies and native SQLite loaded from the runner's cache. These start real processes.
/// </summary>
public class EfCoreRunnerTests
{
    static readonly CSharpRunner Runner = new();
    static readonly Checker Checker = new(Runner);

    /// <summary>A step written the way lesson files are, with the template as an array of lines.</summary>
    static JsonObject Step(string json)
    {
        var step = JsonNode.Parse(json)!.AsObject();
        if (step["template"] is JsonArray lines) step["template"] = string.Join('\n', lines.Select(l => (string)l!));
        return step;
    }

    static string Why(CheckResult r) => string.Join("\n", r.Tests.Select(t => $"{t.Name}: {t.Detail}")) + "\n" + r.Stderr;

    const string Library = """
        using var db = new LibraryDb();
        db.Database.EnsureCreated();

        var tolkien = new Author { Name = "Tolkien" };
        db.Authors.Add(tolkien);
        db.Books.AddRange(
            new Book { Title = "The Hobbit", Year = 1937, Author = tolkien },
            new Book { Title = "The Silmarillion", Year = 1977, Author = tolkien },
            new Book { Title = "Dune", Year = 1965, Author = new Author { Name = "Herbert" } });
        db.SaveChanges();

        db.ChangeTracker.Clear();
        var old = db.Books.Where(b => b.Year < 1970).OrderBy(b => b.Year).Select(b => b.Title).ToList();
        Console.WriteLine(string.Join(", ", old));

        foreach (var a in db.Authors.Include(a => a.Books).OrderBy(a => a.Name))
            Console.WriteLine($"{a.Name}: {a.Books.Count}");

        Console.WriteLine(db.Books.Where(b => b.Year > 1950).ToQueryString().Split('\n').Last().Trim());

        class Author
        {
            public int Id { get; set; }
            public string Name { get; set; } = "";
            public List<Book> Books { get; set; } = [];
        }

        class Book
        {
            public int Id { get; set; }
            [MaxLength(200)] public string Title { get; set; } = "";
            public int Year { get; set; }
            public int AuthorId { get; set; }
            public Author Author { get; set; } = null!;
        }

        class LibraryDb : DbContext
        {
            public DbSet<Author> Authors => Set<Author>();
            public DbSet<Book> Books => Set<Book>();
            protected override void OnConfiguring(DbContextOptionsBuilder options) => options.UseSqlite("Data Source=library.db");
        }
        """;

    [Fact]
    public void Framework_values_parse()
    {
        Assert.Equal((false, false), CSharpRunner.Frameworks(null));
        Assert.Equal((true, false), CSharpRunner.Frameworks("web"));
        Assert.Equal((false, true), CSharpRunner.Frameworks("efcore"));
        Assert.Equal((true, true), CSharpRunner.Frameworks("web+efcore"));
    }

    [Fact]
    public void Plain_steps_cannot_see_ef_core()
    {
        var (program, diags) = Runner.Compile(Library);
        Assert.Null(program);
        Assert.Contains(diags, d => d.Severity == "error");
    }

    [Fact]
    public async Task A_dbcontext_program_creates_inserts_and_queries_with_include()
    {
        var (program, diags) = Runner.Compile(Library, efCore: true);
        Assert.True(program is not null, string.Join("\n", diags.Select(d => $"{d.Line}: {d.Message}")));
        using (program)
        {
            var sw = Stopwatch.StartNew();
            var run = await Runner.Run(program!, null);
            Assert.True(run.ExitCode == 0, run.Stderr);
            Assert.Equal("""
                The Hobbit, Dune
                Herbert: 1
                Tolkien: 2
                WHERE "b"."Year" > 1950
                """.ReplaceLineEndings("\n"), run.Stdout.TrimEnd());
            Assert.True(sw.ElapsedMilliseconds < 15000);
        }
    }

    [Fact]
    public async Task In_memory_sqlite_with_an_open_connection_works()
    {
        const string code = """
            using var conn = new SqliteConnection("Data Source=:memory:");
            conn.Open();
            var options = new DbContextOptionsBuilder<Shop>().UseSqlite(conn).Options;
            using (var db = new Shop(options)) { db.Database.EnsureCreated(); db.Items.Add(new Item { Name = "pen", Price = 1.5m }); db.SaveChanges(); }
            using (var db = new Shop(options))
            {
                var n = db.Items.Where(i => i.Name == "pen").ExecuteUpdate(s => s.SetProperty(i => i.Price, i => i.Price * 2));
                Console.WriteLine($"{n} {db.Items.AsNoTracking().Single().Price}");
            }
            class Item { public int Id { get; set; } public string Name { get; set; } = ""; public decimal Price { get; set; } }
            class Shop(DbContextOptions<Shop> options) : DbContext(options) { public DbSet<Item> Items => Set<Item>(); }
            """;
        var (program, diags) = Runner.Compile(code, efCore: true);
        Assert.True(program is not null, string.Join("\n", diags.Select(d => $"{d.Line}: {d.Message}")));
        using (program)
        {
            var run = await Runner.Run(program!, null);
            Assert.True(run.ExitCode == 0, run.Stderr);
            Assert.Equal("1 3.0", run.Stdout.Trim());
        }
    }

    [Fact]
    public async Task An_efcore_step_with_a_template_is_graded()
    {
        var step = Step("""
            { "type": "code", "framework": "efcore", "template": [
              "using var dojoDb = new NotesDb();",
              "dojoDb.Database.EnsureDeleted();",
              "dojoDb.Database.EnsureCreated();",
              "dojoDb.Add(new Note { Text = \"a\" }); dojoDb.Add(new Note { Text = \"bb\" }); dojoDb.SaveChanges();",
              "Dojo.Eq(\"Longest(db) is bb\", \"bb\", Longest(dojoDb));",
              "{{CODE}}" ] }
            """);
        const string code = """
            string Longest(NotesDb db) => db.Notes.OrderByDescending(n => n.Text.Length).Select(n => n.Text).First();
            class Note { public int Id { get; set; } public string Text { get; set; } = ""; }
            class NotesDb : DbContext
            {
                public DbSet<Note> Notes => Set<Note>();
                protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=notes.db");
            }
            """;
        var r = await Checker.Check(step, code);
        Assert.True(r.Passed, Why(r));
    }

    [Fact]
    public async Task A_web_plus_efcore_step_serves_data_from_sqlite()
    {
        var step = Step("""
            { "type": "code", "framework": "web+efcore", "template": [
              "{{CODE}}",
              "static class DojoTests",
              "{",
              "    public static async Task Run(HttpClient http)",
              "    {",
              "        var post = await http.PostAsJsonAsync(\"/books\", new { title = \"Dune\" });",
              "        DojoWeb.Status(\"POST /books responds 201\", 201, post);",
              "        var list = await DojoWeb.Json(await http.GetAsync(\"/books\"));",
              "        Dojo.Eq(\"GET /books lists it\", \"Dune\", DojoWeb.Prop(list[0], \"title\"));",
              "    }",
              "}" ] }
            """);
        const string code = """
            var builder = WebApplication.CreateBuilder(args);
            builder.Services.AddDbContext<LibraryDb>(o => o.UseSqlite("Data Source=library.db"));
            var app = builder.Build();
            using (var scope = app.Services.CreateScope())
                scope.ServiceProvider.GetRequiredService<LibraryDb>().Database.EnsureCreated();

            app.MapGet("/books", (LibraryDb db) => db.Books.AsNoTracking().OrderBy(b => b.Id).ToList());
            app.MapPost("/books", async (Book book, LibraryDb db) =>
            {
                db.Books.Add(book);
                await db.SaveChangesAsync();
                return Results.Created($"/books/{book.Id}", book);
            });
            app.Run();

            class Book { public int Id { get; set; } public string Title { get; set; } = ""; }
            class LibraryDb(DbContextOptions<LibraryDb> options) : DbContext(options) { public DbSet<Book> Books => Set<Book>(); }
            """;
        var r = await Checker.Check(step, code);
        Assert.True(r.Passed, Why(r));
        Assert.Equal(2, r.Tests.Count);
    }

    [Fact]
    public void Code_intelligence_knows_ef_core()
    {
        const string code = "class Db : DbContext { void M() { Database. } }";
        var at = code.IndexOf("Database.", StringComparison.Ordinal) + "Database.".Length;
        var r = CodeIntel.Run(Runner, new("complete", [new("Program.cs", code)], "Program.cs", at, null));
        Assert.Contains(r.Items!, i => i.Label == "EnsureCreated");
    }
}
