using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// Terminal steps (TermSteps.cs) and lab steps (LabSteps.cs). The parsing and judging tests always run. The container
/// tests return early (pass without checking) when Docker is not running or the dojo-shell image is not built:
/// tests never build images. Their containers carry a test-only instance label and are always removed.
/// </summary>
public class TermStepsTests
{
    static string Root([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        foreach (var start in new[] { Path.GetDirectoryName(here)!, AppContext.BaseDirectory })
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "netlabs", "images", "shell"))) return dir.FullName;
        throw new DirectoryNotFoundException("netlabs/images/shell");
    }

    static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    static string Module(params (string Name, string Text)[] files)
    {
        var dir = Path.Combine(Path.GetTempPath(), "termstep-test-" + Guid.NewGuid().ToString("N"), "01-mod");
        Directory.CreateDirectory(Path.Combine(dir, "files"));
        foreach (var (name, text) in files) File.WriteAllText(Path.Combine(dir, "files", name), text.Replace("\r", ""));
        return dir;
    }

    const string Step = """
        { "type": "terminal", "prompt": "Make ~/hello.txt say hi.",
          "setup": ["seed.sh", "echo ready > ~/ready.txt"],
          "checks": [
            { "name": "hello.txt says hi", "cmd": "cat ~/hello.txt", "expectOutput": "hi", "fail": "Not yet." },
            { "name": "the seed ran", "cmd": "cat ~/seeded.txt", "expectContains": ["seed", "ed"] },
            { "name": "owned by learner", "cmd": "stat -c %U ~/ready.txt", "expectOutput": "learner" },
            { "name": "root can read the state", "cmd": "cat /opt/dojo/state/x", "user": "root", "expectExit": 0 }
          ],
          "solution": ["echo hi > ~/hello.txt"] }
        """;

    static readonly (string, string) Seed = ("seed.sh", "echo seed > ~/seeded.txt\nmkdir -p /opt/dojo/state && echo 1 > /opt/dojo/state/x && chmod 600 /opt/dojo/state/x\n");

    // ---------------------------------------------------------------- parsing and judging (no Docker)

    [Fact]
    public void The_pwsh_image_types_solutions_into_PowerShell_and_the_others_into_bash()
    {
        var steps = new TermSteps(Path.Combine(Root(), "netlabs", "images"), "test-shell", sweep: false);
        Assert.Equal("pwsh", steps.MachineFor("pwsh").Shell);
        Assert.Equal("bash", steps.MachineFor("shell").Shell);
        // The solution travels base64-encoded and is run one top-level statement at a time.
        var script = "cd ~\n$x = 'it''s \"quoted\" `n'\nthrow 'on purpose'\n'still runs'";
        var wrapped = TermSteps.PwshTyped(script);
        var b64 = System.Text.RegularExpressions.Regex.Match(wrapped, "FromBase64String\\('([^']+)'\\)").Groups[1].Value;
        Assert.Equal(script, System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(b64)));
        Assert.Contains("EndBlock.Statements", wrapped);
        Assert.Contains("catch", wrapped);
    }

    [Fact]
    public void Parses_a_terminal_step_and_runs_named_scripts_from_the_module_files()
    {
        var spec = TermSteps.Parse(Obj(Step), "t/m/l#0", Module(Seed));
        Assert.Equal("shell", spec.Image);
        Assert.False(spec.Network);
        Assert.Contains("bash \"$DOJO_FILES/seed.sh\"", spec.Setup);
        Assert.Contains("echo ready > ~/ready.txt", spec.Setup);
        Assert.Equal(4, spec.Checks.Count);
        Assert.Equal(["seed", "ed"], spec.Checks[1].ExpectContains);
        Assert.Equal("learner", spec.Checks[0].RunAs);
        Assert.Equal("root", spec.Checks[3].RunAs);
        Assert.Equal("echo hi > ~/hello.txt", spec.Solution);
        Assert.NotNull(spec.FilesDir);
    }

    [Theory]
    [InlineData("""{ "type": "terminal", "prompt": "p", "checks": [] }""", "checks")]
    [InlineData("""{ "type": "terminal", "checks": [{ "name": "a", "cmd": "true" }] }""", "prompt")]
    [InlineData("""{ "type": "terminal", "prompt": "p", "setup": ["missing.sh"], "checks": [{ "name": "a", "cmd": "true" }] }""", "missing.sh")]
    [InlineData("""{ "type": "terminal", "prompt": "p", "checks": [{ "name": "a" }] }""", "cmd")]
    [InlineData("""{ "type": "terminal", "prompt": "p", "checks": [{ "name": "a", "cmd": "x", "user": "bob" }] }""", "user")]
    [InlineData("""{ "type": "terminal", "prompt": "p", "checks": [{ "name": "a", "cmd": "x", "expectMatch": "(" }] }""", "expectMatch")]
    [InlineData("""{ "type": "terminal", "prompt": "p", "checks": [{ "name": "a", "cmd": "x" }, { "name": "a", "cmd": "y" }] }""", "unique")]
    [InlineData("""{ "type": "terminal", "prompt": "p", "image": "../x", "checks": [{ "name": "a", "cmd": "x" }] }""", "image")]
    [InlineData("""{ "type": "terminal", "prompt": "p", "network": "yes", "checks": [{ "name": "a", "cmd": "x" }] }""", "network")]
    public void Rejects_malformed_steps_with_a_clear_message(string json, string mentions)
    {
        var e = Assert.Throws<InvalidDataException>(() => TermSteps.Parse(Obj(json), "k", Module()));
        Assert.Contains(mentions, e.Message);
    }

    static TermSteps.Check C(string json) => TermSteps.Parse(Obj($$"""{ "prompt": "p", "checks": [{{json}}] }"""), "k", Module()).Checks[0];

    [Fact]
    public void Judges_exit_codes_output_and_patterns()
    {
        NetLabs.Result R(int code, string output) => new(code, output, "");
        var plain = C("""{ "name": "a", "cmd": "x" }""");
        Assert.True(TermSteps.Judge(plain, R(0, "")));
        Assert.False(TermSteps.Judge(plain, R(1, "")));
        // Output expectations do not care about the exit code unless asked (grep -c prints 0 and exits 1).
        var count = C("""{ "name": "a", "cmd": "x", "expectOutput": "0" }""");
        Assert.True(TermSteps.Judge(count, R(1, "0\n")));
        Assert.False(TermSteps.Judge(count, R(0, "1\n")));
        var both = C("""{ "name": "a", "cmd": "x", "expectOutput": "0", "expectExit": 0 }""");
        Assert.False(TermSteps.Judge(both, R(1, "0")));
        var contains = C("""{ "name": "a", "cmd": "x", "expectContains": ["main", "feature"] }""");
        Assert.True(TermSteps.Judge(contains, R(0, "* main\n  feature\n")));
        Assert.False(TermSteps.Judge(contains, R(0, "* main\n")));
        var match = C("""{ "name": "a", "cmd": "x", "expectMatch": "^[0-9a-f]{40}$" }""");
        Assert.True(TermSteps.Judge(match, R(0, "x\n" + new string('a', 40) + "\n")));
        Assert.False(TermSteps.Judge(match, R(0, "abc")));
        Assert.False(TermSteps.Judge(plain, R(124, "")));   // a timed-out check never passes
    }

    [Fact]
    public void Every_terminal_and_lab_step_in_the_tracks_is_well_formed()
    {
        var content = new Content(Root());
        int terminals = 0, labs = 0;
        foreach (var track in content.Tracks().OfType<JsonObject>())
        foreach (var module in (track["modules"] as JsonArray ?? []).OfType<JsonObject>())
        foreach (var meta in (module["lessons"] as JsonArray ?? []).OfType<JsonObject>())
        {
            string t = (string)track["id"]!, m = (string)module["id"]!, l = (string)meta["id"]!;
            var steps = content.Lesson(t, m, l)!["steps"]!.AsArray();
            for (var i = 0; i < steps.Count; i++)
            {
                var step = steps[i]!.AsObject();
                if ((string?)step["type"] == "terminal")
                {
                    terminals++;
                    var spec = TermSteps.Parse(step, $"{t}/{m}/{l}#{i}", TermSteps.ModuleDir(content, step, t, m));
                    Assert.True(spec.Solution.Length > 0, $"{t}/{m}/{l}#{i} has no solution");
                }
                if ((string?)step["type"] == "lab")
                {
                    labs++;
                    Assert.Empty(LabSteps.Check(step, Root()));
                }
            }
        }
        Assert.True(terminals >= 16, $"only {terminals} terminal steps");
        Assert.True(labs >= 10, $"only {labs} lab steps");
    }

    [Fact]
    public void Lab_steps_must_name_a_real_challenge_or_task()
    {
        var root = Root();
        Assert.Empty(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "lab": "netbuild", "challenge": "static" }"""), root));
        Assert.Empty(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "live": "13-pipes-and-plumbing", "task": ["t1", "t3"] }"""), root));
        Assert.Contains(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "lab": "netbuild", "challenge": "nope" }"""), root), e => e.Contains("not a challenge"));
        Assert.Contains(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "lab": "netbuild", "challenge": "sandbox" }"""), root), e => e.Contains("sandbox"));
        Assert.Contains(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "lab": "paint", "challenge": "x" }"""), root), e => e.Contains("not a visual lab"));
        Assert.Contains(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "live": "99-nope", "task": "t1" }"""), root), e => e.Contains("not a lab folder"));
        Assert.Contains(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "live": "13-pipes-and-plumbing", "task": "t99" }"""), root), e => e.Contains("not a task"));
        Assert.Contains(LabSteps.Check(Obj("""{ "type": "lab", "prompt": "p", "lab": "netbuild", "live": "13-pipes-and-plumbing" }"""), root), e => e.Contains("exactly one"));
        // Every builder's challenge list can be read.
        foreach (var lab in LabSteps.Visual.Keys) Assert.True(LabSteps.Challenges(Path.Combine(root, "ui"), lab).Count >= 5, lab);
    }

    // ---------------------------------------------------------------- containers (Docker, skips when it is off)

    static async Task<bool> DockerAndImage() =>
        (await NetLabs.Probe()).Ok && (await NetLabs.Docker(["image", "inspect", "dojo-shell:latest"], TimeSpan.FromSeconds(20))).Ok;

    static TermSteps Engine(string instance, TermSteps.Options? options = null) =>
        new(Path.Combine(Root(), "netlabs", "images"), instance, options, sweep: false);

    static async Task<string> Inspect(string name, string format) =>
        (await NetLabs.Docker(["container", "inspect", "--format", format, name], TimeSpan.FromSeconds(20))).Out.Trim();

    static async Task<bool> Exists(string name) =>
        (await NetLabs.Docker(["container", "inspect", name], TimeSpan.FromSeconds(20))).Ok;

    [Fact]
    public async Task A_step_container_is_set_up_checked_reused_reset_and_removed()
    {
        if (!await DockerAndImage()) return;
        await using var steps = Engine("test-" + Guid.NewGuid().ToString("N")[..8]);
        var spec = TermSteps.Parse(Obj(Step), "t/m/l#0", Module(Seed));
        var name = steps.ContainerName(spec.Key);
        try
        {
            var open = await steps.Open(spec);
            Assert.True(open.Ok, open.Message);
            Assert.True(open.Fresh);
            // Labelled, limited, and without a network.
            Assert.Equal(steps.Instance, await Inspect(name, "{{index .Config.Labels \"code-dojo.termstep\"}}"));
            Assert.Equal("t/m/l#0", await Inspect(name, "{{index .Config.Labels \"code-dojo.step\"}}"));
            Assert.Equal("none", await Inspect(name, "{{.HostConfig.NetworkMode}}"));
            Assert.Equal((512L * 1024 * 1024).ToString(), await Inspect(name, "{{.HostConfig.Memory}}"));
            Assert.Equal("256", await Inspect(name, "{{.HostConfig.PidsLimit}}"));
            var id = await Inspect(name, "{{.Id}}");

            // Before the learner does anything: the setup ran, the task check fails, with its message.
            var before = await steps.RunChecks(spec);
            Assert.Equal("ready", before.State);
            Assert.False(before.Passed);
            Assert.False(before.Rows[0].Pass);
            Assert.StartsWith("Not yet.", before.Rows[0].Detail);
            Assert.True(before.Rows[1].Pass, before.Rows[1].Detail);
            Assert.True(before.Rows[2].Pass, before.Rows[2].Detail);
            Assert.True(before.Rows[3].Pass, before.Rows[3].Detail);

            // The learner types the command; the checks see the real result.
            var typed = await NetLabs.Docker(["exec", "-u", "learner", "-w", "/home/learner", name, "bash", "-c", "echo hi > ~/hello.txt"], TimeSpan.FromSeconds(20));
            Assert.True(typed.Ok, typed.Err);
            Assert.True((await steps.RunChecks(spec)).Passed);

            // Opening the step again reuses the same machine; Reset scenario starts over.
            Assert.True((await steps.Open(spec)).Ok);
            Assert.Equal(id, await Inspect(name, "{{.Id}}"));
            var reset = await steps.Reset(spec);
            Assert.True(reset.Ok, reset.Message);
            Assert.NotEqual(id, await Inspect(name, "{{.Id}}"));
            Assert.False((await steps.RunChecks(spec)).Passed);

            // Leaving the step removes it; checking after that says so instead of failing.
            Assert.True(await steps.Remove(spec.Key));
            Assert.False(await Exists(name));
            Assert.Equal("gone", (await steps.RunChecks(spec)).State);
        }
        finally { await steps.RemoveAll(); }
        Assert.False(await Exists(name));
    }

    [Fact]
    public async Task The_cap_evicts_the_oldest_idle_container_and_the_reaper_removes_quiet_ones()
    {
        if (!await DockerAndImage()) return;
        await using var steps = Engine("test-" + Guid.NewGuid().ToString("N")[..8], new TermSteps.Options { MaxContainers = 2, Grace = TimeSpan.FromMinutes(5) });
        var dir = Module();
        TermSteps.Spec S(int i) => TermSteps.Parse(Obj("""{ "prompt": "p", "checks": [{ "name": "a", "cmd": "test -f ~/x" }], "solution": "touch ~/x" }"""), $"t/m/l#{i}", dir);
        try
        {
            Assert.True((await steps.Open(S(1))).Ok);
            await Task.Delay(50);
            Assert.True((await steps.Open(S(2))).Ok);
            Assert.True((await steps.Open(S(3))).Ok);       // over the cap: #1 is the least recently used
            Assert.False(steps.Has("t/m/l#1"));
            Assert.False(await Exists(steps.ContainerName("t/m/l#1")));
            Assert.True(steps.Has("t/m/l#2") && steps.Has("t/m/l#3"));

            Assert.Equal(0, await steps.Sweep(DateTime.UtcNow));    // nothing is quiet yet
            steps.Age("t/m/l#2", TimeSpan.FromMinutes(6));          // no terminal for longer than the grace period
            Assert.Equal(1, await steps.Sweep(DateTime.UtcNow));
            Assert.False(await Exists(steps.ContainerName("t/m/l#2")));
            Assert.True(steps.Has("t/m/l#3"));
        }
        finally { await steps.RemoveAll(); }
        Assert.False(await Exists(steps.ContainerName("t/m/l#3")));
    }

    [Fact]
    public async Task Never_removes_a_container_it_did_not_create()
    {
        if (!await DockerAndImage()) return;
        await using var steps = Engine("test-" + Guid.NewGuid().ToString("N")[..8]);
        var spec = TermSteps.Parse(Obj("""{ "prompt": "p", "checks": [{ "name": "a", "cmd": "true" }] }"""), "t/m/l#9", Module());
        var name = steps.ContainerName(spec.Key);
        // Someone else's container that happens to have the same name, without our label.
        var foreign = await NetLabs.Docker(["run", "-d", "--name", name, "--network", "none", "dojo-shell:latest", "sleep", "300"], TimeSpan.FromMinutes(1));
        Assert.True(foreign.Ok, foreign.Err);
        try
        {
            var open = await steps.Open(spec);
            Assert.False(open.Ok);                                   // cannot take the name, and does not steal it
            await steps.Remove(spec.Key);
            await steps.RemoveAll();
            Assert.True(await Exists(name));
            Assert.Equal("", await Inspect(name, "{{index .Config.Labels \"code-dojo.termstep\"}}"));
        }
        finally { await NetLabs.Docker(["rm", "-f", name], TimeSpan.FromMinutes(1)); }
    }

    [Fact]
    public async Task Prove_runs_the_solution_and_reports_steps_that_cannot_fail_or_cannot_pass()
    {
        if (!await DockerAndImage()) return;
        await using var steps = Engine("test-" + Guid.NewGuid().ToString("N")[..8]);
        var good = TermSteps.Parse(Obj(Step), "t/m/l#0", Module(Seed));
        Assert.Empty(await steps.Prove(good));
        var always = TermSteps.Parse(Obj("""{ "prompt": "p", "checks": [{ "name": "a", "cmd": "true" }], "solution": "true" }"""), "t/m/l#1", Module());
        Assert.Contains(await steps.Prove(always), p => p.Contains("already passes"));
        var wrong = TermSteps.Parse(Obj("""{ "prompt": "p", "checks": [{ "name": "a", "cmd": "test -f ~/x" }], "solution": "touch ~/y" }"""), "t/m/l#2", Module());
        Assert.Contains(await steps.Prove(wrong), p => p.Contains("check \"a\" fails"));
        var broken = TermSteps.Parse(Obj("""{ "prompt": "p", "setup": "false", "checks": [{ "name": "a", "cmd": "true" }], "solution": "true" }"""), "t/m/l#3", Module());
        Assert.Contains(await steps.Prove(broken), p => p.Contains("setup failed"));
        Assert.Empty(steps.List());
        Assert.Equal("", (await NetLabs.Docker(["ps", "-aq", "--filter", $"label=code-dojo.termstep={steps.Instance}"], TimeSpan.FromSeconds(20))).Out.Trim());
    }
}
