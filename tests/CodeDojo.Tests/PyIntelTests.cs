using CodeDojo;
using static CodeDojo.CodeIntel;

namespace CodeDojo.Tests;

/// <summary>Python intelligence (server/intel/pyintel.py's own analyser; Jedi is in JediIntelTests). Each test only runs when Python is installed.</summary>
[Collection("Python intel")]   // one Python helper serves both this class and JediIntelTests: one at a time
public class PyIntelTests
{
    static readonly CSharpRunner Runner = new();
    static readonly bool HavePython = new LangRunner().Find("python") is not null;

    static async Task<Response> Ask(string action, string code, params FileText[] more)
    {
        var pos = code.IndexOf("$$", StringComparison.Ordinal);
        Assert.True(pos >= 0, "marker $$ not found");
        return await RunAny(Runner, new(action, [new("main.py", code.Replace("$$", "")), .. more], "main.py", pos, null, "python", Engine: "basic"));
    }

    static List<string> Labels(Response r) => r.Items?.Select(i => i.Label).ToList() ?? [];

    static readonly FileText Geo = new("geo.py", "def area(r: float) -> float:\n    \"\"\"Area of a circle.\"\"\"\n    return 3.14 * r * r\n\nclass Shape:\n    def __init__(self, name):\n        self.name = name\n\n    def describe(self) -> str:\n        return self.name\n");

    [Fact]
    public async Task Completes_string_methods_on_a_literal()
    {
        if (!HavePython) return;
        var r = await Ask("complete", "word = \"text\".$$");
        var labels = Labels(r);
        Assert.Contains("upper", labels);
        Assert.Contains("split", labels);
        Assert.DoesNotContain("__len__", labels);
        Assert.Equal("method", r.Items!.First(i => i.Label == "upper").Kind);
    }

    [Fact]
    public async Task Completes_members_of_a_user_class_including_self_attributes()
    {
        if (!HavePython) return;
        var r = await Ask("complete", "class Point:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = y\n\n    def length(self) -> float:\n        return (self.x ** 2 + self.y ** 2) ** 0.5\n\np = Point(3, 4)\np.$$");
        var labels = Labels(r);
        Assert.Contains("x", labels);
        Assert.Contains("y", labels);
        Assert.Contains("length", labels);
        Assert.Contains(r.Items!, i => i.Label == "length" && i.Kind == "method" && i.Detail!.Contains("-> float"));
    }

    [Fact]
    public async Task Completes_names_in_scope_with_kinds()
    {
        if (!HavePython) return;
        var r = await Ask("complete", "import math\ntotal = 1\ndef double(n):\n    count = n * 2\n    return co$$");
        Assert.Contains(r.Items!, i => i.Label == "count" && i.Kind == "variable");
        Assert.Contains(r.Items!, i => i.Label == "double" && i.Kind == "function" && i.Detail == "def double(n)");
        Assert.Contains(r.Items!, i => i.Label == "math" && i.Kind == "module");
        Assert.Contains(r.Items!, i => i.Label == "print" && i.Kind == "function");
        Assert.Contains(r.Items!, i => i.Label == "while" && i.Kind == "keyword");
    }

    [Fact]
    public async Task Completes_members_of_a_standard_module()
    {
        if (!HavePython) return;
        var r = await Ask("complete", "import math\nmath.sq$$");
        Assert.Contains(r.Items!, i => i.Label == "sqrt" && i.Kind == "function");
    }

    [Fact]
    public async Task Completes_numpy_members_when_numpy_is_installed()
    {
        if (!HavePython) return;
        var hover = await Ask("hover", "import numpy as np\nn$$p.zeros(3)");
        if (hover.Hover is null || !hover.Hover.Contains("numpy")) return;   // numpy not installed here
        var labels = Labels(await Ask("complete", "import numpy as np\na = np.ar$$"));
        Assert.Contains("array", labels);
        Assert.Contains("arange", labels);
        var arr = Labels(await Ask("complete", "import numpy as np\na = np.zeros(3)\na.$$"));
        Assert.Contains("shape", arr);
        Assert.Contains("reshape", arr);
    }

    [Fact]
    public async Task Survives_half_typed_code()
    {
        if (!HavePython) return;
        var labels = Labels(await Ask("complete", "names = [\"a\"]\nfor n in names:\n    print(n.up$$\n\ndef broken(:\n    pass\n"));
        Assert.Contains("upper", labels);
    }

    [Fact]
    public async Task Goes_to_a_definition_in_the_same_file()
    {
        if (!HavePython) return;
        var r = await Ask("definition", "rate = 0.2\n\ndef tax(amount):\n    return amount * ra$$te\n");
        Assert.Equal("main.py", r.Definition!.Path);
        Assert.Equal(1, r.Definition.Line);
        Assert.Equal(1, r.Definition.Column);
    }

    [Fact]
    public async Task Goes_to_a_definition_in_another_file()
    {
        if (!HavePython) return;
        var r = await Ask("definition", "from geo import area\nprint(ar$$ea(2))", Geo);
        Assert.Equal("geo.py", r.Definition!.Path);
        Assert.Equal(1, r.Definition.Line);
        Assert.Equal(5, r.Definition.Column);

        var viaModule = await Ask("definition", "import geo\ns = geo.Shape(\"sq\")\ns.descr$$ibe()", Geo);
        Assert.Equal("geo.py", viaModule.Definition!.Path);
        Assert.Equal(9, viaModule.Definition.Line);
    }

    [Fact]
    public async Task Library_symbols_are_described_instead()
    {
        if (!HavePython) return;
        var r = await Ask("definition", "import json\njson.du$$mps({})");
        Assert.Null(r.Definition);
        Assert.Contains("json.dumps(obj", r.External);
        Assert.Contains("no source to open", r.External);
    }

    [Fact]
    public async Task Finds_references_across_files()
    {
        if (!HavePython) return;
        var r = await Ask("references", "from geo import area\nsmall = ar$$ea(1)\nbig = area(10)", Geo);
        var where = r.References!.Select(l => $"{l.Path}:{l.Line}").ToList();
        Assert.Equal(["main.py:1", "main.py:2", "main.py:3", "geo.py:1"], where);
    }

    [Fact]
    public async Task References_of_a_local_respect_scope()
    {
        if (!HavePython) return;
        var r = await Ask("references", "x = 1\n\ndef f(x):\n    return x$$ + 1\n\nprint(x)");
        Assert.Equal([3, 4], r.References!.Select(l => l.Line));
    }

    [Fact]
    public async Task References_of_an_attribute_on_self()
    {
        if (!HavePython) return;
        var r = await Ask("references", "class Counter:\n    def __init__(self):\n        self.count = 0\n\n    def bump(self):\n        self.cou$$nt += 1\n\nc = Counter()\nprint(c.count)");
        Assert.Equal([3, 6, 9], r.References!.Select(l => l.Line));
    }

    [Fact]
    public async Task Hover_shows_signature_doc_and_inferred_types()
    {
        if (!HavePython) return;
        var fn = await Ask("hover", "from geo import area\nprint(ar$$ea(2))", Geo);
        Assert.Equal("(function) def area(r: float) -> float\nArea of a circle.", fn.Hover);
        Assert.Equal("(variable) names: list", (await Ask("hover", "na$$mes = [\"a\", \"b\"]")).Hover);
        Assert.Equal("(variable) s: Shape", (await Ask("hover", "from geo import Shape\ns$$ = Shape(\"x\")", Geo)).Hover);
        Assert.Equal("(parameter) n: int", (await Ask("hover", "def f(n: int):\n    return n$$")).Hover);
        Assert.StartsWith("(function) print(", (await Ask("hover", "pri$$nt(1)")).Hover);
    }
}
