using CodeDojo;

namespace CodeDojo.Tests;

public class TidyTests
{
    [Theory]
    [InlineData("a\r\nb\r\n", "a\nb")]
    [InlineData("a   \nb\t\n\n\n", "a\nb")]
    [InlineData("\n\nx", "x")]
    [InlineData("", "")]
    public void Tidy_ignores_line_endings_trailing_space_and_blank_edges(string input, string expected) =>
        Assert.Equal(expected, Checker.Tidy(input));

    [Fact]
    public void Tidy_keeps_leading_indentation() =>
        Assert.Equal("  a\n    b", Checker.Tidy("  a\n    b\n"));
}

public class StripCommentsAndStringsTests
{
    [Fact]
    public void Line_and_block_comments_are_removed()
    {
        var bare = Checker.StripCommentsAndStrings("int x = 1; // foreach\n/* foreach */ int y = 2;");
        Assert.DoesNotContain("foreach", bare);
        Assert.Contains("int x = 1;", bare);
        Assert.Contains("int y = 2;", bare);
    }

    [Theory]
    [InlineData("var s = \"foreach\";")]
    [InlineData("var s = @\"for\"\"each\";")]
    [InlineData("var s = \"\"\"\nforeach\n\"\"\";")]
    [InlineData("var c = 'f'; var s = $\"foreach {c}\";")]
    public void String_literal_text_is_blanked(string code) =>
        Assert.DoesNotContain("foreach", Checker.StripCommentsAndStrings(code));

    [Fact]
    public void Code_inside_interpolation_holes_is_kept()
    {
        var bare = Checker.StripCommentsAndStrings("var s = $\"{items.Where(i => i > 0).Count()}\";");
        Assert.Contains("items.Where", bare);
    }

    [Fact]
    public void Real_loops_survive()
    {
        var bare = Checker.StripCommentsAndStrings("foreach (var x in xs) Console.WriteLine(\"hi\");");
        Assert.StartsWith("foreach (var x in xs)", bare);
    }
}
