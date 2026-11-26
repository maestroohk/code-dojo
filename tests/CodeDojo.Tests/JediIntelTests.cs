using CodeDojo;
using static CodeDojo.CodeIntel;

namespace CodeDojo.Tests;

/// <summary>
/// Python intelligence from Jedi (server/intel/pyintel.py, "Jedi, when it is installed"). Each test is skipped
/// when Python or Jedi is not there (asking starts the one-time Jedi install in the background, so a later run
/// has it). PyIntelTests covers the dojo's own analyser, which answers when Jedi cannot.
/// </summary>
[Collection("Python intel")]
public class JediIntelTests
{
    static readonly bool HavePython = new LangRunner().Find("python") is not null;

    /// <summary>Jedi's answer, or null when Jedi is not installed (the test then has nothing to check).</summary>
    static async Task<Response?> Ask(string action, string code, string? dir = null, params FileText[] more)
    {
        if (!HavePython) return null;
        var pos = code.IndexOf("$$", StringComparison.Ordinal);
        Assert.True(pos >= 0, "marker $$ not found");
        var r = await PyIntel.Run(new(action, [new("main.py", code.Replace("$$", "")), .. more], "main.py", pos, null, "python", Engine: "jedi"), dir);
        if (r.Engine == "unavailable") return null;
        Assert.Equal("jedi", r.Engine);
        return r;
    }

    static List<string> Labels(Response r) => r.Items?.Select(i => i.Label).ToList() ?? [];

    static readonly FileText Geo = new("geo.py", "def area(r: float) -> float:\n    \"\"\"Area of a circle.\"\"\"\n    return 3.14 * r * r\n\n\nclass Shape:\n    def __init__(self, name: str):\n        self.name = name\n");

    [Fact]
    public async Task Completes_string_methods()
    {
        if (await Ask("complete", "word = \"x\".up$$") is not { } r) return;
        Assert.Contains("upper", Labels(r));
        Assert.DoesNotContain("__len__", Labels(r));
        Assert.Equal("method", r.Items!.First(i => i.Label == "upper").Kind);
    }

    [Fact]
    public async Task Completes_members_of_a_class_from_another_file()
    {
        if (await Ask("complete", "from geo import Shape\ns = Shape('sq')\ns.$$", more: Geo) is not { } r) return;
        Assert.Contains("name", Labels(r));
    }

    [Fact]
    public async Task Goes_to_a_definition_in_another_file()
    {
        if (await Ask("definition", "from geo import area\nprint(ar$$ea(2))", more: Geo) is not { } r) return;
        Assert.NotNull(r.Definition);
        Assert.Equal("geo.py", r.Definition!.Path);
        Assert.Equal(1, r.Definition.Line);
        Assert.Equal(5, r.Definition.Column);
        Assert.Equal("def area(r: float) -> float:", r.Definition.Preview);
    }

    [Fact]
    public async Task Finds_references_across_files()
    {
        if (await Ask("references", "from geo import area\nx = ar$$ea(1) + area(2)", more: Geo) is not { } r) return;
        var refs = r.References!;
        Assert.Contains(refs, l => l.Path == "geo.py" && l.Line == 1);
        Assert.Equal(3, refs.Count(l => l.Path == "main.py"));
        Assert.Equal("main.py", refs[0].Path);
    }

    [Fact]
    public async Task Hover_shows_the_signature_and_docstring()
    {
        if (await Ask("hover", "from geo import area\nar$$ea(2)", more: Geo) is not { } r) return;
        Assert.Contains("def area(r: float)", r.Hover);
        Assert.NotNull(r.Hover);
        Assert.Contains("float", r.Hover[(r.Hover.IndexOf(')') + 1)..]);   // the return type
        Assert.Contains("Area of a circle.", r.Hover);
    }

    [Fact]
    public async Task Hover_shows_an_inferred_type()
    {
        if (await Ask("hover", "words = 'a b'.split()\nwor$$ds") is not { } r) return;
        Assert.Contains("(variable) words: list", r.Hover);
    }

    [Fact]
    public async Task Standard_library_definitions_are_external()
    {
        if (await Ask("definition", "import json\njson.du$$mps({})") is not { } r) return;
        Assert.Null(r.Definition);
        Assert.Contains("Declared in json", r.External);
    }

    [Fact]
    public async Task Sees_a_code_space_venv()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dojo-jedi-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            var site = OperatingSystem.IsWindows() ? Path.Combine(dir, ".venv", "Lib", "site-packages") : Path.Combine(dir, ".venv", "lib", "python3.12", "site-packages");
            Directory.CreateDirectory(Path.Combine(site, "fakepkg"));
            File.WriteAllText(Path.Combine(site, "fakepkg", "__init__.py"), "def helper(count: int) -> str:\n    \"\"\"Says how many.\"\"\"\n    return str(count)\n");
            if (await Ask("complete", "import fakepkg\nfakepkg.hel$$", dir) is not { } r) return;
            Assert.Contains("helper", Labels(r));
            var def = await Ask("definition", "import fakepkg\nfakepkg.hel$$per(1)", dir);
            Assert.Contains("Declared in fakepkg", def!.External);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
