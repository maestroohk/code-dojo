using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

public class DebuggerTests
{
    static readonly string Dotnet = new CSharpRunner().DotnetPath;

    static Task<CodeDebugger.Result> Debug(params (string Path, string Code)[] files) => Debug(null, files);

    static Task<CodeDebugger.Result> Debug(List<CodeDebugger.Breakpoint>? bps, params (string Path, string Code)[] files) =>
        CodeDebugger.Run(Dotnet, new CodeDebugger.Input
        {
            Files = files.Select(f => new CodeDebugger.SourceFile(f.Path, f.Code)).ToList(),
            GlobalUsings = CodeDebugger.DefaultImplicitUsings,
            Breakpoints = bps,
        });

    static List<JsonObject> Steps(CodeDebugger.Result r) => r.Events.OfType<JsonObject>().Where(e => e["k"] is null).ToList();
    static string FileOf(CodeDebugger.Result r, JsonObject e) => r.Files[(int)e["f"]!];
    static JsonArray Frames(CodeDebugger.Result r, JsonObject e) => r.Stacks[(int)e["s"]!]!.AsArray();
    static JsonObject? Var(CodeDebugger.Result r, JsonObject e, string name) =>
        e["v"]!.AsArray().Select(id => r.Values[(int)id!]!.AsObject()).FirstOrDefault(v => (string?)v["n"] == name);

    const string Program = """
        using Shop;

        var cart = new Cart();
        cart.Add(new Item("pen", 2));
        cart.Add(new Item("book", 10));
        var total = cart.Total();
        Console.WriteLine($"Total: {total}");
        """;

    const string CartFile = """
        namespace Shop;

        public record Item(string Name, int Price);

        public class Cart
        {
            readonly List<Item> _items = new();
            public int Count => _items.Count;

            public void Add(Item item)
            {
                _items.Add(item);
            }

            public int Total()
            {
                var sum = 0;
                foreach (var i in _items)
                    sum += i.Price;
                return sum;
            }
        }
        """;

    [Fact]
    public async Task Steps_through_several_files_with_file_and_line()
    {
        var r = await Debug(("App/Program.cs", Program), ("App/Shop/Cart.cs", CartFile));
        Assert.True(r.Error is null, r.Error + string.Join("\n", r.Diagnostics.Select(d => d.Message)) + string.Join("\n", r.Notes));
        var steps = Steps(r);
        Assert.Contains(steps, e => FileOf(r, e) == "App/Program.cs" && (int)e["l"]! == 3);
        Assert.Contains(steps, e => FileOf(r, e) == "App/Shop/Cart.cs" && (int)e["l"]! == 12);   // _items.Add(item)
        Assert.Contains(steps, e => FileOf(r, e) == "App/Shop/Cart.cs" && (int)e["l"]! == 19);   // sum += i.Price
        Assert.Equal("Total: 12", r.Output.Trim());
        Assert.Null(r.Exception);
        // The return line in Total sees sum = 12, and "this" shows the cart's list.
        var ret = steps.Last(e => FileOf(r, e) == "App/Shop/Cart.cs" && (int)e["l"]! == 20);
        Assert.Equal("12", (string)Var(r, ret, "sum")!["t"]!);
        var self = Var(r, ret, "this")!;
        var items = self["props"]!.AsArray().First(p => (string?)p!["n"] == "_items")!;
        Assert.Contains("pen", (string)items["t"]!);
    }

    [Fact]
    public async Task Frames_carry_method_file_and_line_across_files()
    {
        var r = await Debug(("App/Program.cs", Program), ("App/Shop/Cart.cs", CartFile));
        Assert.Null(r.Error);
        var inAdd = Steps(r).First(e => (int)e["l"]! == 12);
        var frames = Frames(r, inAdd);
        Assert.Equal(2, frames.Count);
        Assert.Equal("top level", (string)frames[0]!["m"]!);
        Assert.Equal("App/Program.cs", r.Files[(int)frames[0]!["f"]!]);
        Assert.Equal(4, (int)frames[0]!["l"]!);                     // the call site: cart.Add(new Item("pen", 2))
        Assert.Equal("Cart.Add", (string)frames[1]!["m"]!);
        Assert.Equal("App/Shop/Cart.cs", r.Files[(int)frames[1]!["f"]!]);
        // An expression-bodied member gets a stop of its own.
        var r2 = await Debug(("P.cs", "var c = new C();\nConsole.WriteLine(c.Twice(4));\nclass C\n{\n    public int Twice(int x) => x * 2;\n}"));
        Assert.Null(r2.Error);
        var twice = Steps(r2).Single(e => (int)e["l"]! == 5);
        Assert.Equal("4", (string)Var(r2, twice, "x")!["t"]!);
        Assert.Equal("C.Twice", (string)Frames(r2, twice)[^1]!["m"]!);
    }

    [Fact]
    public async Task Breakpoints_report_every_hit()
    {
        var r = await Debug([new("App/Shop/Cart.cs", 19), new("App/Program.cs", 7)], ("App/Program.cs", Program), ("App/Shop/Cart.cs", CartFile));
        Assert.Null(r.Error);
        var hits = r.Hits.Select(i => (JsonObject)r.Events[i]!).ToList();
        Assert.Equal(3, hits.Count);                                 // sum += twice, then the WriteLine
        Assert.Equal([19, 19, 7], hits.Select(e => (int)e["l"]!));
        Assert.Equal("10", (string)Var(r, hits[1], "i")!["props"]!.AsArray().First(p => (string?)p!["n"] == "Price")!["t"]!);
    }

    [Fact]
    public async Task Exceptions_are_recorded_where_they_were_thrown()
    {
        var r = await Debug(
            ("Program.cs", "var a = new Account();\na.Withdraw(5);\nConsole.WriteLine(\"unreachable\");"),
            ("Account.cs", "public class Account\n{\n    public int Balance { get; private set; }\n    public void Withdraw(int amount)\n    {\n        if (amount > Balance)\n            throw new InvalidOperationException(\"Not enough money\");\n        Balance -= amount;\n    }\n}"));
        Assert.Null(r.Error);
        Assert.NotNull(r.Exception);
        Assert.Equal("crash", (string)r.Exception!["k"]!);
        Assert.Equal("System.InvalidOperationException", (string)r.Exception["ty"]!);
        Assert.Equal("Not enough money", (string)r.Exception["msg"]!);
        Assert.Equal("Account.cs", r.Files[(int)r.Exception["f"]!]);
        Assert.Equal(7, (int)r.Exception["l"]!);
        Assert.Equal("Account.Withdraw", (string)r.Stacks[(int)r.Exception["s"]!]!.AsArray()[^1]!["m"]!);
        Assert.Contains(r.Events, e => (string?)e!["k"] == "throw");
    }

    [Fact]
    public async Task Caught_exceptions_do_not_count_as_a_crash()
    {
        var r = await Debug(("Program.cs", "try { throw new Exception(\"boom\"); }\ncatch (Exception e) { Console.WriteLine(e.Message); }"));
        Assert.Null(r.Error);
        Assert.Null(r.Exception);
        Assert.Contains(r.Events, e => (string?)e!["k"] == "throw" && (string?)e["msg"] == "boom");
        Assert.Equal("boom", r.Output.Trim());
    }

    [Fact]
    public async Task Collections_are_capped_and_counted()
    {
        var r = await Debug(("Program.cs", "var xs = Enumerable.Range(0, 500).ToList();\nvar d = new Dictionary<string, int> { [\"a\"] = 1 };\nConsole.WriteLine(xs.Count);"));
        Assert.Null(r.Error);
        var last = Steps(r).Last();
        var xs = Var(r, last, "xs")!;
        Assert.Equal(500, (int)xs["c"]!);
        Assert.Equal(30, xs["items"]!.AsArray().Count);
        Assert.Equal("List<int>", (string)xs["ty"]!);
        var d = Var(r, last, "d")!;
        Assert.Equal(["\"a\""], d["keys"]!.AsArray().Select(k => (string)k!));
    }

    [Fact]
    public async Task Long_runs_stop_at_the_step_cap()
    {
        var r = await CodeDebugger.Run(Dotnet, new CodeDebugger.Input
        {
            Files = [new("Program.cs", "var i = 0;\nwhile (true) { i++; }")],
            GlobalUsings = CodeDebugger.DefaultImplicitUsings,
            MaxEvents = 1000,
        });
        Assert.True(r.Truncated);
        Assert.InRange(Steps(r).Count, 990, 1000);
    }

    [Fact]
    public async Task Compile_errors_come_back_with_files()
    {
        var r = await Debug(("Program.cs", "Console.WriteLine(new Thing().Name);"), ("Thing.cs", "class Thing { public string Name => missing; }"));
        Assert.NotNull(r.Error);
        Assert.Contains(r.Diagnostics, d => d.File == "Thing.cs" && d.Line == 1);
    }

    [Fact]
    public async Task Stdin_is_read()
    {
        var r = await CodeDebugger.Run(Dotnet, new CodeDebugger.Input
        {
            Files = [new("Program.cs", "var name = Console.ReadLine();\nConsole.WriteLine($\"Hi {name}\");")],
            GlobalUsings = CodeDebugger.DefaultImplicitUsings,
            Stdin = "Ada\n",
        });
        Assert.Null(r.Error);
        Assert.Equal("Hi Ada", r.Output.Trim());
        Assert.Equal("\"Ada\"", (string)Var(r, Steps(r).Last(), "name")!["t"]!);
    }

    [Fact]
    public async Task A_code_space_console_project_with_a_library_can_be_debugged()
    {
        var root = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "dbg-" + Guid.NewGuid().ToString("N")[..8]);
        using var spaces = new CodeSpaces(root, Dotnet);
        try
        {
            await spaces.Create(new("dbg", "empty"));
            var dir = Path.Combine(root, "dbg");
            Directory.CreateDirectory(Path.Combine(dir, "Lib"));
            Directory.CreateDirectory(Path.Combine(dir, "App"));
            File.WriteAllText(Path.Combine(dir, "Lib", "Lib.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>");
            File.WriteAllText(Path.Combine(dir, "Lib", "Greeter.cs"), "namespace Lib;\npublic class Greeter\n{\n    public string Greet(string n)\n    {\n        return $\"Hello, {n}!\";\n    }\n}");
            File.WriteAllText(Path.Combine(dir, "App", "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include=\"..\\Lib\\Lib.csproj\" /></ItemGroup></Project>");
            File.WriteAllText(Path.Combine(dir, "App", "Program.cs"), "var g = new Lib.Greeter();\nConsole.WriteLine(g.Greet(\"Ada\"));");

            var input = spaces.DebugInput("dbg", new(null, null, null, null), out var error);
            Assert.True(input is not null, error);
            Assert.Equal(["App/Program.cs", "Lib/Greeter.cs"], input!.Files.Select(f => f.Path).Order());
            var r = await CodeDebugger.Run(Dotnet, input);
            Assert.True(r.Error is null, r.Error + string.Join("\n", r.Diagnostics.Select(d => d.Message)));
            Assert.Contains(Steps(r), e => FileOf(r, e) == "Lib/Greeter.cs" && (int)e["l"]! == 6);
            Assert.Equal("Hello, Ada!", r.Output.Trim());
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }
}
