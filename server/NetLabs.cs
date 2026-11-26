using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// Live network labs: hands-on networking and security labs that run as small Docker networks
/// (a C# port of the netsec-dojo engine). Each lab is a folder under netlabs/labs holding
/// lab.json (tasks, hints, solutions), lesson.md and docker-compose.yml; files/ is mounted at /lab
/// in every node. Docker is only ever invoked through an argument list, never a shell string, and
/// lab ids, node names and task ids are always looked up in the lab definitions first.
/// </summary>
public sealed partial class NetLabs
{
    public const string Toolbox = "dojo-toolbox:latest";
    public const string ProjectPrefix = "cdnet-";
    const int MaxTerminals = 8;

    readonly string _labsDir, _imageDir, _stateFile;
    readonly object _stateLock = new();
    readonly ConcurrentDictionary<string, SemaphoreSlim> _labLocks = new();
    int _terminals;

    public NetLabs(string labsDir, string imageDir, string stateDir)
    {
        _labsDir = labsDir;
        _imageDir = imageDir;
        _stateFile = Path.Combine(stateDir, "netlabs.json");
    }

    // ---------------------------------------------------------------- lab definitions

    public sealed record Lab(string Id, string Num, string Project, string Dir, JsonObject Def)
    {
        public string Title => (string?)Def["title"] ?? Id;
        public JsonObject Nodes => Def["nodes"] as JsonObject ?? [];
        public IEnumerable<JsonObject> Tasks => (Def["tasks"] as JsonArray ?? []).OfType<JsonObject>();
        public bool HasNode(string? node) => node is { Length: > 0 } && Nodes.ContainsKey(node);
        public JsonObject? Task(string? id) => id is null ? null : Tasks.FirstOrDefault(t => (string?)t["id"] == id);
        public string Container(string node) => $"{Project}-{node}-1";
        public string ComposeFile => Path.Combine(Dir, "docker-compose.yml");
    }

    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]{0,63}$")]
    private static partial Regex IdShape();

    public static bool ValidId(string? id) => id is not null && IdShape().IsMatch(id);

    public List<Lab> LoadLabs()
    {
        var labs = new List<Lab>();
        if (!Directory.Exists(_labsDir)) return labs;
        foreach (var dir in Directory.GetDirectories(_labsDir).OrderBy(d => d, StringComparer.Ordinal))
        {
            var id = Path.GetFileName(dir);
            var file = Path.Combine(dir, "lab.json");
            if (!ValidId(id) || !File.Exists(file)) continue;
            if (JsonNode.Parse(File.ReadAllText(file)) is not JsonObject def) continue;
            var num = id.Split('-')[0];
            labs.Add(new Lab(id, num, ProjectPrefix + num, dir, def));
        }
        return labs;
    }

    /// <summary>Exact id match only: the id has to name a lab folder that exists.</summary>
    public Lab? FindLab(string? id) => ValidId(id) ? LoadLabs().FirstOrDefault(l => l.Id == id) : null;

    // ---------------------------------------------------------------- vars and answers

    [GeneratedRegex(@"\{\{(\w+)\}\}")]
    private static partial Regex Placeholder();

    /// <summary>Replace {{NAME}} with this run's generated value; unknown names stay as they are.</summary>
    public static string Sub(string? text, IReadOnlyDictionary<string, string> vars) =>
        Placeholder().Replace(text ?? "", m => vars.TryGetValue(m.Groups[1].Value, out var v) ? v : m.Value);

    static readonly int[] PublicFirstOctets = [45, 62, 91, 103, 141, 176, 185, 193];

    public static Dictionary<string, string> GenVars(JsonObject? specs)
    {
        var vars = new Dictionary<string, string>();
        foreach (var (name, node) in specs ?? [])
        {
            var spec = node as JsonObject ?? throw new InvalidDataException($"var {name} has no spec");
            vars[name] = (string?)spec["type"] switch
            {
                "flag" => "DOJO{" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant() + "}",
                "int" => RandomNumberGenerator.GetInt32((int)spec["min"]!, (int)spec["max"]! + 1).ToString(),
                "choice" => spec["options"]!.AsArray()[RandomNumberGenerator.GetInt32(spec["options"]!.AsArray().Count)]!.ToString(),
                "ip" => $"{PublicFirstOctets[RandomNumberGenerator.GetInt32(PublicFirstOctets.Length)]}.{RandomNumberGenerator.GetInt32(1, 255)}.{RandomNumberGenerator.GetInt32(1, 255)}.{RandomNumberGenerator.GetInt32(2, 255)}",
                var t => throw new InvalidDataException($"unknown var type {t} for {name}"),
            };
        }
        return vars;
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    public static string Normalize(string? value, bool stripSpaces) =>
        Spaces().Replace((value ?? "").Trim().Trim('"', '\'').ToLowerInvariant(), stripSpaces ? "" : " ");

    static bool StripSpaces(JsonObject task) => task["strip_spaces"]?.GetValue<bool>() == true;

    /// <summary>The literal answers of a task (vars substituted). Empty for answer_cmd tasks.</summary>
    public static List<string> LiteralAnswers(JsonObject task, IReadOnlyDictionary<string, string> vars) => task["answer"] switch
    {
        JsonArray a => a.Select(x => Sub(x?.ToString(), vars)).ToList(),
        JsonNode n => [Sub(n.ToString(), vars)],
        _ => [],
    };

    public static bool Matches(JsonObject task, string? value, IEnumerable<string> expected)
    {
        var strip = StripSpaces(task);
        var got = Normalize(value, strip);
        return got.Length > 0 && expected.Any(e => Normalize(e, strip) == got);
    }

    /// <summary>True when the answer differs per run, so the lab has to be running to check it.</summary>
    public static bool NeedsRun(JsonObject task) => task.ContainsKey("answer_cmd") || (task["answer"]?.ToJsonString().Contains("{{") ?? false);

    // ---------------------------------------------------------------- state (.state/netlabs.json)

    JsonObject ReadState()
    {
        try { return File.Exists(_stateFile) ? JsonNode.Parse(File.ReadAllText(_stateFile)) as JsonObject ?? [] : []; }
        catch (JsonException) { return []; }
    }

    void WriteState(JsonObject s)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
        var tmp = _stateFile + ".tmp";
        File.WriteAllText(tmp, s.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, _stateFile, overwrite: true);
    }

    static JsonObject Section(JsonObject s, string name) => s[name] as JsonObject ?? (JsonObject)(s[name] = new JsonObject());

    public HashSet<string> DoneTasks(Lab lab)
    {
        lock (_stateLock)
            return (Section(ReadState(), "progress")[lab.Id] as JsonObject)?.Select(p => p.Key).ToHashSet() ?? [];
    }

    public void MarkDone(Lab lab, string taskId)
    {
        lock (_stateLock)
        {
            var s = ReadState();
            var p = Section(Section(s, "progress"), lab.Id);
            if (p.ContainsKey(taskId)) return;
            p[taskId] = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss");
            WriteState(s);
        }
    }

    public void ResetProgress(Lab lab)
    {
        lock (_stateLock)
        {
            var s = ReadState();
            Section(s, "progress").Remove(lab.Id);
            WriteState(s);
        }
    }

    public Dictionary<string, string> Vars(Lab lab)
    {
        lock (_stateLock)
            return (Section(ReadState(), "runs")[lab.Id]?["vars"] as JsonObject)?
                .ToDictionary(p => p.Key, p => p.Value?.ToString() ?? "") ?? [];
    }

    void SaveRun(Lab lab, Dictionary<string, string> vars)
    {
        lock (_stateLock)
        {
            var s = ReadState();
            var v = new JsonObject();
            foreach (var (k, val) in vars) v[k] = val;
            Section(s, "runs")[lab.Id] = new JsonObject { ["vars"] = v, ["started"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() };
            WriteState(s);
        }
    }

    // ---------------------------------------------------------------- docker

    public record Result(int Code, string Out, string Err)
    {
        public bool Ok => Code == 0;
    }

    /// <summary>Run docker with an argument list. Never throws; 124 = timed out, 127 = docker not found.</summary>
    public static async Task<Result> Docker(IEnumerable<string> args, TimeSpan timeout, IDictionary<string, string>? env = null, Action<string>? onLine = null,
        byte[]? input = null)
    {
        var psi = new ProcessStartInfo("docker")
        {
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        foreach (var (k, v) in env ?? new Dictionary<string, string>()) psi.Environment[k] = v;
        Process p;
        try { p = Process.Start(psi)!; }
        catch (Win32Exception) { return new(127, "", "docker was not found. Install Docker Desktop."); }
        using (p)
        {
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            // stdin: the bytes given (docker exec -i ... reads them), else closed at once.
            if (input is null) p.StandardInput.Close();
            else _ = Task.Run(async () =>
            {
                try { await p.StandardInput.BaseStream.WriteAsync(input); await p.StandardInput.BaseStream.FlushAsync(); }
                catch (Exception e) when (e is IOException or ObjectDisposedException) { }
                finally { try { p.StandardInput.Close(); } catch (Exception e) when (e is IOException or ObjectDisposedException) { } }
            });
            async Task Pump(StreamReader r, StringBuilder sb)
            {
                while (await r.ReadLineAsync() is { } line)
                {
                    lock (sb) { if (sb.Length < 200_000) sb.AppendLine(line); }
                    onLine?.Invoke(line);
                }
            }
            var pumps = Task.WhenAll(Pump(p.StandardOutput, stdout), Pump(p.StandardError, stderr));
            using var cts = new CancellationTokenSource(timeout);
            try { await p.WaitForExitAsync(cts.Token); await pumps.WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (Exception e) when (e is OperationCanceledException or TimeoutException)
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                if (!p.HasExited) return new(124, stdout.ToString(), "timed out");
            }
            return new(p.HasExited ? p.ExitCode : 124, stdout.ToString(), stderr.ToString());
        }
    }

    public Task<Result> Exec(Lab lab, string node, string cmd, int seconds = 40) =>
        Docker(["exec", lab.Container(node), "bash", "-c", cmd], TimeSpan.FromSeconds(seconds));

    public record DockerStatus(bool Ok, string State, string Message, string? Version);
    DockerStatus? _status;
    DateTime _statusAt;

    public async Task<DockerStatus> Status(bool fresh = false)
    {
        if (!fresh && _status is { } s && DateTime.UtcNow - _statusAt < TimeSpan.FromSeconds(s.Ok ? 15 : 4)) return s;
        _status = await Probe();
        _statusAt = DateTime.UtcNow;
        return _status;
    }

    /// <summary>Ask Docker whether it is running, with a message a learner can act on (shared with TermSteps.cs).</summary>
    public static async Task<DockerStatus> Probe()
    {
        var r = await Docker(["info", "--format", "{{.ServerVersion}}"], TimeSpan.FromSeconds(20));
        return r.Code switch
        {
            0 => new(true, "running", "Docker is running.", r.Out.Trim()),
            127 => new(false, "missing", "Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then come back here.", null),
            124 => new(false, "slow", "Docker did not answer in time. If Docker Desktop is still starting, wait until its whale icon stops animating, then press Retry.", null),
            _ => new(false, "stopped", "Docker Desktop is not running. Start Docker Desktop from the Start menu, wait until it says \"Engine running\", then press Retry.", null),
        };
    }

    HashSet<string>? _projects;
    DateTime _projectsAt;

    public async Task<HashSet<string>> RunningProjects(bool fresh = false)
    {
        if (!fresh && _projects is { } p && DateTime.UtcNow - _projectsAt < TimeSpan.FromSeconds(2)) return p;
        var r = await Docker(["ps", "--format", "{{.Label \"com.docker.compose.project\"}}"], TimeSpan.FromSeconds(20));
        _projects = r.Ok ? r.Out.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).ToHashSet() : [];
        _projectsAt = DateTime.UtcNow;
        return _projects;
    }

    public async Task<bool> IsRunning(Lab lab) => (await RunningProjects()).Contains(lab.Project);

    // ---------------------------------------------------------------- toolbox image build (background, DockerImage.cs)

    DockerImage? _toolbox;
    DockerImage ToolboxImage => _toolbox ??= new DockerImage(Toolbox, _imageDir);

    /// <summary>Built and current; an outdated image starts rebuilding in the background (DockerImage.Usable).</summary>
    public Task<bool> ImageReady() => ToolboxImage.Usable();
    public string BuildState => ToolboxImage.State;   // idle | building | done | failed
    public object BuildInfo() => ToolboxImage.Info();
    public bool StartBuild() => ToolboxImage.StartBuild();

    // ---------------------------------------------------------------- lifecycle

    SemaphoreSlim LabLock(Lab lab) => _labLocks.GetOrAdd(lab.Id, _ => new SemaphoreSlim(1, 1));

    public async Task<(bool Ok, string Msg)> Start(Lab lab)
    {
        if (!(await Status(fresh: true)).Ok) return (false, _status!.Message);
        if (!await ImageReady())
            return (false, ToolboxImage.Outdated
                ? "The lab tools image is being updated (its files changed since it was built). Wait until the banner above clears, then start the lab."
                : "The lab tools image is not built yet. Press \"Build the tools image\" first.");
        var gate = LabLock(lab);
        if (!await gate.WaitAsync(0)) return (false, "This lab is already starting or stopping.");
        try
        {
            await Down(lab);
            var vars = GenVars(lab.Def["vars"] as JsonObject);
            SaveRun(lab, vars);
            var env = vars.ToDictionary(kv => "DOJO_" + kv.Key, kv => kv.Value);
            var up = await Docker(["compose", "-p", lab.Project, "-f", lab.ComposeFile, "up", "-d"], TimeSpan.FromMinutes(10), env);
            _projects = null;
            if (!up.Ok)
            {
                var err = Tail(up.Err, 1500);
                if (err.Contains("overlap", StringComparison.OrdinalIgnoreCase))
                    err += "\n\nAnother Docker network uses the same addresses. If netsec-dojo (or another copy of this lab) is running, stop it first.";
                return (false, "Could not start the lab:\n" + err);
            }
            var pending = (lab.Def["ready"] as JsonArray ?? []).OfType<JsonObject>().ToList();
            // JVM-based labs (Camel) need longer than plain toolbox nodes: lab.json may say how long.
            var deadline = DateTime.UtcNow.AddSeconds(Math.Clamp((int?)lab.Def["ready_seconds"] ?? 45, 10, 300));
            while (pending.Count > 0 && DateTime.UtcNow < deadline)
            {
                var still = new List<JsonObject>();
                foreach (var c in pending)
                    if (!HasNodeCmd(lab, c, out var node, out var cmd) || !(await Exec(lab, node, Sub(cmd, vars), 15)).Ok) still.Add(c);
                pending = still;
                if (pending.Count > 0) await Task.Delay(1000);
            }
            if (pending.Count > 0)
                return (false, "The lab started but some services did not come up: " + string.Join(", ", pending.Select(c => (string?)c["node"])) + ". Try Restart.");
            return (true, "Lab started.");
        }
        finally { gate.Release(); }
    }

    public async Task<(bool Ok, string Msg)> Stop(Lab lab)
    {
        var gate = LabLock(lab);
        await gate.WaitAsync();
        try
        {
            var r = await Down(lab);
            return r.Ok ? (true, "Lab stopped.") : (false, Tail(r.Err, 800));
        }
        finally { gate.Release(); }
    }

    async Task<Result> Down(Lab lab)
    {
        var r = await Docker(["compose", "-p", lab.Project, "down", "-v", "--remove-orphans", "-t", "1"], TimeSpan.FromMinutes(3));
        _projects = null;
        return r;
    }

    static bool HasNodeCmd(Lab lab, JsonObject c, out string node, out string cmd)
    {
        node = (string?)c["node"] ?? "";
        cmd = (string?)c["cmd"] ?? "";
        return lab.HasNode(node) && cmd.Length > 0;
    }

    static string Tail(string s, int n) => s.Length <= n ? s.Trim() : "..." + s[^n..].Trim();

    // ---------------------------------------------------------------- checking

    public async Task<(bool Ok, string Msg)> CheckState(Lab lab, JsonObject task, bool record = true)
    {
        if (!await IsRunning(lab)) return (false, "The lab is not running. Start it first.");
        var vars = Vars(lab);
        foreach (var c in (task["checks"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (!HasNodeCmd(lab, c, out var node, out var cmd)) return (false, "This check is broken in lab.json.");
            var r = await Exec(lab, node, Sub(cmd, vars), 30);
            var wantOk = ((string?)c["expect"] ?? "ok") == "ok";
            if (r.Ok != wantOk) return (false, Sub((string?)c["fail_msg"] ?? "Not there yet.", vars));
        }
        if (record) MarkDone(lab, (string)task["id"]!);
        return (true, "Passed.");
    }

    public async Task<List<string>> ExpectedAnswers(Lab lab, JsonObject task, IReadOnlyDictionary<string, string> vars)
    {
        if (task["answer_cmd"] is JsonObject c)
        {
            if (!HasNodeCmd(lab, c, out var node, out var cmd)) return [];
            var r = await Exec(lab, node, Sub(cmd, vars));
            var last = LastLine(r.Out);
            return r.Ok && last.Length > 0 ? [last] : [];
        }
        return LiteralAnswers(task, vars);
    }

    public static string LastLine(string s) => s.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? "";

    public async Task<(bool Ok, string Msg)> CheckAnswer(Lab lab, JsonObject task, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return (false, "Type an answer first.");
        if (NeedsRun(task) && !await IsRunning(lab)) return (false, "Start the lab first: this answer is different on every run.");
        var expected = await ExpectedAnswers(lab, task, Vars(lab));
        if (expected.Count == 0) return (false, "The lab could not work out the expected answer. Is everything still running? Try Restart.");
        if (!Matches(task, value, expected)) return (false, "Not quite.");
        MarkDone(lab, (string)task["id"]!);
        return (true, "Correct.");
    }

    // ---------------------------------------------------------------- topology (from docker-compose.yml)

    public record Attach(string Net, string Ip);
    public record TopoNode(string Name, string Desc, List<Attach> Addrs);
    public record TopoNet(string Name, string? Subnet);
    public record Topology(List<TopoNode> Nodes, List<TopoNet> Networks);

    [GeneratedRegex(@"([A-Za-z0-9_-]+):\s*\{\s*ipv4_address:\s*(?:""([^""]+)""|([^""}\s,]+))\s*\}")]
    private static partial Regex NetAttach();

    [GeneratedRegex(@"subnet:\s*""?([0-9./]+)")]
    private static partial Regex SubnetRe();

    [GeneratedRegex(@"\$\{DOJO_(\w+)\}")]
    private static partial Regex ComposeVar();

    /// <summary>
    /// A small reader for the compose files these labs use (not general YAML): which service
    /// joins which network with which address, and each network's subnet.
    /// </summary>
    public static Topology ParseTopology(string compose, JsonObject nodes, IReadOnlyDictionary<string, string> vars)
    {
        var attach = new Dictionary<string, List<Attach>>();
        var nets = new List<TopoNet>();
        string? section = null, service = null, net = null;
        var inNetworks = false;
        foreach (var raw in compose.Replace("\r", "").Split('\n'))
        {
            var line = raw.Split(" #")[0].TrimEnd();
            if (line.Trim().Length == 0 || line.TrimStart().StartsWith('#')) continue;
            var indent = line.Length - line.TrimStart().Length;
            var text = line.Trim();
            if (indent == 0) { section = text.TrimEnd(':'); service = net = null; inNetworks = false; continue; }
            if (section == "services")
            {
                if (indent == 2) { service = text.Split(':')[0]; inNetworks = false; continue; }
                if (service is null) continue;
                if (indent == 4) inNetworks = text.StartsWith("networks:");
                if (!inNetworks && indent == 4) continue;
                if (inNetworks)
                    foreach (Match m in NetAttach().Matches(text))
                    {
                        var ip = ComposeVar().Replace(m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value, v => vars.TryGetValue(v.Groups[1].Value, out var x) ? x : "?");
                        (attach.TryGetValue(service, out var l) ? l : attach[service] = []).Add(new(m.Groups[1].Value, ip));
                    }
            }
            else if (section == "networks")
            {
                if (indent == 2) { net = text.Split(':')[0]; nets.Add(new(net, null)); }
                if (net is not null && SubnetRe().Match(text) is { Success: true } sm)
                    nets[^1] = nets[^1] with { Subnet = sm.Groups[1].Value };
            }
        }
        var list = nodes.Select(n => new TopoNode(n.Key, n.Value?.ToString() ?? "", attach.GetValueOrDefault(n.Key) ?? [])).ToList();
        return new(list, nets);
    }

    // ---------------------------------------------------------------- views for the UI

    public async Task<object> Overview()
    {
        var docker = await Status();
        var up = docker.Ok ? await RunningProjects() : [];
        var image = docker.Ok && await ImageReady();
        return new
        {
            docker, image, build = BuildInfo(),
            labs = LoadLabs().Select(l =>
            {
                var done = DoneTasks(l);
                var ids = l.Tasks.Select(t => (string?)t["id"]).ToList();
                return new
                {
                    id = l.Id, num = l.Num, title = l.Title, module = (string?)l.Def["module"], minutes = (int?)l.Def["minutes"],
                    summary = (string?)l.Def["summary"] ?? "", download = (string?)l.Def["download"], running = up.Contains(l.Project),
                    done = ids.Count(i => i is not null && done.Contains(i)), total = ids.Count,
                };
            }),
        };
    }

    public async Task<object> Detail(Lab lab)
    {
        var running = await IsRunning(lab);
        var vars = running ? Vars(lab) : [];
        var done = DoneTasks(lab);
        var lesson = Path.Combine(lab.Dir, "lesson.md");
        var compose = File.Exists(lab.ComposeFile) ? File.ReadAllText(lab.ComposeFile) : "";
        return new
        {
            id = lab.Id, num = lab.Num, title = lab.Title, module = (string?)lab.Def["module"], minutes = (int?)lab.Def["minutes"],
            summary = (string?)lab.Def["summary"] ?? "", download = (string?)lab.Def["download"], running, defaultNode = (string?)lab.Def["default_node"] ?? lab.Nodes.FirstOrDefault().Key,
            lesson = File.Exists(lesson) ? File.ReadAllText(lesson) : "",
            topology = ParseTopology(compose, lab.Nodes, vars),
            tasks = lab.Tasks.Select(t => new
            {
                id = (string?)t["id"], title = (string?)t["title"], type = (string?)t["type"],
                text = Sub((string?)t["text"], vars), done = done.Contains((string?)t["id"] ?? ""),
                hints = (t["hints"] as JsonArray)?.Count ?? 0, hasSolution = t.ContainsKey("solution"),
            }),
        };
    }

    public object Hints(Lab lab, JsonObject task, int n)
    {
        var hints = (task["hints"] as JsonArray ?? []).Select(x => x?.ToString() ?? "").ToList();
        var vars = Vars(lab);
        return new { hints = hints.Take(Math.Clamp(n, 0, hints.Count)).Select(x => Sub(x, vars)), total = hints.Count };
    }

    public object Solution(Lab lab, JsonObject task)
    {
        var vars = Vars(lab);
        var sol = task["solution"] as JsonObject ?? [];
        var steps = (sol["steps"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        if (sol["answer_cmd"] is JsonObject ac) steps.Add(ac);
        return new
        {
            note = Sub((string?)sol["note"], vars),
            answer = sol["answer"] is JsonNode a ? Sub(a.ToString(), vars) : null,
            steps = steps.Select(s => new { node = (string?)s["node"], cmd = Sub((string?)s["cmd"], vars) }),
        };
    }

    // ---------------------------------------------------------------- in-page terminal

    /// <summary>
    /// Starts the in-page terminal's shell (run as `sh -c ShellBoot`). A real pty inside the container when `script` is
    /// there (prompt, Ctrl+C, line editing), else the shell as it is. bash when the image has it, else sh (Alpine, BusyBox).
    /// With DOJO_RC in the environment (the live labs send the stand-ins of netlabs/images/shell/dojo-linerc that way, so
    /// any image works, with nothing baked in), it is written to /tmp and read as bash's --rcfile or sh's $ENV; it is
    /// taken out of the environment again, so `env` in a lab shows nothing extra.
    /// </summary>
    public const string ShellBoot =
        "rc=; if [ -n \"${DOJO_RC:-}\" ]; then rc=/tmp/.dojo-rc-$(id -u); printf '%s\\n' \"$DOJO_RC\" > \"$rc\" 2>/dev/null || rc=; fi; unset DOJO_RC; " +
        "if command -v bash >/dev/null 2>&1; then if [ -n \"$rc\" ]; then s=\"bash --rcfile $rc -i\"; else s='bash -i'; fi; " +
        "else s='sh -i'; if [ -n \"$rc\" ]; then ENV=$rc; export ENV; fi; fi; " +
        "if command -v script >/dev/null 2>&1; then exec script -qfc \"stty cols 160 rows 40 -echoctl 2>/dev/null; exec $s\" /dev/null; else exec $s; fi";

    /// <summary>Environment for a line-based terminal: no pagers, and full-screen editors open the page's editor.</summary>
    public static readonly string[] LineTermEnv =
        ["TERM=xterm-256color", "DOJO_LINE_TERM=1", "DOJO_EDITOR=page", "PAGER=cat", "GIT_PAGER=cat", "MANPAGER=cat", "SYSTEMD_PAGER="];

    /// <summary>
    /// The rc a live-lab shell starts with: the host's own bash setup (its prompt), then the shared stand-ins
    /// (netlabs/images/shell/dojo-linerc, the same file terminal steps use). Read on every terminal, so edits apply at once.
    /// </summary>
    public string LabRc()
    {
        var file = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(_imageDir))!, "shell", "dojo-linerc");
        var standins = File.Exists(file) ? File.ReadAllText(file).Replace("\r", "") : "";
        return "if [ -n \"${BASH_VERSION:-}\" ]; then [ -f /etc/bash.bashrc ] && . /etc/bash.bashrc; [ -f ~/.bashrc ] && . ~/.bashrc; fi\n" + standins;
    }

    public const string LabWorkdir = "/root";

    public async Task Terminal(HttpContext ctx, Lab lab, string node)
    {
        using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        async Task Say(string text) => await ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);
        if (!await IsRunning(lab)) { await Say("\r\n[the lab is not running: start it first]\r\n"); await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "not running", default); return; }
        if (Interlocked.Increment(ref _terminals) > MaxTerminals)
        {
            Interlocked.Decrement(ref _terminals);
            await Say("\r\n[too many terminals open: close some tabs]\r\n");
            await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "too many", default);
            return;
        }
        var args = new List<string> { "exec", "-i", "-w", LabWorkdir };
        foreach (var e in LineTermEnv.Append("DOJO_RC=" + LabRc())) { args.Add("-e"); args.Add(e); }
        args.AddRange([lab.Container(node), "sh", "-c", ShellBoot]);
        try { await Bridge(ctx, ws, args); }
        finally { Interlocked.Decrement(ref _terminals); }
    }

    /// <summary>
    /// Bridges an accepted WebSocket to a `docker exec -i ...` process: socket messages go to its stdin, its stdout and
    /// stderr come back as text messages. Ends when either side closes; the process is always killed. Shared by the live
    /// labs and the terminal steps (TermSteps.cs). <paramref name="onInput"/> is called for every message from the page.
    /// </summary>
    public static async Task Bridge(HttpContext ctx, WebSocket ws, IEnumerable<string> dockerArgs, Action? onInput = null)
    {
        async Task Say(string text) => await ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);
        var psi = new ProcessStartInfo("docker")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
        };
        foreach (var a in dockerArgs) psi.ArgumentList.Add(a);
        Process? p = null;
        try
        {
            p = Process.Start(psi)!;
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
            var sendLock = new SemaphoreSlim(1, 1);
            async Task Pump(Stream s)
            {
                var buf = new byte[8192];
                var dec = Encoding.UTF8.GetDecoder();
                var chars = new char[8192 + 4];
                try
                {
                    int n;
                    while ((n = await s.ReadAsync(buf, cts.Token)) > 0)
                    {
                        var c = dec.GetChars(buf, 0, n, chars, 0);
                        if (c == 0) continue;
                        await sendLock.WaitAsync(cts.Token);
                        try { await ws.SendAsync(Encoding.UTF8.GetBytes(chars, 0, c), WebSocketMessageType.Text, true, cts.Token); }
                        finally { sendLock.Release(); }
                    }
                }
                catch (Exception e) when (e is OperationCanceledException or WebSocketException or ObjectDisposedException) { }
            }
            var outTask = Pump(p.StandardOutput.BaseStream);
            var errTask = Pump(p.StandardError.BaseStream);
            var inTask = Task.Run(async () =>
            {
                var buf = new byte[4096];
                try
                {
                    while (ws.State == WebSocketState.Open)
                    {
                        var r = await ws.ReceiveAsync(buf, cts.Token);
                        if (r.MessageType == WebSocketMessageType.Close) break;
                        onInput?.Invoke();
                        await p.StandardInput.BaseStream.WriteAsync(buf.AsMemory(0, r.Count), cts.Token);
                        await p.StandardInput.BaseStream.FlushAsync(cts.Token);
                    }
                }
                catch (Exception e) when (e is OperationCanceledException or WebSocketException or IOException or ObjectDisposedException) { }
            });
            await Task.WhenAny(inTask, p.WaitForExitAsync(cts.Token));
            if (p.HasExited)
            {
                await Task.WhenAny(Task.WhenAll(outTask, errTask), Task.Delay(1000));
                if (ws.State == WebSocketState.Open) { await Say("\r\n[shell closed]\r\n"); }
            }
            cts.Cancel();
            if (ws.State == WebSocketState.Open)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
        }
        catch (Exception e) when (e is Win32Exception or WebSocketException or OperationCanceledException or IOException) { }
        finally
        {
            if (p is not null)
            {
                try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { }
                p.Dispose();
            }
        }
    }

    // ---------------------------------------------------------------- HTTP endpoints

    public record TaskRequest(string? Task, string? Value, int? N);
    public record FileRequest(string? Node, string? Path, string? Text, string? Eol, string? Hash, bool? Root);

    static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    /// <summary>The page editor's answers (ui/fileedit.js), shared with TermSteps.cs.</summary>
    public static IResult FileReply(ContainerFiles.ReadResult r) =>
        Results.Json(new { ok = r.Ok, state = r.State, msg = r.Message, path = r.Path, text = r.Text, eol = r.Eol, hash = r.Hash }, WebJson);

    public static IResult FileReply(ContainerFiles.WriteResult r) =>
        Results.Json(new { ok = r.Ok, state = r.State, msg = r.Message, hash = r.Hash }, WebJson);

    /// <summary>Wire every live-lab endpoint. Called once from Program.cs.</summary>
    public static NetLabs Map(WebApplication app, string root, string stateDir)
    {
        var labs = new NetLabs(Path.Combine(root, "netlabs", "labs"), Path.Combine(root, "netlabs", "images", "toolbox"), stateDir);
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

        app.MapGet("/api/netlabs", async (bool? fresh) =>
        {
            if (fresh == true) await labs.Status(fresh: true);
            return Results.Json(await labs.Overview(), json);
        });
        app.MapPost("/api/netlabs/setup", async () =>
        {
            if (!(await labs.Status(fresh: true)).Ok) return Results.Json(new { ok = false, msg = labs._status!.Message }, json);
            labs.StartBuild();
            return Results.Json(new { ok = true, build = labs.BuildInfo() }, json);
        });
        app.MapPost("/api/netlabs/stop-all", async () =>
        {
            var up = await labs.RunningProjects(fresh: true);
            foreach (var l in labs.LoadLabs().Where(l => up.Contains(l.Project))) await labs.Stop(l);
            return Results.Json(new { ok = true }, json);
        });
        app.MapGet("/api/netlabs/{id}", async (string id) =>
            labs.FindLab(id) is { } lab ? Results.Json(await labs.Detail(lab), json) : Results.NotFound());

        app.MapPost("/api/netlabs/{id}/{action}", async (string id, string action, TaskRequest? req) =>
        {
            if (labs.FindLab(id) is not { } lab) return Results.NotFound();
            object Reply((bool Ok, string Msg) r) => new { ok = r.Ok, msg = r.Msg };
            switch (action)
            {
                case "start": return Results.Json(Reply(await labs.Start(lab)), json);
                case "stop": return Results.Json(Reply(await labs.Stop(lab)), json);
                case "reset": labs.ResetProgress(lab); return Results.Json(new { ok = true }, json);
            }
            if (lab.Task(req?.Task) is not { } task) return Results.NotFound();
            return action switch
            {
                "check" => Results.Json(Reply((string?)task["type"] == "state"
                    ? await labs.CheckState(lab, task)
                    : await labs.CheckAnswer(lab, task, req!.Value)), json),
                "hint" => Results.Json(labs.Hints(lab, task, req!.N ?? 1), json),
                "solution" => Results.Json(labs.Solution(lab, task), json),
                _ => Results.NotFound(),
            };
        });

        // The page's file editor (ui/fileedit.js): `nano file` / `vim file` in a lab terminal, or its Open file button.
        // As the container's own user (the one the terminal runs as), or as root for sudoedit / "save as root".
        app.MapPost("/api/netlabs/{id}/file/{op}", async (string id, string op, FileRequest req) =>
        {
            if (labs.FindLab(id) is not { } lab || !lab.HasNode(req.Node)) return Results.NotFound();
            if (!await labs.IsRunning(lab)) return Results.Json(new { ok = false, state = "gone", msg = "The lab is not running. Start it first." }, json);
            var user = req.Root == true ? "0" : null;
            return op switch
            {
                "read" => FileReply(await ContainerFiles.Read(lab.Container(req.Node!), user, LabWorkdir, req.Path ?? "")),
                "write" => FileReply(await ContainerFiles.Write(lab.Container(req.Node!), user, LabWorkdir, req.Path ?? "", req.Text ?? "", req.Eol, req.Hash)),
                _ => Results.NotFound(),
            };
        });

        // The terminal. The global middleware has already checked Host and (if present) Origin;
        // a WebSocket must also come from our own page, so here the Origin is required.
        app.Map("/api/netlabs/{id}/term/{node}", async (HttpContext ctx, string id, string node) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) return Results.BadRequest("WebSocket only");
            var host = ctx.Request.Host.Value ?? "";
            var hostName = ctx.Request.Host.Host;
            if (ctx.Request.Headers.Origin.ToString() != "http://" + host || (hostName != "127.0.0.1" && hostName != "localhost"))
                return Results.StatusCode(403);
            if (labs.FindLab(id) is not { } lab || !lab.HasNode(node)) return Results.NotFound();
            await labs.Terminal(ctx, lab, node);
            return Results.Empty;
        });
        return labs;
    }
}
