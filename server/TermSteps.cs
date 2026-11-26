using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// "terminal" lesson steps: the learner gets a real shell in a throwaway container, set up with a scenario by the
/// lesson, and the checks run real commands against the state they leave behind. Format: tracks/AUTHORING.md,
/// "terminal". Lifecycle guarantees:
///   - one container per (lesson, step), started when the step opens and reused while the learner stays;
///   - removed when the page says the learner left the step, after a grace period with no terminal attached,
///     after an idle timeout, when the server stops, and at the next start (leftovers of a crash);
///   - at most <see cref="Options.MaxContainers"/> at once (the oldest one without a terminal makes room);
///   - memory, CPU and process limits; no network unless the step says "network": true;
///   - every container carries the label code-dojo.termstep=&lt;instance&gt;, and only containers with this
///     instance's label are ever removed.
/// Docker is only called with argument lists; lesson, module and step come from the server's own content.
/// </summary>
public sealed partial class TermSteps : IAsyncDisposable
{
    public const string Label = "code-dojo.termstep";
    public const string StepLabel = "code-dojo.step";
    public const string User = "learner";
    public const string Home = "/home/learner";
    public const string FilesIn = "/opt/dojo/files";

    public sealed record Options
    {
        public int MaxContainers { get; init; } = 4;
        public TimeSpan Idle { get; init; } = TimeSpan.FromMinutes(30);          // no keystroke or check for this long
        public TimeSpan Grace { get; init; } = TimeSpan.FromMinutes(5);          // no terminal attached for this long
        public TimeSpan SweepEvery { get; init; } = TimeSpan.FromSeconds(30);
        public string Memory { get; init; } = "512m";
        public string Cpus { get; init; } = "1";
        public int Pids { get; init; } = 256;
    }

    // ---------------------------------------------------------------- the step, as authored

    public sealed record Check(string Name, string Cmd, int? ExpectExit, string? ExpectOutput, IReadOnlyList<string> ExpectContains,
        string? ExpectMatch, string Fail, string RunAs, bool Quiet);

    public sealed record Spec(string Key, string Image, bool Network, string Setup, string? FilesDir, IReadOnlyList<Check> Checks, string Solution);

    public sealed record CheckRow(string Name, bool Pass, string? Detail);

    static string? Str(JsonObject o, string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>Lines of a field that may be a string (newline separated) or an array of strings.</summary>
    static List<string> Lines(JsonNode? n) => n switch
    {
        JsonArray a => a.Select(x => x is JsonValue v && v.TryGetValue<string>(out var s) ? s : throw new InvalidDataException("must be strings")).ToList(),
        JsonValue v when v.TryGetValue<string>(out var s) => s.Length == 0 ? [] : s.Split('\n').ToList(),
        null => [],
        _ => throw new InvalidDataException("must be a string or an array of strings"),
    };

    [GeneratedRegex(@"^[a-z0-9][a-z0-9_-]{0,40}$")]
    private static partial Regex ImageName();

    [GeneratedRegex(@"^(files/)?([A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.sh$")]
    private static partial Regex ScriptPath();

    /// <summary>
    /// Reads a terminal step. <paramref name="moduleDir"/> is the lesson's module folder; its files/ folder is copied to
    /// /opt/dojo/files in the container, and a setup entry naming a .sh file there runs that script.
    /// Throws InvalidDataException with an author-facing message when the step is malformed.
    /// </summary>
    public static Spec Parse(JsonObject step, string key, string moduleDir)
    {
        var image = Str(step, "image") ?? "shell";
        if (!ImageName().IsMatch(image)) throw new InvalidDataException($"\"image\": \"{image}\" is not an image folder name");
        var network = step["network"] switch { null => false, JsonValue v when v.TryGetValue<bool>(out var b) => b, _ => throw new InvalidDataException("\"network\" must be true or false") };
        if (Str(step, "prompt") is not { Length: > 0 }) throw new InvalidDataException("missing 'prompt'");

        var filesDir = Path.Combine(moduleDir, "files");
        var setup = new StringBuilder();
        List<string> setupLines;
        try { setupLines = Lines(step["setup"]); } catch (InvalidDataException e) { throw new InvalidDataException("\"setup\" " + e.Message); }
        foreach (var raw in setupLines)
        {
            var line = raw.Trim();
            if (ScriptPath().IsMatch(line))
            {
                var rel = line.StartsWith("files/", StringComparison.Ordinal) ? line[6..] : line;
                if (!File.Exists(Path.Combine(filesDir, rel))) throw new InvalidDataException($"setup script {line} is not in {Path.GetFileName(moduleDir)}/files/");
                setup.Append("( cd ~ && bash \"$DOJO_FILES/").Append(rel).Append("\" )\n");
            }
            else setup.Append(raw).Append('\n');
        }

        var checks = new List<Check>();
        if (step["checks"] is not JsonArray { Count: > 0 } list) throw new InvalidDataException("needs a non-empty \"checks\" array");
        foreach (var (node, i) in list.Select((n, i) => (n, i + 1)))
        {
            if (node is not JsonObject c) throw new InvalidDataException($"check {i} is not an object");
            var name = Str(c, "name") is { Length: > 0 } nm ? nm : throw new InvalidDataException($"check {i} needs a \"name\"");
            var cmd = Lines(c["cmd"]) is { Count: > 0 } cl ? string.Join("\n", cl) : throw new InvalidDataException($"check \"{name}\" needs a \"cmd\"");
            int? exit = c["expectExit"] switch { null => null, JsonValue v when v.TryGetValue<int>(out var x) => x, _ => throw new InvalidDataException($"check \"{name}\": \"expectExit\" must be a number") };
            var contains = Lines(c["expectContains"]);
            var match = Str(c, "expectMatch");
            if (match is not null)
                try { _ = new Regex(match, RegexOptions.Multiline); } catch (ArgumentException e) { throw new InvalidDataException($"check \"{name}\": bad \"expectMatch\": {e.Message}"); }
            var user = Str(c, "user") ?? User;
            if (user is not (User or "root")) throw new InvalidDataException($"check \"{name}\": \"user\" is \"{User}\" or \"root\"");
            checks.Add(new(name, cmd, exit, c["expectOutput"] is null ? null : string.Join("\n", Lines(c["expectOutput"])), contains, match,
                Str(c, "fail") ?? "Not there yet.", user, (bool?)(c["quiet"] as JsonValue) == true));
        }
        if (checks.Select(c => c.Name).Distinct().Count() != checks.Count) throw new InvalidDataException("check names must be unique");
        var solution = string.Join("\n", Lines(step["solution"]));
        return new(key, image, network, setup.ToString(), Directory.Exists(filesDir) ? filesDir : null, checks, solution);
    }

    /// <summary>Did this check pass, given what its command did? Exit code only counts when asked for, or when nothing else is.</summary>
    public static bool Judge(Check c, NetLabs.Result r)
    {
        var output = Checker.Tidy(r.Out);
        var ok = true;
        if (c.ExpectExit is { } want) ok &= r.Code == want;
        if (c.ExpectOutput is { } exact) ok &= output == Checker.Tidy(exact);
        foreach (var part in c.ExpectContains) ok &= r.Out.Contains(part, StringComparison.Ordinal);
        if (c.ExpectMatch is { } re) ok &= Regex.IsMatch(r.Out, re, RegexOptions.Multiline);
        if (c.ExpectExit is null && c.ExpectOutput is null && c.ExpectContains.Count == 0 && c.ExpectMatch is null) ok = r.Code == 0;
        return ok && r.Code != 124;
    }

    // ---------------------------------------------------------------- sessions

    sealed class Session(string key, string name)
    {
        public string Key { get; } = key;
        public string Name { get; } = name;
        public DateTime Created { get; } = DateTime.UtcNow;
        public DateTime LastActive = DateTime.UtcNow;
        public DateTime? Detached;
        public int Terminals;
        public void Touch() => LastActive = DateTime.UtcNow;
    }

    readonly string _imagesDir, _instance;
    readonly Options _opt;
    readonly ConcurrentDictionary<string, Session> _sessions = new();
    readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();
    readonly ConcurrentDictionary<string, DockerImage> _images = new();
    readonly SemaphoreSlim _create = new(1, 1);     // one container start at a time: easy on a hot laptop
    readonly Timer? _sweeper;
    int _disposed;

    /// <param name="imagesDir">netlabs/images: "image": "shell" is built from netlabs/images/shell as dojo-shell:latest.</param>
    /// <param name="instance">Labels this server's containers; only those are ever removed. Letters, digits and dashes.</param>
    public TermSteps(string imagesDir, string instance, Options? options = null, bool sweep = true)
    {
        _imagesDir = imagesDir;
        _instance = Regex.Replace(instance.ToLowerInvariant(), "[^a-z0-9-]", "-");
        _opt = options ?? new Options();
        if (sweep) _sweeper = new Timer(_ => _ = Sweep(DateTime.UtcNow), null, _opt.SweepEvery, _opt.SweepEvery);
    }

    public string Instance => _instance;

    public DockerImage ImageFor(string image) =>
        _images.GetOrAdd(image, i => new DockerImage($"dojo-{i}:latest", Path.Combine(_imagesDir, i)));

    public bool ImageExists(string image) => File.Exists(Path.Combine(_imagesDir, image, "Dockerfile"));

    public string ContainerName(string key) =>
        $"cdterm-{_instance}-{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..10].ToLowerInvariant()}";

    SemaphoreSlim LockOf(string key) => _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));

    public IReadOnlyList<(string Key, string Name, int Terminals, DateTime LastActive)> List() =>
        _sessions.Values.Select(s => (s.Key, s.Name, s.Terminals, s.LastActive)).OrderBy(s => s.Key, StringComparer.Ordinal).ToList();

    public sealed record OpenResult(string State, string Message, object? Build = null, long? ImageBytes = null, bool Fresh = false)
    {
        public bool Ok => State == "ready";
    }

    static string Tail(string s, int n) => s.Length <= n ? s.Trim() : "..." + s[^n..].Trim();

    Task<NetLabs.Result> Exec(string name, string user, string script, int seconds, params string[] env)
    {
        var args = new List<string> { "exec", "-u", user, "-w", Home, "-e", "HOME=" + (user == "root" ? "/root" : Home), "-e", "DOJO_FILES=" + FilesIn };
        foreach (var e in env) { args.Add("-e"); args.Add(e); }
        args.AddRange([name, "bash", "-c", script]);
        return NetLabs.Docker(args, TimeSpan.FromSeconds(seconds));
    }

    /// <summary>
    /// Make sure the step's container is up, starting and setting it up when needed. With <paramref name="fresh"/>,
    /// any existing one is thrown away first (Reset scenario). Builds the image on first use (in the background:
    /// the state is "building" until it is done).
    /// </summary>
    public async Task<OpenResult> Open(Spec spec, bool fresh = false, bool waitForImage = false)
    {
        var docker = await NetLabs.Probe();
        if (!docker.Ok) return new("docker", docker.Message);
        var image = ImageFor(spec.Image);
        if (!await image.Ready())
        {
            if (!ImageExists(spec.Image)) return new("failed", $"There is no image folder netlabs/images/{spec.Image}.");
            if (!waitForImage)
            {
                if (image.State == "failed") return new("failed", "The shell image build failed. Press Try again; the log is below.", image.Info());
                image.StartBuild();
                return new("building", "Building the shell image (first time only: a few minutes, it downloads Debian and the tools).", image.Info());
            }
            if (!await image.Ensure()) return new("failed", "The shell image build failed.", image.Info());
        }
        var gate = LockOf(spec.Key);
        await gate.WaitAsync();
        try
        {
            if (!fresh && _sessions.TryGetValue(spec.Key, out var have))
            {
                if (await Running(have.Name)) { have.Touch(); return new("ready", "The scenario is ready.", null, await image.Size()); }
                _sessions.TryRemove(spec.Key, out _);
            }
            if (_sessions.TryRemove(spec.Key, out var old)) await RemoveContainer(old.Name);
            return await Create(spec, image);
        }
        finally { gate.Release(); }
    }

    /// <summary>Reset scenario: throw the container away and set the step up again from scratch.</summary>
    public Task<OpenResult> Reset(Spec spec) => Open(spec, fresh: true);

    async Task<OpenResult> Create(Spec spec, DockerImage image)
    {
        await _create.WaitAsync();
        try
        {
            // The cap: the least recently used container with no terminal attached makes room.
            while (_sessions.Count >= _opt.MaxContainers)
            {
                var victim = _sessions.Values.Where(s => s.Terminals == 0).OrderBy(s => s.LastActive).FirstOrDefault();
                if (victim is null)
                    return new("busy", $"{_opt.MaxContainers} terminal steps are already open in other tabs. Close one of them, then press Retry.");
                await Remove(victim.Key);
            }
            var name = ContainerName(spec.Key);
            await RemoveContainer(name);   // a leftover from a crash (only when it carries our label)
            var args = new List<string>
            {
                "run", "-d", "--name", name, "--label", $"{Label}={_instance}", "--label", $"{StepLabel}={spec.Key}",
                "--hostname", "dojo", "--init", "--memory", _opt.Memory, "--memory-swap", _opt.Memory, "--cpus", _opt.Cpus,
                "--pids-limit", _opt.Pids.ToString(),
            };
            if (!spec.Network) args.AddRange(["--network", "none"]);
            args.AddRange([image.Tag, "sleep", "infinity"]);
            var run = await NetLabs.Docker(args, TimeSpan.FromMinutes(2));
            if (!run.Ok) return new("failed", "Could not start the container:\n" + Tail(run.Err, 1200));
            var session = new Session(spec.Key, name);
            _sessions[spec.Key] = session;

            if (spec.FilesDir is { } dir)
            {
                var cp = await NetLabs.Docker(["cp", dir + Path.DirectorySeparatorChar + ".", $"{name}:{FilesIn}"], TimeSpan.FromMinutes(1));
                if (!cp.Ok) { await Remove(spec.Key); return new("failed", "Could not copy the lesson's files into the container:\n" + Tail(cp.Err, 800)); }
            }
            // Setup runs as root in the learner's home; then the home folder is handed to the learner.
            var script = "set -e -o pipefail\nchmod -R a+rX " + FilesIn + " 2>/dev/null || true\ncd ~\n" + spec.Setup;
            var setup = await Exec(name, "root", script, 180, "HOME=" + Home);
            if (!setup.Ok)
            {
                await Remove(spec.Key);
                return new("failed", "The scenario setup failed (a lesson authoring error):\n" + Tail(setup.Out + setup.Err, 1500));
            }
            var own = await Exec(name, "root", $"chown -R {User}:{User} {Home}", 60);
            if (!own.Ok) { await Remove(spec.Key); return new("failed", "Could not prepare the home folder:\n" + Tail(own.Err, 800)); }
            session.Touch();
            return new("ready", "The scenario is ready.", null, await image.Size(), Fresh: true);
        }
        finally { _create.Release(); }
    }

    static async Task<bool> Running(string name) =>
        (await NetLabs.Docker(["container", "inspect", "--format", "{{.State.Running}}", name], TimeSpan.FromSeconds(20))).Out.Trim() == "true";

    /// <summary>Remove one container by name, but only when it carries this instance's label.</summary>
    async Task RemoveContainer(string name)
    {
        var label = await NetLabs.Docker(["container", "inspect", "--format", "{{index .Config.Labels \"" + Label + "\"}}", name], TimeSpan.FromSeconds(20));
        if (label.Ok && label.Out.Trim() == _instance) await NetLabs.Docker(["rm", "-f", "-v", name], TimeSpan.FromMinutes(1));
    }

    /// <summary>The learner left the step: remove its container.</summary>
    public async Task<bool> Remove(string key)
    {
        if (!_sessions.TryRemove(key, out var s)) return false;
        await RemoveContainer(s.Name);
        return true;
    }

    /// <summary>Remove every container of this instance, tracked or not (leftovers of an earlier run with the same instance).</summary>
    public async Task RemoveAll()
    {
        _sessions.Clear();
        var ps = await NetLabs.Docker(["ps", "-aq", "--filter", $"label={Label}={_instance}"], TimeSpan.FromSeconds(30));
        var ids = ps.Ok ? ps.Out.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries) : [];
        if (ids.Length > 0) await NetLabs.Docker(["rm", "-f", "-v", .. ids], TimeSpan.FromMinutes(2));
    }

    /// <summary>The reaper: idle containers, and containers nobody has had a terminal on for the grace period.</summary>
    public async Task<int> Sweep(DateTime now)
    {
        var removed = 0;
        foreach (var s in _sessions.Values.ToList())
        {
            var quiet = s.Terminals == 0 && now - (s.Detached is { } d && d > s.LastActive ? d : s.LastActive) > _opt.Grace;
            if (quiet || now - s.LastActive > _opt.Idle)
                if (await Remove(s.Key)) removed++;
        }
        return removed;
    }

    public bool Has(string key) => _sessions.ContainsKey(key);

    /// <summary>Back-date a session (tests of the reaper).</summary>
    public void Age(string key, TimeSpan by)
    {
        if (_sessions.TryGetValue(key, out var s)) { s.LastActive -= by; if (s.Detached is { } d) s.Detached = d - by; }
    }

    // ---------------------------------------------------------------- checking

    public sealed record CheckResult(string State, string Message, List<CheckRow> Rows)
    {
        public bool Passed => State == "ready" && Rows.Count > 0 && Rows.All(r => r.Pass);
    }

    /// <summary>Run every check against the step's container, in order. Missing container: state "gone".</summary>
    public async Task<CheckResult> RunChecks(Spec spec)
    {
        if (!_sessions.TryGetValue(spec.Key, out var s) || !await Running(s.Name))
        {
            _sessions.TryRemove(spec.Key, out _);
            return new("gone", "The scenario is not running any more (it stops after a while without use). Press Reset scenario to start it again.", []);
        }
        s.Touch();
        return new("ready", "", await ChecksOn(s.Name, spec));
    }

    async Task<List<CheckRow>> ChecksOn(string name, Spec spec)
    {
        var rows = new List<CheckRow>();
        foreach (var c in spec.Checks)
        {
            var r = await Exec(name, c.RunAs, c.Cmd, 30);
            var pass = Judge(c, r);
            string? detail = null;
            if (!pass)
            {
                var shown = Tail((r.Out + (r.Err.Length > 0 ? "\n" + r.Err : "")).Trim(), 700);
                detail = c.Fail + (c.Quiet || shown.Length == 0 ? "" : "\n\nWhat the check saw:\n" + shown) + (r.Code == 124 ? "\n(the check timed out)" : "");
            }
            rows.Add(new(c.Name, pass, detail));
        }
        return rows;
    }

    /// <summary>
    /// `dojo validate`: start the scenario, confirm the checks fail before the learner does anything, run the
    /// solution as the learner, confirm every check passes, and remove the container. Returns the problems found.
    /// </summary>
    public async Task<List<string>> Prove(Spec spec)
    {
        var problems = new List<string>();
        var open = await Open(spec, fresh: true, waitForImage: true);
        if (!open.Ok) { problems.Add($"{open.State}: {open.Message}"); return problems; }
        try
        {
            var name = _sessions[spec.Key].Name;
            var before = await ChecksOn(name, spec);
            if (before.All(r => r.Pass)) problems.Add("every check already passes before the learner does anything");
            if (spec.Solution.Trim().Length == 0) { problems.Add("missing 'solution' (the commands an expert would type)"); return problems; }
            // Typed one line at a time, like the learner would: a command that stops on purpose (a revert that
            // conflicts) does not end the script. The checks afterwards decide.
            var sol = await Exec(name, User, "cd ~\n" + spec.Solution, 180, "GIT_EDITOR=true", "EDITOR=true", "DOJO_LINE_TERM=1");
            var after = await ChecksOn(name, spec);
            foreach (var row in after.Where(r => !r.Pass))
                problems.Add($"after the solution, check \"{row.Name}\" fails: {row.Detail?.Replace("\n", " | ")}");
            if (after.Any(r => !r.Pass)) problems.Add("what the solution printed: " + Tail(sol.Out + sol.Err, 900).Replace("\n", " | "));
        }
        finally { await Remove(spec.Key); }
        return problems;
    }

    // ---------------------------------------------------------------- the terminal

    const int MaxTerminals = 6;
    int _terminals;

    public async Task Terminal(HttpContext ctx, string key)
    {
        using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        async Task Say(string text) => await ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);
        if (!_sessions.TryGetValue(key, out var s) || !await Running(s.Name))
        {
            await Say("\r\n[the scenario is not running: press Reset scenario to start it again]\r\n");
            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "not running", default);
            return;
        }
        if (Interlocked.Increment(ref _terminals) > MaxTerminals)
        {
            Interlocked.Decrement(ref _terminals);
            await Say("\r\n[too many terminals open: close some tabs]\r\n");
            await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "too many", default);
            return;
        }
        Interlocked.Increment(ref s.Terminals);
        s.Touch();
        try
        {
            await NetLabs.Bridge(ctx, ws, ["exec", "-i", "-u", User, "-w", Home, "-e", "HOME=" + Home, "-e", "TERM=xterm-256color",
                "-e", "DOJO_LINE_TERM=1", "-e", "DOJO_FILES=" + FilesIn, s.Name, "sh", "-c", NetLabs.ShellBoot], s.Touch);
        }
        finally
        {
            Interlocked.Decrement(ref _terminals);
            Interlocked.Decrement(ref s.Terminals);
            s.Detached = DateTime.UtcNow;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        if (_sweeper is not null) await _sweeper.DisposeAsync();
        await RemoveAll();
    }

    // ---------------------------------------------------------------- HTTP endpoints

    public record StepRequest(string? Track, string? Module, string? Lesson, int? Step);

    /// <summary>The terminal step a request names, looked up in the server's own content. Null when it is not one.</summary>
    static Spec? Find(Content content, StepRequest? req, out string? error)
    {
        error = null;
        if (req?.Track is not { } t || req.Module is not { } m || req.Lesson is not { } l || req.Step is not { } i) return null;
        if (content.Lesson(t, m, l)?["steps"] is not JsonArray steps || steps.ElementAtOrDefault(i) is not JsonObject step || (string?)step["type"] != "terminal")
            return null;
        try { return Parse(step, $"{t}/{m}/{l}#{i}", ModuleDir(content, step, t, m)); }
        catch (InvalidDataException e) { error = e.Message; return null; }
    }

    /// <summary>A "coldOf" step borrows its scenario from another lesson: its files come from that lesson's module ("filesOf").</summary>
    public static string ModuleDir(Content content, JsonObject step, string track, string module) =>
        Str(step, "filesOf") is { } of && of.Split('/') is [var ft, var fm] && Content.SafeSegment(ft) && Content.SafeSegment(fm)
            ? Path.Combine(content.TracksDir, ft, fm)
            : Path.Combine(content.TracksDir, track, module);

    public static TermSteps Map(WebApplication app, Content content, string root, int port)
    {
        var steps = new TermSteps(Path.Combine(root, "netlabs", "images"), $"p{port}");
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        // Leftovers of an earlier run on this port (a crash, a killed process) go first.
        _ = Task.Run(steps.RemoveAll);
        app.Lifetime.ApplicationStopping.Register(() => steps.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(25)));

        IResult Reply(OpenResult r) => Results.Json(new { ok = r.Ok, state = r.State, msg = r.Message, build = r.Build, imageBytes = r.ImageBytes, fresh = r.Fresh }, json);
        IResult NotFound(string? error) => error is null ? Results.NotFound() : Results.Json(new { ok = false, state = "failed", msg = "This step is broken: " + error }, json);

        app.MapGet("/api/termstep", async () => Results.Json(new
        {
            docker = await NetLabs.Probe(),
            sessions = steps.List().Select(s => new { key = s.Key, name = s.Name, terminals = s.Terminals }),
        }, json));
        app.MapPost("/api/termstep/open", async (StepRequest req) =>
            Find(content, req, out var err) is { } spec ? Reply(await steps.Open(spec)) : NotFound(err));
        app.MapPost("/api/termstep/reset", async (StepRequest req) =>
            Find(content, req, out var err) is { } spec ? Reply(await steps.Reset(spec)) : NotFound(err));
        app.MapPost("/api/termstep/close", async (StepRequest req) =>
            Find(content, req, out var err) is { } spec ? Results.Json(new { ok = await steps.Remove(spec.Key) }, json) : NotFound(err));
        app.MapPost("/api/termstep/check", async (StepRequest req) =>
        {
            if (Find(content, req, out var err) is not { } spec) return NotFound(err);
            var r = await steps.RunChecks(spec);
            return Results.Json(new { ok = r.State == "ready", state = r.State, msg = r.Message, passed = r.Passed, tests = r.Rows.Select(x => new { name = x.Name, pass = x.Pass, detail = x.Detail }) }, json);
        });
        // The terminal. Like the live labs' one, a WebSocket must come from our own page, so the Origin is required.
        app.Map("/api/termstep/term/{track}/{module}/{lesson}/{step:int}", async (HttpContext ctx, string track, string module, string lesson, int step) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) return Results.BadRequest("WebSocket only");
            var host = ctx.Request.Host.Value ?? "";
            var hostName = ctx.Request.Host.Host;
            if (ctx.Request.Headers.Origin.ToString() != "http://" + host || (hostName != "127.0.0.1" && hostName != "localhost"))
                return Results.StatusCode(403);
            if (Find(content, new(track, module, lesson, step), out _) is not { } spec) return Results.NotFound();
            await steps.Terminal(ctx, spec.Key);
            return Results.Empty;
        });
        return steps;
    }
}
