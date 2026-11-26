using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Threads in motion: real threads under the deterministic scheduler (server/Interleave.cs).</summary>
public class InterleaveTests
{
    static readonly CSharpRunner Runner = new();

    static Interleave.Request Two(string setup, string t1, string t2, string? result = null, string? code = null) =>
        new(setup, [new("T1", t1), new("T2", t2)], code, null, result, null, null, null);

    static Dictionary<string, int> Outcomes(JsonObject r) =>
        (r["outcomes"] as JsonArray ?? []).OfType<JsonObject>().ToDictionary(o => (string)o["outcome"]!, o => (int)o["count"]!);

    [Fact]
    public async Task A_racy_increment_loses_updates_in_four_of_six_interleavings()
    {
        var r = await Interleave.Run(Runner, Two("int count = 0;", "count++;", "count++;", "count") with { Mode = "explore" });
        Assert.Null(r["error"]);
        Assert.True((bool)r["complete"]!);
        Assert.Equal(new Dictionary<string, int> { ["1"] = 4, ["2"] = 2 }, Outcomes(r));
    }

    [Fact]
    public async Task A_lock_leaves_one_outcome()
    {
        var r = await Interleave.Run(Runner, Two("int count = 0; object gate = new();", "lock (gate) count++;", "lock (gate) count++;", "count") with { Mode = "explore" });
        Assert.Equal(["2"], Outcomes(r).Keys);
    }

    [Fact]
    public async Task A_schedule_is_followed_and_a_deadlock_is_detected()
    {
        var req = Two("object a = new(), b = new();", "lock (a) { lock (b) { } }", "lock (b) { lock (a) { } }") with { Mode = "trace", Schedule = [0, 1] };
        var r = await Interleave.Run(Runner, req);
        Assert.Equal("deadlock", (string?)r["status"]);
        Assert.Equal([0, 1], (r["chosen"] as JsonArray)!.Select(x => (int)x!).Take(2));
        Assert.Contains("T0 holds a and waits for b", (string?)r["deadlock"]);
        // every step records who could run next and which lock each thread needs
        var last = (r["steps"] as JsonArray)!.OfType<JsonObject>().Last();
        Assert.All(last["s"]!.AsArray(), s => Assert.Equal(1, (int)s![0]!));   // both blocked
    }

    [Fact]
    public async Task Reads_and_writes_carry_the_register_and_the_written_value()
    {
        var r = await Interleave.Run(Runner, Two("int count = 0;", "count++;", "count++;", "count") with { Mode = "trace", Schedule = [0, 1, 0, 1] });
        var steps = (r["steps"] as JsonArray)!.OfType<JsonObject>().ToList();
        Assert.Equal([1, 1, 2, 2], steps.Select(s => (int)s["k"]!));
        Assert.Equal(["0", "0"], steps.Take(2).Select(s => (string)s["r"]!));
        Assert.Equal("1", (string?)r["outcome"]);
    }

    [Fact]
    public async Task Compile_errors_point_at_the_thread()
    {
        var r = await Interleave.Run(Runner, Two("int count = 0;", "count++;", "cuont++;"));
        Assert.NotNull(r["error"]);
        var diag = (r["diagnostics"] as JsonArray)!.OfType<JsonObject>().First(d => (string?)d["severity"] == "error");
        Assert.Equal("T1", (string?)diag["file"]);
        Assert.Equal(1, (int)diag["line"]!);
    }

    [Fact]
    public async Task Semaphores_are_modelled_and_while_true_still_compiles()
    {
        const string code = """
            class Slots
            {
                readonly SemaphoreSlim _gate = new(1);
                int _inside, _peak;
                public int Peak => _peak;
                public void Use()
                {
                    _gate.Wait();
                    while (true)
                    {
                        _inside++;
                        if (_inside > _peak) _peak = _inside;
                        _inside--;
                        break;
                    }
                    _gate.Release();
                }
            }
            """;
        var r = await Interleave.Run(Runner, Two("var s = new Slots();", "s.Use();", "s.Use();", "s.Peak", code) with { Mode = "explore" });
        Assert.Null(r["error"]);
        Assert.Equal(["1"], Outcomes(r).Keys);
    }

    [Fact]
    public async Task Grading_fails_a_racy_class_with_the_breaking_interleaving_and_passes_a_fix()
    {
        var spec = JsonNode.Parse("""
            { "setup": "var c = new Counter();", "threads": [ { "name": "T1", "code": "c.Add();" }, { "name": "T2", "code": "c.Add();" } ],
              "result": "c.Value", "expect": "2" }
            """)!;
        var racy = await Interleave.Grade(Runner, spec, "class Counter { int _n; public void Add() => _n++; public int Value => _n; }", []);
        Assert.False(racy.Passed);
        var detail = racy.Tests.Single().Detail;
        Assert.Contains("end with 1", detail);
        Assert.Contains("\u0002interleave:", detail);

        var safe = await Interleave.Grade(Runner, spec, "class Counter { int _n; public void Add() => Interlocked.Increment(ref _n); public int Value => _n; }", []);
        Assert.True(safe.Passed, string.Join("; ", safe.Tests.Select(t => t.Detail)));
    }
}
