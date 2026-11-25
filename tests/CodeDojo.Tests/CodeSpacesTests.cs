using System.Text.Json;
using CodeDojo;

namespace CodeDojo.Tests;

public class CodeSpacesTests
{
    static readonly string Root = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "space-root");

    [Theory]
    [InlineData("Program.cs")]
    [InlineData("src/App/Models/Order.cs")]
    [InlineData("src\\App\\Program.cs")]
    [InlineData("README.md")]
    public void Accepts_paths_inside_the_space(string rel)
    {
        var full = CodeSpaces.SafePath(Root, rel, out var error);
        Assert.NotNull(full);
        Assert.Equal("", error);
        Assert.StartsWith(Path.GetFullPath(Root) + Path.DirectorySeparatorChar, full);
    }

    [Theory]
    [InlineData("../outside.txt")]
    [InlineData("src/../../outside.txt")]
    [InlineData("./Program.cs")]
    [InlineData("/etc/passwd")]
    [InlineData("C:\\Windows\\win.ini")]
    [InlineData("C:relative.txt")]
    [InlineData("\\\\server\\share\\x")]
    [InlineData("file.txt:stream")]
    [InlineData(".git/config")]
    [InlineData("src/CON")]
    [InlineData("nul.txt")]
    [InlineData("trailing.")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Rejects_paths_that_escape_or_are_unsafe(string? rel)
    {
        Assert.Null(CodeSpaces.SafePath(Root, rel, out var error));
        Assert.NotEqual("", error);
    }

    [Fact]
    public void Does_not_follow_links_out_of_the_space()
    {
        var root = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "link-" + Guid.NewGuid().ToString("N")[..8]);
        var outside = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "outside-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(outside);
        try
        {
            try { Directory.CreateSymbolicLink(Path.Combine(root, "escape"), outside); }
            catch (Exception) { return; }   // creating links needs developer mode on Windows: nothing to test then
            Assert.Null(CodeSpaces.SafePath(root, "escape/secret.txt", out _));
        }
        finally
        {
            try { Directory.Delete(Path.Combine(root, "escape")); } catch { }
            Directory.Delete(root, true);
            Directory.Delete(outside, true);
        }
    }

    [Theory]
    [InlineData("my-app", true)]
    [InlineData("Shop_2", true)]
    [InlineData("a", true)]
    [InlineData("2fast", false)]
    [InlineData("-x", false)]
    [InlineData("a.b", false)]
    [InlineData("con", false)]
    [InlineData("has space", false)]
    [InlineData("..", false)]
    [InlineData("a/b", false)]
    public void Validates_space_names(string name, bool ok) => Assert.Equal(ok, CodeSpaces.ValidSpaceName(name));

    [Theory]
    [InlineData("Humanizer.Core", true)]
    [InlineData("Newtonsoft.Json", true)]
    [InlineData("xunit.runner.visualstudio", true)]
    [InlineData("Microsoft.Extensions.Http-Polly", true)]
    [InlineData("Some_Package", true)]
    [InlineData("", false)]
    [InlineData("bad id", false)]
    [InlineData("--source", false)]
    [InlineData("a..b", false)]
    [InlineData(".hidden", false)]
    [InlineData("pkg;rm -rf", false)]
    [InlineData("a/b", false)]
    public void Validates_package_ids(string id, bool ok) => Assert.Equal(ok, CodeSpaces.ValidPackageId(id));

    [Theory]
    [InlineData("2.14.1", true)]
    [InlineData("1.0", true)]
    [InlineData("10.0.0-preview.7.25380.108", true)]
    [InlineData("1.2.3+build.5", true)]
    [InlineData("1.2.3.4", true)]
    [InlineData("1", false)]
    [InlineData("latest", false)]
    [InlineData("1.0 --source x", false)]
    [InlineData("[1.0,2.0)", false)]
    public void Validates_versions(string v, bool ok) => Assert.Equal(ok, CodeSpaces.ValidVersion(v));

    [Fact]
    public void Parses_a_compiler_error_with_a_relative_path()
    {
        var dir = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "space"));
        var line = $"{Path.Combine(dir, "src", "App", "Program.cs")}(12,5): error CS0103: The name 'foo' does not exist in the current context [{Path.Combine(dir, "src", "App", "App.csproj")}]";
        var p = CodeSpaces.ParseDiagnostic(line, dir)!;
        Assert.Equal("error", p.Severity);
        Assert.Equal("CS0103", p.Code);
        Assert.Equal("src/App/Program.cs", p.File);
        Assert.Equal(12, p.Line);
        Assert.Equal(5, p.Column);
        Assert.Equal("The name 'foo' does not exist in the current context", p.Message);
        Assert.Equal("src/App/App.csproj", p.Project);
    }

    [Fact]
    public void Parses_warnings_and_errors_without_a_location()
    {
        var dir = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "space"));
        var warn = CodeSpaces.ParseDiagnostic($"  {Path.Combine(dir, "Models.cs")}(3,19,3,23): warning CS8618: Non-nullable property 'Name' must contain a non-null value. [{Path.Combine(dir, "a.csproj")}]", dir)!;
        Assert.Equal(("warning", "CS8618", "Models.cs", 3, 19), (warn.Severity, warn.Code, warn.File, warn.Line, warn.Column));

        var nu = CodeSpaces.ParseDiagnostic($"{Path.Combine(dir, "a.csproj")} : error NU1101: Unable to find package Nope.Nope. No packages exist with this id in source(s): nuget.org", dir)!;
        Assert.Equal(("error", "NU1101", "a.csproj", 0), (nu.Severity, nu.Code, nu.File, nu.Line));

        var tool = CodeSpaces.ParseDiagnostic("MSBUILD : error MSB1009: Project file does not exist.", dir)!;
        Assert.Null(tool.File);
        Assert.Equal("MSB1009", tool.Code);

        Assert.Null(CodeSpaces.ParseDiagnostic("Build succeeded.", dir));
        Assert.Null(CodeSpaces.ParseDiagnostic("    0 Error(s)", dir));
        Assert.Null(CodeSpaces.ParseDiagnostic("Console.WriteLine(\"no error here\");", dir));
    }

    [Fact]
    public void Lists_package_references_from_a_project_file()
    {
        var xml = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Humanizer.Core" Version="2.14.1" />
                <PackageReference Include="Serilog">
                  <Version>4.0.0</Version>
                </PackageReference>
                <PackageReference Include="Central.Managed" />
                <ProjectReference Include="..\Core\Core.csproj" />
              </ItemGroup>
            </Project>
            """;
        var pkgs = CodeSpaces.ReadPackages(xml);
        Assert.Equal([new("Humanizer.Core", "2.14.1"), new("Serilog", "4.0.0"), new CodeSpaces.Package("Central.Managed", null)], pkgs);
        Assert.Empty(CodeSpaces.ReadPackages("not xml"));
    }

    [Fact]
    public void Reads_compile_assemblies_from_project_assets()
    {
        var folder = Path.Combine(Path.GetTempPath(), "nuget-packages") + Path.DirectorySeparatorChar;
        var assets = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["targets"] = new Dictionary<string, object>
            {
                ["net10.0"] = new Dictionary<string, object>
                {
                    ["Humanizer.Core/2.14.1"] = new { type = "package", compile = new Dictionary<string, object> { ["lib/net6.0/Humanizer.dll"] = new { } } },
                    ["Empty/1.0.0"] = new { type = "package", compile = new Dictionary<string, object> { ["lib/net6.0/_._"] = new { } } },
                    ["Core/1.0.0"] = new { type = "project", compile = new Dictionary<string, object> { ["bin/placeholder/Core.dll"] = new { } } },
                },
            },
            ["libraries"] = new Dictionary<string, object>
            {
                ["Humanizer.Core/2.14.1"] = new { path = "humanizer.core/2.14.1" },
                ["Empty/1.0.0"] = new { path = "empty/1.0.0" },
                ["Core/1.0.0"] = new { path = "../Core/Core.csproj" },
            },
            ["packageFolders"] = new Dictionary<string, object> { [folder] = new { } },
        });
        var refs = CodeSpaces.ReadAssets(assets);
        Assert.Equal([Path.GetFullPath(Path.Combine(folder, "humanizer.core/2.14.1", "lib/net6.0/Humanizer.dll"))], refs);
    }

    [Theory]
    [InlineData("my-shop", "MyShop")]
    [InlineData("todo_api", "TodoApi")]
    [InlineData("x", "X")]
    public void Names_projects_after_the_space(string space, string expected) => Assert.Equal(expected, CodeSpaces.ProjectName(space));

    [Fact]
    public async Task File_operations_stay_inside_and_delete_moves_to_trash()
    {
        var root = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "fs-" + Guid.NewGuid().ToString("N")[..8]);
        using var spaces = new CodeSpaces(root, "dotnet");
        try
        {
            Assert.True(Ok(await spaces.Create(new("demo", "empty"))));
            Assert.True(Ok(spaces.Fs("demo", new("newfile", "Models/Order.cs", null))));
            var starter = Get<string>(spaces.ReadFile("demo", "Models/Order.cs"), "code");
            Assert.Contains("public class Order", starter);
            Assert.True(Ok(spaces.WriteFile("demo", new("Models/Order.cs", "public record Order(int Id);\n"))));
            Assert.Equal("public record Order(int Id);\n", Get<string>(spaces.ReadFile("demo", "Models/Order.cs"), "code"));
            Assert.True(Ok(spaces.Fs("demo", new("rename", "Models/Order.cs", "Models/Purchase.cs"))));
            Assert.False(Ok(spaces.WriteFile("demo", new("../escape.cs", "x"))));
            Assert.False(Ok(spaces.Fs("demo", new("rename", "Models/Purchase.cs", "../../escape.cs"))));
            Assert.True(Ok(spaces.Fs("demo", new("delete", "Models", null))));
            Assert.False(Directory.Exists(Path.Combine(root, "demo", "Models")));
            Assert.True(Directory.EnumerateFiles(Path.Combine(root, ".trash"), "Purchase.cs", SearchOption.AllDirectories).Any());
            Assert.True(Ok(spaces.Delete("demo")));
            Assert.False(Directory.Exists(Path.Combine(root, "demo")));
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    [Fact]
    public async Task Creates_builds_and_runs_a_console_space()
    {
        var root = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "e2e-" + Guid.NewGuid().ToString("N")[..8]);
        using var spaces = new CodeSpaces(root, new CSharpRunner().DotnetPath);
        try
        {
            var created = await spaces.Create(new("hello", "console"));
            if (!Ok(created)) return;     // dotnet new is not available here: nothing more to check
            Assert.True(Ok(spaces.WriteFile("hello", new("Program.cs", "Console.WriteLine(Greeting.Text + \" \" + (6 * 7));\n"))));
            Assert.True(Ok(spaces.WriteFile("hello", new("Greeting.cs", "static class Greeting { public const string Text = \"dojo says\"; }\n"))));

            Assert.Equal("succeeded", await Finish(spaces, spaces.Build("hello", new(null))));
            Assert.Equal("succeeded", await Finish(spaces, spaces.Run("hello", new(null))));
            var events = JsonSerializer.SerializeToElement(spaces.Events("hello", 0), Json);
            var lines = events.GetProperty("lines").EnumerateArray().Select(l => l.GetProperty("text").GetString()).ToList();
            Assert.Contains("dojo says 42", lines);

            // A compile error comes back as a structured problem with a relative path.
            spaces.WriteFile("hello", new("Program.cs", "Console.WriteLine(missing);\n"));
            Assert.Equal("failed", await Finish(spaces, spaces.Build("hello", new(null))));
            var problems = JsonSerializer.SerializeToElement(spaces.Events("hello", 0), Json).GetProperty("problems").EnumerateArray().ToList();
            Assert.Contains(problems, p => p.GetProperty("code").GetString() == "CS0103" && p.GetProperty("file").GetString() == "Program.cs" && p.GetProperty("line").GetInt32() == 1);
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    static async Task<string?> Finish(CodeSpaces spaces, object started)
    {
        Assert.True(JsonSerializer.SerializeToElement(started, Json).TryGetProperty("started", out _), JsonSerializer.Serialize(started, Json));
        for (var i = 0; i < 600; i++)
        {
            var job = JsonSerializer.SerializeToElement(spaces.Events("hello", 0), Json).GetProperty("job");
            var status = job.GetProperty("status").GetString();
            if (status != "running") return status;
            await Task.Delay(250);
        }
        return "timeout";
    }

    static bool Ok(object result) => JsonSerializer.SerializeToElement(result, Json).TryGetProperty("ok", out var ok) && ok.GetBoolean();
    static T Get<T>(object result, string prop) => JsonSerializer.SerializeToElement(result, Json).GetProperty(prop).Deserialize<T>(Json)!;
}
