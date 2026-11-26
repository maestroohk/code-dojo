using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// Python and Node.js code spaces. A Python space has its own virtual environment (.venv) and records its
/// packages in requirements.txt; a Node space has a package.json and node_modules. Everything runs through
/// the real python / node / npm, always with an argument list (never a shell), the same job, output and
/// problems machinery as .NET spaces. npm is started as `node npm-cli.js` so no .cmd file is involved.
/// </summary>
public sealed partial class CodeSpaces
{
    static readonly TimeSpan NpmTimeout = TimeSpan.FromMinutes(8), PipTimeout = TimeSpan.FromMinutes(5);

    // ================================================================ kind detection

    /// <summary>dotnet, python or node, from the files in the folder (then the template it was made from).</summary>
    public static string DetectKind(string dir)
    {
        if (!Directory.Exists(dir)) return "dotnet";
        bool Has(string pattern) { try { return Directory.EnumerateFiles(dir, pattern).Any(); } catch { return false; } }
        bool File_(string name) => File.Exists(Path.Combine(dir, name));
        if (Has("*.csproj") || Has("*.sln") || Has("*.slnx")) return "dotnet";
        if (File_("package.json")) return "node";
        if (File_("pyproject.toml") || File_("requirements.txt") || File_("setup.py") || File_("setup.cfg") || File_("Pipfile")
            || Directory.Exists(Path.Combine(dir, ".venv"))) return "python";
        try
        {
            if ((string?)JsonNode.Parse(File.ReadAllText(Path.Combine(dir, MetaFile)))?["kind"] is ("python" or "node" or "dotnet") and var k) return k;
        }
        catch { }
        // No manifest: count source files a couple of levels down.
        int cs = 0, py = 0, js = 0;
        void Walk(string d, int depth)
        {
            if (depth > 3) return;
            try
            {
                foreach (var f in Directory.EnumerateFiles(d))
                    switch (Path.GetExtension(f).ToLowerInvariant())
                    {
                        case ".csproj": cs += 100; break;
                        case ".cs": cs++; break;
                        case ".py": py++; break;
                        case ".js" or ".mjs" or ".cjs" or ".ts" or ".mts" or ".tsx" or ".jsx": js++; break;
                    }
                foreach (var sub in Directory.EnumerateDirectories(d))
                    if (!SkipDirs.Contains(Path.GetFileName(sub)) && !IsLink(sub)) Walk(sub, depth + 1);
            }
            catch { }
        }
        Walk(dir, 0);
        if (py > cs && py >= js) return "python";
        if (js > cs && js > py) return "node";
        return "dotnet";
    }

    /// <summary>The space's kind when it is a Python or Node space, else null (a .NET space, or no such space).</summary>
    string? PolyKind(string name) =>
        SpaceDir(name) is { } dir && Directory.Exists(dir) && DetectKind(dir) is "python" or "node" ? DetectKind(dir) : null;

    static readonly string[] JsExts = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

    static HashSet<string> SourceExtensions(string? lang) => new(lang?.ToLowerInvariant() switch
    {
        "python" or "py" => new[] { ".py", ".pyi" },
        "javascript" or "js" or "typescript" or "ts" or "tsx" or "node" => JsExts,
        _ => new[] { ".cs" },
    }, StringComparer.OrdinalIgnoreCase);

    // ================================================================ toolchains

    static string? FindOnPath(string exe)
    {
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var p = Path.Combine(d.Trim('"'), exe);
                // The Microsoft Store "python.exe" stub opens the Store instead of running Python.
                if (File.Exists(p) && !p.Contains("WindowsApps", StringComparison.OrdinalIgnoreCase)) return p;
            }
            catch { }
        }
        return null;
    }

    static readonly bool Win = OperatingSystem.IsWindows();

    /// <summary>The Python that creates a space's .venv: DOJO_PYTHON, the dojo's own environment, or Python on PATH.</summary>
    public static string? BasePython() =>
        Environment.GetEnvironmentVariable("DOJO_PYTHON") is { Length: > 0 } env && File.Exists(env) ? env
            : LangRunner.PyEnvPython() ?? FindOnPath(Win ? "python.exe" : "python3") ?? FindOnPath(Win ? "py.exe" : "python");

    public static string VenvPython(string dir) => Path.Combine(dir, ".venv", Win ? "Scripts" : "bin", Win ? "python.exe" : "python");

    static string? SitePackages(string dir)
    {
        var venv = Path.Combine(dir, ".venv");
        if (Win) { var p = Path.Combine(venv, "Lib", "site-packages"); return Directory.Exists(p) ? p : null; }
        var lib = Path.Combine(venv, "lib");
        return Directory.Exists(lib) ? Directory.GetDirectories(lib, "python*").Select(d => Path.Combine(d, "site-packages")).FirstOrDefault(Directory.Exists) : null;
    }

    public static string? NodeExe() =>
        Environment.GetEnvironmentVariable("DOJO_NODE") is { Length: > 0 } env && File.Exists(env) ? env : FindOnPath(Win ? "node.exe" : "node");

    /// <summary>npm's own entry script next to node (so npm runs as `node npm-cli.js`, with no .cmd shim).</summary>
    public static string? NpmCli()
    {
        if (NodeExe() is not { } node) return null;
        var dir = Path.GetDirectoryName(node)!;
        foreach (var p in new[] { Path.Combine(dir, "node_modules", "npm", "bin", "npm-cli.js"), Path.Combine(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js") })
            if (File.Exists(p)) return Path.GetFullPath(p);
        return null;
    }

    // ================================================================ validation (public for tests)

    [GeneratedRegex(@"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?(?:\[[A-Za-z0-9][A-Za-z0-9._-]*(?:,[A-Za-z0-9][A-Za-z0-9._-]*)*\])?$")] private static partial Regex PipNameRx();
    [GeneratedRegex(@"^\d+(?:\.\d+){0,5}(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$")] private static partial Regex PipVersionRx();
    [GeneratedRegex(@"^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$")] private static partial Regex NpmNameRx();
    [GeneratedRegex(@"^[\^~]?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")] private static partial Regex NpmVersionRx();
    [GeneratedRegex(@"^[A-Za-z0-9][\w:.-]{0,49}$")] private static partial Regex ScriptNameRx();

    /// <summary>A PyPI project name, optionally with extras ("fastapi[standard]"). Never starts with "-".</summary>
    public static bool ValidPipName(string? name) => name is { Length: > 0 and <= 120 } && PipNameRx().IsMatch(name);
    /// <summary>An exact PEP 440 release such as 2.32.3, 1.0rc1 or 0.9.post2 (no ranges, no spaces).</summary>
    public static bool ValidPipVersion(string? v) => v is { Length: > 0 and <= 40 } && PipVersionRx().IsMatch(v);
    /// <summary>An npm package name (lower case, optional @scope/). Never starts with "-" or ".".</summary>
    public static bool ValidNpmName(string? name) => name is { Length: > 0 and <= 214 } && NpmNameRx().IsMatch(name) && !name.Contains("..");
    /// <summary>An npm version: exact semver, optionally ^ or ~ (no tags, URLs or ranges with spaces).</summary>
    public static bool ValidNpmVersion(string? v) => v is { Length: > 0 and <= 64 } && NpmVersionRx().IsMatch(v);

    /// <summary>PEP 503 normalized name: "Python_DateUtil" → "python-dateutil". Extras are dropped.</summary>
    public static string NormalizePipName(string name)
    {
        var bare = name.Split('[')[0];
        return Regex.Replace(bare, @"[-_.]+", "-").ToLowerInvariant();
    }

    // ================================================================ requirements.txt

    [GeneratedRegex(@"^(?<name>[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?)\s*(?:(?<op>==|>=|<=|~=|!=|>|<|===)\s*(?<ver>[^\s;,#]+))?")] private static partial Regex ReqLineRx();

    /// <summary>The packages named in a requirements.txt (comments, options and -r lines skipped).</summary>
    public static List<Package> ReadRequirements(string text)
    {
        var list = new List<Package>();
        foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            var line = raw.Split(" #")[0].Trim();
            if (line.Length == 0 || line.StartsWith('#') || line.StartsWith('-')) continue;
            var m = ReqLineRx().Match(line);
            if (!m.Success) continue;
            list.Add(new(m.Groups["name"].Value, m.Groups["ver"].Success ? (m.Groups["op"].Value == "==" ? "" : m.Groups["op"].Value) + m.Groups["ver"].Value : null));
        }
        return list;
    }

    /// <summary>requirements.txt with one package pinned (name==version), added, or removed; other lines untouched.</summary>
    public static string UpdateRequirements(string text, string name, string? version, bool remove)
    {
        var key = NormalizePipName(name);
        var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
        if (lines.Count > 0 && lines[^1] == "") lines.RemoveAt(lines.Count - 1);
        var entry = version is { Length: > 0 } ? $"{name}=={version}" : name;
        var found = false;
        for (var i = lines.Count - 1; i >= 0; i--)
        {
            var line = lines[i].Trim();
            if (line.Length == 0 || line.StartsWith('#') || line.StartsWith('-')) continue;
            var m = ReqLineRx().Match(line);
            if (!m.Success || NormalizePipName(m.Groups["name"].Value) != key) continue;
            if (remove || found) lines.RemoveAt(i);
            else
            {
                // Keep extras the learner wrote ("fastapi[standard]") when the new entry has none.
                var written = m.Groups["name"].Value;
                if (written.Contains('[') && !name.Contains('[')) entry = version is { Length: > 0 } ? $"{written}=={version}" : written;
                lines[i] = entry;
                found = true;
            }
        }
        if (!found && !remove) lines.Add(entry);
        return string.Join("\n", lines) + "\n";
    }

    /// <summary>Installed distributions of a space's .venv: normalized name → (display name, version).</summary>
    static Dictionary<string, (string Name, string Version)> InstalledPython(string dir)
    {
        var map = new Dictionary<string, (string, string)>();
        if (SitePackages(dir) is not { } site) return map;
        try
        {
            foreach (var info in Directory.EnumerateDirectories(site, "*.dist-info"))
            {
                string? name = null, version = null;
                var meta = Path.Combine(info, "METADATA");
                if (File.Exists(meta))
                    foreach (var line in File.ReadLines(meta).Take(40))
                    {
                        if (line.StartsWith("Name: ", StringComparison.Ordinal)) name ??= line[6..].Trim();
                        else if (line.StartsWith("Version: ", StringComparison.Ordinal)) version ??= line[9..].Trim();
                        if (line.Length == 0) break;
                    }
                if (name is null || version is null)
                {
                    var stem = Path.GetFileName(info)[..^".dist-info".Length];
                    var dash = stem.IndexOf('-');
                    if (dash <= 0) continue;
                    name ??= stem[..dash]; version ??= stem[(dash + 1)..];
                }
                map[NormalizePipName(name)] = (name, version);
            }
        }
        catch { }
        return map;
    }

    // ================================================================ package.json

    static JsonObject? ReadPackageJson(string dir)
    {
        try { return JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "package.json")), documentOptions: new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }) as JsonObject; }
        catch { return null; }
    }

    public record NpmDep(string Id, string? Version, bool Dev);

    /// <summary>dependencies and devDependencies of a package.json.</summary>
    public static List<NpmDep> NpmDeps(string packageJson)
    {
        try { return NpmDeps(JsonNode.Parse(packageJson) as JsonObject); } catch { return []; }
    }

    static List<NpmDep> NpmDeps(JsonObject? pkg)
    {
        var list = new List<NpmDep>();
        if (pkg is null) return list;
        foreach (var (section, dev) in new[] { ("dependencies", false), ("devDependencies", true) })
            if (pkg[section] is JsonObject deps)
                foreach (var (id, v) in deps)
                    list.Add(new(id, v?.ToString(), dev));
        return list;
    }

    static Dictionary<string, string> NpmScripts(JsonObject? pkg)
    {
        var map = new Dictionary<string, string>();
        if (pkg?["scripts"] is JsonObject scripts)
            foreach (var (k, v) in scripts)
                if (v is not null && ScriptNameRx().IsMatch(k)) map[k] = v.ToString();
        return map;
    }

    static string? InstalledNpm(string dir, string id)
    {
        try
        {
            var p = Path.Combine([dir, "node_modules", .. id.Split('/'), "package.json"]);
            return File.Exists(p) ? (string?)JsonNode.Parse(File.ReadAllText(p))?["version"] : null;
        }
        catch { return null; }
    }

    /// <summary>npm init's placeholder test script, which only fails.</summary>
    static bool PlaceholderTest(string? script) => script is null || script.Contains("no test specified", StringComparison.OrdinalIgnoreCase);

    // ================================================================ describing a space

    static bool IsTestFile(string rel, string kind)
    {
        var file = Path.GetFileName(rel);
        if (kind == "python") return file.StartsWith("test_", StringComparison.OrdinalIgnoreCase) || file.EndsWith("_test.py", StringComparison.OrdinalIgnoreCase) || file == "conftest.py";
        return Regex.IsMatch(file, @"\.(test|spec)\.[cm]?[jt]sx?$", RegexOptions.IgnoreCase) || rel.Split('/').Contains("__tests__");
    }

    /// <summary>Files that make sense to Run on their own: scripts, not tests, configs or packages' __init__.</summary>
    List<string> Entries(string dir, string kind)
    {
        var list = new List<string>();
        foreach (var e in Tree(dir))
        {
            if (e.Dir || list.Count >= 60 || e.Path.Count(c => c == '/') > 3) continue;
            var ext = Path.GetExtension(e.Path).ToLowerInvariant();
            var file = Path.GetFileName(e.Path);
            if (IsTestFile(e.Path, kind)) continue;
            if (kind == "python" ? ext == ".py" && file != "__init__.py" && file != "setup.py"
                : ext is ".js" or ".mjs" or ".cjs" or ".ts" or ".mts" or ".cts" && !file.EndsWith(".d.ts", StringComparison.OrdinalIgnoreCase)
                  && !file.Contains(".config.", StringComparison.OrdinalIgnoreCase) && !e.Path.StartsWith("app/") && !e.Path.StartsWith("pages/"))
                list.Add(e.Path);
        }
        // Top-level files first, then the rest.
        return list.OrderBy(p => p.Contains('/')).ThenBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
    }

    static readonly string[] PyMains = ["main.py", "app.py", "__main__.py", "run.py", "manage.py"];
    static readonly string[] NodeMains = ["index.js", "main.js", "index.ts", "main.ts", "index.mjs", "main.mjs", "server.js", "app.js", "src/index.js", "src/index.ts", "src/main.ts"];

    /// <summary>What Run does by default: a file path, or "script:dev" style for an npm script.</summary>
    string? DefaultEntry(string dir, string kind)
    {
        if (kind == "python")
            return PyMains.FirstOrDefault(m => File.Exists(Path.Combine(dir, m))) ?? Entries(dir, kind).FirstOrDefault();
        var scripts = NpmScripts(ReadPackageJson(dir));
        if (scripts.ContainsKey("dev")) return "script:dev";
        return NodeMains.FirstOrDefault(m => File.Exists(Path.Combine(dir, m)))
            ?? (scripts.ContainsKey("start") ? "script:start" : Entries(dir, kind).FirstOrDefault());
    }

    List<string?> PolySummary(string dir, string kind)
    {
        try
        {
            if (kind == "python")
            {
                var req = Path.Combine(dir, "requirements.txt");
                var n = File.Exists(req) ? ReadRequirements(File.ReadAllText(req)).Count : 0;
                return ["Python", $"{n} package{(n == 1 ? "" : "s")}"];
            }
            var deps = NpmDeps(ReadPackageJson(dir)).Count;
            return ["Node.js", $"{deps} package{(deps == 1 ? "" : "s")}"];
        }
        catch { return [kind]; }
    }

    object PolyDetail(string name, string dir, string kind)
    {
        var entries = Entries(dir, kind);
        object env;
        List<object> packages = [];
        Dictionary<string, string> scripts = [];
        string? needs = null;
        var hasTests = Tree(dir).Any(e => !e.Dir && IsTestFile(e.Path, kind));
        if (kind == "python")
        {
            var installed = InstalledPython(dir);
            var reqFile = Path.Combine(dir, "requirements.txt");
            var reqs = File.Exists(reqFile) ? ReadRequirements(File.ReadAllText(reqFile)) : [];
            foreach (var r in reqs)
                packages.Add(new { id = r.Id, version = r.Version, installed = installed.TryGetValue(NormalizePipName(r.Id), out var i) ? i.Version : null, dev = false });
            var venv = File.Exists(VenvPython(dir));
            if (hasTests && !installed.ContainsKey("pytest")) needs = "pytest";
            env = new
            {
                venv, python = BasePython(), manifest = "requirements.txt",
                installedCount = installed.Count,
                // Everything pip installed, including what the requirements pulled in.
                all = installed.Values.OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase).Select(v => new { id = v.Name, version = v.Version }).Take(300).ToList(),
            };
        }
        else
        {
            var pkg = ReadPackageJson(dir);
            scripts = NpmScripts(pkg);
            foreach (var d in NpmDeps(pkg)) packages.Add(new { id = d.Id, version = d.Version, installed = InstalledNpm(dir, d.Id), dev = d.Dev });
            var nodeModules = Directory.Exists(Path.Combine(dir, "node_modules"));
            env = new { node = NodeExe(), npm = NpmCli() is not null, nodeModules, manifest = "package.json", packageJson = pkg is not null };
        }
        return new
        {
            name, dir, kind, solution = (string?)null, projects = Array.Empty<object>(),
            tree = Tree(dir),
            job = _states.TryGetValue(name, out var s) && s.Job is { } j ? Describe(j) : null,
            entries, scripts, defaultEntry = DefaultEntry(dir, kind), hasTests, needs, packages, env,
        };
    }

    // ================================================================ processes

    void PolyEnv(ProcessStartInfo psi, string dir, string kind, int port)
    {
        psi.Environment["NO_COLOR"] = "1";
        psi.Environment["FORCE_COLOR"] = "0";
        if (port > 0) psi.Environment["PORT"] = port.ToString();
        if (kind == "python")
        {
            psi.Environment.Remove("PYTHONHOME");
            psi.Environment.Remove("PYTHONPATH");
            psi.Environment["PYTHONUNBUFFERED"] = "1";
            psi.Environment["PYTHONIOENCODING"] = "utf-8";
            psi.Environment["PYTHONUTF8"] = "1";
            psi.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
            psi.Environment["MPLBACKEND"] = "Agg";
            psi.Environment["PIP_DISABLE_PIP_VERSION_CHECK"] = "1";
            psi.Environment["PIP_NO_INPUT"] = "1";
            psi.Environment["PIP_NO_COLOR"] = "1";
            var venv = Path.Combine(dir, ".venv");
            if (Directory.Exists(venv))
            {
                psi.Environment["VIRTUAL_ENV"] = venv;
                psi.Environment["PATH"] = Path.Combine(venv, Win ? "Scripts" : "bin") + Path.PathSeparator + psi.Environment["PATH"];
            }
        }
        else
        {
            psi.Environment["NODE_DISABLE_COLORS"] = "1";
            psi.Environment["NEXT_TELEMETRY_DISABLED"] = "1";
            psi.Environment["BROWSER"] = "none";
            psi.Environment["NO_UPDATE_NOTIFIER"] = "1";
            psi.Environment["npm_config_update_notifier"] = "false";
            psi.Environment["npm_config_fund"] = "false";
            psi.Environment["npm_config_audit"] = "false";
            psi.Environment["npm_config_color"] = "false";
            if (NodeExe() is { } node) psi.Environment["PATH"] = Path.GetDirectoryName(node) + Path.PathSeparator + psi.Environment["PATH"];
        }
    }

    Task<int> Py(SpaceState s, Job job, string dir, IReadOnlyList<string> args, TimeSpan? timeout, int port = 0) =>
        Exec(s, job, dir, args, timeout, psi => PolyEnv(psi, dir, "python", port), VenvPython(dir), "python", dir);

    Task<int> Node(SpaceState s, Job job, string dir, IReadOnlyList<string> args, TimeSpan? timeout, int port = 0)
    {
        if (NodeExe() is not { } node) { Append(s, null, "sys", "Node.js is not installed (node was not found on PATH). Install it from nodejs.org and restart the dojo.", dir); return Task.FromResult(-1); }
        return Exec(s, job, dir, args, timeout, psi => PolyEnv(psi, dir, "node", port), node, "node", dir);
    }

    async Task<int> Npm(SpaceState s, Job job, string dir, IReadOnlyList<string> args, TimeSpan? timeout, int port = 0, bool needsRegistry = false)
    {
        if (NodeExe() is not { } node || NpmCli() is not { } cli)
        {
            Append(s, null, "sys", "npm was not found next to Node.js. Install Node.js from nodejs.org (it includes npm) and restart the dojo.", dir);
            return -1;
        }
        if (needsRegistry && await NpmRegistry() is (false, var why))
        {
            Append(s, null, "sys", why, dir);
            return 1;
        }
        var code = await Exec(s, job, dir, [cli, .. args], timeout, psi => PolyEnv(psi, dir, "node", port), node, "npm", dir, hide: 1);
        if (code != 0 && needsRegistry && SawNetworkError(s)) Append(s, null, "sys", NpmOfflineHelp(RegistryUrl, "npm could not download packages"), dir);
        return code;
    }

    static bool SawNetworkError(SpaceState s)
    {
        lock (s.Gate)
            return s.Lines.TakeLast(60).Any(l => Regex.IsMatch(l.Text, @"E403|E407|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_|ProxyError|NewConnectionError|ConnectTimeout|Max retries exceeded|SSLError|Could not fetch URL|getaddrinfo failed|No matching distribution found", RegexOptions.IgnoreCase));
    }

    /// <summary>Make the space's .venv if it has none (streams venv's output into the job).</summary>
    async Task<bool> EnsureVenv(SpaceState s, Job job, string dir)
    {
        if (File.Exists(VenvPython(dir))) return true;
        if (BasePython() is not { } py)
        {
            Append(s, null, "sys", "Python was not found. Install Python 3 from python.org (tick \"Add python.exe to PATH\") and restart the dojo.", dir);
            return false;
        }
        Append(s, null, "sys", "Creating this space's virtual environment (.venv)…", dir);
        var code = await Exec(s, job, dir, ["-m", "venv", ".venv"], CreateTimeout, psi => PolyEnv(psi, dir, "python", 0), py, "python", dir);
        return code == 0 && File.Exists(VenvPython(dir));
    }

    static bool HasPytest(string dir) => SitePackages(dir) is { } site && (Directory.Exists(Path.Combine(site, "pytest")) || Directory.Exists(Path.Combine(site, "_pytest")));

    // ---------------------------------------------------------------- registries

    string RegistryUrl = "https://registry.npmjs.org/";
    (DateTimeOffset At, bool Ok, string Message) _npmCheck;
    bool _registryRead;

    public static string NpmOfflineHelp(string registry, string why) =>
        $"The npm registry ({registry}) is not reachable from this network ({why}). npm packages cannot be installed or updated here right now. " +
        "Plain .js and .ts files still run with Node, and packages already in node_modules keep working. On another network, press Install packages to finish the job.";

    /// <summary>Whether npm's registry answers (cached for two minutes), with a friendly message when it does not.</summary>
    async Task<(bool Ok, string Message)> NpmRegistry()
    {
        if (DateTimeOffset.UtcNow - _npmCheck.At < TimeSpan.FromMinutes(2)) return (_npmCheck.Ok, _npmCheck.Message);
        if (!_registryRead)
        {
            // The learner (or their company) may point npm at a mirror: ask npm once.
            _registryRead = true;
            try
            {
                if (NodeExe() is { } node && NpmCli() is { } cli)
                {
                    var psi = new ProcessStartInfo(node) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
                    psi.ArgumentList.Add(cli); psi.ArgumentList.Add("config"); psi.ArgumentList.Add("get"); psi.ArgumentList.Add("registry");
                    using var p = Process.Start(psi)!;
                    var outTask = p.StandardOutput.ReadToEndAsync();
                    if (p.WaitForExit(8000))
                    {
                        var url = (await outTask).Trim();
                        if (Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme is "https" or "http") RegistryUrl = url.EndsWith('/') ? url : url + "/";
                    }
                    else try { p.Kill(true); } catch { }
                }
            }
            catch { }
        }
        bool ok; string message = "";
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            using var res = await _nuget.GetAsync(RegistryUrl + "is-number", HttpCompletionOption.ResponseHeadersRead, cts.Token);
            ok = res.IsSuccessStatusCode || res.StatusCode == HttpStatusCode.Unauthorized;
            if (!ok) message = NpmOfflineHelp(RegistryUrl, $"it answered {(int)res.StatusCode} {res.ReasonPhrase}");
        }
        catch (Exception e)
        {
            ok = false;
            message = NpmOfflineHelp(RegistryUrl, e is TaskCanceledException ? "no answer within 8 seconds" : e.GetBaseException().Message);
        }
        _npmCheck = (DateTimeOffset.UtcNow, ok, message);
        return (ok, message);
    }

    // ================================================================ creating

    /// <summary>"my-shop" → "my_shop": a Python package name.</summary>
    public static string PyName(string space)
    {
        var n = Regex.Replace(space.ToLowerInvariant(), "[^a-z0-9]+", "_").Trim('_');
        if (n.Length == 0 || char.IsDigit(n[0])) n = "app_" + n;
        return n;
    }

    /// <summary>"My_Shop" → "my-shop": an npm package name.</summary>
    public static string NpmName(string space)
    {
        var n = Regex.Replace(space.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        return n.Length == 0 ? "app" : n;
    }

    static void Put(string dir, string rel, string text)
    {
        var full = Path.Combine([dir, .. rel.Split('/')]);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, text.Replace("\r\n", "\n"), new UTF8Encoding(false));
    }

    async Task<object> CreatePoly(string name, string dir, Template tpl)
    {
        try { WritePolyTemplate(dir, name, tpl.Id); }
        catch (Exception e) { return new { error = $"Could not write the template: {e.Message}", name }; }
        var s = State(name);
        if (tpl.Kind == "python")
        {
            // Make the .venv now (a few seconds); pytest for the package template, if PyPI answers.
            var (job, error) = StartJob(s, dir, "create", null, async job =>
            {
                if (!await EnsureVenv(s, job, dir)) return 1;
                if (tpl.Id == "py-package")
                {
                    if (await Py(s, job, dir, ["-m", "pip", "install", "-r", "requirements.txt"], PipTimeout) != 0)
                    {
                        Append(s, null, "sys", SawNetworkError(s)
                            ? "PyPI could not be reached, so pytest is not installed yet. The code is ready: install pytest from the PyPI panel when you are online."
                            : "pytest could not be installed. The code is ready; try Install packages again later.", dir);
                        return 0;
                    }
                    PinRequirements(dir);
                }
                return 0;
            }, lang: "python");
            if (job is null) return new { error, name };
            var done = await Task.WhenAny(job.Done, Task.Delay(CreateTimeout + TimeSpan.FromSeconds(30)));
            if (done != job.Done || job.ExitCode != 0)
            {
                string tail;
                lock (s.Gate) tail = string.Join("\n", s.Lines.TakeLast(25).Select(l => l.Text));
                return new { error = "The virtual environment could not be created.", output = tail, name };
            }
            return new { ok = true, name };
        }
        // Node: the files are there. Packages (if any) install in the background, shown in the IDE's output.
        var deps = NpmDeps(ReadPackageJson(dir));
        if (deps.Count > 0)
        {
            StartJob(s, dir, "restore", null, job => Npm(s, job, dir, ["install", "--no-audit", "--no-fund"], NpmTimeout, needsRegistry: true), lang: "node");
            return new { ok = true, name, installing = true };
        }
        return new { ok = true, name };
    }

    /// <summary>Pin every unpinned requirements.txt line to the version now installed.</summary>
    static void PinRequirements(string dir)
    {
        var file = Path.Combine(dir, "requirements.txt");
        if (!File.Exists(file)) return;
        var text = File.ReadAllText(file);
        var installed = InstalledPython(dir);
        foreach (var r in ReadRequirements(text))
            if (r.Version is null && installed.TryGetValue(NormalizePipName(r.Id), out var i))
                text = UpdateRequirements(text, r.Id, i.Version, false);
        File.WriteAllText(file, text, new UTF8Encoding(false));
    }

    static void WritePolyTemplate(string dir, string space, string id)
    {
        var py = PyName(space);
        var npm = NpmName(space);
        const string pyIgnore = ".venv/\n__pycache__/\n.pytest_cache/\n*.pyc\n";
        const string nodeIgnore = "node_modules/\n.next/\nout/\ndist/\n*.log\n.env*.local\nnext-env.d.ts\n";
        switch (id)
        {
            case "py-script":
                Put(dir, "main.py", """"
                    """A Python script. Press Run (F5) to run it; Ctrl+S saves.

                    Packages: search PyPI in the panel on the right. They install into this space's own
                    virtual environment (.venv) and are recorded in requirements.txt.
                    """


                    def greet(name: str) -> str:
                        return f"Hello, {name}!"


                    def main() -> None:
                        for name in ["world", "Python"]:
                            print(greet(name))
                        squares = [n * n for n in range(1, 6)]
                        print("squares:", squares, "sum:", sum(squares))


                    if __name__ == "__main__":
                        main()

                    """");
                Put(dir, "requirements.txt", "# One package per line, e.g. requests==2.32.3. The PyPI panel keeps this file up to date.\n");
                Put(dir, ".gitignore", pyIgnore);
                break;

            case "py-package":
                Put(dir, $"{py}/__init__.py", $$""""
                    """The {{py}} package: plain functions with no input or output, so they are easy to test."""
                    from .stats import mean, median

                    __all__ = ["mean", "median"]

                    """");
                Put(dir, $"{py}/stats.py", """"
                    def mean(values: list[float]) -> float:
                        """The average of the values. Raises ValueError for an empty list."""
                        if not values:
                            raise ValueError("mean() of an empty list")
                        return sum(values) / len(values)


                    def median(values: list[float]) -> float:
                        """The middle value (the average of the two middle values for an even count)."""
                        if not values:
                            raise ValueError("median() of an empty list")
                        ordered = sorted(values)
                        mid = len(ordered) // 2
                        return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2

                    """");
                Put(dir, "main.py", $$""""
                    """Uses the package. Run it with Run (F5); run the tests with Test."""
                    from {{py}} import mean, median

                    scores = [91, 78, 85, 62, 99]
                    print(f"mean   {mean(scores):.1f}")
                    print(f"median {median(scores)}")

                    """");
                Put(dir, "tests/test_stats.py", $$"""
                    import pytest

                    from {{py}} import mean, median


                    def test_mean():
                        assert mean([1, 2, 3, 4]) == 2.5


                    def test_median_odd_and_even():
                        assert median([3, 1, 2]) == 2
                        assert median([4, 1, 3, 2]) == 2.5


                    def test_empty_lists_are_rejected():
                        with pytest.raises(ValueError):
                            mean([])

                    """);
                Put(dir, "pyproject.toml", $$"""
                    [project]
                    name = "{{npm}}"
                    version = "0.1.0"
                    requires-python = ">=3.10"
                    dependencies = []

                    [tool.pytest.ini_options]
                    # Tests import the package from the space folder.
                    pythonpath = ["."]
                    testpaths = ["tests"]

                    """);
                Put(dir, "requirements.txt", "pytest\n");
                Put(dir, ".gitignore", pyIgnore);
                break;

            case "py-api":
                Put(dir, "main.py", """"
                    """A small JSON API on Python's standard library: no packages needed.

                    Run it, then call it from the Request panel (GET /todos, POST /todos with {"title": "..."})
                    or open its URL in your browser. The dojo picks a private port and passes it in PORT.
                    """
                    import json
                    import os
                    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

                    TODOS = [{"id": 1, "title": "Learn Python", "done": False}]


                    class Handler(BaseHTTPRequestHandler):
                        def send_json(self, status: int, body) -> None:
                            data = json.dumps(body).encode("utf-8")
                            self.send_response(status)
                            self.send_header("Content-Type", "application/json")
                            self.send_header("Content-Length", str(len(data)))
                            self.end_headers()
                            self.wfile.write(data)

                        def do_GET(self) -> None:
                            if self.path == "/":
                                self.send_json(200, {"message": "Hello from Python!", "try": ["/todos", "/todos/1"]})
                            elif self.path == "/todos":
                                self.send_json(200, TODOS)
                            elif self.path.startswith("/todos/"):
                                todo = next((t for t in TODOS if str(t["id"]) == self.path.rsplit("/", 1)[1]), None)
                                self.send_json(200, todo) if todo else self.send_json(404, {"error": "no such todo"})
                            else:
                                self.send_json(404, {"error": "not found"})

                        def do_POST(self) -> None:
                            if self.path != "/todos":
                                return self.send_json(404, {"error": "not found"})
                            length = int(self.headers.get("Content-Length") or 0)
                            try:
                                payload = json.loads(self.rfile.read(length) or b"{}")
                            except json.JSONDecodeError:
                                return self.send_json(400, {"error": "send a JSON body"})
                            title = str(payload.get("title", "")).strip()
                            if not title:
                                return self.send_json(400, {"error": "title is required"})
                            todo = {"id": max((t["id"] for t in TODOS), default=0) + 1, "title": title, "done": False}
                            TODOS.append(todo)
                            self.send_json(201, todo)

                        def log_message(self, format, *args) -> None:
                            print(format % args)


                    if __name__ == "__main__":
                        port = int(os.environ.get("PORT", "8000"))
                        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
                        print(f"Serving on http://127.0.0.1:{port}")
                        server.serve_forever()

                    # Prefer FastAPI? Install "fastapi" and "uvicorn" from the PyPI panel, then make api.py:
                    #
                    #     from fastapi import FastAPI
                    #     app = FastAPI()
                    #
                    #     @app.get("/todos")
                    #     def todos():
                    #         return [{"id": 1, "title": "Learn FastAPI"}]
                    #
                    # pick api.py in the toolbar and press Run: the dojo starts it with uvicorn on its private port.

                    """");
                Put(dir, "requirements.txt", "# No packages needed: http.server is part of Python. Add fastapi and uvicorn here (from the PyPI panel) to switch.\n");
                Put(dir, ".gitignore", pyIgnore);
                break;

            case "node-script":
                Put(dir, "package.json", $$"""
                    {
                      "name": "{{npm}}",
                      "version": "1.0.0",
                      "private": true,
                      "type": "module",
                      "scripts": {
                        "start": "node index.js",
                        "test": "node --test"
                      },
                      "dependencies": {}
                    }

                    """);
                Put(dir, "index.js", """
                    // A Node.js script (an ES module: use import, not require). Press Run (F5).
                    // npm packages: search in the panel on the right; they go into package.json and node_modules.
                    import { greet } from './greet.js';

                    for (const name of ['world', 'Node']) console.log(greet(name));

                    const squares = [1, 2, 3, 4, 5].map(n => n * n);
                    console.log('squares:', squares, 'sum:', squares.reduce((a, b) => a + b, 0));

                    """);
                Put(dir, "greet.js", """
                    /** @param {string} name */
                    export function greet(name) {
                      return name.trim() ? `Hello, ${name.trim()}!` : 'Hello, stranger!';
                    }

                    """);
                Put(dir, "greet.test.js", """
                    // Node's built-in test runner: press Test (runs `node --test`).
                    import { test } from 'node:test';
                    import assert from 'node:assert/strict';
                    import { greet } from './greet.js';

                    test('greets by name', () => assert.equal(greet('Ada'), 'Hello, Ada!'));
                    test('handles blank names', () => assert.equal(greet('  '), 'Hello, stranger!'));

                    """);
                Put(dir, ".gitignore", nodeIgnore);
                break;

            case "node-ts":
                Put(dir, "package.json", $$"""
                    {
                      "name": "{{npm}}",
                      "version": "1.0.0",
                      "private": true,
                      "type": "module",
                      "scripts": {
                        "start": "node main.ts",
                        "test": "node --test"
                      },
                      "devDependencies": {}
                    }

                    """);
                Put(dir, "main.ts", """
                    // TypeScript that Node runs directly: Node strips the types (no build step).
                    // Only "erasable" TypeScript works that way: types, interfaces and annotations, not enums or namespaces.
                    import { best, type Student } from './students.ts';

                    const students: Student[] = [
                      { name: 'Ann', score: 91 },
                      { name: 'Bob', score: 78 },
                      { name: 'Cy', score: 85 },
                    ];

                    console.log(`Top student: ${best(students).name}`);

                    """);
                Put(dir, "students.ts", """
                    export interface Student {
                      name: string;
                      score: number;
                    }

                    export function best(list: Student[]): Student {
                      if (list.length === 0) throw new Error('best() of an empty list');
                      return list.reduce((a, b) => (b.score > a.score ? b : a));
                    }

                    """);
                Put(dir, "students.test.ts", """
                    import { test } from 'node:test';
                    import assert from 'node:assert/strict';
                    import { best } from './students.ts';

                    test('finds the top score', () => {
                      assert.equal(best([{ name: 'a', score: 1 }, { name: 'b', score: 3 }]).name, 'b');
                    });

                    test('rejects an empty list', () => assert.throws(() => best([])));

                    """);
                Put(dir, "tsconfig.json", """
                    {
                      "compilerOptions": {
                        "target": "es2023",
                        "module": "nodenext",
                        "moduleResolution": "nodenext",
                        "strict": true,
                        "noEmit": true,
                        "allowImportingTsExtensions": true,
                        "erasableSyntaxOnly": true,
                        "verbatimModuleSyntax": true,
                        "skipLibCheck": true
                      }
                    }

                    """);
                Put(dir, ".gitignore", nodeIgnore);
                break;

            case "node-express":
                Put(dir, "package.json", $$"""
                    {
                      "name": "{{npm}}",
                      "version": "1.0.0",
                      "private": true,
                      "type": "module",
                      "scripts": {
                        "start": "node index.js",
                        "test": "node --test"
                      },
                      "dependencies": {
                        "express": "^5.1.0"
                      }
                    }

                    """);
                Put(dir, "index.js", """
                    // An Express JSON API. Run it, then call it from the Request panel or open its URL.
                    // The dojo picks a private port and passes it in PORT.
                    import express from 'express';

                    const app = express();
                    app.use(express.json());

                    const todos = [{ id: 1, title: 'Learn Express', done: false }];

                    app.get('/', (req, res) => res.json({ message: 'Hello from Express!', try: ['/todos', '/todos/1'] }));
                    app.get('/todos', (req, res) => res.json(todos));
                    app.get('/todos/:id', (req, res) => {
                      const todo = todos.find(t => t.id === Number(req.params.id));
                      todo ? res.json(todo) : res.status(404).json({ error: 'no such todo' });
                    });
                    app.post('/todos', (req, res) => {
                      const title = String(req.body?.title ?? '').trim();
                      if (!title) return res.status(400).json({ error: 'title is required' });
                      const todo = { id: Math.max(0, ...todos.map(t => t.id)) + 1, title, done: false };
                      todos.push(todo);
                      res.status(201).json(todo);
                    });

                    const port = Number(process.env.PORT) || 3000;
                    app.listen(port, '127.0.0.1', () => console.log(`Listening on http://127.0.0.1:${port}`));

                    """);
                Put(dir, ".gitignore", nodeIgnore);
                break;

            case "node-next":
                Put(dir, "package.json", $$"""
                    {
                      "name": "{{npm}}",
                      "version": "0.1.0",
                      "private": true,
                      "scripts": {
                        "dev": "next dev",
                        "build": "next build",
                        "start": "next start"
                      },
                      "dependencies": {
                        "next": "^16.0.0",
                        "react": "^19.2.0",
                        "react-dom": "^19.2.0"
                      },
                      "devDependencies": {
                        "@tailwindcss/postcss": "^4",
                        "@types/node": "^24",
                        "@types/react": "^19",
                        "@types/react-dom": "^19",
                        "tailwindcss": "^4",
                        "typescript": "^5"
                      }
                    }

                    """);
                Put(dir, "next.config.ts", """
                    import type { NextConfig } from 'next';

                    const nextConfig: NextConfig = {};

                    export default nextConfig;

                    """);
                Put(dir, "postcss.config.mjs", """
                    // Tailwind CSS v4 runs as a PostCSS plugin.
                    const config = {
                      plugins: { '@tailwindcss/postcss': {} },
                    };

                    export default config;

                    """);
                Put(dir, "tsconfig.json", """
                    {
                      "compilerOptions": {
                        "target": "ES2017",
                        "lib": ["dom", "dom.iterable", "esnext"],
                        "allowJs": true,
                        "skipLibCheck": true,
                        "strict": true,
                        "noEmit": true,
                        "esModuleInterop": true,
                        "module": "esnext",
                        "moduleResolution": "bundler",
                        "resolveJsonModule": true,
                        "isolatedModules": true,
                        "jsx": "react-jsx",
                        "incremental": true,
                        "plugins": [{ "name": "next" }],
                        "paths": { "@/*": ["./*"] }
                      },
                      "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
                      "exclude": ["node_modules"]
                    }

                    """);
                Put(dir, "app/globals.css", """
                    @import "tailwindcss";

                    :root {
                      --background: #ffffff;
                      --foreground: #171717;
                    }

                    @media (prefers-color-scheme: dark) {
                      :root {
                        --background: #0a0a0a;
                        --foreground: #ededed;
                      }
                    }

                    body {
                      background: var(--background);
                      color: var(--foreground);
                    }

                    """);
                Put(dir, "app/layout.tsx", $$"""
                    import type { Metadata } from 'next';
                    import './globals.css';

                    export const metadata: Metadata = {
                      title: '{{space}}',
                      description: 'A Next.js app made in code-dojo',
                    };

                    export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
                      return (
                        <html lang="en">
                          <body className="antialiased font-sans">{children}</body>
                        </html>
                      );
                    }

                    """);
                Put(dir, "app/page.tsx", $$"""
                    // The home page (app/page.tsx is the route "/"). Edit it and the browser updates by itself.
                    import Counter from './counter';

                    const topics = ['Pages are folders in app/', 'Tailwind classes style everything', 'Server components by default'];

                    export default function Home() {
                      return (
                        <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 p-10">
                          <h1 className="text-4xl font-bold tracking-tight">{{space}}</h1>
                          <p className="text-lg text-neutral-500">Next.js and Tailwind CSS, running from code-dojo.</p>
                          <ul className="grid gap-3 sm:grid-cols-3">
                            {topics.map(t => (
                              <li key={t} className="rounded-xl border border-neutral-200 p-4 text-sm shadow-sm dark:border-neutral-800">{t}</li>
                            ))}
                          </ul>
                          <Counter />
                        </main>
                      );
                    }

                    """);
                Put(dir, "app/counter.tsx", """
                    'use client';
                    // A client component: it runs in the browser, so it can use state and handle clicks.
                    import { useState } from 'react';

                    export default function Counter() {
                      const [count, setCount] = useState(0);
                      return (
                        <button
                          onClick={() => setCount(c => c + 1)}
                          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-500 active:scale-95"
                        >
                          Clicked {count} {count === 1 ? 'time' : 'times'}
                        </button>
                      );
                    }

                    """);
                Put(dir, "next-env.d.ts", "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n\n// NOTE: This file should not be edited\n");
                Put(dir, "public/.gitkeep", "");
                Put(dir, ".gitignore", nodeIgnore);
                break;

            default:
                throw new InvalidOperationException("Unknown template.");
        }
    }

    // ================================================================ run / test / check / packages

    /// <summary>A file of this space Run may start, or an npm script ("script:name"); null with a reason otherwise.</summary>
    string? ResolveEntry(string dir, string kind, string? requested, out string error)
    {
        error = "";
        var entry = string.IsNullOrWhiteSpace(requested) ? DefaultEntry(dir, kind) : requested.Trim();
        if (entry is null) { error = kind == "python" ? "There is no .py file to run yet. Add main.py." : "There is no .js or .ts file to run yet. Add index.js."; return null; }
        if (entry.StartsWith("script:", StringComparison.Ordinal))
        {
            var script = entry[7..];
            if (kind != "node" || !ScriptNameRx().IsMatch(script) || !NpmScripts(ReadPackageJson(dir)).ContainsKey(script)) { error = "package.json has no such script."; return null; }
            return entry;
        }
        if (SafePath(dir, entry, out error) is not { } full) return null;
        var ext = Path.GetExtension(full).ToLowerInvariant();
        var okExt = kind == "python" ? ext == ".py" : ext is ".js" or ".mjs" or ".cjs" or ".ts" or ".mts" or ".cts";
        if (!okExt) { error = kind == "python" ? "Pick a .py file to run." : "Pick a .js or .ts file to run."; return null; }
        if (!File.Exists(full)) { error = "That file does not exist."; return null; }
        var rel = Rel(dir, full);
        if (rel.Split('/').Any(SkipDirs.Contains)) { error = "That file is inside an environment folder."; return null; }
        return rel;
    }

    [GeneratedRegex(@"\b(http\.server|HTTPServer|flask|Flask\(|fastapi|FastAPI\(|uvicorn|aiohttp|bottle|django|socketserver|\.listen\(|createServer|express\(|fastify|new Hono|Bun\.serve)", RegexOptions.IgnoreCase)] private static partial Regex WebHintRx();
    [GeneratedRegex(@"^(?<var>[A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*FastAPI\(", RegexOptions.Multiline)] private static partial Regex FastApiVarRx();

    static readonly HashSet<string> WebPackages = ["express", "next", "fastify", "koa", "hono", "@hono/node-server", "vite", "nuxt", "@sveltejs/kit", "astro", "@nestjs/core", "react-scripts"];

    object PolyRun(string name, string kind, JobRequest req)
    {
        var dir = SpaceDir(name)!;
        if (ResolveEntry(dir, kind, req.Project, out var err) is not { } entry) return new { error = err };
        bool web;
        string? source = null;
        if (entry.StartsWith("script:"))
        {
            var pkg = ReadPackageJson(dir);
            var cmd = NpmScripts(pkg).GetValueOrDefault(entry[7..]) ?? "";
            web = Regex.IsMatch(cmd, @"\b(next|vite|nuxt|astro|serve|http-server|nodemon|webpack serve|react-scripts start)\b") || (NpmDeps(pkg).Any(d => WebPackages.Contains(d.Id)) && entry is "script:dev" or "script:start");
            if (NpmDeps(pkg).Count > 0 && !Directory.Exists(Path.Combine(dir, "node_modules")))
                return new { error = "This project's packages are not installed yet (there is no node_modules folder). Press Install packages first.", needs = "install" };
        }
        else
        {
            try { source = File.ReadAllText(Path.Combine(dir, entry)); } catch { source = ""; }
            web = WebHintRx().IsMatch(source);
        }
        int port;
        using (var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0)) { probe.Start(); port = ((IPEndPoint)probe.LocalEndpoint).Port; }
        var s = State(name);
        var (job, error) = StartJob(s, dir, "run", entry, async job =>
        {
            job.Port = port;
            if (job.Web) _ = WatchPort(s, job, port, dir);
            if (kind == "python")
            {
                if (!await EnsureVenv(s, job, dir)) return 1;
                // A FastAPI app without its own uvicorn.run(...): start it with uvicorn on the private port.
                if (source is not null && FastApiVarRx().Match(source) is { Success: true } fa && !source.Contains("uvicorn.run", StringComparison.Ordinal))
                {
                    var module = entry[..^3].Replace('/', '.');
                    return await Py(s, job, dir, ["-X", "utf8", "-m", "uvicorn", $"{module}:{fa.Groups["var"].Value}", "--host", "127.0.0.1", "--port", port.ToString()], null, port);
                }
                var code = await Py(s, job, dir, ["-X", "utf8", "-u", entry], null, port);
                if (code != 0) HintMissingModule(s, dir, "python");
                return code;
            }
            if (entry.StartsWith("script:")) return await Npm(s, job, dir, ["run", entry[7..], .. NextHostArgs(dir, entry[7..])], null, port);
            var exit = await Node(s, job, dir, ["--disable-warning=ExperimentalWarning", entry], null, port);
            if (exit != 0) HintMissingModule(s, dir, "node");
            return exit;
        }, web, kind);
        return job is null ? new { error } : new { started = true, job = Describe(job) };
    }

    [GeneratedRegex(@"^\s*next\s+(dev|start)\b(?![^&|;]*(--hostname|\s-H\b))[^&|;]*$")] private static partial Regex NextServeRx();

    /// <summary>
    /// Extra arguments for an npm script that is a plain `next dev` / `next start`: listen on loopback only.
    /// By default Next listens on every network interface, and since 15.2 its dev server refuses the
    /// hot-reload socket and dev resources to any origin other than localhost or its own --hostname. The
    /// dojo opens apps at 127.0.0.1, so without this the page renders but never becomes interactive.
    /// </summary>
    static string[] NextHostArgs(string dir, string script) =>
        NpmScripts(ReadPackageJson(dir)).GetValueOrDefault(script) is { } cmd && NextServeRx().IsMatch(cmd)
            ? ["--", "--hostname", "127.0.0.1"]
            : [];

    /// <summary>After a failed run: a hint when the program imported a package that is not installed.</summary>
    void HintMissingModule(SpaceState s, string dir, string kind)
    {
        var rx = kind == "python" ? new Regex(@"^ModuleNotFoundError: No module named '(?<m>[\w.]+)'") : new Regex(@"Cannot find (?:package|module) '(?<m>[^']+)'");
        List<string> recent;
        lock (s.Gate) recent = s.Lines.TakeLast(60).Select(l => l.Text).ToList();
        var mod = recent.Select(t => rx.Match(t)).LastOrDefault(m => m.Success)?.Groups["m"].Value;
        if (mod is null || mod.StartsWith('.') || mod.Contains(':') || mod.Contains('\\')) return;
        if (kind == "python")
            Append(s, null, "sys", $"Hint: \"{mod.Split('.')[0]}\" is not installed in this space's .venv. Search for it in the PyPI panel and press Install (the PyPI name can differ from the import name, e.g. import yaml → PyYAML, import PIL → pillow).", dir);
        else if (!mod.StartsWith('/'))
            Append(s, null, "sys", Directory.Exists(Path.Combine(dir, "node_modules"))
                ? $"Hint: the package \"{mod}\" is not installed. Search for it in the npm panel and press Install."
                : $"Hint: \"{mod}\" comes from npm, and this space has no node_modules yet. Press Install packages (it needs the npm registry).", dir);
    }

    object PolyTest(string name, string kind, JobRequest req)
    {
        var dir = SpaceDir(name)!;
        var s = State(name);
        (Job? Job, string? Error) started;
        if (kind == "python")
        {
            if (File.Exists(VenvPython(dir)) && !HasPytest(dir))
                return new { error = "pytest is not installed in this space. Install it from the PyPI panel (or press Install pytest).", needs = "pytest" };
            started = StartJob(s, dir, "test", null, async job =>
            {
                if (!await EnsureVenv(s, job, dir)) return 1;
                if (!HasPytest(dir)) { Append(s, null, "sys", "pytest is not installed in this space: install it from the PyPI panel.", dir); return 1; }
                var code = await Py(s, job, dir, ["-X", "utf8", "-m", "pytest", "-v", "--tb=short", "-rfE", "--color=no", "-p", "no:cacheprovider"], TestTimeout);
                if (code == 5) Append(s, null, "sys", "pytest found no tests. Test files are named test_*.py and test functions start with test_.", dir);
                return code;
            }, lang: "pytest");
        }
        else
        {
            var pkg = ReadPackageJson(dir);
            var script = NpmScripts(pkg).GetValueOrDefault("test");
            started = StartJob(s, dir, "test", null, job =>
                !PlaceholderTest(script) && !(script!.Trim() is "node --test")
                    ? Npm(s, job, dir, ["test"], TestTimeout)
                    : Node(s, job, dir, ["--disable-warning=ExperimentalWarning", "--test"], TestTimeout), lang: "node");
        }
        return started.Job is null ? new { error = started.Error } : new { started = true, job = Describe(started.Job) };
    }

    const string PyCheckScript = """
        import ast, os, sys
        skip = {'.venv', 'venv', 'node_modules', '.git', '__pycache__', '.pytest_cache', '.mypy_cache'}
        bad = n = 0
        for root, dirs, files in os.walk('.'):
            dirs[:] = sorted(d for d in dirs if d not in skip)
            for f in sorted(files):
                if not f.endswith('.py'):
                    continue
                p = os.path.join(root, f)
                n += 1
                try:
                    with open(p, encoding='utf-8') as fh:
                        ast.parse(fh.read(), p)
                except SyntaxError as e:
                    bad += 1
                    print(f'  File "{os.path.abspath(p)}", line {e.lineno or 1}')
                    print(f'{type(e).__name__}: {e.msg}')
        print(f'Checked {n} Python file(s): {bad} with syntax errors.')
        sys.exit(1 if bad else 0)
        """;

    object PolyBuild(string name, string kind, JobRequest req)
    {
        var dir = SpaceDir(name)!;
        var s = State(name);
        (Job? Job, string? Error) started;
        if (kind == "python")
            started = StartJob(s, dir, "build", null, async job =>
            {
                if (!await EnsureVenv(s, job, dir)) return 1;
                return await Py(s, job, dir, ["-X", "utf8", "-c", PyCheckScript], BuildTimeout);
            }, lang: "python");
        else
        {
            var pkg = ReadPackageJson(dir);
            var tsc = Path.Combine(dir, "node_modules", "typescript", "bin", "tsc");
            started = StartJob(s, dir, "build", null, async job =>
            {
                if (NpmScripts(pkg).ContainsKey("build"))
                {
                    if (NpmDeps(pkg).Count > 0 && !Directory.Exists(Path.Combine(dir, "node_modules")))
                    { Append(s, null, "sys", "Install the packages first (Install packages): the build needs them.", dir); return 1; }
                    return await Npm(s, job, dir, ["run", "build"], BuildTimeout);
                }
                if (File.Exists(tsc) && File.Exists(Path.Combine(dir, "tsconfig.json")))
                    return await Node(s, job, dir, [tsc, "--noEmit", "--pretty", "false"], BuildTimeout);
                // No build script and no TypeScript compiler: a syntax check of every script.
                var bad = 0;
                var files = Tree(dir).Where(e => !e.Dir && Path.GetExtension(e.Path).ToLowerInvariant() is ".js" or ".mjs" or ".cjs" or ".ts" or ".mts" or ".cts" && !e.Path.EndsWith(".d.ts")).Take(80).ToList();
                foreach (var f in files)
                    if (await Node(s, job, dir, ["--disable-warning=ExperimentalWarning", "--check", f.Path], BuildTimeout) != 0) bad++;
                Append(s, null, "sys", $"Checked {files.Count} file(s) with node --check: {bad} with syntax errors. (Add typescript as a dev package for full type checking.)", dir);
                return bad == 0 ? 0 : 1;
            }, lang: "node");
        }
        return started.Job is null ? new { error = started.Error } : new { started = true, job = Describe(started.Job) };
    }

    object PolyRestore(string name, string kind)
    {
        var dir = SpaceDir(name)!;
        var s = State(name);
        var (job, error) = kind == "python"
            ? StartJob(s, dir, "restore", null, async job =>
            {
                if (!await EnsureVenv(s, job, dir)) return 1;
                var req = Path.Combine(dir, "requirements.txt");
                if (!File.Exists(req) || ReadRequirements(File.ReadAllText(req)).Count == 0) { Append(s, null, "sys", "requirements.txt lists no packages: nothing to install.", dir); return 0; }
                var code = await Py(s, job, dir, ["-m", "pip", "install", "-r", "requirements.txt"], PipTimeout);
                if (code != 0 && SawNetworkError(s)) Append(s, null, "sys", "PyPI (pypi.org) could not be reached from this network, so pip could not download the packages.", dir);
                if (code == 0) PinRequirements(dir);
                return code;
            }, lang: "python")
            : StartJob(s, dir, "restore", null, job => Npm(s, job, dir, ["install", "--no-audit", "--no-fund"], NpmTimeout, needsRegistry: true), lang: "node");
        return job is null ? new { error } : new { started = true, job = Describe(job) };
    }

    object PolyPackage(string name, string kind, PackageRequest req)
    {
        var dir = SpaceDir(name)!;
        var s = State(name);
        var remove = req.Remove == true;
        (Job? Job, string? Error) started;
        if (kind == "python")
        {
            if (!ValidPipName(req.Id)) return new { error = "That is not a valid PyPI package name." };
            if (req.Version is { Length: > 0 } && !ValidPipVersion(req.Version)) return new { error = "That is not a valid version (use an exact one such as 2.32.3)." };
            var id = req.Id!;
            started = StartJob(s, dir, "package", null, async job =>
            {
                if (!await EnsureVenv(s, job, dir)) return 1;
                var reqFile = Path.Combine(dir, "requirements.txt");
                int code;
                if (remove)
                {
                    code = await Py(s, job, dir, ["-m", "pip", "uninstall", "-y", id.Split('[')[0]], PipTimeout);
                    if (code == 0 || !InstalledPython(dir).ContainsKey(NormalizePipName(id)))
                    {
                        File.WriteAllText(reqFile, UpdateRequirements(File.Exists(reqFile) ? File.ReadAllText(reqFile) : "", id, null, true), new UTF8Encoding(false));
                        Append(s, null, "sys", $"Removed {id} from requirements.txt. (Packages it pulled in stay installed until you recreate .venv.)", dir);
                        code = 0;
                    }
                    return code;
                }
                code = await Py(s, job, dir, ["-m", "pip", "install", req.Version is { Length: > 0 } v ? $"{id}=={v}" : id], PipTimeout);
                if (code != 0)
                {
                    if (SawNetworkError(s)) Append(s, null, "sys", "PyPI (pypi.org) could not be reached from this network, or it has no such package/version.", dir);
                    return code;
                }
                var installed = InstalledPython(dir).TryGetValue(NormalizePipName(id), out var i) ? i.Version : req.Version;
                File.WriteAllText(reqFile, UpdateRequirements(File.Exists(reqFile) ? File.ReadAllText(reqFile) : "", id, installed, false), new UTF8Encoding(false));
                Append(s, null, "sys", $"Added {id}=={installed} to requirements.txt.", dir);
                return 0;
            }, lang: "python");
        }
        else
        {
            if (!ValidNpmName(req.Id)) return new { error = "That is not a valid npm package name (lower case, optionally @scope/name)." };
            if (req.Version is { Length: > 0 } && !ValidNpmVersion(req.Version)) return new { error = "That is not a valid version (use one such as 5.1.0)." };
            if (!File.Exists(Path.Combine(dir, "package.json"))) return new { error = "This space has no package.json." };
            List<string> args = remove ? ["uninstall", req.Id!] : ["install", req.Version is { Length: > 0 } v ? $"{req.Id}@{v}" : req.Id!];
            if (!remove && req.Dev == true) args.Add("--save-dev");
            args.AddRange(["--no-audit", "--no-fund"]);
            started = StartJob(s, dir, "package", null, job => Npm(s, job, dir, args, NpmTimeout, needsRegistry: !remove), lang: "node");
        }
        return started.Job is null ? new { error = started.Error } : new { started = true, job = Describe(started.Job) };
    }

    // ================================================================ output parsing

    /// <summary>
    /// Reads Python, pytest and Node output a line at a time and turns tracebacks, test failures and
    /// compiler errors into problems (paths relative to the space). Keeps a little state between lines.
    /// </summary>
    public sealed class PolyParser
    {
        // Python
        string? _pyFile; int _pyLine;
        // pytest
        string? _test;
        readonly Dictionary<string, (string File, int Line)> _testLoc = [];
        readonly Dictionary<string, string> _testMsg = [];
        // Node
        string? _nodeHeaderFile; int _nodeHeaderLine;
        (string Type, string Msg)? _nodeError;

        static readonly Regex PyFrame = new(@"^\s*File ""(?<file>[^""]+)"", line (?<line>\d+)");
        static readonly Regex PyException = new(@"^(?<type>[A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt|Iteration|Failure))(?::\s*(?<msg>.*))?$");
        static readonly Regex PytestHeader = new(@"^_{3,} (?<name>.+?) _{3,}$");
        static readonly Regex PytestLoc = new(@"^(?<file>(?:[A-Za-z]:)?[^:""<>|*?\s][^:""<>|*?]*?\.py):(?<line>\d+): (?<rest>.*)$");
        static readonly Regex PytestE = new(@"^E\s+(?<msg>\S.*)$");
        static readonly Regex PytestSummary = new(@"^(?<kind>FAILED|ERROR) (?<id>\S+?)(?: - (?<msg>.*))?$");
        static readonly Regex NodeHeader = new(@"^(?<file>(?:file:///)?(?:[A-Za-z]:)?[^:\s][^:]*?\.(?:[cm]?[jt]sx?)):(?<line>\d+)$");
        static readonly Regex NodeError = new(@"^\s*(?<type>(?:[A-Z][A-Za-z]*)?Error)(?: \[(?<code>[A-Z0-9_]+)\])?: (?<msg>.+)$");
        static readonly Regex NodeFrame = new(@"^\s+at (?:.*?\()?(?<file>(?:file:///)?(?:[A-Za-z]:)?[^():\s][^():]*?\.(?:[cm]?[jt]sx?)):(?<line>\d+):(?<col>\d+)\)?\s*$");
        static readonly Regex TscPretty = new(@"^(?<file>[^\s:(][^:(]*?\.(?:[cm]?[jt]sx?)):(?<line>\d+):(?<col>\d+) - (?<sev>error|warning) (?<code>TS\d+): (?<msg>.*)$");

        /// <summary>The problems one more line of output completes (often none).</summary>
        public IEnumerable<Problem> Feed(string lang, string line, string dir)
        {
            if (line.Length > 4000) yield break;
            if (lang is "python" or "pytest")
            {
                if (lang == "pytest")
                {
                    if (PytestHeader.Match(line) is { Success: true } h) { _test = h.Groups["name"].Value.Trim(); _pyFile = null; yield break; }
                    if (_test is not null && PytestLoc.Match(line) is { Success: true } loc && InSpace(dir, loc.Groups["file"].Value) is { } lf)
                    { _testLoc[_test] = (lf, int.Parse(loc.Groups["line"].Value)); yield break; }
                    if (_test is not null && PytestE.Match(line) is { Success: true } e) { _testMsg.TryAdd(_test, e.Groups["msg"].Value.Trim()); yield break; }
                    if (PytestSummary.Match(line) is { Success: true } sm) { yield return Summary(sm, dir); yield break; }
                }
                if (line.StartsWith("Traceback (most recent call last)", StringComparison.Ordinal)) { _pyFile = null; yield break; }
                if (PyFrame.Match(line) is { Success: true } f)
                {
                    if (InSpace(dir, f.Groups["file"].Value) is { } rel) { _pyFile = rel; _pyLine = int.Parse(f.Groups["line"].Value); }
                    yield break;
                }
                if (_pyFile is not null && PyException.Match(line) is { Success: true } x)
                {
                    var type = x.Groups["type"].Value;
                    yield return new("error", type.Split('.')[^1], x.Groups["msg"].Success && x.Groups["msg"].Value.Length > 0 ? $"{type}: {x.Groups["msg"].Value.Trim()}" : type, _pyFile, _pyLine, 1, null);
                    _pyFile = null;
                }
                yield break;
            }
            if (lang != "node") yield break;
            // TypeScript compiler output, both styles.
            if (line.Contains(" TS", StringComparison.Ordinal))
            {
                if (ParseDiagnostic(line, dir) is { } d && d.Code.StartsWith("TS")) { yield return d; yield break; }
                if (TscPretty.Match(line) is { Success: true } t)
                {
                    yield return new(t.Groups["sev"].Value, t.Groups["code"].Value, t.Groups["msg"].Value.Trim(), InSpace(dir, t.Groups["file"].Value) ?? t.Groups["file"].Value.Replace('\\', '/'),
                        int.Parse(t.Groups["line"].Value), int.Parse(t.Groups["col"].Value), null);
                    yield break;
                }
            }
            if (NodeHeader.Match(line) is { Success: true } hd && InSpace(dir, hd.Groups["file"].Value) is { } hf)
            { _nodeHeaderFile = hf; _nodeHeaderLine = int.Parse(hd.Groups["line"].Value); yield break; }
            if (NodeError.Match(line) is { Success: true } ne)
            {
                var msg = $"{ne.Groups["type"].Value}: {ne.Groups["msg"].Value.Trim()}";
                var code = ne.Groups["code"].Success ? ne.Groups["code"].Value : ne.Groups["type"].Value;
                // "Cannot find package 'x' imported from C:\...\index.js": the import is the learner's file.
                if (code == "ERR_MODULE_NOT_FOUND" && Regex.Match(ne.Groups["msg"].Value, @" imported from (?<f>.+?)\s*$") is { Success: true } imp && InSpace(dir, imp.Groups["f"].Value) is { } impFile)
                {
                    yield return new("error", code, msg, impFile, 1, 1, null);
                    _nodeHeaderFile = null; _nodeError = null;
                    yield break;
                }
                if (_nodeHeaderFile is not null)
                {
                    yield return new("error", code, msg, _nodeHeaderFile, _nodeHeaderLine, 1, null);
                    _nodeHeaderFile = null; _nodeError = null;
                }
                else _nodeError = (code, msg);
                yield break;
            }
            if (_nodeError is { } pending && NodeFrame.Match(line) is { Success: true } fr && InSpace(dir, fr.Groups["file"].Value) is { } ff)
            {
                yield return new("error", pending.Type, pending.Msg, ff, int.Parse(fr.Groups["line"].Value), int.Parse(fr.Groups["col"].Value), null);
                _nodeError = null;
            }
        }

        Problem Summary(Match sm, string dir)
        {
            var id = sm.Groups["id"].Value;
            var parts = id.Split("::");
            var file = InSpace(dir, parts[0]) ?? parts[0].Replace('\\', '/');
            var name = parts.Length > 1 ? string.Join('.', parts.Skip(1)) : null;
            // pytest's section headers name the test as Class.test (or "ERROR collecting path").
            var key = name is null ? _testLoc.Keys.FirstOrDefault(k => k.Contains(parts[0].Replace('\\', '/'))) ?? _testLoc.Keys.FirstOrDefault(k => k.Contains(parts[0]))
                : _testLoc.ContainsKey(name) ? name : _testLoc.Keys.FirstOrDefault(k => k.EndsWith(name.Split('.')[^1]));
            var loc = key is not null && _testLoc.TryGetValue(key, out var l) ? l : (file, 0);
            var msg = sm.Groups["msg"].Success ? sm.Groups["msg"].Value.Trim() : key is not null && _testMsg.TryGetValue(key, out var m) ? m : null;
            var what = sm.Groups["kind"].Value == "ERROR" ? (name is null ? $"{parts[0]} could not be collected" : $"{name} errored") : $"{name ?? id} failed";
            return new("error", "pytest", msg is { Length: > 0 } ? $"{what}: {msg}" : what, loc.Item1, loc.Item2, 1, null);
        }

        /// <summary>A path printed by a tool, relative to the space when it is a file of the space (not of .venv or node_modules).</summary>
        public static string? InSpace(string dir, string path)
        {
            try
            {
                if (path.StartsWith("file:///", StringComparison.OrdinalIgnoreCase)) path = new Uri(path).LocalPath;
                if (path.StartsWith('<') || path.StartsWith("node:")) return null;
                var full = Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(dir, path));
                var root = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return null;
                var rel = Rel(dir, full);
                if (rel.Split('/').Any(seg => SkipDirs.Contains(seg) || seg.Equals("site-packages", StringComparison.OrdinalIgnoreCase))) return null;
                return rel;
            }
            catch { return null; }
        }
    }

    /// <summary>Every problem in a block of output (for tests and one-off parsing).</summary>
    public static List<Problem> ParseOutput(string lang, string output, string dir)
    {
        var parser = new PolyParser();
        var list = new List<Problem>();
        foreach (var line in output.Replace("\r\n", "\n").Split('\n')) list.AddRange(parser.Feed(lang, line, dir));
        return list;
    }

    // ================================================================ PyPI and npm lookups

    public record PopularPackage(string Id, string Description);
    /// <summary>A search hit, shaped like a NuGet one so the packages panel shows both the same way.</summary>
    public record PkgResult(string Id, string? Version, string? Description, List<string>? Authors, long Downloads, bool Verified, List<string>? Versions, bool Popular);

    /// <summary>
    /// PyPI has no search API any more (the XML-RPC search was switched off), so "search" is a curated list of
    /// popular packages filtered by the query, plus an exact-name lookup of what was typed.
    /// </summary>
    public static readonly PopularPackage[] PopularPython =
    [
        new("requests", "HTTP for humans: call web APIs and download pages."),
        new("httpx", "A modern HTTP client with sync and async APIs."),
        new("numpy", "Fast n-dimensional arrays and numerical computing."),
        new("pandas", "Data frames: load, clean, group and analyse tabular data."),
        new("polars", "Very fast data frames written in Rust."),
        new("matplotlib", "Plots and charts."),
        new("seaborn", "Statistical charts built on matplotlib."),
        new("plotly", "Interactive charts."),
        new("scipy", "Scientific computing: statistics, optimisation, signal processing."),
        new("scikit-learn", "Machine learning: classification, regression, clustering."),
        new("sympy", "Symbolic mathematics."),
        new("networkx", "Graphs and networks."),
        new("fastapi", "A fast web API framework with type hints and automatic docs (run it with uvicorn)."),
        new("uvicorn", "The ASGI server that runs FastAPI and Starlette apps."),
        new("flask", "A small, classic web framework."),
        new("django", "The batteries-included web framework."),
        new("waitress", "A production web server for Flask and other WSGI apps that works on Windows."),
        new("pydantic", "Data validation with type hints."),
        new("sqlalchemy", "The SQL toolkit and ORM."),
        new("alembic", "Database migrations for SQLAlchemy."),
        new("peewee", "A small, expressive ORM."),
        new("psycopg", "PostgreSQL driver (install psycopg[binary])."),
        new("pymongo", "MongoDB driver."),
        new("redis", "Redis client."),
        new("duckdb", "An in-process analytical SQL database."),
        new("pytest", "The test runner: plain assert statements, fixtures, parametrize."),
        new("pytest-cov", "Test coverage for pytest."),
        new("hypothesis", "Property-based testing."),
        new("ruff", "An extremely fast linter and formatter."),
        new("black", "The uncompromising code formatter."),
        new("mypy", "Static type checker."),
        new("rich", "Colourful text, tables, progress bars and tracebacks in the terminal."),
        new("typer", "Command-line apps from type hints."),
        new("click", "Command-line interfaces."),
        new("tabulate", "Pretty-print tables in plain text."),
        new("tqdm", "Progress bars for loops."),
        new("colorama", "Coloured terminal text on Windows."),
        new("six", "Python 2 and 3 compatibility helpers (tiny, pure Python)."),
        new("python-dateutil", "Powerful extensions to datetime: parsing, relative deltas."),
        new("arrow", "Friendlier dates and times."),
        new("pendulum", "Dates and times made easy."),
        new("pytz", "Time zone definitions."),
        new("pyyaml", "YAML parser and emitter (import yaml)."),
        new("tomli-w", "Write TOML files."),
        new("python-dotenv", "Load settings from a .env file (import dotenv)."),
        new("jinja2", "Templates for HTML and text."),
        new("markdown", "Markdown to HTML."),
        new("beautifulsoup4", "Parse HTML and scrape web pages (import bs4)."),
        new("lxml", "Fast XML and HTML processing."),
        new("pillow", "Image processing (import PIL)."),
        new("openpyxl", "Read and write Excel .xlsx files."),
        new("xlsxwriter", "Write Excel files with charts and formatting."),
        new("faker", "Fake names, addresses and other test data."),
        new("attrs", "Classes without boilerplate."),
        new("loguru", "Logging made simple."),
        new("tenacity", "Retry anything."),
        new("cachetools", "Caching collections and decorators."),
        new("more-itertools", "More routines for iterables."),
        new("toolz", "Functional utilities."),
        new("marshmallow", "Object serialisation and validation."),
        new("cryptography", "Cryptographic recipes and primitives."),
        new("bcrypt", "Password hashing."),
        new("pyjwt", "JSON Web Tokens (import jwt)."),
        new("aiohttp", "Async HTTP client and server."),
        new("websockets", "WebSocket servers and clients."),
        new("boto3", "The AWS SDK."),
        new("streamlit", "Data apps in pure Python."),
        new("textual", "Text user interfaces in the terminal."),
        new("schedule", "Run Python functions periodically."),
        new("humanize", "Human-friendly numbers, sizes and times."),
        new("emoji", "Emoji for Python."),
        new("inflect", "Plurals, ordinals and number words."),
        new("nltk", "Natural language processing toolkit."),
    ];

    public async Task<object> PypiSearch(string? q)
    {
        var query = (q ?? "").Trim();
        if (query.Length > 100 || query.Any(char.IsControl)) return new { error = "Search for a shorter name." };
        var note = "PyPI has no search API, so this lists popular packages that match, plus the exact name you typed.";
        var matches = PopularPython
            .Where(p => query.Length == 0 || p.Id.Contains(query, StringComparison.OrdinalIgnoreCase) || p.Description.Contains(query, StringComparison.OrdinalIgnoreCase))
            .OrderBy(p => !p.Id.Equals(query, StringComparison.OrdinalIgnoreCase)).ThenBy(p => !p.Id.StartsWith(query, StringComparison.OrdinalIgnoreCase))
            .Take(25)
            .Select(p => new PkgResult(p.Id, null, p.Description, null, 0, false, null, true))
            .ToList();
        string? warning = null;
        var bare = query.Split('[')[0];
        if (ValidPipName(bare))
        {
            var exact = await PypiProject(bare);
            if (exact is JsonObject info)
            {
                var name = (string?)info["info"]?["name"] ?? bare;
                matches.RemoveAll(m => NormalizePipName(m.Id) == NormalizePipName(name));
                var author = (string?)info["info"]?["author"];
                matches.Insert(0, new PkgResult(name, (string?)info["info"]?["version"], Clip((string?)info["info"]?["summary"], 400),
                    author is { Length: > 0 } ? [Clip(author, 80)!] : null, 0, false, PypiVersions(info).Take(15).ToList(), false));
            }
            else if (exact is string err) warning = err;
        }
        return new { packages = matches, note, warning };
    }

    /// <summary>The PyPI JSON for a project, null when there is no such project, or an error message.</summary>
    async Task<object?> PypiProject(string name)
    {
        try
        {
            using var res = await _nuget.GetAsync($"https://pypi.org/pypi/{Uri.EscapeDataString(name)}/json");
            if (res.StatusCode == HttpStatusCode.NotFound) return null;
            if (!res.IsSuccessStatusCode) return $"PyPI answered {(int)res.StatusCode} {res.ReasonPhrase}.";
            return JsonNode.Parse(await res.Content.ReadAsStringAsync());
        }
        catch (Exception e) { return $"Could not reach pypi.org: {e.GetBaseException().Message}"; }
    }

    /// <summary>Final (non-pre-release, non-yanked) versions of a PyPI project, newest first.</summary>
    public static List<string> PypiVersions(JsonNode? project)
    {
        if (project?["releases"] is not JsonObject releases) return [];
        return releases
            .Where(kv => ValidPipVersion(kv.Key) && !Regex.IsMatch(kv.Key, @"(a|b|rc|dev)\d")
                && kv.Value is JsonArray files && files.Count > 0 && files.Any(f => f?["yanked"]?.GetValue<bool>() != true))
            .Select(kv => kv.Key)
            .OrderByDescending(v => v, Comparer<string>.Create(ComparePipVersions))
            .Take(80).ToList();
    }

    static int ComparePipVersions(string a, string b)
    {
        static long[] Parts(string v) => Regex.Matches(v, @"\d+").Select(m => long.TryParse(m.Value, out var n) ? n : 0).ToArray();
        var x = Parts(a); var y = Parts(b);
        for (var i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            var c = (i < x.Length ? x[i] : 0).CompareTo(i < y.Length ? y[i] : 0);
            if (c != 0) return c;
        }
        return string.CompareOrdinal(a, b);
    }

    public async Task<object> PypiVersionsOf(string? id)
    {
        var bare = id?.Split('[')[0];
        if (!ValidPipName(bare)) return new { error = "That is not a valid PyPI package name." };
        return await PypiProject(bare!) switch
        {
            JsonObject info => new { id = (string?)info["info"]?["name"] ?? bare, versions = PypiVersions(info) },
            string err => new { error = err },
            _ => (object)new { error = "No such package on PyPI." },
        };
    }

    public async Task<object> NpmSearch(string? q)
    {
        var query = (q ?? "").Trim();
        if (query.Length is 0 or > 100 || query.Any(char.IsControl)) return new { packages = Array.Empty<object>() };
        if (await NpmRegistry() is (false, var why)) return new { error = why };
        try
        {
            var doc = JsonNode.Parse(await _nuget.GetStringAsync($"{RegistryUrl}-/v1/search?text={Uri.EscapeDataString(query)}&size=20"));
            var data = (doc?["objects"] as JsonArray)?.OfType<JsonObject>().Select(o => o["package"] as JsonObject).OfType<JsonObject>().Select(p => new
            {
                id = (string?)p["name"], version = (string?)p["version"], description = Clip((string?)p["description"], 400),
                authors = (string?)p["publisher"]?["username"] is { } u ? new List<string> { u } : null,
                downloads = 0L, verified = false, versions = (string?)p["version"] is { } v ? new List<string> { v } : null,
            }).Where(p => ValidNpmName(p.id)).ToList();
            return new { packages = data ?? [] };
        }
        catch (Exception e) { return new { error = NpmOfflineHelp(RegistryUrl, e.GetBaseException().Message) }; }
    }

    public async Task<object> NpmVersions(string? id)
    {
        if (!ValidNpmName(id)) return new { error = "That is not a valid npm package name." };
        if (await NpmRegistry() is (false, var why)) return new { error = why };
        try
        {
            using var msg = new HttpRequestMessage(HttpMethod.Get, RegistryUrl + id!.Replace("/", "%2f"));
            msg.Headers.Accept.ParseAdd("application/vnd.npm.install-v1+json");
            using var res = await _nuget.SendAsync(msg);
            if (res.StatusCode == HttpStatusCode.NotFound) return new { error = "No such package on npm." };
            res.EnsureSuccessStatusCode();
            var doc = JsonNode.Parse(await res.Content.ReadAsStringAsync());
            var versions = (doc?["versions"] as JsonObject)?.Select(kv => kv.Key).Where(v => ValidNpmVersion(v) && !v.Contains('-'))
                .OrderByDescending(v => v, Comparer<string>.Create(ComparePipVersions)).Take(80).ToList() ?? [];
            return new { id, versions, latest = (string?)doc?["dist-tags"]?["latest"] };
        }
        catch (Exception e) { return new { error = NpmOfflineHelp(RegistryUrl, e.GetBaseException().Message) }; }
    }

    static void MapPoly(WebApplication app, CodeSpaces spaces, JsonSerializerOptions json)
    {
        app.MapGet("/api/pypi/search", async (string? q) => Results.Json(await spaces.PypiSearch(q), json));
        app.MapGet("/api/pypi/versions", async (string? id) => Results.Json(await spaces.PypiVersionsOf(id), json));
        app.MapGet("/api/npm/search", async (string? q) => Results.Json(await spaces.NpmSearch(q), json));
        app.MapGet("/api/npm/versions", async (string? id) => Results.Json(await spaces.NpmVersions(id), json));
    }
}
