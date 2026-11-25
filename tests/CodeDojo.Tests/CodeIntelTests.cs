using CodeDojo;
using static CodeDojo.CodeIntel;

namespace CodeDojo.Tests;

public class CodeIntelTests
{
    static readonly CSharpRunner Runner = new();

    static Response Ask(string action, string code, string marker, params FileText[] more)
    {
        var pos = code.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(pos >= 0, $"marker {marker} not found");
        var text = code.Replace(marker, "");
        return Run(Runner, new(action, [new("Program.cs", text), .. more], "Program.cs", pos, null));
    }

    [Fact]
    public void Completes_instance_members_of_the_real_type()
    {
        var r = Ask("complete", "var names = new List<string>();\nnames.$$", "$$");
        var labels = r.Items!.Select(i => i.Label).ToList();
        Assert.Contains("Add", labels);
        Assert.Contains("Count", labels);
        Assert.Contains("Where", labels);          // LINQ extension methods
        Assert.DoesNotContain("ReferenceEquals", labels);   // static, not on an instance
    }

    [Fact]
    public void Completes_static_members_of_a_type()
    {
        var labels = Ask("complete", "Console.Wr$$", "$$").Items!.Select(i => i.Label).ToList();
        Assert.Contains("WriteLine", labels);
        Assert.Contains("ReadLine", labels);
    }

    [Fact]
    public void Completes_locals_in_scope()
    {
        var items = Ask("complete", "var total = 3;\nvar count = 4;\nConsole.WriteLine(co$$);", "$$").Items!;
        Assert.Contains(items, i => i.Label == "count" && i.Kind == "local" && i.Detail == "int count");
    }

    [Fact]
    public void Goes_to_a_definition_in_another_file()
    {
        var other = new FileText("Models/Order.cs", "public record Order(string Customer, decimal Total)\n{\n    public bool IsLarge => Total > 100;\n}\n");
        var r = Ask("definition", "var o = new Order(\"ann\", 120m);\nConsole.WriteLine(o.Is$$Large);", "$$", other);
        Assert.Equal("Models/Order.cs", r.Definition!.Path);
        Assert.Equal(3, r.Definition.Line);
    }

    [Fact]
    public void Library_symbols_are_described_instead()
    {
        var r = Ask("definition", "Console.Write$$Line(1);", "$$");
        Assert.Null(r.Definition);
        Assert.Contains("Console.WriteLine", r.External);
    }

    [Fact]
    public void Finds_every_reference_including_the_declaration()
    {
        var r = Ask("references", "int Twice(int n) => n * 2;\nvar a = Tw$$ice(1);\nvar b = Twice(a);", "$$");
        Assert.Equal([1, 2, 3], r.References!.Select(l => l.Line).Order());
    }

    [Fact]
    public void Hover_shows_the_type()
    {
        var r = Ask("hover", "var prices = new Dictionary<string, decimal>();\nprices$$.Clear();", "$$");
        Assert.Contains("Dictionary<string, decimal>", r.Hover);
    }
}
