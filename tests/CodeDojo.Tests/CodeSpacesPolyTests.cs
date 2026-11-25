using System.Net.Http;
using System.Text.Json;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Python and Node code spaces (server/CodeSpaces.Poly.cs). Network tests return early when offline.</summary>
public class CodeSpacesPolyTests
{
    static string NewRoot(string what) => Path.Combine(Path.GetTempPath(), "code-dojo-tests", $"{what}-{Guid.NewGuid():N}"[..(what.Length + 9)]);
    static readonly string Dir = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "poly-space"));

    // ---------------------------------------------------------------- kind detection

    [Theory]
    [InlineData("requirements.txt", "python")]
    [InlineData("pyproject.toml", "python")]
    [InlineData("setup.py", "python")]
    [InlineData("package.json", "node")]
    [InlineData("App.csproj", "dotnet")]
    [InlineData("Shop.sln", "dotnet")]
    [InlineData("main.py", "python")]
    [InlineData("index.ts", "node")]
    [InlineData("Program.cs", "dotnet")]
    public void Detects_the_kind_from_files(string file, string kind)
    {
        var dir = NewRoot("kind");
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, file), file.EndsWith(".json") ? "{}" : "");
            Assert.Equal(kind, CodeSpaces.DetectKind(dir));
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void A_csproj_wins_over_a_package_json_and_an_empty_folder_is_dotnet()
    {
        var dir = NewRoot("kind");
        Directory.CreateDirectory(dir);
        try
        {
            Assert.Equal("dotnet", CodeSpaces.DetectKind(dir));
            File.WriteAllText(Path.Combine(dir, "package.json"), "{}");
            Assert.Equal("node", CodeSpaces.DetectKind(dir));
            File.WriteAllText(Path.Combine(dir, "Web.csproj"), "<Project/>");
            Assert.Equal("dotnet", CodeSpaces.DetectKind(dir));
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Templates_cover_every_kind()
    {
        Assert.Contains(CodeSpaces.Templates, t => t.Kind == "python" && t.Id == "py-package");
        Assert.Contains(CodeSpaces.Templates, t => t.Kind == "node" && t.Id == "node-next");
        Assert.Contains(CodeSpaces.Templates, t => t.Kind == "dotnet" && t.Id == "console");
        Assert.Equal(CodeSpaces.Templates.Length, CodeSpaces.Templates.Select(t => t.Id).Distinct().Count());
    }

    // ---------------------------------------------------------------- validation

    [Theory]
    [InlineData("requests", true)]
    [InlineData("python-dateutil", true)]
    [InlineData("Django", true)]
    [InlineData("zope.interface", true)]
    [InlineData("fastapi[standard]", true)]
    [InlineData("psycopg[binary,pool]", true)]
    [InlineData("a", true)]
    [InlineData("", false)]
    [InlineData("-r", false)]
    [InlineData("--index-url", false)]
    [InlineData("req uests", false)]
    [InlineData("requests==2.0", false)]
    [InlineData("pkg;rm", false)]
    [InlineData("https://evil/x.whl", false)]
    [InlineData("../local", false)]
    [InlineData("name-", false)]
    [InlineData("x[--extra]", false)]
    public void Validates_pip_names(string name, bool ok) => Assert.Equal(ok, CodeSpaces.ValidPipName(name));

    [Theory]
    [InlineData("2.32.3", true)]
    [InlineData("1.0", true)]
    [InlineData("3", true)]
    [InlineData("1.0rc1", true)]
    [InlineData("0.9.post2", true)]
    [InlineData(">=1.0", false)]
    [InlineData("1.0 --pre", false)]
    [InlineData("latest", false)]
    [InlineData("", false)]
    public void Validates_pip_versions(string v, bool ok) => Assert.Equal(ok, CodeSpaces.ValidPipVersion(v));

    [Theory]
    [InlineData("express", true)]
    [InlineData("@types/node", true)]
    [InlineData("@tailwindcss/postcss", true)]
    [InlineData("lodash.debounce", true)]
    [InlineData("react-dom", true)]
    [InlineData("Express", false)]
    [InlineData("-g", false)]
    [InlineData("--save", false)]
    [InlineData(".hidden", false)]
    [InlineData("a b", false)]
    [InlineData("git+https://x", false)]
    [InlineData("file:../x", false)]
    [InlineData("@scope", false)]
    [InlineData("x@1.0", false)]
    public void Validates_npm_names(string name, bool ok) => Assert.Equal(ok, CodeSpaces.ValidNpmName(name));

    [Theory]
    [InlineData("5.1.0", true)]
    [InlineData("^19.2.0", true)]
    [InlineData("~1.2", true)]
    [InlineData("1.0.0-beta.1", true)]
    [InlineData("latest", false)]
    [InlineData(">=1 <2", false)]
    [InlineData("1.0.0 --force", false)]
    public void Validates_npm_versions(string v, bool ok) => Assert.Equal(ok, CodeSpaces.ValidNpmVersion(v));

    // ---------------------------------------------------------------- requirements.txt

    [Fact]
    public void Reads_and_updates_requirements()
    {
        var text = "# my deps\nrequests==2.32.3\nPython_DateUtil>=2.8  # dates\n-r other.txt\nfastapi[standard]\n\n";
        var reqs = CodeSpaces.ReadRequirements(text);
        Assert.Equal([new("requests", "2.32.3"), new("Python_DateUtil", ">=2.8"), new CodeSpaces.Package("fastapi[standard]", null)], reqs);

        var pinned = CodeSpaces.UpdateRequirements(text, "python-dateutil", "2.9.0", false);
        Assert.Contains("python-dateutil==2.9.0", pinned);
        Assert.DoesNotContain("Python_DateUtil", pinned);
        Assert.Contains("# my deps", pinned);
        Assert.Contains("-r other.txt", pinned);

        Assert.Contains("fastapi[standard]==0.115.0", CodeSpaces.UpdateRequirements(text, "fastapi", "0.115.0", false));
        Assert.EndsWith("tabulate==0.9.0\n", CodeSpaces.UpdateRequirements(text, "tabulate", "0.9.0", false));
        var removed = CodeSpaces.UpdateRequirements(text, "REQUESTS", null, true);
        Assert.DoesNotContain("requests", removed);
        Assert.Equal("python-dateutil", CodeSpaces.NormalizePipName("Python_DateUtil"));
    }

    [Fact]
    public void Reads_npm_dependencies()
    {
        var deps = CodeSpaces.NpmDeps("""{ "dependencies": { "express": "^5.1.0" }, "devDependencies": { "@types/node": "^24" } }""");
        Assert.Equal([new("express", "^5.1.0", false), new CodeSpaces.NpmDep("@types/node", "^24", true)], deps);
        Assert.Empty(CodeSpaces.NpmDeps("not json"));
    }

    // ---------------------------------------------------------------- output parsing

    [Fact]
    public void Parses_a_python_traceback_to_the_deepest_frame_in_the_space()
    {
        var output = $"""
            Traceback (most recent call last):
              File "{Path.Combine(Dir, "main.py")}", line 3, in <module>
                f()
              File "{Path.Combine(Dir, "lib", "calc.py")}", line 7, in f
                return 1/0
              File "{Path.Combine(Dir, ".venv", "Lib", "site-packages", "x.py")}", line 99, in g
            ZeroDivisionError: division by zero
            """;
        var p = Assert.Single(CodeSpaces.ParseOutput("python", output, Dir));
        Assert.Equal(("ZeroDivisionError", "lib/calc.py", 7), (p.Code, p.File, p.Line));
        Assert.Equal("ZeroDivisionError: division by zero", p.Message);
    }

    [Fact]
    public void Parses_python_syntax_errors_and_ignores_frames_outside_the_space()
    {
        var syntax = $"  File \"{Path.Combine(Dir, "main.py")}\", line 2\n    print(\n         ^\nSyntaxError: '(' was never closed\n";
        var p = Assert.Single(CodeSpaces.ParseOutput("python", syntax, Dir));
        Assert.Equal(("SyntaxError", "main.py", 2), (p.Code, p.File, p.Line));

        var outside = "Traceback (most recent call last):\n  File \"<frozen runpy>\", line 198, in _run_module_as_main\n  File \"C:\\Python313\\Lib\\json\\__init__.py\", line 346, in loads\nValueError: nope\n";
        Assert.Empty(CodeSpaces.ParseOutput("python", outside, Dir));
        Assert.Empty(CodeSpaces.ParseOutput("python", "print('ValueError: just text')\nAll good\n", Dir));
    }

    [Fact]
    public void Parses_pytest_failures()
    {
        var output = """
            tests/test_stats.py::test_mean FAILED                                    [ 33%]
            tests/test_stats.py::test_median PASSED                                  [ 66%]

            ================================== FAILURES ===================================
            __________________________________ test_mean __________________________________
            tests\test_stats.py:7: in test_mean
                assert mean([1, 2, 3, 4]) == 3
            E   assert 2.5 == 3
            E    +  where 2.5 = mean([1, 2, 3, 4])
            ____________________________ TestCls.test_deep ________________________________
            tests\test_stats.py:20: in test_deep
                helper()
            demo\stats.py:4: in helper
                raise ValueError("bad")
            E   ValueError: bad
            =========================== short test summary info ===========================
            FAILED tests/test_stats.py::test_mean - assert 2.5 == 3
            FAILED tests/test_stats.py::TestCls::test_deep - ValueError: bad
            ERROR tests/test_broken.py - ModuleNotFoundError: No module named 'nope'
            ========================= 2 failed, 1 passed in 0.05s =========================
            """;
        var problems = CodeSpaces.ParseOutput("pytest", output, Dir);
        Assert.Equal(3, problems.Count);
        Assert.Equal(("tests/test_stats.py", 7), (problems[0].File, problems[0].Line));
        Assert.Equal("test_mean failed: assert 2.5 == 3", problems[0].Message);
        Assert.Equal(("demo/stats.py", 4), (problems[1].File, problems[1].Line));
        Assert.Contains("TestCls.test_deep failed", problems[1].Message);
        Assert.Equal("tests/test_broken.py", problems[2].File);
        Assert.Contains("could not be collected", problems[2].Message);
    }

    [Fact]
    public void Parses_node_errors_stack_traces_and_tsc_output()
    {
        var runtime = $"""
            {Path.Combine(Dir, "index.js")}:2
            foo();
            ^

            ReferenceError: foo is not defined
                at Object.<anonymous> ({Path.Combine(Dir, "index.js")}:2:1)
                at Module._compile (node:internal/modules/cjs/loader:1929:14)
            """;
        var p = Assert.Single(CodeSpaces.ParseOutput("node", runtime, Dir));
        Assert.Equal(("ReferenceError", "index.js", 2), (p.Code, p.File, p.Line));

        var url = new Uri(Path.Combine(Dir, "src", "math.test.ts")).AbsoluteUri;
        var test = $"""
            ✖ adds (1.0ms)
              AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
                  at TestContext.<anonymous> ({url}:3:24)
                  at Test.runInAsyncScope (node:async_hooks:227:14)
            """;
        var t = Assert.Single(CodeSpaces.ParseOutput("node", test, Dir));
        Assert.Equal(("ERR_ASSERTION", "src/math.test.ts", 3, 24), (t.Code, t.File, t.Line, t.Column));

        var tsc = $"{Path.Combine(Dir, "main.ts")}(4,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/x.ts:1:5 - error TS2304: Cannot find name 'y'.\n";
        var ts = CodeSpaces.ParseOutput("node", tsc, Dir);
        Assert.Equal(2, ts.Count);
        Assert.Equal(("TS2322", "main.ts", 4, 7), (ts[0].Code, ts[0].File, ts[0].Line, ts[0].Column));
        Assert.Equal(("TS2304", "src/x.ts", 1), (ts[1].Code, ts[1].File, ts[1].Line));

        // Frames in node_modules are not the learner's code.
        var lib = $"TypeError: x is not a function\n    at f ({Path.Combine(Dir, "node_modules", "lib", "index.js")}:1:1)\n";
        Assert.Empty(CodeSpaces.ParseOutput("node", lib, Dir));
    }

    // ---------------------------------------------------------------- end to end: Python

    static bool Online(string url)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
            return http.GetAsync(url).GetAwaiter().GetResult().IsSuccessStatusCode;
        }
        catch { return false; }
    }

    [Fact]
    public async Task Python_space_with_a_venv_a_pip_package_a_run_and_pytest()
    {
        if (CodeSpaces.BasePython() is null) return;          // no Python on this machine
        var root = NewRoot("py");
        using var spaces = new CodeSpaces(root, "dotnet");
        try
        {
            var created = await spaces.Create(new("calc", "py-package"));
            Assert.True(Ok(created), JsonSerializer.Serialize(created, Json));
            var dir = Path.Combine(root, "calc");
            Assert.True(File.Exists(CodeSpaces.VenvPython(dir)));
            Assert.Equal("python", CodeSpaces.DetectKind(dir));
            var detail = JsonSerializer.SerializeToElement(spaces.Detail("calc"), Json);
            Assert.Equal("python", detail.GetProperty("kind").GetString());
            Assert.Equal("main.py", detail.GetProperty("defaultEntry").GetString());
            Assert.DoesNotContain(detail.GetProperty("tree").EnumerateArray(), e => e.GetProperty("path").GetString()!.StartsWith(".venv"));

            // Run main.py: no packages needed.
            Assert.Equal("succeeded", await Finish(spaces, "calc", spaces.Run("calc", new(null))));
            Assert.Contains("mean   83.0", Lines(spaces, "calc"));

            // A runtime error becomes a problem at the right line.
            spaces.WriteFile("calc", new("broken.py", "x = 1\nprint(undefined_name)\n"));
            Assert.Equal("failed", await Finish(spaces, "calc", spaces.Run("calc", new("broken.py"))));
            Assert.Contains(Problems(spaces, "calc"), p => p.GetProperty("file").GetString() == "broken.py" && p.GetProperty("line").GetInt32() == 2 && p.GetProperty("code").GetString() == "NameError");

            // The syntax check finds a syntax error without running anything.
            spaces.WriteFile("calc", new("broken.py", "def f(:\n    pass\n"));
            Assert.Equal("failed", await Finish(spaces, "calc", spaces.Build("calc", new(null))));
            Assert.Contains(Problems(spaces, "calc"), p => p.GetProperty("file").GetString() == "broken.py" && p.GetProperty("code").GetString() == "SyntaxError");
            spaces.Fs("calc", new("delete", "broken.py", null));

            // A path outside the space or a non-Python file is refused.
            Assert.False(Started(spaces.Run("calc", new("../x.py"))));
            Assert.False(Started(spaces.Run("calc", new("pyproject.toml"))));
            Assert.False(Started(spaces.ChangePackage("calc", new(null, "--index-url", null, false))));
            Assert.False(Started(spaces.ChangePackage("calc", new(null, "six", ">=1", false))));

            if (!Online("https://pypi.org/pypi/six/json")) return;     // offline: the rest needs PyPI

            // pip install a tiny pure-Python package; requirements.txt gets the pinned version.
            Assert.Equal("succeeded", await Finish(spaces, "calc", spaces.ChangePackage("calc", new(null, "tabulate", null, false))));
            var req = File.ReadAllText(Path.Combine(dir, "requirements.txt"));
            Assert.Matches(@"(?m)^tabulate==\d", req);
            spaces.WriteFile("calc", new("table.py", "from tabulate import tabulate\nprint(tabulate([[1, 2]], headers=['a', 'b']))\n"));
            Assert.Equal("succeeded", await Finish(spaces, "calc", spaces.Run("calc", new("table.py"))));
            Assert.Contains("---  ---", Lines(spaces, "calc"));

            // pytest came with the template (requirements.txt), so the tests run.
            var test = spaces.Test("calc", new(null));
            if (JsonSerializer.SerializeToElement(test, Json).TryGetProperty("needs", out _))
            {
                Assert.Equal("succeeded", await Finish(spaces, "calc", spaces.ChangePackage("calc", new(null, "pytest", null, false))));
                test = spaces.Test("calc", new(null));
            }
            Assert.Equal("succeeded", await Finish(spaces, "calc", test));
            Assert.Contains(Lines(spaces, "calc"), l => l.Contains("3 passed"));

            // A failing test points at the test file and line.
            spaces.WriteFile("calc", new("tests/test_fail.py", "def test_wrong():\n    assert 1 + 1 == 3\n"));
            Assert.Equal("failed", await Finish(spaces, "calc", spaces.Test("calc", new(null))));
            Assert.Contains(Problems(spaces, "calc"), p => p.GetProperty("file").GetString() == "tests/test_fail.py" && p.GetProperty("line").GetInt32() == 2);

            // Uninstall removes it from requirements.txt.
            Assert.Equal("succeeded", await Finish(spaces, "calc", spaces.ChangePackage("calc", new(null, "tabulate", null, true))));
            Assert.DoesNotContain("tabulate", File.ReadAllText(Path.Combine(dir, "requirements.txt")));

            // PyPI lookup: the exact name comes first with its versions.
            var search = JsonSerializer.SerializeToElement(await spaces.PypiSearch("six"), Json);
            var first = search.GetProperty("packages").EnumerateArray().First();
            Assert.Equal("six", first.GetProperty("id").GetString());
            Assert.True(first.GetProperty("versions").GetArrayLength() > 0);
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    [Fact]
    public async Task Python_api_template_listens_on_its_port()
    {
        if (CodeSpaces.BasePython() is null) return;
        var root = NewRoot("pyapi");
        using var spaces = new CodeSpaces(root, "dotnet");
        try
        {
            Assert.True(Ok(await spaces.Create(new("api", "py-api"))));
            var started = JsonSerializer.SerializeToElement(spaces.Run("api", new(null)), Json);
            Assert.True(started.TryGetProperty("started", out _), started.ToString());
            for (var i = 0; i < 80 && !Job(spaces, "api").GetProperty("listening").GetBoolean(); i++) await Task.Delay(250);
            var job = Job(spaces, "api");
            Assert.True(job.GetProperty("listening").GetBoolean());
            Assert.StartsWith("http://127.0.0.1:", job.GetProperty("url").GetString());
            var reply = JsonSerializer.SerializeToElement(await spaces.Send("api", new("GET", "/todos", null, null, null)), Json);
            Assert.Equal(200, reply.GetProperty("status").GetInt32());
            Assert.Contains("Learn Python", reply.GetProperty("body").GetString());
            spaces.Stop("api");
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    // ---------------------------------------------------------------- end to end: Node

    [Fact]
    public async Task Node_typescript_space_runs_and_tests_without_npm()
    {
        if (CodeSpaces.NodeExe() is null) return;          // no Node on this machine
        var root = NewRoot("node");
        using var spaces = new CodeSpaces(root, "dotnet");
        try
        {
            Assert.True(Ok(await spaces.Create(new("ts", "node-ts"))));
            Assert.Equal("node", CodeSpaces.DetectKind(Path.Combine(root, "ts")));
            var detail = JsonSerializer.SerializeToElement(spaces.Detail("ts"), Json);
            Assert.Equal("main.ts", detail.GetProperty("defaultEntry").GetString());

            Assert.Equal("succeeded", await Finish(spaces, "ts", spaces.Run("ts", new(null))));
            Assert.Contains("Top student: Ann", Lines(spaces, "ts"));

            Assert.Equal("succeeded", await Finish(spaces, "ts", spaces.Test("ts", new(null))));

            // A runtime error in a .ts file points at the file and line.
            spaces.WriteFile("ts", new("oops.ts", "const n: number = 1;\nconst o: any = null;\nconsole.log(o.name);\n"));
            Assert.Equal("failed", await Finish(spaces, "ts", spaces.Run("ts", new("oops.ts"))));
            Assert.Contains(Problems(spaces, "ts"), p => p.GetProperty("file").GetString() == "oops.ts" && p.GetProperty("line").GetInt32() == 3);

            // A plain .js file in a script space, and a syntax check.
            Assert.True(Ok(await spaces.Create(new("js", "node-script"))));
            Assert.Equal("succeeded", await Finish(spaces, "js", spaces.Run("js", new("index.js"))));
            Assert.Contains("Hello, Node!", Lines(spaces, "js"));
            Assert.Equal("succeeded", await Finish(spaces, "js", spaces.Build("js", new(null))));

            Assert.False(Started(spaces.ChangePackage("js", new(null, "--global", null, false))));
            Assert.False(Started(spaces.Run("js", new("script:nope"))));
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    [Fact]
    public async Task Next_template_is_scaffolded_and_explains_missing_packages()
    {
        var root = NewRoot("next");
        using var spaces = new CodeSpaces(root, "dotnet");
        try
        {
            var created = JsonSerializer.SerializeToElement(await spaces.Create(new("site", "node-next")), Json);
            Assert.True(created.GetProperty("ok").GetBoolean());
            var dir = Path.Combine(root, "site");
            foreach (var f in new[] { "package.json", "app/page.tsx", "app/layout.tsx", "app/globals.css", "postcss.config.mjs", "tsconfig.json", "next.config.ts" })
                Assert.True(File.Exists(Path.Combine(dir, f)), f);
            Assert.Contains("@import \"tailwindcss\"", File.ReadAllText(Path.Combine(dir, "app", "globals.css")));
            var pkg = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "package.json")));
            Assert.Equal("next dev", pkg.RootElement.GetProperty("scripts").GetProperty("dev").GetString());
            spaces.Stop("site");            // the background npm install, if one started
            for (var i = 0; i < 40 && Job(spaces, "site") is { ValueKind: JsonValueKind.Object } j && j.GetProperty("status").GetString() == "running"; i++) await Task.Delay(250);
            if (!Directory.Exists(Path.Combine(dir, "node_modules")))
            {
                var run = JsonSerializer.SerializeToElement(spaces.Run("site", new(null)), Json);
                Assert.Contains("Install packages", run.GetProperty("error").GetString());
            }
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    [Fact]
    public async Task Npm_explains_an_unreachable_registry_and_a_missing_package()
    {
        if (CodeSpaces.NodeExe() is null || CodeSpaces.NpmCli() is null) return;
        var root = NewRoot("npmoff");
        // npm reads its registry from this variable: point it at a port nothing listens on (like a blocked network).
        var before = Environment.GetEnvironmentVariable("npm_config_registry");
        Environment.SetEnvironmentVariable("npm_config_registry", "http://127.0.0.1:9/");
        using var spaces = new CodeSpaces(root, "dotnet");
        try
        {
            var created = JsonSerializer.SerializeToElement(await spaces.Create(new("api", "node-express")), Json);
            Assert.True(created.GetProperty("ok").GetBoolean());
            for (var i = 0; i < 200 && Job(spaces, "api").GetProperty("status").GetString() == "running"; i++) await Task.Delay(250);
            Assert.Equal("failed", Job(spaces, "api").GetProperty("status").GetString());
            Assert.Contains(Lines(spaces, "api"), l => l.Contains("not reachable from this network") && l.Contains("127.0.0.1:9"));

            Assert.Equal("failed", await Finish(spaces, "api", spaces.ChangePackage("api", new(null, "zod", null, false))));
            Assert.Contains(Lines(spaces, "api"), l => l.Contains("npm packages cannot be installed"));
            var search = JsonSerializer.SerializeToElement(await spaces.NpmSearch("express"), Json);
            Assert.Contains("not reachable", search.GetProperty("error").GetString());

            // Running the file anyway: Node cannot find express, and the output says why.
            Assert.Equal("failed", await Finish(spaces, "api", spaces.Run("api", new("index.js"))));
            var lines = Lines(spaces, "api");
            Assert.True(lines.Any(l => l.StartsWith("Hint:") && l.Contains("express")), string.Join("\n", lines.TakeLast(30)));
            Assert.Contains(Problems(spaces, "api"), p => p.GetProperty("code").GetString() == "ERR_MODULE_NOT_FOUND" && p.GetProperty("file").GetString() == "index.js");
        }
        finally
        {
            Environment.SetEnvironmentVariable("npm_config_registry", before);
            try { Directory.Delete(root, true); } catch { }
        }
    }

    [Fact]
    public void Offline_npm_message_is_friendly()
    {
        var m = CodeSpaces.NpmOfflineHelp("https://registry.npmjs.org/", "it answered 403 Forbidden");
        Assert.Contains("not reachable from this network", m);
        Assert.Contains("403", m);
        Assert.Contains("still run", m);
    }

    // ---------------------------------------------------------------- helpers

    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    static async Task<string?> Finish(CodeSpaces spaces, string name, object started)
    {
        Assert.True(Started(started), JsonSerializer.Serialize(started, Json));
        for (var i = 0; i < 1200; i++)
        {
            var status = Job(spaces, name).GetProperty("status").GetString();
            if (status != "running") return status;
            await Task.Delay(250);
        }
        return "timeout";
    }

    static JsonElement Job(CodeSpaces spaces, string name) => JsonSerializer.SerializeToElement(spaces.Events(name, 0), Json).GetProperty("job");
    static List<string> Lines(CodeSpaces spaces, string name) =>
        JsonSerializer.SerializeToElement(spaces.Events(name, 0), Json).GetProperty("lines").EnumerateArray().Select(l => l.GetProperty("text").GetString()!).ToList();
    static List<JsonElement> Problems(CodeSpaces spaces, string name) =>
        JsonSerializer.SerializeToElement(spaces.Events(name, 0), Json).GetProperty("problems").EnumerateArray().ToList();
    static bool Started(object result) => JsonSerializer.SerializeToElement(result, Json).TryGetProperty("started", out _);
    static bool Ok(object result) => JsonSerializer.SerializeToElement(result, Json).TryGetProperty("ok", out var ok) && ok.GetBoolean();
}
