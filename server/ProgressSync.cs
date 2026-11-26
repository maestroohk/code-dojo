using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// The learner's record on disk and how it travels between machines.
///
///   .state/progress.json     the UI's state (game.js), written by PUT /api/progress
///   .state/profile.json      the welcome answers
///   .state/netlabs.json      live-lab tasks done (NetLabs.cs; only its "progress" section travels)
///   .state/sync.json         the sync folder, this machine's name and the last sync
///   .state/backups/          the record as it was before every import or sync that changed it (the last 20)
///
/// Export / import: one versioned file (ProgressMerge.MakeBundle). Import merges, never replaces (ProgressMerge rules).
/// Sync folder: a folder both machines can see (OneDrive, Dropbox, a network share, a cloned private Git repo). On every
/// change (debounced) and every few minutes the server merges in code-dojo-progress*.json from that folder (conflict
/// copies too) and writes the union back as code-dojo-progress.json. In a Git repo, Pull and Commit-and-push run the real
/// git with the user's own configuration; the dojo never sees credentials.
///
/// Revisions: GET /api/progress answers with X-Dojo-Rev. A page that PUTs with an older revision (a sync merged something
/// in meanwhile) is merged rather than written over, and gets the merged state back to adopt.
/// </summary>
public sealed class ProgressSync : IDisposable
{
    public const string SyncFileName = "code-dojo-progress.json";
    const string RevHeader = "X-Dojo-Rev";
    static readonly TimeSpan PushDelay = TimeSpan.FromSeconds(5), PullEvery = TimeSpan.FromMinutes(3), GitTimeout = TimeSpan.FromSeconds(90);
    static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    readonly string _stateDir, _progressFile, _profileFile, _configFile, _backupDir;
    readonly NetLabs? _netlabs;
    readonly object _lock = new();
    readonly string _revBase = DateTime.UtcNow.Ticks.ToString("x", CultureInfo.InvariantCulture);
    long _counter;
    readonly Dictionary<string, string> _snapshots = new(StringComparer.Ordinal);   // rev -> progress.json as it was when that rev ended
    readonly SemaphoreSlim _syncGate = new(1, 1);
    readonly Timer _pushTimer, _pullTimer;
    string? _lastError;

    public ProgressSync(string stateDir, NetLabs? netlabs, bool timers = true)
    {
        _stateDir = stateDir;
        _progressFile = Path.Combine(stateDir, "progress.json");
        _profileFile = Path.Combine(stateDir, "profile.json");
        _configFile = Path.Combine(stateDir, "sync.json");
        _backupDir = Path.Combine(stateDir, "backups");
        _netlabs = netlabs;
        _pushTimer = new Timer(_ => _ = SafeSync());
        _pullTimer = new Timer(_ => _ = SafeSync());
        if (timers) _pullTimer.Change(TimeSpan.FromSeconds(3), PullEvery);
    }

    public void Dispose() { _pushTimer.Dispose(); _pullTimer.Dispose(); }

    public string Rev { get { lock (_lock) return $"{_revBase}.{_counter}"; } }

    // ------------------------------------------------------------ local files

    JsonObject ReadProgress()
    {
        try { return File.Exists(_progressFile) ? JsonNode.Parse(File.ReadAllText(_progressFile)) as JsonObject ?? [] : []; }
        catch (JsonException) { return []; }
    }

    JsonNode? ReadProfile()
    {
        try { return File.Exists(_profileFile) ? JsonNode.Parse(File.ReadAllText(_profileFile)) : null; }
        catch (JsonException) { return null; }
    }

    static void WriteAtomic(string file, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, text);
        File.Move(tmp, file, overwrite: true);
    }

    void WriteProgress(JsonNode progress) => WriteAtomic(_progressFile, progress.ToJsonString(Indented));

    /// <summary>This machine's whole record as one bundle.</summary>
    public JsonObject Bundle()
    {
        lock (_lock) return BundleLocked();
    }

    JsonObject BundleLocked() =>
        ProgressMerge.MakeBundle(ReadProgress(), ReadProfile(), _netlabs?.ProgressSnapshot(), Config().Machine, DateTimeOffset.UtcNow);

    /// <summary>A new revision: the page's copy is now stale. Keeps what the old revision looked like for stamping.</summary>
    void BumpLocked(string previousText)
    {
        _snapshots[$"{_revBase}.{_counter}"] = previousText;
        _counter++;
        foreach (var old in _snapshots.Keys.Where(k => long.TryParse(k[(k.LastIndexOf('.') + 1)..], out var n) && n < _counter - 8).ToList())
            _snapshots.Remove(old);
    }

    static string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

    /// <summary>
    /// The page saves its state. Same revision: written as sent (edits stamped). Older revision: merged with what is on
    /// disk now, and the merged state is returned for the page to adopt.
    /// </summary>
    public (JsonObject? Merged, string Rev) Put(JsonObject incoming, string? clientRev)
    {
        JsonObject? merged = null;
        lock (_lock)
        {
            var disk = ReadProgress();
            var current = $"{_revBase}.{_counter}";
            var fresh = clientRev is null || clientRev == current;
            JsonObject? basis = fresh ? disk
                : _snapshots.TryGetValue(clientRev!, out var text) ? JsonNode.Parse(text) as JsonObject : null;
            // Edits are what changed since the copy the page started from. Without that copy (the server restarted) nothing
            // is stamped as new: the merge then falls back to its fixed order for entries both sides changed.
            if (basis is not null) ProgressMerge.Stamp(basis, incoming, Now());
            if (fresh) WriteProgress(incoming);
            else
            {
                merged = ProgressMerge.MergeProgress(disk, incoming);
                WriteProgress(merged);
            }
        }
        if (HasFolder()) _pushTimer.Change(PushDelay, Timeout.InfiniteTimeSpan);
        return (merged, Rev);
    }

    /// <summary>
    /// Merges a bundle into this machine. Backs up the record first when anything changes. Returns the summary, the
    /// backup file (or null) and the merged progress.
    /// </summary>
    public (JsonObject Summary, string? Backup, JsonObject Progress) Apply(JsonObject incoming, string reason)
    {
        lock (_lock)
        {
            var local = BundleLocked();
            var merged = ProgressMerge.MergeBundles(local, incoming);
            var summary = ProgressMerge.Summarize(local, merged, DateOnly.FromDateTime(DateTime.Now));
            string? backup = null;
            if ((bool)summary["changed"]!)
            {
                backup = Backup(local, reason);
                var before = File.Exists(_progressFile) ? File.ReadAllText(_progressFile) : "{}";
                var progress = merged["progress"] as JsonObject ?? [];
                WriteProgress(progress);
                if (merged["profile"] is JsonObject profile && ProgressMerge.Canon(profile) != ProgressMerge.Canon(local["profile"]))
                    WriteAtomic(_profileFile, profile.ToJsonString(Indented));
                _netlabs?.MergeProgress(merged["netlabs"] as JsonObject);
                BumpLocked(before);
            }
            return (summary, backup, (JsonObject)(merged["progress"] ?? new JsonObject()).DeepClone());
        }
    }

    public JsonObject Preview(JsonObject incoming)
    {
        lock (_lock)
        {
            var local = BundleLocked();
            return ProgressMerge.Summarize(local, ProgressMerge.MergeBundles(local, incoming), DateOnly.FromDateTime(DateTime.Now));
        }
    }

    string Backup(JsonObject bundle, string reason)
    {
        Directory.CreateDirectory(_backupDir);
        var file = Path.Combine(_backupDir, $"progress-before-{reason}-{DateTime.Now:yyyyMMdd-HHmmss-fff}.json");
        File.WriteAllText(file, bundle.ToJsonString(Indented));
        foreach (var old in Directory.GetFiles(_backupDir, "progress-before-*.json").OrderByDescending(f => f, StringComparer.Ordinal).Skip(20))
            try { File.Delete(old); } catch (IOException) { }
        return file;
    }

    // ------------------------------------------------------------ the sync folder

    public sealed record SyncConfig(string? Folder, string Machine, string? LastSyncAt, string? LastFromMachine, string? LastFromAt,
        Dictionary<string, string>? Machines, string? LastWriteAt);

    SyncConfig Config()
    {
        try
        {
            if (File.Exists(_configFile) && JsonSerializer.Deserialize<SyncConfig>(File.ReadAllText(_configFile), JsonOpts) is { } c)
                return c with { Machine = string.IsNullOrWhiteSpace(c.Machine) ? Environment.MachineName : c.Machine };
        }
        catch (JsonException) { }
        return new SyncConfig(null, Environment.MachineName, null, null, null, null, null);
    }

    static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    void SaveConfig(SyncConfig c) => WriteAtomic(_configFile, JsonSerializer.Serialize(c, JsonOpts));

    bool HasFolder() => Config().Folder is { Length: > 0 } f && Directory.Exists(f);

    /// <summary>Sets (or clears, with an empty folder) the sync folder and this machine's name.</summary>
    public string? Configure(string? folder, string? machine)
    {
        folder = folder?.Trim().Trim('"');
        if (folder is { Length: > 0 })
        {
            if (!Path.IsPathFullyQualified(folder)) return "Give the full path of the folder (for example C:\\Users\\you\\OneDrive\\code-dojo).";
            if (!Directory.Exists(folder)) return "That folder does not exist. Create it first (or let OneDrive / Dropbox / git clone create it).";
            if (Path.GetFullPath(folder).TrimEnd('\\', '/').Equals(Path.GetFullPath(_stateDir).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
                return "Pick a folder outside the dojo's own state folder.";
        }
        machine = machine?.Trim();
        if (machine is { Length: > 64 }) return "Keep the machine name under 64 characters.";
        lock (_lock)
        {
            var c = Config();
            SaveConfig(c with { Folder = folder is { Length: > 0 } ? Path.GetFullPath(folder) : null, Machine = machine is { Length: > 0 } ? machine : c.Machine });
        }
        return null;
    }

    async Task SafeSync()
    {
        try { await SyncNow(); }
        catch (Exception e) { _lastError = e.Message; }
    }

    /// <summary>
    /// Merge every code-dojo-progress*.json in the folder into this machine, then write the union back as
    /// code-dojo-progress.json (only when it differs, so cloud clients and git see no churn).
    /// </summary>
    public async Task<JsonObject?> SyncNow()
    {
        var c = Config();
        if (c.Folder is not { Length: > 0 } folder || !Directory.Exists(folder)) return null;
        await _syncGate.WaitAsync();
        try
        {
            JsonObject? summary = null;
            var incoming = ReadFolder(folder, c.Machine, out var from, out var conflictCopies);
            if (incoming is not null) summary = Apply(incoming, "sync").Summary;
            var mine = Bundle();
            var file = Path.Combine(folder, SyncFileName);
            JsonObject? existing = null;
            // A damaged file (half a line merge, duplicate keys) counts as missing: it is rewritten from the union.
            try { existing = File.Exists(file) ? ProgressMerge.ReadBundle(JsonNode.Parse(File.ReadAllText(file))).Bundle : null; } catch (JsonException) { }
            string? wrote = c.LastWriteAt;
            if (existing is null || ProgressMerge.Content(existing) != ProgressMerge.Content(mine))
            {
                var tmp = Path.Combine(folder, "." + SyncFileName + ".tmp");
                File.WriteAllText(tmp, mine.ToJsonString(Indented));
                File.Move(tmp, file, overwrite: true);
                wrote = Now();
            }
            lock (_lock)
            {
                var now = Config();
                var machines = new Dictionary<string, string>(now.Machines ?? [], StringComparer.Ordinal);
                foreach (var (m, at) in from) if (!machines.TryGetValue(m, out var had) || string.CompareOrdinal(at, had) > 0) machines[m] = at;
                var latest = machines.Where(m => m.Key != now.Machine).OrderByDescending(m => m.Value, StringComparer.Ordinal).FirstOrDefault();
                SaveConfig(now with
                {
                    LastSyncAt = Now(), Machines = machines, LastWriteAt = wrote,
                    LastFromMachine = latest.Key ?? now.LastFromMachine, LastFromAt = latest.Value ?? now.LastFromAt,
                });
            }
            _lastError = null;
            return summary;
        }
        finally { _syncGate.Release(); }
    }

    /// <summary>All progress files in the folder (the main one and conflict copies), merged. Records who wrote them.</summary>
    static JsonObject? ReadFolder(string folder, string machine, out List<(string Machine, string At)> from, out int conflictCopies)
    {
        from = [];
        conflictCopies = 0;
        JsonObject? merged = null;
        foreach (var f in Directory.GetFiles(folder, "code-dojo-progress*.json").Order(StringComparer.Ordinal))
        {
            if (!string.Equals(Path.GetFileName(f), SyncFileName, StringComparison.OrdinalIgnoreCase)) conflictCopies++;
            JsonNode? node;
            try { node = JsonNode.Parse(File.ReadAllText(f)); } catch (Exception e) when (e is JsonException or IOException) { continue; }
            var (bundle, _) = ProgressMerge.ReadBundle(node);
            if (bundle is null) continue;
            if (bundle["machine"]?.ToString() is { Length: > 0 } m && m != machine && bundle["exportedAt"]?.ToString() is { Length: > 0 } at) from.Add((m, at));
            merged = merged is null ? bundle : ProgressMerge.MergeBundles(merged, bundle);
        }
        return merged;
    }

    public JsonObject Status()
    {
        var c = Config();
        var folder = c.Folder;
        var exists = folder is { Length: > 0 } && Directory.Exists(folder);
        var copies = exists ? Directory.GetFiles(folder!, "code-dojo-progress*.json").Count(f => !string.Equals(Path.GetFileName(f), SyncFileName, StringComparison.OrdinalIgnoreCase)) : 0;
        var machines = new JsonObject();
        foreach (var (m, at) in c.Machines ?? []) machines[m] = at;
        return new JsonObject
        {
            ["rev"] = Rev,
            ["machine"] = c.Machine,
            ["folder"] = folder,
            ["folderOk"] = exists,
            ["file"] = exists ? Path.Combine(folder!, SyncFileName) : null,
            ["isGit"] = exists && IsGit(folder!),
            ["lastSyncAt"] = c.LastSyncAt,
            ["lastWriteAt"] = c.LastWriteAt,
            ["lastFromMachine"] = c.LastFromMachine,
            ["lastFromAt"] = c.LastFromAt,
            ["machines"] = machines,
            ["conflictCopies"] = copies,
            ["error"] = _lastError,
            ["backups"] = Directory.Exists(_backupDir) ? Directory.GetFiles(_backupDir, "progress-before-*.json").Length : 0,
            ["backupDir"] = _backupDir,
        };
    }

    // ------------------------------------------------------------ git (the user's own git and credentials)

    static bool IsGit(string folder)
    {
        for (var d = new DirectoryInfo(folder); d is not null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, ".git")) || File.Exists(Path.Combine(d.FullName, ".git"))) return true;
        return false;
    }

    static async Task<(int Exit, string Output)> Git(string folder, params string[] args)
    {
        var psi = new ProcessStartInfo("git") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        psi.ArgumentList.Add("-C");
        psi.ArgumentList.Add(folder);
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";     // never wait for a password on a console nobody sees
        using var p = new Process { StartInfo = psi };
        try { p.Start(); }
        catch (Exception e) { return (-1, "git is not installed or not on PATH: " + e.Message); }
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(GitTimeout);
        try { await p.WaitForExitAsync(cts.Token); }
        catch (OperationCanceledException) { try { p.Kill(true); } catch { } return (-1, $"git {string.Join(' ', args)} took longer than {GitTimeout.TotalSeconds:0} s and was stopped."); }
        return (p.ExitCode, ((await stdout) + (await stderr)).Trim());
    }

    sealed class Log
    {
        readonly StringBuilder _sb = new();
        public bool Ok = true;
        public async Task<(int Exit, string Output)> Run(string folder, params string[] args)
        {
            var r = await Git(folder, args);
            _sb.AppendLine("$ git " + string.Join(' ', args.Select(a => a.Contains(' ') ? $"\"{a}\"" : a)));
            if (r.Output.Length > 0) _sb.AppendLine(r.Output);
            return r;
        }
        public void Note(string s) => _sb.AppendLine(s);
        public override string ToString() => _sb.ToString().TrimEnd();
    }

    /// <summary>Stage and commit the progress file if it changed. False when git failed.</summary>
    async Task<bool> Commit(string folder, Log log, string message)
    {
        if ((await log.Run(folder, "add", "--", SyncFileName)).Exit != 0) return false;
        var diff = await Git(folder, "diff", "--cached", "--quiet", "--", SyncFileName);
        if (diff.Exit == 0) { log.Note("(no progress changes to commit)"); return true; }
        return (await log.Run(folder, "commit", "-m", message, "--", SyncFileName)).Exit == 0;
    }

    /// <summary>
    /// Pull: merge the upstream's progress file into this machine first (so nothing can be lost), commit the union, then
    /// merge the upstream branch preferring our side for conflicting lines (ours already contains theirs), and rewrite
    /// the file from the merged record in case a line merge left it odd.
    /// </summary>
    public async Task<(bool Ok, string Log)> GitPull()
    {
        var folder = Config().Folder;
        if (folder is null || !Directory.Exists(folder) || !IsGit(folder)) return (false, "The sync folder is not a Git repository.");
        var log = new Log();
        await SyncNow();
        if ((await log.Run(folder, "fetch")).Exit != 0) return (false, log + "\nFetch failed: check the remote and your git credentials in a terminal.");
        var up = await Git(folder, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
        if (up.Exit != 0) return (false, log + "\nThis branch has no upstream yet: press Commit and push first (it sets the upstream on origin).");
        var prefix = (await Git(folder, "rev-parse", "--show-prefix")).Output.Trim();
        var theirs = await Git(folder, "show", $"@{{u}}:{prefix}{SyncFileName}");
        if (theirs.Exit == 0)
        {
            try
            {
                if (ProgressMerge.ReadBundle(JsonNode.Parse(theirs.Output)).Bundle is { } b)
                {
                    var (summary, _, _) = Apply(b, "git-pull");
                    log.Note("Merged the remote progress: " + summary["sentence"]);
                }
            }
            catch (JsonException) { log.Note("The remote progress file is not valid JSON; keeping this machine's record."); }
        }
        else log.Note("The remote branch has no progress file yet.");
        await SyncNow();
        var machine = Config().Machine;
        if (!await Commit(folder, log, $"code-dojo progress from {machine}")) return (false, log.ToString());
        // Two machines that each started from an empty clone have unrelated first commits: still one file, still mergeable.
        var merge = await log.Run(folder, "merge", "--no-edit", "--allow-unrelated-histories", "-X", "ours", "@{u}");
        if (merge.Exit != 0)
        {
            await log.Run(folder, "merge", "--abort");
            return (false, log + "\nThe merge stopped (see the output above). Your progress is safe on this machine; finish the merge in a terminal, then press Pull again.");
        }
        await SyncNow();
        await Commit(folder, log, $"code-dojo: merge progress on {machine}");
        return (true, log.ToString());
    }

    public async Task<(bool Ok, string Log)> GitPush()
    {
        var folder = Config().Folder;
        if (folder is null || !Directory.Exists(folder) || !IsGit(folder)) return (false, "The sync folder is not a Git repository.");
        var log = new Log();
        await SyncNow();
        if (!await Commit(folder, log, $"code-dojo progress from {Config().Machine}")) return (false, log.ToString());
        // A fresh clone of an empty repo has no upstream yet: the first push sets it on origin.
        var hasUpstream = (await Git(folder, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).Exit == 0;
        var hasOrigin = (await Git(folder, "remote")).Output.Split('\n').Any(r => r.Trim() == "origin");
        var push = hasUpstream || !hasOrigin ? await log.Run(folder, "push") : await log.Run(folder, "push", "-u", "origin", "HEAD");
        if (push.Exit != 0)
            return (false, log + (push.Output.Contains("rejected", StringComparison.OrdinalIgnoreCase) || push.Output.Contains("fetch first", StringComparison.OrdinalIgnoreCase)
                ? "\nThe other machine pushed first. Press Pull (it merges both records), then push again."
                : "\nPush failed. If git needs a sign-in, run git push once in a terminal in that folder."));
        return (true, log.ToString());
    }

    // ------------------------------------------------------------ endpoints

    public static ProgressSync Map(WebApplication app, string stateDir, NetLabs? netlabs)
    {
        var sync = new ProgressSync(stateDir, netlabs);
        app.Lifetime.ApplicationStopping.Register(sync.Dispose);
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        app.MapGet("/api/progress", (HttpContext ctx) =>
        {
            lock (sync._lock)
            {
                ctx.Response.Headers[RevHeader] = $"{sync._revBase}.{sync._counter}";
                return Results.Text(File.Exists(sync._progressFile) ? File.ReadAllText(sync._progressFile) : "{}", "application/json");
            }
        });

        app.MapPut("/api/progress", async (HttpContext ctx) =>
        {
            JsonNode? node;
            try { node = await JsonNode.ParseAsync(ctx.Request.Body); }   // reject anything that is not JSON
            catch (JsonException) { return Results.BadRequest("not JSON"); }
            if (node is not JsonObject incoming) return Results.BadRequest("progress is a JSON object");
            var rev = ctx.Request.Headers[RevHeader].ToString();
            var (merged, now) = sync.Put(incoming, rev.Length > 0 ? rev : null);
            ctx.Response.Headers[RevHeader] = now;
            return merged is null ? Results.NoContent() : Results.Text(new JsonObject { ["merged"] = true, ["rev"] = now, ["state"] = merged }.ToJsonString(), "application/json");
        });

        // The welcome profile (docs/CURRICULUM.md 3.8) as its own file, so it survives a progress reset and can be edited by hand.
        app.MapGet("/api/profile", () =>
        {
            lock (sync._lock)
                return Results.Text(File.Exists(sync._profileFile) ? File.ReadAllText(sync._profileFile) : "null", "application/json");
        });
        app.MapPut("/api/profile", async (HttpRequest req) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            if (doc.RootElement.ValueKind is not (JsonValueKind.Object or JsonValueKind.Null)) return Results.BadRequest("a profile is a JSON object");
            var text = JsonSerializer.Serialize(doc.RootElement, Indented);
            lock (sync._lock) WriteAtomic(sync._profileFile, text);
            if (sync.HasFolder()) sync._pushTimer.Change(PushDelay, Timeout.InfiniteTimeSpan);
            return Results.NoContent();
        });

        app.MapGet("/api/sync/export", (HttpContext ctx) =>
        {
            var bundle = sync.Bundle();
            ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"code-dojo-progress-{DateTime.Now:yyyy-MM-dd}.json\"";
            return Results.Text(bundle.ToJsonString(Indented), "application/json");
        });

        static (JsonObject? Bundle, string? Error) Incoming(JsonNode? body) =>
            ProgressMerge.ReadBundle(body is JsonObject o && o["bundle"] is JsonObject inner ? inner : body);

        app.MapPost("/api/sync/preview", async (HttpRequest req) =>
        {
            var (bundle, error) = Incoming(await ReadJson(req));
            if (bundle is null) return Results.Json(new { ok = false, error }, json);
            return Results.Text(new JsonObject { ["ok"] = true, ["summary"] = sync.Preview(bundle), ["machine"] = bundle["machine"]?.DeepClone(), ["exportedAt"] = bundle["exportedAt"]?.DeepClone() }.ToJsonString(), "application/json");
        });

        app.MapPost("/api/sync/import", async (HttpRequest req) =>
        {
            var (bundle, error) = Incoming(await ReadJson(req));
            if (bundle is null) return Results.Json(new { ok = false, error }, json);
            var (summary, backup, progress) = sync.Apply(bundle, "import");
            if (sync.HasFolder()) sync._pushTimer.Change(PushDelay, Timeout.InfiniteTimeSpan);
            return Results.Text(new JsonObject { ["ok"] = true, ["summary"] = summary, ["backup"] = backup, ["rev"] = sync.Rev, ["state"] = progress }.ToJsonString(), "application/json");
        });

        app.MapGet("/api/sync/status", () => Results.Text(sync.Status().ToJsonString(), "application/json"));

        app.MapPut("/api/sync/config", async (HttpRequest req) =>
        {
            if (await ReadJson(req) is not JsonObject body) return Results.Json(new { ok = false, error = "Send { \"folder\": path or \"\", \"machine\": name }." }, json);
            if (sync.Configure(body?["folder"]?.ToString(), body?["machine"]?.ToString()) is { } error) return Results.Json(new { ok = false, error }, json);
            JsonObject? summary = null;
            try { summary = await sync.SyncNow(); }
            catch (Exception e) { return Results.Json(new { ok = false, error = "Saved, but the first sync failed: " + e.Message }, json); }
            return Results.Text(new JsonObject { ["ok"] = true, ["summary"] = summary, ["status"] = sync.Status() }.ToJsonString(), "application/json");
        });

        app.MapPost("/api/sync/now", async () =>
        {
            try
            {
                var summary = await sync.SyncNow();
                return Results.Text(new JsonObject { ["ok"] = true, ["summary"] = summary, ["status"] = sync.Status() }.ToJsonString(), "application/json");
            }
            catch (Exception e) { return Results.Json(new { ok = false, error = e.Message }, json); }
        });

        app.MapPost("/api/sync/git/{action}", async (string action) =>
        {
            if (action is not ("pull" or "push")) return Results.NotFound();
            var (ok, log) = action == "pull" ? await sync.GitPull() : await sync.GitPush();
            sync._lastError = ok ? null : $"git {action} failed";
            return Results.Text(new JsonObject { ["ok"] = ok, ["log"] = log, ["status"] = sync.Status() }.ToJsonString(), "application/json");
        });

        return sync;
    }

    static async Task<JsonNode?> ReadJson(HttpRequest req)
    {
        try { return await JsonNode.ParseAsync(req.Body); }
        catch (JsonException) { return null; }
    }
}
