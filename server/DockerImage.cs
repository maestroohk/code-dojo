using System.Security.Cryptography;
using System.Text;

namespace CodeDojo;

/// <summary>
/// A local Docker image the dojo builds itself from a folder under netlabs/images (the live-lab toolbox, the
/// terminal-step shell). Builds run in the background with a short rolling log the UI can show; <see cref="Ensure"/>
/// waits for one (used by `dojo validate`). Docker is only ever called with an argument list.
/// Every build carries the label <see cref="ContextLabel"/> = a hash of the folder's files (<see cref="ContextHash"/>),
/// so an image built from an older Dockerfile (or an older file it copies in) is not "ready": it is rebuilt.
/// </summary>
public sealed class DockerImage(string tag, string dir)
{
    public const string ContextLabel = "code-dojo.context";

    public string Tag { get; } = tag;
    public string Dir { get; } = dir;

    readonly object _lock = new();
    readonly List<string> _log = [];
    Task<bool>? _build;
    public string State { get; private set; } = "idle";   // idle | building | done | failed
    /// <summary>The last <see cref="Check"/> found the image built from older files (it is being, or will be, rebuilt).</summary>
    public bool Outdated { get; private set; }

    public object Info()
    {
        lock (_lock) return new { state = State, outdated = Outdated, log = _log.TakeLast(40).ToArray() };
    }

    /// <summary>
    /// A hash of every file in the build folder (relative path and content, sorted by path), so any change to the
    /// Dockerfile or a file it copies changes it. Line endings do not count: a CRLF checkout builds the same image.
    /// </summary>
    public static string ContextHash(string dir)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var root = Path.GetFullPath(dir);
        var files = (Directory.Exists(root) ? Directory.GetFiles(root, "*", SearchOption.AllDirectories) : [])
            .Select(f => (Rel: Path.GetRelativePath(root, f).Replace('\\', '/'), Full: f))
            .OrderBy(f => f.Rel, StringComparer.Ordinal);
        foreach (var (rel, full) in files)
        {
            var bytes = File.ReadAllBytes(full);
            sha.AppendData(Encoding.UTF8.GetBytes(rel + "\0" + bytes.Count(b => b != '\r') + "\0"));
            sha.AppendData(bytes.Where(b => b != '\r').ToArray());
        }
        return Convert.ToHexString(sha.GetHashAndReset())[..16].ToLowerInvariant();
    }

    /// <summary>What a built image's label says against what the folder hashes to now.</summary>
    public enum Freshness { Missing, Outdated, Current }

    public static Freshness Compare(bool exists, string? label, string hash) =>
        !exists ? Freshness.Missing : string.Equals(label?.Trim(), hash, StringComparison.Ordinal) ? Freshness.Current : Freshness.Outdated;

    public async Task<Freshness> Check()
    {
        var r = await NetLabs.Docker(["image", "inspect", "--format", "{{index .Config.Labels \"" + ContextLabel + "\"}}", Tag], TimeSpan.FromSeconds(20));
        var f = Compare(r.Ok, r.Out, ContextHash(Dir));
        Outdated = f == Freshness.Outdated;
        return f;
    }

    /// <summary>Built, and from the folder's current files.</summary>
    public async Task<bool> Ready() => await Check() == Freshness.Current;

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
            var hash = ContextHash(Dir);
            build = _build = Task.Run(async () =>
            {
                var r = await NetLabs.Docker(["build", "--progress=plain", "--label", $"{ContextLabel}={hash}", "-t", Tag, Dir], TimeSpan.FromMinutes(30), onLine: line =>
                {
                    lock (_lock) { _log.Add(line); if (_log.Count > 400) _log.RemoveAt(0); }
                });
                lock (_lock) { State = r.Ok ? "done" : "failed"; if (r.Ok) Outdated = false; }
                return r.Ok;
            });
            return true;
        }
    }

    /// <summary>
    /// Can containers start from this image now? When it is current, yes. When it was built from older files, it is
    /// rebuilt in the background (no question asked: Docker's layer cache makes that quick, and the old image may lack
    /// what the dojo now expects) and the answer is no until that is done; if that rebuild failed (offline, say), the
    /// old image is better than nothing, so yes. Not built at all: no (the first build waits for the learner's click
    /// or, for terminal steps, is started by the caller).
    /// </summary>
    public async Task<bool> Usable()
    {
        switch (await Check())
        {
            case Freshness.Current: return true;
            case Freshness.Outdated:
                if (State == "failed") return true;
                StartBuild();
                return false;
            default: return false;
        }
    }

    /// <summary>Build the image unless it is current, and wait for it. Prints progress through <paramref name="say"/>.</summary>
    public async Task<bool> Ensure(Action<string>? say = null)
    {
        var f = await Check();
        if (f == Freshness.Current) return true;
        say?.Invoke(f == Freshness.Outdated ? $"rebuilding {Tag}: the files in {Dir} changed..." : $"building {Tag} from {Dir} (first time only, a few minutes)...");
        Begin(out var build);
        var ok = await build;
        if (!ok) lock (_lock) say?.Invoke(string.Join("\n", _log.TakeLast(15)));
        return ok;
    }
}
