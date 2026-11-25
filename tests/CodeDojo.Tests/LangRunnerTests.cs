using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Each test only runs when that language is installed on the machine running the tests.</summary>
public class LangRunnerTests
{
    static readonly LangRunner Langs = new();

    [Theory]
    [InlineData("python", "print(6 * 7)", "42")]
    [InlineData("javascript", "console.log(6 * 7)", "42")]
    [InlineData("typescript", "const n: number = 6; console.log(n * 7)", "42")]
    [InlineData("java", "public class Main { public static void main(String[] a) { System.out.println(6 * 7); } }", "42")]
    public async Task Runs_a_program_and_returns_clean_output(string id, string code, string expected)
    {
        if (Langs.Find(id) is not { } lang) return;
        var r = await Langs.Run(lang, code, null);
        Assert.True(r.Compiled, r.CompileOutput);
        Assert.Equal(expected, r.Stdout.Trim());   // no colour codes
    }

    [Fact]
    public async Task Stdin_reaches_the_program()
    {
        if (Langs.Find("python") is not { } py) return;
        var r = await Langs.Run(py, "print(input()[::-1])", "dojo\n");
        Assert.Equal("ojod", r.Stdout.Trim());
    }

    [Fact]
    public async Task Endless_loops_are_stopped()
    {
        if (Langs.Find("python") is not { } py) return;
        var r = await Langs.Run(py, "while True: pass", null);
        Assert.True(r.TimedOut);
    }

    [Fact]
    public async Task Compile_errors_come_back_as_text()
    {
        if (Langs.Find("java") is not { } java) return;
        var r = await Langs.Run(java, "public class Main { oops }", null);
        Assert.False(r.Compiled);
        Assert.Contains("error", r.CompileOutput);
    }
}
