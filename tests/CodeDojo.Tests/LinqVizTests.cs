using CodeDojo;

namespace CodeDojo.Tests;

public class LinqVizTests
{
    static readonly CSharpRunner Runner = new();

    [Fact]
    public async Task Streaming_operators_pass_items_one_at_a_time()
    {
        var r = await LinqViz.Run(Runner, new("new[] { 5, 1, 8 }", ".Where(n => n > 2).Select(n => n * 10)", null));
        Assert.Null(r.Error);
        Assert.Equal(["source", ".Where(n => n > 2)", ".Select(n => n * 10)"], r.Stages);
        // 5 goes all the way through before 1 is even looked at.
        Assert.Equal([(0, "5"), (1, "5"), (2, "50"), (0, "1"), (0, "8"), (1, "8"), (2, "80")], r.Events.Select(e => (e.Stage, e.Text)));
        Assert.True(r.Lazy);
    }

    [Fact]
    public async Task OrderBy_buffers_everything_first()
    {
        var r = await LinqViz.Run(Runner, new("new[] { 3, 1, 2 }", ".OrderBy(n => n)", null));
        Assert.Equal([(0, "3"), (0, "1"), (0, "2"), (1, "1"), (1, "2"), (1, "3")], r.Events.Select(e => (e.Stage, e.Text)));
    }

    [Fact]
    public async Task Terminal_operator_shows_its_result()
    {
        var r = await LinqViz.Run(Runner, new("new[] { 1, 2, 3, 4 }", ".Where(n => n % 2 == 0).Sum()", null));
        Assert.Null(r.Error);
        Assert.Equal("6", r.Result);
        Assert.DoesNotContain(r.Events, e => e.Stage == 2);
    }

    [Fact]
    public async Task Setup_types_are_available()
    {
        var r = await LinqViz.Run(Runner, new("new[] { new P(\"a\", 3), new P(\"b\", 1) }", ".OrderBy(p => p.Age).Select(p => p.Name)", "record P(string Name, int Age);"));
        Assert.Null(r.Error);
        Assert.Equal(["\"b\"", "\"a\""], r.Events.Where(e => e.Stage == 2).Select(e => e.Text));
    }

    [Theory]
    [InlineData("Where(n => n > 2")]
    [InlineData(".Where(n => undefinedThing)")]
    public async Task Bad_queries_explain_themselves(string query)
    {
        var r = await LinqViz.Run(Runner, new("new[] { 1 }", query, null));
        Assert.NotNull(r.Error);
    }
}
