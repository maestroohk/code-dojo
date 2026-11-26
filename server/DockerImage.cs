namespace CodeDojo;

/// <summary>
/// A local Docker image the dojo builds itself from a folder under netlabs/images (the live-lab toolbox, the
/// terminal-step shell). Builds run in the background with a short rolling log the UI can show; <see cref="Ensure"/>
/// waits for one (used by `dojo validate`). Docker is only ever called with an argument list.
/// </summary>
public sealed class DockerImage(string tag, string dir)
{
    public string Tag { get; } = tag;
    public string Dir { get; } = dir;

    readonly object _lock = new();
    readonly List<string> _log = [];
    Task<bool>? _build;
    public string State { get; private set; } = "idle";   // idle | building | done | failed

    public object Info()
    {
        lock (_lock) return new { state = State, log = _log.TakeLast(40).ToArray() };
    }

    public async Task<bool> Ready() =>
        (await NetLabs.Docker(["image", "inspect", "--format", "{{.Id}}", Tag], TimeSpan.FromSeconds(20))).Ok;

    /// <summary>The image size in bytes as Docker reports it, or null when it is not built.</summary>
    public async Task<long?> Size()
    {
        var r = await NetLabs.Docker(["image", "inspect", "--format", "{{.Size}}", Tag], TimeSpan.FromSeconds(20));
        return r.Ok && long.TryParse(r.Out.Trim(), out var n) ? n : null;
    }

    /// <summary>Start a background build. False when one is already running.</summary>
    public bool StartBuild() => Begin(out _);

    bool Begin(out Task<bool> build)
    {
        lock (_lock)
        {
            if (State == "building" && _build is not null) { build = _build; return false; }
            State = "building";
            _log.Clear();
            build = _build = Task.Run(async () =>
            {
                var r = await NetLabs.Docker(["build", "--progress=plain", "-t", Tag, Dir], TimeSpan.FromMinutes(30), onLine: line =>
                {
                    lock (_lock) { _log.Add(line); if (_log.Count > 400) _log.RemoveAt(0); }
                });
                lock (_lock) State = r.Ok ? "done" : "failed";
                return r.Ok;
            });
            return true;
        }
    }

    /// <summary>Build the image unless it exists, and wait for it. Prints progress through <paramref name="say"/>.</summary>
    public async Task<bool> Ensure(Action<string>? say = null)
    {
        if (await Ready()) return true;
        say?.Invoke($"building {Tag} from {Dir} (first time only, a few minutes)...");
        Begin(out var build);
        var ok = await build;
        if (!ok) lock (_lock) say?.Invoke(string.Join("\n", _log.TakeLast(15)));
        return ok;
    }
}
