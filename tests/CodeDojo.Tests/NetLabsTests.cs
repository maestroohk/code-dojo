using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

public class NetLabsTests
{
    static string Root([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        foreach (var start in new[] { Path.GetDirectoryName(here)!, AppContext.BaseDirectory })
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "netlabs", "labs"))) return dir.FullName;
        throw new DirectoryNotFoundException("netlabs/labs");
    }

    static NetLabs Engine(out string state)
    {
        state = Path.Combine(Path.GetTempPath(), "netlabs-test-" + Guid.NewGuid().ToString("N"));
        return new NetLabs(Path.Combine(Root(), "netlabs", "labs"), Path.Combine(Root(), "netlabs", "images", "toolbox"), state);
    }

    static JsonObject Task(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void Loads_every_lab_folder_with_a_valid_definition()
    {
        var labs = Engine(out _).LoadLabs();
        var folders = Directory.GetDirectories(Path.Combine(Root(), "netlabs", "labs")).Count(d => File.Exists(Path.Combine(d, "lab.json")));
        Assert.Equal(folders, labs.Count);
        Assert.True(labs.Count >= 10);
        Assert.Equal("01-ip-addressing", labs[0].Id);
        Assert.Equal("cdnet-01", labs[0].Project);
        Assert.Equal("cdnet-01-pc2-1", labs[0].Container("pc2"));
        foreach (var lab in labs)
        {
            Assert.True(File.Exists(lab.ComposeFile), lab.Id);
            Assert.NotEmpty(lab.Nodes);
            Assert.NotEmpty(lab.Tasks);
            Assert.Equal(lab.Tasks.Count(), lab.Tasks.Select(t => (string?)t["id"]).Distinct().Count());
            var compose = File.ReadAllText(lab.ComposeFile);
            // every node a task, check or solution refers to must be a declared node and a compose service
            var refs = lab.Def.ToJsonString();
            foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(refs, "\"node\":\"([^\"]+)\""))
                Assert.True(lab.HasNode(m.Groups[1].Value), $"{lab.Id}: unknown node {m.Groups[1].Value}");
            foreach (var node in lab.Nodes) Assert.Contains($"  {node.Key}:", compose);
            // every {{VAR}} used must be declared
            var vars = (lab.Def["vars"] as JsonObject)?.Select(v => v.Key).ToHashSet() ?? [];
            foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(refs, @"\{\{(\w+)\}\}"))
                Assert.Contains(m.Groups[1].Value, vars);
            foreach (var t in lab.Tasks)
            {
                var type = (string?)t["type"];
                Assert.True(type is "state" or "answer", $"{lab.Id}/{t["id"]}");
                if (type == "state") Assert.NotEmpty(t["checks"]!.AsArray());
                else Assert.True(t.ContainsKey("answer") || t.ContainsKey("answer_cmd"), $"{lab.Id}/{t["id"]}");
            }
            // generated vars always produce values for every declared var
            Assert.Equal(vars, NetLabs.GenVars(lab.Def["vars"] as JsonObject).Keys.ToHashSet());
        }
    }

    [Theory]
    [InlineData("01-ip-addressing", true)]
    [InlineData("1", false)]
    [InlineData("../01-ip-addressing", false)]
    [InlineData("01-IP-addressing", false)]
    [InlineData("01-ip-addressing;rm", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("99-nope", false)]
    public void Finds_labs_by_exact_id_only(string? id, bool found) =>
        Assert.Equal(found, Engine(out _).FindLab(id) is not null);

    [Fact]
    public void Node_and_task_names_are_validated_against_the_definition()
    {
        var lab = Engine(out _).FindLab("01-ip-addressing")!;
        Assert.True(lab.HasNode("pc1"));
        Assert.False(lab.HasNode("pc3"));
        Assert.False(lab.HasNode("pc1 bash"));
        Assert.False(lab.HasNode(""));
        Assert.False(lab.HasNode(null));
        Assert.NotNull(lab.Task("t1"));
        Assert.Null(lab.Task("t99"));
    }

    [Fact]
    public void Substitutes_known_vars_and_leaves_unknown_ones()
    {
        var vars = new Dictionary<string, string> { ["FLAG"] = "DOJO{abc}", ["PORT"] = "8123" };
        Assert.Equal("curl :8123 -> DOJO{abc} {{NOPE}}", NetLabs.Sub("curl :{{PORT}} -> {{FLAG}} {{NOPE}}", vars));
        Assert.Equal("", NetLabs.Sub(null, vars));
    }

    [Fact]
    public void Generates_vars_of_every_type_within_their_spec()
    {
        var spec = Task("""{ "F": {"type":"flag"}, "I": {"type":"int","min":5,"max":7}, "C": {"type":"choice","options":["a","b"]}, "IP": {"type":"ip"} }""");
        for (var i = 0; i < 50; i++)
        {
            var v = NetLabs.GenVars(spec);
            Assert.Matches(@"^DOJO\{[0-9a-f]{12}\}$", v["F"]);
            Assert.InRange(int.Parse(v["I"]), 5, 7);
            Assert.Contains(v["C"], new[] { "a", "b" });
            Assert.Matches(@"^\d+\.\d+\.\d+\.\d+$", v["IP"]);
        }
        Assert.NotEqual(NetLabs.GenVars(spec)["F"], NetLabs.GenVars(spec)["F"]);
        Assert.Throws<InvalidDataException>(() => NetLabs.GenVars(Task("""{ "X": {"type":"nope"} }""")));
    }

    [Fact]
    public void Answer_checking_normalises_case_quotes_and_spaces()
    {
        var t = Task("""{ "id":"t3", "answer": ["10.11.9.0", "10.11.9.0/24"] }""");
        var expected = NetLabs.LiteralAnswers(t, new Dictionary<string, string>());
        Assert.True(NetLabs.Matches(t, " 10.11.9.0 ", expected));
        Assert.True(NetLabs.Matches(t, "'10.11.9.0/24'", expected));
        Assert.False(NetLabs.Matches(t, "10.11.9.1", expected));
        Assert.False(NetLabs.Matches(t, "", expected));

        var words = Task("""{ "id":"x", "answer": "Dojo  Lab Root CA" }""");
        Assert.True(NetLabs.Matches(words, "dojo lab   root ca", NetLabs.LiteralAnswers(words, new Dictionary<string, string>())));
        var strip = Task("""{ "id":"x", "answer": "a, b, c", "strip_spaces": true }""");
        Assert.True(NetLabs.Matches(strip, "A,B , C", NetLabs.LiteralAnswers(strip, new Dictionary<string, string>())));
    }

    [Fact]
    public void Per_run_answers_use_the_runs_vars_and_need_a_running_lab()
    {
        var flag = Task("""{ "id":"t1", "answer": "{{FLAG}}" }""");
        Assert.True(NetLabs.NeedsRun(flag));
        Assert.True(NetLabs.NeedsRun(Task("""{ "id":"t1", "answer_cmd": {"node":"a","cmd":"x"} }""")));
        Assert.False(NetLabs.NeedsRun(Task("""{ "id":"t1", "answer": "62" }""")));
        var expected = NetLabs.LiteralAnswers(flag, new Dictionary<string, string> { ["FLAG"] = "DOJO{1234}" });
        Assert.True(NetLabs.Matches(flag, "DOJO{1234}", expected));
        Assert.False(NetLabs.Matches(flag, "{{FLAG}}", NetLabs.LiteralAnswers(flag, new Dictionary<string, string> { ["FLAG"] = "DOJO{1}" })));
    }

    [Fact]
    public async Task Static_answers_are_checked_and_progress_is_persisted()
    {
        var engine = Engine(out var state);
        try
        {
            var lab = engine.FindLab("01-ip-addressing")!;
            Assert.False((await engine.CheckAnswer(lab, lab.Task("t2")!, "64")).Ok);
            Assert.Empty(engine.DoneTasks(lab));
            Assert.True((await engine.CheckAnswer(lab, lab.Task("t2")!, " 62 ")).Ok);
            Assert.Contains("t2", engine.DoneTasks(lab));
            Assert.True(File.Exists(Path.Combine(state, "netlabs.json")));
            // a fresh engine reads the same progress back
            var again = new NetLabs(Path.Combine(Root(), "netlabs", "labs"), "", state);
            Assert.Contains("t2", again.DoneTasks(again.FindLab("01-ip-addressing")!));
            again.ResetProgress(lab);
            Assert.Empty(engine.DoneTasks(lab));
        }
        finally { if (Directory.Exists(state)) Directory.Delete(state, true); }
    }

    [Fact]
    public void Topology_is_read_from_the_compose_file()
    {
        var engine = Engine(out _);
        var nat = engine.FindLab("05-nat")!;
        var topo = NetLabs.ParseTopology(File.ReadAllText(nat.ComposeFile), nat.Nodes, new Dictionary<string, string>());
        Assert.Equal(["home", "internet"], topo.Networks.Select(n => n.Name));
        Assert.Equal("10.18.1.0/24", topo.Networks[0].Subnet);
        var router = topo.Nodes.Single(n => n.Name == "router");
        Assert.Equal([new("home", "10.18.1.254"), new NetLabs.Attach("internet", "203.0.113.1")], router.Addrs);

        var scan = engine.FindLab("06-port-scanning")!;
        var withVars = NetLabs.ParseTopology(File.ReadAllText(scan.ComposeFile), scan.Nodes, new Dictionary<string, string> { ["HOST"] = "42" });
        Assert.Contains(withVars.Nodes.SelectMany(n => n.Addrs), a => a.Ip == "10.15.1.42");
        foreach (var lab in engine.LoadLabs())
        {
            var t = NetLabs.ParseTopology(File.ReadAllText(lab.ComposeFile), lab.Nodes, new Dictionary<string, string>());
            Assert.NotEmpty(t.Networks);
            Assert.All(t.Nodes, n => Assert.NotEmpty(n.Addrs));
        }
    }

    [Fact]
    public void Last_line_ignores_blank_lines() =>
        Assert.Equal("02:42:0a", NetLabs.LastLine("noise\n02:42:0a \n\n"));
}
