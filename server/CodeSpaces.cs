using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace CodeDojo;

/// <summary>
/// Code spaces: real multi-file .NET projects the learner creates, edits, builds, runs and tests inside
/// the dojo, with NuGet packages. Each space is a folder under %USERPROFILE%\code-dojo\spaces (or
/// DOJO_SPACES). Everything goes through the real `dotnet` CLI; arguments are always passed as an
/// argument list, never through a shell. Deleting moves to a .trash folder, never deletes for good.
/// </summary>
public sealed partial class CodeSpaces : IDisposable
{
    public const int MaxRuns = 6;
    const int LineCap = 5000, ProblemCap = 500, TreeCap = 4000, SourceCap = 600;
    const long FileCap = 1_800_000;                      // under the server's 2 MB request limit
    static readonly TimeSpan BuildTimeout = TimeSpan.FromMinutes(5), TestTimeout = TimeSpan.FromMinutes(10),
        PackageTimeout = TimeSpan.FromMinutes(3), CreateTimeout = TimeSpan.FromMinutes(5), IdleRun = TimeSpan.FromMinutes(20);
    static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase) { "bin", "obj", ".git", ".vs", ".idea", "node_modules", "TestResults" };
    const string MetaFile = ".dojo-space.json";

    public string Root { get; }
    readonly string _dotnet;
    readonly ConcurrentDictionary<string, SpaceState> _states = new(StringComparer.OrdinalIgnoreCase);
    readonly HttpClient _http = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(30) };
    readonly HttpClient _nuget = new() { Timeout = TimeSpan.FromSeconds(15) };
    readonly Timer _reaper;
    readonly HashSet<string> _frameworkDlls;
    long _seq;
    string? _searchBase;

    public CodeSpaces(string root, string dotnet)
    {
        Root = Path.GetFullPath(root);
        Directory.CreateDirectory(Root);
        _dotnet = dotnet;
        _nuget.DefaultRequestHeaders.UserAgent.ParseAdd("code-dojo/1.0");
        _reaper = new Timer(_ => Reap(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
        // Assemblies the code-intelligence service already has (runtime + ASP.NET Core): never send twice.
        var tpa = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        _frameworkDlls = new(tpa.Select(Path.GetFileName).OfType<string>(), StringComparer.OrdinalIgnoreCase);
    }

    public static string DefaultRoot() =>
        Environment.GetEnvironmentVariable("DOJO_SPACES") is { Length: > 0 } env ? env
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "code-dojo", "spaces");

    // ================================================================ records

    public record Template(string Id, string Name, string Description);
    public record CreateRequest(string? Name, string? Template);
    public record WriteRequest(string? Path, string? Code);
    public record FsRequest(string? Op, string? Path, string? To);
    public record JobRequest(string? Project);
    public record PackageRequest(string? Project, string? Id, string? Version, bool? Remove);
    public record StdinRequest(string? Text);
    public record SendRequest(string? Method, string? Path, string[][]? Headers, string? Body, string? ContentType);
    public record Problem(string Severity, string Code, string Message, string? File, int Line, int Column, string? Project);
    public record Package(string Id, string? Version);
    public record OutLine(long N, string Stream, string Text);

    public static readonly Template[] Templates =
    [
        new("console", "Console app", "A program you run from the terminal. Reads input, prints output."),
        new("web", "Web API", "ASP.NET Core minimal API on a private port. Call it from the request panel or your browser."),
        new("solution", "Library + tests", "A solution with three projects: a class library, a console app that uses it, and an xUnit test project."),
        new("empty", "Empty folder", "Nothing at all. Add your own files and projects."),
    ];

    sealed class SpaceState
    {
        public readonly object Gate = new();
        public Job? Job;
        public readonly List<OutLine> Lines = [];
        public readonly List<Problem> Problems = [];
        public readonly HashSet<string> ProblemKeys = [];
        public DateTimeOffset LastPoll = DateTimeOffset.UtcNow;
    }

    sealed class Job
    {
        public required string Kind { get; init; }
        public required string? Project { get; init; }
        public string Status = "running";
        public int? ExitCode;
        public Process? Proc;
        public int Port;
        public bool Web, Listening, Stopped;
        public DateTimeOffset Started = DateTimeOffset.UtcNow, Ended;
        public Task Done = Task.CompletedTask;
        public string? FailedTest, FailedMessage;
        public bool ExpectMessage;
        public bool Running => Status == "running";
        public string? Url => Web && Port > 0 ? $"http://127.0.0.1:{Port}" : null;
    }

    // ================================================================ validation (public for tests)

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_-]{0,39}$")] private static partial Regex SpaceNameRx();
    [GeneratedRegex(@"^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*$")] private static partial Regex PackageIdRx();
    [GeneratedRegex(@"^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")] private static partial Regex VersionRx();
    [GeneratedRegex(@"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", RegexOptions.IgnoreCase)] private static partial Regex ReservedRx();
    [GeneratedRegex(@"\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07")] private static partial Regex AnsiRx();

    public static bool ValidSpaceName(string? name) => name is not null && SpaceNameRx().IsMatch(name) && !ReservedRx().IsMatch(name);
    public static bool ValidPackageId(string? id) => id is { Length: > 0 and <= 100 } && PackageIdRx().IsMatch(id);
    public static bool ValidVersion(string? v) => v is { Length: > 0 and <= 64 } && VersionRx().IsMatch(v);

    /// <summary>
    /// The full path of <paramref name="rel"/> inside <paramref name="root"/>, or null (with a reason) when it
    /// is absolute, climbs out, names a device, touches .git, or passes through a symlink or junction.
    /// </summary>
    public static string? SafePath(string root, string? rel, out string error)
    {
        error = "";
        if (string.IsNullOrWhiteSpace(rel)) { error = "A path is required."; return null; }
        if (rel.Length > 260) { error = "That path is too long."; return null; }
        var norm = rel.Replace('\\', '/');
        if (norm.StartsWith('/') || norm.Contains(':') || Path.IsPathRooted(rel)) { error = "Use a path inside the space, not an absolute one."; return null; }
        var parts = norm.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) { error = "A path is required."; return null; }
        foreach (var p in parts)
        {
            if (p is "." or "..") { error = "Paths cannot use . or .. segments."; return null; }
            if (p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || p.Any(char.IsControl)) { error = $"\"{p}\" has characters a file name cannot hold."; return null; }
            if (p.EndsWith('.') || p.EndsWith(' ') || ReservedRx().IsMatch(p)) { error = $"\"{p}\" is not a usable file name on Windows."; return null; }
            if (p.Equals(".git", StringComparison.OrdinalIgnoreCase) || p.Equals(MetaFile, StringComparison.OrdinalIgnoreCase)) { error = "That path is reserved."; return null; }
        }
        var full = Path.GetFullPath(Path.Combine([root, .. parts]));
        var rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) { error = "That path leaves the space."; return null; }
        // No symlinks or junctions anywhere on the way (they could point outside the space).
        var walk = rootFull.TrimEnd(Path.DirectorySeparatorChar);
        if (IsLink(walk)) { error = "The space folder is a link."; return null; }
        foreach (var p in parts)
        {
            walk = Path.Combine(walk, p);
            if (!File.Exists(walk) && !Directory.Exists(walk)) break;
            if (IsLink(walk)) { error = "Links (symlinks, junctions) are not followed."; return null; }
        }
        return full;
    }

    static bool IsLink(string path)
    {
        try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
        catch { return false; }
    }

    static string Rel(string root, string full) => Path.GetRelativePath(root, full).Replace('\\', '/');

    string? SpaceDir(string? name) => ValidSpaceName(name) ? Path.Combine(Root, name!) : null;

    // ================================================================ diagnostics

    [GeneratedRegex(@"^\s*(?<file>(?:[A-Za-z]:)?[^:(\r\n]+?)\((?<line>\d+)(?:,(?<col>\d+))?(?:,\d+(?:,\d+)?)?\)\s*:\s*(?<sev>error|warning)\s+(?<code>[A-Za-z]+\d+)\s*:\s*(?<msg>.*?)(?:\s+\[(?<proj>[^\[\]]+)\])?\s*$")]
    private static partial Regex DiagWithLineRx();
    [GeneratedRegex(@"^\s*(?:(?<file>(?:[A-Za-z]:)?[^:\r\n]+?)\s*:\s*)?(?<sev>error|warning)\s+(?<code>[A-Za-z]+\d+)\s*:\s*(?<msg>.*?)(?:\s+\[(?<proj>[^\[\]]+)\])?\s*$")]
    private static partial Regex DiagRx();

    /// <summary>One line of MSBuild / compiler output as a structured problem, paths relative to the space.</summary>
    public static Problem? ParseDiagnostic(string line, string spaceDir)
    {
        if (line.Length > 4000 || (!line.Contains("error", StringComparison.Ordinal) && !line.Contains("warning", StringComparison.Ordinal))) return null;
        var m = DiagWithLineRx().Match(line);
        int ln = 0, col = 0;
        if (m.Success)
        {
            ln = int.Parse(m.Groups["line"].Value);
            col = m.Groups["col"].Success ? int.Parse(m.Groups["col"].Value) : 1;
        }
        else
        {
            m = DiagRx().Match(line);
            if (!m.Success) return null;
        }
        var file = m.Groups["file"].Success ? m.Groups["file"].Value.Trim() : null;
        // "MSBUILD : error ..." and "CSC : error ..." name a tool, not a file.
        if (file is not null && !file.Contains('\\') && !file.Contains('/') && !Path.HasExtension(file)) file = null;
        return new(m.Groups["sev"].Value, m.Groups["code"].Value, m.Groups["msg"].Value.Trim(),
            file is null ? null : RelativeTo(spaceDir, file), ln, col,
            m.Groups["proj"].Success ? RelativeTo(spaceDir, m.Groups["proj"].Value.Trim()) : null);
    }

    static string RelativeTo(string spaceDir, string path)
    {
        try
        {
            if (Path.IsPathRooted(path))
            {
                var full = Path.GetFullPath(path);
                var root = Path.GetFullPath(spaceDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return Rel(spaceDir, full);
            }
        }
        catch { }
        return path.Replace('\\', '/');
    }

    [GeneratedRegex(@"^\s*Failed\s+(?<name>[^\s\[]+)\s*\[")] private static partial Regex TestFailedRx();
    [GeneratedRegex(@"\sin\s+(?<file>.+?\.cs):line\s+(?<line>\d+)\s*$")] private static partial Regex StackLineRx();

    // ================================================================ projects

    /// <summary>PackageReference items of a project file (Include + Version attribute or element).</summary>
    public static List<Package> ReadPackages(string csprojXml)
    {
        try
        {
            var doc = XDocument.Parse(csprojXml);
            return doc.Descendants().Where(e => e.Name.LocalName == "PackageReference")
                .Select(e => new Package(
                    (string?)e.Attribute("Include") ?? (string?)e.Attribute("Update") ?? "",
                    (string?)e.Attribute("Version") ?? e.Elements().FirstOrDefault(c => c.Name.LocalName == "Version")?.Value?.Trim()))
                .Where(p => p.Id.Length > 0)
                .ToList();
        }
        catch { return []; }
    }

    /// <summary>web, test, console or library.</summary>
    static string Kind(XDocument doc, List<Package> packages)
    {
        var sdk = (string?)doc.Root?.Attribute("Sdk") ?? "";
        var isTest = Prop(doc, "IsTestProject").Equals("true", StringComparison.OrdinalIgnoreCase)
            || packages.Any(p => p.Id is "Microsoft.NET.Test.Sdk" or "xunit" or "xunit.v3" or "NUnit" or "MSTest" or "MSTest.TestFramework");
        return sdk.Contains(".Web", StringComparison.OrdinalIgnoreCase) && !isTest ? "web"
            : isTest ? "test"
            : Prop(doc, "OutputType").Equals("Exe", StringComparison.OrdinalIgnoreCase) || sdk.Contains("Worker", StringComparison.OrdinalIgnoreCase) ? "console"
            : "library";
    }

    public static string KindOf(string csproj)
    {
        try { var text = File.ReadAllText(csproj); return Kind(XDocument.Parse(text), ReadPackages(text)); }
        catch { return "library"; }
    }

    static string Prop(XDocument doc, string name) =>
        doc.Descendants().FirstOrDefault(e => e.Name.LocalName == name)?.Value.Trim() ?? "";

    List<string> ProjectFiles(string dir)
    {
        var list = new List<string>();
        void Walk(string d, int depth)
        {
            if (depth > 6 || list.Count > 50) return;
            foreach (var f in Directory.EnumerateFiles(d, "*.csproj")) list.Add(f);
            foreach (var sub in Directory.EnumerateDirectories(d))
            {
                var n = Path.GetFileName(sub);
                if (SkipDirs.Contains(n) || n.StartsWith('.') || IsLink(sub)) continue;
                Walk(sub, depth + 1);
            }
        }
        if (Directory.Exists(dir)) Walk(dir, 0);
        return list.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
    }

    static string? SolutionFile(string dir) =>
        Directory.EnumerateFiles(dir, "*.slnx").Concat(Directory.EnumerateFiles(dir, "*.sln")).FirstOrDefault();

    object DescribeProject(string spaceDir, string csproj)
    {
        string text;
        try { text = File.ReadAllText(csproj); } catch { text = "<Project/>"; }
        XDocument doc;
        try { doc = XDocument.Parse(text); } catch { doc = XDocument.Parse("<Project/>"); }
        var packages = ReadPackages(text);
        var kind = Kind(doc, packages);
        var projDir = Path.GetDirectoryName(csproj)!;
        var projRefs = doc.Descendants().Where(e => e.Name.LocalName == "ProjectReference")
            .Select(e => (string?)e.Attribute("Include")).OfType<string>()
            .Select(r => { try { return Rel(spaceDir, Path.GetFullPath(Path.Combine(projDir, r.Replace('\\', Path.DirectorySeparatorChar)))); } catch { return r; } })
            .ToList();
        var framework = Prop(doc, "TargetFramework") is { Length: > 0 } tf ? tf : Prop(doc, "TargetFrameworks").Split(';').FirstOrDefault();
        return new
        {
            path = Rel(spaceDir, csproj), name = Path.GetFileNameWithoutExtension(csproj), dir = Rel(spaceDir, projDir) is "." ? "" : Rel(spaceDir, projDir),
            kind, framework, packages, projectRefs = projRefs,
            references = CompileReferences(projDir),
            globalUsings = GlobalUsings(projDir, doc),
        };
    }

    readonly ConcurrentDictionary<string, (DateTime Stamp, List<string> Refs)> _refCache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The compile-time assemblies NuGet restored for a project (from obj/project.assets.json), minus the
    /// framework ones the intelligence service already has. Cached until the assets file changes.
    /// </summary>
    public List<string> CompileReferences(string projDir)
    {
        var assets = Path.Combine(projDir, "obj", "project.assets.json");
        if (!File.Exists(assets)) return [];
        var stamp = File.GetLastWriteTimeUtc(assets);
        if (_refCache.TryGetValue(assets, out var hit) && hit.Stamp == stamp) return hit.Refs;
        var refs = ReadAssets(File.ReadAllText(assets)).Where(p => !_frameworkDlls.Contains(Path.GetFileName(p)) && File.Exists(p)).ToList();
        _refCache[assets] = (stamp, refs);
        return refs;
    }

    /// <summary>Compile-time DLL paths listed in a project.assets.json (first target framework, packages only).</summary>
    public static List<string> ReadAssets(string assetsJson)
    {
        var result = new List<string>();
        try
        {
            if (JsonNode.Parse(assetsJson) is not JsonObject root) return result;
            var folders = (root["packageFolders"] as JsonObject)?.Select(kv => kv.Key).ToList() ?? [];
            var libraries = root["libraries"] as JsonObject;
            var target = (root["targets"] as JsonObject)?.FirstOrDefault(kv => !kv.Key.Contains('/')).Value as JsonObject;
            if (target is null || libraries is null) return result;
            foreach (var (key, value) in target)
            {
                if (value is not JsonObject lib || (string?)lib["type"] != "package" || lib["compile"] is not JsonObject compile) continue;
                var libPath = (string?)libraries[key]?["path"];
                if (libPath is null) continue;
                foreach (var (file, _) in compile)
                {
                    if (!file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) continue;    // "_._" placeholders
                    foreach (var folder in folders)
                    {
                        var p = Path.GetFullPath(Path.Combine(folder, libPath, file));
                        if (File.Exists(p) || folders.Count == 1) { result.Add(p); break; }
                    }
                }
            }
        }
        catch { }
        return result.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>The project's global usings: the generated file after a build, else its &lt;Using&gt; items.</summary>
    static string GlobalUsings(string projDir, XDocument doc)
    {
        try
        {
            var obj = Path.Combine(projDir, "obj");
            if (Directory.Exists(obj))
            {
                var gen = Directory.EnumerateFiles(obj, "*.GlobalUsings.g.cs", SearchOption.AllDirectories)
                    .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
                if (gen is not null) return File.ReadAllText(gen);
            }
        }
        catch { }
        var usings = doc.Descendants().Where(e => e.Name.LocalName == "Using").Select(e => (string?)e.Attribute("Include")).OfType<string>()
            .Where(u => Regex.IsMatch(u, @"^[A-Za-z_][\w.]*$"));
        return string.Concat(usings.Select(u => $"global using {u};\n"));
    }

    // ================================================================ spaces

    public object List()
    {
        var spaces = Directory.EnumerateDirectories(Root)
            .Select(d => new DirectoryInfo(d))
            .Where(d => ValidSpaceName(d.Name))
            .OrderByDescending(d => d.LastWriteTimeUtc)
            .Select(d =>
            {
                string? template = null;
                try { template = (string?)JsonNode.Parse(File.ReadAllText(Path.Combine(d.FullName, MetaFile)))?["template"]; } catch { }
                var projects = ProjectFiles(d.FullName).Select(Path.GetFileNameWithoutExtension).ToList();
                var job = _states.TryGetValue(d.Name, out var s) ? s.Job : null;
                return new { name = d.Name, template, modified = d.LastWriteTimeUtc, projects, running = job is { Running: true, Kind: "run" } };
            }).ToList();
        return new { root = Root, templates = Templates, spaces };
    }

    public object Detail(string name)
    {
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) return new { error = "No such space." };
        var sln = SolutionFile(dir);
        return new
        {
            name, dir, solution = sln is null ? null : Rel(dir, sln),
            projects = ProjectFiles(dir).Select(p => DescribeProject(dir, p)).ToList(),
            tree = Tree(dir),
            job = _states.TryGetValue(name, out var s) && s.Job is { } j ? Describe(j) : null,
        };
    }

    public record Entry(string Path, bool Dir, long Size);

    List<Entry> Tree(string dir)
    {
        var list = new List<Entry>();
        void Walk(string d)
        {
            foreach (var sub in Directory.EnumerateDirectories(d).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                if (list.Count >= TreeCap) return;
                var n = Path.GetFileName(sub);
                if (SkipDirs.Contains(n) || IsLink(sub)) continue;
                list.Add(new(Rel(dir, sub), true, 0));
                Walk(sub);
            }
            foreach (var f in Directory.EnumerateFiles(d).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                if (list.Count >= TreeCap) return;
                if (Path.GetFileName(f).Equals(MetaFile, StringComparison.OrdinalIgnoreCase) || IsLink(f)) continue;
                list.Add(new(Rel(dir, f), false, new FileInfo(f).Length));
            }
        }
        Walk(dir);
        return list;
    }

    [GeneratedRegex(@"[^A-Za-z0-9]+")] private static partial Regex NonAlnum();

    /// <summary>A valid C# project/namespace name from a space name: "my-shop" → "MyShop".</summary>
    public static string ProjectName(string space)
    {
        var parts = NonAlnum().Split(space).Where(p => p.Length > 0).Select(p => char.ToUpperInvariant(p[0]) + p[1..]);
        var name = string.Concat(parts);
        if (name.Length == 0 || !char.IsLetter(name[0])) name = "App" + name;
        return name;
    }

    public async Task<object> Create(CreateRequest req)
    {
        if (!ValidSpaceName(req.Name)) return new { error = "Use 1–40 letters, digits, - or _, starting with a letter." };
        var tpl = Templates.FirstOrDefault(t => t.Id == req.Template);
        if (tpl is null) return new { error = "Pick a template." };
        var dir = Path.Combine(Root, req.Name!);
        if (Directory.Exists(dir) || File.Exists(dir)) return new { error = $"A space called \"{req.Name}\" already exists." };
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, MetaFile), JsonSerializer.Serialize(new { template = tpl.Id, created = DateTimeOffset.UtcNow }));
        if (tpl.Id == "empty") return new { ok = true, name = req.Name };

        var p = ProjectName(req.Name!);
        var s = State(req.Name!);
        var started = StartJob(s, dir, "create", null, async job =>
        {
            async Task<bool> Step(string cwd, params string[] args) => await Exec(s, job, cwd, args, CreateTimeout, null) == 0;
            switch (tpl.Id)
            {
                case "console":
                    if (!await Step(dir, "new", "console", "-n", p, "-o", ".", "--force")) return 1;
                    break;
                case "web":
                    if (!await Step(dir, "new", "webapi", "-n", p, "-o", ".", "--force")) return 1;
                    break;
                case "solution":
                    if (!await Step(dir, "new", "sln", "-n", p, "--force")) return 1;
                    if (!await Step(dir, "new", "classlib", "-n", $"{p}.Core", "-o", $"src/{p}.Core", "--force")) return 1;
                    if (!await Step(dir, "new", "console", "-n", $"{p}.App", "-o", $"src/{p}.App", "--force")) return 1;
                    if (!await Step(dir, "new", "xunit", "-n", $"{p}.Tests", "-o", $"tests/{p}.Tests", "--force")) return 1;
                    var sln = SolutionFile(dir)!;
                    if (!await Step(dir, "sln", Path.GetFileName(sln), "add", $"src/{p}.Core/{p}.Core.csproj", $"src/{p}.App/{p}.App.csproj", $"tests/{p}.Tests/{p}.Tests.csproj")) return 1;
                    if (!await Step(dir, "add", $"src/{p}.App/{p}.App.csproj", "reference", $"src/{p}.Core/{p}.Core.csproj")) return 1;
                    if (!await Step(dir, "add", $"tests/{p}.Tests/{p}.Tests.csproj", "reference", $"src/{p}.Core/{p}.Core.csproj")) return 1;
                    WriteSolutionStarter(dir, p);
                    if (!await Step(dir, "restore")) return 1;
                    break;
            }
            await Step(dir, "new", "gitignore", "--force");
            return 0;
        });
        if (started.Job is not { } j) return new { error = started.Error };
        var finished = await Task.WhenAny(j.Done, Task.Delay(CreateTimeout + TimeSpan.FromSeconds(30)));
        if (finished != j.Done || j.ExitCode != 0)
        {
            string tail;
            lock (s.Gate) tail = string.Join("\n", s.Lines.TakeLast(25).Select(l => l.Text));
            return new { error = "dotnet could not create the project.", output = tail, name = req.Name };
        }
        return new { ok = true, name = req.Name };
    }

    static void WriteSolutionStarter(string dir, string p)
    {
        var core = Path.Combine(dir, "src", $"{p}.Core");
        var app = Path.Combine(dir, "src", $"{p}.App");
        var tests = Path.Combine(dir, "tests", $"{p}.Tests");
        TryDelete(Path.Combine(core, "Class1.cs"));
        TryDelete(Path.Combine(tests, "UnitTest1.cs"));
        File.WriteAllText(Path.Combine(core, "Greeter.cs"), $$"""
            namespace {{p}}.Core;

            /// <summary>The library: plain logic with no console or web code, so it is easy to test.</summary>
            public class Greeter
            {
                public string Greet(string name) =>
                    string.IsNullOrWhiteSpace(name) ? "Hello, stranger!" : $"Hello, {name.Trim()}!";
            }

            """);
        File.WriteAllText(Path.Combine(app, "Program.cs"), $$"""
            using {{p}}.Core;

            // The console app uses the library through a project reference.
            var greeter = new Greeter();
            Console.WriteLine(greeter.Greet(args.Length > 0 ? args[0] : "world"));

            """);
        File.WriteAllText(Path.Combine(tests, "GreeterTests.cs"), $$"""
            using {{p}}.Core;

            namespace {{p}}.Tests;

            public class GreeterTests
            {
                [Fact]
                public void Greets_by_name() => Assert.Equal("Hello, Ada!", new Greeter().Greet("Ada"));

                [Fact]
                public void Handles_blank_names() => Assert.Equal("Hello, stranger!", new Greeter().Greet("  "));
            }

            """);
    }

    static void TryDelete(string path) { try { File.Delete(path); } catch { } }   // only files the template just wrote

    string TrashFor(string what)
    {
        var trash = Path.Combine(Root, ".trash", $"{what}-{DateTime.Now:yyyyMMdd-HHmmss-fff}");
        Directory.CreateDirectory(Path.GetDirectoryName(trash)!);
        return trash;
    }

    public object Delete(string name)
    {
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) return new { error = "No such space." };
        if (IsLink(dir)) return new { error = "That space is a link; remove it yourself." };
        if (_states.TryGetValue(name, out var s)) lock (s.Gate) if (s.Job is { Running: true } j) Kill(s, j);
        var to = TrashFor(name);
        Directory.Move(dir, to);
        _states.TryRemove(name, out _);
        return new { ok = true, trash = to };
    }

    // ================================================================ files

    public object ReadFile(string name, string? path)
    {
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) return new { error = "No such space." };
        if (SafePath(dir, path, out var err) is not { } full) return new { error = err };
        if (!File.Exists(full)) return new { error = "No such file." };
        var size = new FileInfo(full).Length;
        if (size > FileCap) return new { path, binary = true, size, error = "This file is too large to edit here." };
        var bytes = File.ReadAllBytes(full);
        if (Array.IndexOf(bytes, (byte)0) >= 0) return new { path, binary = true, size };
        return new { path = Rel(dir, full), code = Normalize(new UTF8Encoding(false).GetString(bytes).TrimStart('﻿')), size };
    }

    static string Normalize(string s) => s.Replace("\r\n", "\n");

    public object WriteFile(string name, WriteRequest req)
    {
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) return new { error = "No such space." };
        if (SafePath(dir, req.Path, out var err) is not { } full) return new { error = err };
        if (Directory.Exists(full)) return new { error = "That is a folder." };
        var code = Normalize(req.Code ?? "");
        // Keep the file's own line endings and byte-order mark.
        var crlf = false; var bom = false;
        if (File.Exists(full))
        {
            var old = File.ReadAllBytes(full);
            bom = old.Length >= 3 && old[0] == 0xEF && old[1] == 0xBB && old[2] == 0xBF;
            crlf = Encoding.UTF8.GetString(old).Contains("\r\n");
        }

        if (crlf) code = code.Replace("\n", "\r\n");
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, code, new UTF8Encoding(bom));
        return new { ok = true, path = Rel(dir, full) };
    }

    public object Fs(string name, FsRequest req)
    {
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) return new { error = "No such space." };
        if (SafePath(dir, req.Path, out var err) is not { } full) return new { error = err };
        switch (req.Op)
        {
            case "newfile":
                if (File.Exists(full) || Directory.Exists(full)) return new { error = "Something with that name already exists." };
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                File.WriteAllText(full, Starter(dir, full), new UTF8Encoding(false));
                return new { ok = true, path = Rel(dir, full) };
            case "mkdir":
                if (File.Exists(full) || Directory.Exists(full)) return new { error = "Something with that name already exists." };
                Directory.CreateDirectory(full);
                return new { ok = true, path = Rel(dir, full) };
            case "rename":
                if (SafePath(dir, req.To, out var err2) is not { } to) return new { error = err2 };
                if (!File.Exists(full) && !Directory.Exists(full)) return new { error = "Nothing to rename." };
                if ((File.Exists(to) || Directory.Exists(to)) && !string.Equals(full, to, StringComparison.OrdinalIgnoreCase)) return new { error = "Something with that name already exists." };
                if (to.StartsWith(full + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return new { error = "A folder cannot move into itself." };
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                if (Directory.Exists(full)) Directory.Move(full, to); else File.Move(full, to);
                return new { ok = true, path = Rel(dir, to) };
            case "delete":
                if (!File.Exists(full) && !Directory.Exists(full)) return new { error = "Nothing to delete." };
                var trash = Path.Combine(TrashFor(name), Rel(dir, full).Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(trash)!);
                if (Directory.Exists(full)) Directory.Move(full, trash); else File.Move(full, trash);
                return new { ok = true, trash };
            default:
                return new { error = "Unknown operation." };
        }
    }

    /// <summary>A sensible first line for a new file: a namespace and type named after it for C#.</summary>
    string Starter(string dir, string full)
    {
        if (!full.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return "";
        var type = Path.GetFileNameWithoutExtension(full);
        if (!Regex.IsMatch(type, @"^[A-Za-z_]\w*$")) return "";
        // Namespace: the owning project's name plus the folders below it.
        var proj = ProjectFiles(dir).Where(p => full.StartsWith(Path.GetDirectoryName(p)! + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(p => p.Length).FirstOrDefault();
        var ns = proj is null ? ProjectName(Path.GetFileName(dir)) : Path.GetFileNameWithoutExtension(proj);
        if (proj is not null)
        {
            var sub = Path.GetRelativePath(Path.GetDirectoryName(proj)!, Path.GetDirectoryName(full)!);
            if (sub != ".") ns += "." + string.Join('.', sub.Split(Path.DirectorySeparatorChar).Select(ProjectName));
        }
        ns = string.Join('.', ns.Split('.').Select(seg => Regex.IsMatch(seg, @"^[A-Za-z_]\w*$") ? seg : ProjectName(seg)));
        var kind = type.Length > 1 && type[0] == 'I' && char.IsUpper(type[1]) ? "interface" : "class";
        return $"namespace {ns};\n\npublic {kind} {type}\n{{\n}}\n";
    }

    /// <summary>Every C# file of the space (for the intelligence service): small files only, newline-normalized.</summary>
    public object Sources(string name)
    {
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) return new { error = "No such space." };
        var files = new List<object>();
        long total = 0;
        foreach (var (path, isDir, size) in Tree(dir))
        {
            if (isDir || !path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) continue;
            var full = Path.Combine(dir, path);
            if (size > 300_000 || (total += size) > 4_000_000 || files.Count >= SourceCap) continue;
            files.Add(new { path, code = Normalize(File.ReadAllText(full)) });
        }
        return new { files };
    }

    // ================================================================ jobs: build / run / test / packages

    SpaceState State(string name) => _states.GetOrAdd(name, _ => new SpaceState());

    long Next() => Interlocked.Increment(ref _seq);

    void Append(SpaceState s, Job? job, string stream, string text, string dir)
    {
        text = AnsiRx().Replace(text, "");
        if (text.Length > 4000) text = text[..4000] + "…";
        lock (s.Gate)
        {
            s.Lines.Add(new(Next(), stream, text));
            if (s.Lines.Count > LineCap) s.Lines.RemoveRange(0, s.Lines.Count - LineCap);
            if (stream == "sys" || job is null) return;
            if (ParseDiagnostic(text, dir) is { } p) AddProblem(s, p);
            else if (job.Kind == "test") ParseTestLine(s, job, text, dir);
        }
    }

    static void AddProblem(SpaceState s, Problem p)
    {
        var key = $"{p.Severity}|{p.Code}|{p.File}|{p.Line}|{p.Column}|{p.Message}";
        if (s.Problems.Count < ProblemCap && s.ProblemKeys.Add(key)) s.Problems.Add(p);
    }

    static void ParseTestLine(SpaceState s, Job job, string text, string dir)
    {
        var failed = TestFailedRx().Match(text);
        if (failed.Success) { job.FailedTest = failed.Groups["name"].Value; job.FailedMessage = null; job.ExpectMessage = false; return; }
        if (job.FailedTest is null) return;
        if (text.Trim() == "Error Message:") { job.ExpectMessage = true; return; }
        if (job.ExpectMessage && text.Trim().Length > 0) { job.FailedMessage = text.Trim(); job.ExpectMessage = false; return; }
        var at = StackLineRx().Match(text);
        if (at.Success)
        {
            var file = RelativeTo(dir, at.Groups["file"].Value.Trim());
            if (Path.IsPathRooted(file)) return;            // a frame outside the space (the test framework)
            AddProblem(s, new("error", "test", $"{job.FailedTest} failed{(job.FailedMessage is { } m ? ": " + m : "")}", file, int.Parse(at.Groups["line"].Value), 1, null));
            job.FailedTest = null;
        }
    }

    object Describe(Job j) => new
    {
        kind = j.Kind, project = j.Project, status = j.Status, exitCode = j.ExitCode, url = j.Url, listening = j.Listening,
        started = j.Started, ms = (long)((j.Running ? DateTimeOffset.UtcNow : j.Ended) - j.Started).TotalMilliseconds,
    };

    (Job? Job, string? Error) StartJob(SpaceState s, string dir, string kind, string? project, Func<Job, Task<int>> body, bool web = false)
    {
        Job job;
        lock (s.Gate)
        {
            if (s.Job is { Running: true } current)
            {
                if (current.Kind == "run")
                {
                    Kill(s, current);
                    s.Lines.Add(new(Next(), "sys", "Stopped the running app first."));
                }
                else return (null, $"A {current.Kind} is already in progress in this space. Wait for it or press Stop.");
            }
            if (kind == "run" && _states.Values.Count(x => x.Job is { Running: true, Kind: "run" }) >= MaxRuns)
                return (null, $"At most {MaxRuns} programs can run at once. Stop one in another space first.");
            job = new Job { Kind = kind, Project = project, Web = web };
            s.Job = job;
            s.Problems.Clear(); s.ProblemKeys.Clear();
        }
        job.Done = Task.Run(async () =>
        {
            int code;
            try { code = await body(job); }
            catch (Exception e) { Append(s, job, "sys", $"Failed: {e.Message}", dir); code = -1; }
            lock (s.Gate)
            {
                job.ExitCode = code;
                job.Ended = DateTimeOffset.UtcNow;
                job.Status = job.Stopped ? "stopped" : code == 0 ? "succeeded" : "failed";
            }
            var secs = (job.Ended - job.Started).TotalSeconds;
            Append(s, null, "sys", job.Stopped ? $"{kind} stopped." : $"{kind} {(code == 0 ? "succeeded" : $"failed (exit code {code})")} in {secs:0.0} s.", dir);
        });
        return (job, null);
    }

    void Kill(SpaceState s, Job j)
    {
        j.Stopped = true;
        try { if (j.Proc is { HasExited: false } p) { p.Kill(entireProcessTree: true); p.WaitForExit(5000); } } catch { }
    }

    ProcessStartInfo Psi(string cwd, IEnumerable<string> args)
    {
        var psi = new ProcessStartInfo(_dotnet)
        {
            WorkingDirectory = cwd,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // Variables MSBuild set for THIS server's own build would point a child build at the wrong SDK.
        foreach (var key in psi.Environment.Keys.ToList())
            if (key.StartsWith("MSBuild", StringComparison.OrdinalIgnoreCase) || key.StartsWith("ASPNETCORE_", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("DOJO_", StringComparison.OrdinalIgnoreCase) || key is "DOTNET_STARTUP_HOOKS" or "DOTNET_ENVIRONMENT")
                psi.Environment.Remove(key);
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        psi.Environment["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1";
        psi.Environment["DOTNET_GENERATE_ASPNET_CERTIFICATE"] = "false";
        psi.Environment["MSBUILDTERMINALLOGGER"] = "off";
        psi.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        psi.Environment["NO_COLOR"] = "1";
        return psi;
    }

    /// <summary>Run dotnet with <paramref name="args"/>, streaming every line into the space's output.</summary>
    async Task<int> Exec(SpaceState s, Job job, string cwd, IReadOnlyList<string> args, TimeSpan? timeout, Action<ProcessStartInfo>? configure)
    {
        var dir = cwd;
        if (job.Stopped) return -1;
        Append(s, null, "sys", "> dotnet " + string.Join(' ', args.Select(a => a.Contains(' ') ? $"\"{a}\"" : a)), dir);
        var psi = Psi(cwd, args);
        configure?.Invoke(psi);
        var p = Process.Start(psi)!;
        job.Proc = p;
        try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        if (job.Kind != "run") p.StandardInput.Close();
        var pumps = Task.WhenAll(Pump(s, job, p.StandardOutput, "out", dir), Pump(s, job, p.StandardError, "err", dir));
        using var cts = new CancellationTokenSource();
        if (timeout is { } t) cts.CancelAfter(t);
        try { await p.WaitForExitAsync(cts.Token); }
        catch (OperationCanceledException)
        {
            Append(s, null, "sys", $"Stopped: it ran longer than {timeout!.Value.TotalMinutes:0} minutes.", dir);
            try { p.Kill(entireProcessTree: true); } catch { }
            await p.WaitForExitAsync();
        }
        // Build servers can inherit the output pipes and keep them open: do not wait for them.
        await Task.WhenAny(pumps, Task.Delay(1500));
        return p.ExitCode;
    }


    async Task Pump(SpaceState s, Job job, StreamReader reader, string stream, string dir)
    {
        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync()) is not null) Append(s, job, stream, line, dir);
        }
        catch { }
    }

    /// <summary>A project (or solution) path of this space, validated, or the default for the action.</summary>
    string? Target(string dir, string? project, string action, out string error)
    {
        error = "";
        if (!string.IsNullOrWhiteSpace(project))
        {
            if (SafePath(dir, project, out error) is not { } full) return null;
            if (!(full.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || full.EndsWith(".sln", StringComparison.OrdinalIgnoreCase) || full.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase)) || !File.Exists(full))
            { error = "That is not a project in this space."; return null; }
            return full;
        }
        var projects = ProjectFiles(dir);
        if (projects.Count == 0) { error = "There is no project here yet. Create one with a .csproj file."; return null; }
        if (action is "build" or "test" && SolutionFile(dir) is { } sln) return sln;
        if (action == "test")
        {
            var tests = projects.Where(p => KindOf(p) == "test").ToList();
            if (tests.Count == 0) { error = "There is no test project in this space."; return null; }
            if (tests.Count == 1) return tests[0];
        }
        if (action == "run")
        {
            var runnable = projects.Where(p => KindOf(p) is "console" or "web").ToList();
            if (runnable.Count == 0) { error = "Nothing here can run: add a console or web project."; return null; }
            return runnable[0];
        }
        if (projects.Count == 1) return projects[0];
        error = "Pick a project first.";
        return null;
    }


    public object Build(string name, JobRequest req) => Launch(name, req.Project, "build", (s, dir, target, job) =>
        Exec(s, job, dir, ["build", Rel(dir, target), "-nologo", "-nodeReuse:false", "-v:minimal"], BuildTimeout, null));

    public object Test(string name, JobRequest req) => Launch(name, req.Project, "test", (s, dir, target, job) =>
        Exec(s, job, dir, ["test", Rel(dir, target), "-nologo", "--logger", "console;verbosity=normal"], TestTimeout, null));

    public object Run(string name, JobRequest req)
    {
        int port;
        using (var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0)) { probe.Start(); port = ((IPEndPoint)probe.LocalEndpoint).Port; }
        return Launch(name, req.Project, "run", async (s, dir, target, job) =>
        {
            // Run the DLL through dotnet rather than the generated .exe: app-control policies often block
            // freshly built, unsigned executables in the user profile ("Access is denied").
            job.Port = port;
            var url = $"http://127.0.0.1:{port}";
            if (job.Web) _ = WatchPort(s, job, port, dir);
            return await Exec(s, job, dir, ["run", "--project", Rel(dir, target), "--no-launch-profile", "-p:UseAppHost=false"], null, psi =>
            {
                psi.Environment["ASPNETCORE_URLS"] = url;
                psi.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";
                psi.Environment["DOTNET_ENVIRONMENT"] = "Development";
                psi.Environment["Logging__Console__FormatterName"] = "simple";
                psi.Environment["Logging__Console__FormatterOptions__ColorBehavior"] = "Disabled";
            });
        }, webCheck: true);
    }

    async Task WatchPort(SpaceState s, Job job, int port, string dir)
    {
        while (job.Running && !job.Stopped)
        {
            try
            {
                using var c = new System.Net.Sockets.TcpClient();
                await c.ConnectAsync(IPAddress.Loopback, port);
                job.Listening = true;
                Append(s, null, "sys", $"Listening on {job.Url}", dir);
                return;
            }
            catch { await Task.Delay(300); }
        }
    }

    public object ChangePackage(string name, PackageRequest req)
    {
        if (!ValidPackageId(req.Id)) return new { error = "That is not a valid package id." };
        if (req.Version is { Length: > 0 } && !ValidVersion(req.Version)) return new { error = "That is not a valid version." };
        if (string.IsNullOrWhiteSpace(req.Project) || !req.Project.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) return new { error = "Pick the project to add the package to." };
        return Launch(name, req.Project, "package", (s, dir, target, job) =>
        {
            if (!target.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) return Task.FromResult(1);
            List<string> args = req.Remove == true
                ? ["remove", Rel(dir, target), "package", req.Id!]
                : ["add", Rel(dir, target), "package", req.Id!];
            if (req.Remove != true && req.Version is { Length: > 0 } v) { args.Add("--version"); args.Add(v); }
            return Exec(s, job, dir, args, PackageTimeout, null);
        });
    }

    public object Restore(string name, JobRequest req) => Launch(name, req.Project, "restore", (s, dir, target, job) =>
        Exec(s, job, dir, ["restore", Rel(dir, target)], BuildTimeout, null));

    object Launch(string name, string? project, string kind, Func<SpaceState, string, string, Job, Task<int>> body, bool webCheck = false)
    {
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) return new { error = "No such space." };
        if (Target(dir, project, kind is "package" ? "build" : kind, out var err) is not { } target) return new { error = err };
        var web = webCheck && target.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) && KindOf(target) == "web";
        var s = State(name);
        var (job, error) = StartJob(s, dir, kind, Rel(dir, target), j => body(s, dir, target, j), web);
        return job is null ? new { error } : new { started = true, job = Describe(job) };
    }

    public object Stop(string name)
    {
        if (!_states.TryGetValue(name, out var s)) return new { stopped = false };
        lock (s.Gate)
        {
            if (s.Job is not { Running: true } j) return new { stopped = false };
            Kill(s, j);
        }
        return new { stopped = true };
    }

    public object Stdin(string name, StdinRequest req)
    {
        if (!_states.TryGetValue(name, out var s) || s.Job is not { Running: true, Kind: "run", Proc: { } p }) return new { error = "Nothing is running." };
        try
        {
            p.StandardInput.WriteLine(req.Text ?? "");
            p.StandardInput.Flush();
            lock (s.Gate) s.Lines.Add(new(Next(), "in", req.Text ?? ""));
            return new { ok = true };
        }
        catch (Exception e) { return new { error = e.Message }; }
    }

    public object Events(string name, long since)
    {
        if (!ValidSpaceName(name)) return new { error = "No such space." };
        var s = State(name);
        lock (s.Gate)
        {
            s.LastPoll = DateTimeOffset.UtcNow;
            var lines = s.Lines.Where(l => l.N > since).Take(2000).ToList();
            return new { lines, job = s.Job is { } j ? Describe(j) : null, problems = s.Problems.ToList(), seq = lines.Count > 0 ? lines[^1].N : since };
        }
    }

    static readonly HashSet<string> Methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

    /// <summary>Send one HTTP request to the web app running in this space (and nowhere else).</summary>
    public async Task<object> Send(string name, SendRequest req)
    {
        if (!_states.TryGetValue(name, out var s) || s.Job is not { Running: true, Kind: "run", Port: > 0 } j) return new { error = "The app is not running." };
        var method = (req.Method ?? "GET").Trim().ToUpperInvariant();
        if (!Methods.Contains(method)) return new { error = "Unsupported method." };
        var path = (req.Path ?? "/").Trim();
        if (!path.StartsWith('/') || path.StartsWith("//")) path = "/" + path.TrimStart('/');
        if (!Uri.TryCreate($"http://127.0.0.1:{j.Port}{path}", UriKind.Absolute, out var uri) || uri.Host != "127.0.0.1" || uri.Port != j.Port)
            return new { error = "Bad path." };
        using var msg = new HttpRequestMessage(new HttpMethod(method), uri);
        if (req.Body is { Length: > 0 } body)
            msg.Content = new StringContent(body, Encoding.UTF8, string.IsNullOrWhiteSpace(req.ContentType) ? "application/json" : req.ContentType);
        foreach (var pair in req.Headers ?? [])
            if (pair.Length >= 2 && !string.IsNullOrWhiteSpace(pair[0]) && !msg.Headers.TryAddWithoutValidation(pair[0], pair[1]))
                msg.Content?.Headers.TryAddWithoutValidation(pair[0], pair[1]);
        var sw = Stopwatch.StartNew();
        try
        {
            using var res = await _http.SendAsync(msg);
            var bytes = await res.Content.ReadAsByteArrayAsync();
            var type = res.Content.Headers.ContentType?.MediaType ?? "";
            var textual = type.Length == 0 || type.StartsWith("text/") || type.Contains("json") || type.Contains("xml");
            return new
            {
                status = (int)res.StatusCode, reason = res.ReasonPhrase, ms = sw.ElapsedMilliseconds, size = bytes.Length,
                headers = res.Headers.Concat(res.Content.Headers).Select(h => new[] { h.Key, string.Join(", ", h.Value) }).ToList(),
                body = textual ? Encoding.UTF8.GetString(bytes, 0, Math.Min(bytes.Length, 200_000)) : $"({bytes.Length:N0} bytes of {type})",
            };
        }
        catch (Exception e) { return new { error = $"No response: {e.Message}" }; }
    }

    // ================================================================ NuGet

    async Task<string> SearchBase()
    {
        if (_searchBase is not null) return _searchBase;
        try
        {
            var index = JsonNode.Parse(await _nuget.GetStringAsync("https://api.nuget.org/v3/index.json"));
            var url = (index?["resources"] as JsonArray)?.OfType<JsonObject>()
                .FirstOrDefault(r => ((string?)r["@type"])?.StartsWith("SearchQueryService", StringComparison.Ordinal) == true)?["@id"]?.ToString();
            if (url is not null && url.StartsWith("https://", StringComparison.Ordinal)) return _searchBase = url;
        }
        catch { }
        return "https://azuresearch-usnc.nuget.org/query";
    }

    public async Task<object> Search(string? q, int? take)
    {
        var query = (q ?? "").Trim();
        if (query.Length > 100 || query.Any(char.IsControl)) return new { error = "Search for a shorter name." };
        var n = Math.Clamp(take ?? 20, 1, 50);
        try
        {
            var url = $"{await SearchBase()}?q={Uri.EscapeDataString(query)}&take={n}&prerelease=false&semVerLevel=2.0.0";
            var doc = JsonNode.Parse(await _nuget.GetStringAsync(url));
            var data = (doc?["data"] as JsonArray)?.OfType<JsonObject>().Select(p => new
            {
                id = (string?)p["id"], version = (string?)p["version"], description = Clip((string?)p["description"], 400),
                authors = (p["authors"] as JsonArray)?.Select(a => a?.ToString()).Take(3).ToList(),
                downloads = (long?)p["totalDownloads"] ?? 0, verified = (bool?)p["verified"] ?? false,
                versions = (p["versions"] as JsonArray)?.Select(v => (string?)v?["version"]).OfType<string>().Reverse().Take(12).ToList(),
            }).Where(p => ValidPackageId(p.id)).ToList();
            return new { packages = data ?? [] };
        }
        catch (Exception e) { return new { error = $"Could not reach nuget.org: {e.Message}" }; }
    }

    public async Task<object> Versions(string? id)
    {
        if (!ValidPackageId(id)) return new { error = "That is not a valid package id." };
        try
        {
            var doc = JsonNode.Parse(await _nuget.GetStringAsync($"https://api.nuget.org/v3-flatcontainer/{id!.ToLowerInvariant()}/index.json"));
            var versions = (doc?["versions"] as JsonArray)?.Select(v => (string?)v).OfType<string>().Where(ValidVersion).Reverse().Take(80).ToList() ?? [];
            return new { id, versions };
        }
        catch (HttpRequestException e) when (e.StatusCode == HttpStatusCode.NotFound) { return new { error = "No such package on nuget.org." }; }
        catch (Exception e) { return new { error = $"Could not reach nuget.org: {e.Message}" }; }
    }

    static string? Clip(string? s, int n) => s is null ? null : s.Length > n ? s[..n] + "…" : s;

    // ================================================================ lifetime

    void Reap()
    {
        foreach (var s in _states.Values)
            lock (s.Gate)
                if (s.Job is { Running: true, Kind: "run" } j && DateTimeOffset.UtcNow - s.LastPoll > IdleRun)
                {
                    Kill(s, j);
                    s.Lines.Add(new(Next(), "sys", "Stopped: nobody was watching it for 20 minutes."));
                }
    }

    public void Dispose()
    {
        _reaper.Dispose();
        foreach (var s in _states.Values)
            lock (s.Gate) if (s.Job is { Running: true } j) Kill(s, j);
        _http.Dispose();
        _nuget.Dispose();
    }

    // ================================================================ HTTP endpoints

    /// <summary>Wire every code-space endpoint. Called once from Program.cs.</summary>
    public static CodeSpaces Map(WebApplication app, CSharpRunner runner)
    {
        var spaces = new CodeSpaces(DefaultRoot(), runner.DotnetPath);
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        IResult J(object o) => Results.Json(o, json);

        app.MapGet("/api/spaces", () => J(spaces.List()));
        app.MapPost("/api/spaces", async (CreateRequest req) => J(await spaces.Create(req)));
        app.MapGet("/api/spaces/{name}", (string name) => J(spaces.Detail(name)));
        app.MapPost("/api/spaces/{name}/delete", (string name) => J(spaces.Delete(name)));
        app.MapGet("/api/spaces/{name}/file", (string name, string? path) => J(spaces.ReadFile(name, path)));
        app.MapPost("/api/spaces/{name}/file", (string name, WriteRequest req) => J(spaces.WriteFile(name, req)));
        app.MapPost("/api/spaces/{name}/fs", (string name, FsRequest req) => J(spaces.Fs(name, req)));
        app.MapGet("/api/spaces/{name}/sources", (string name) => J(spaces.Sources(name)));
        app.MapPost("/api/spaces/{name}/build", (string name, JobRequest req) => J(spaces.Build(name, req)));
        app.MapPost("/api/spaces/{name}/run", (string name, JobRequest req) => J(spaces.Run(name, req)));
        app.MapPost("/api/spaces/{name}/test", (string name, JobRequest req) => J(spaces.Test(name, req)));
        app.MapPost("/api/spaces/{name}/restore", (string name, JobRequest req) => J(spaces.Restore(name, req)));
        app.MapPost("/api/spaces/{name}/stop", (string name) => J(spaces.Stop(name)));
        app.MapPost("/api/spaces/{name}/stdin", (string name, StdinRequest req) => J(spaces.Stdin(name, req)));
        app.MapPost("/api/spaces/{name}/package", (string name, PackageRequest req) => J(spaces.ChangePackage(name, req)));
        app.MapPost("/api/spaces/{name}/send", async (string name, SendRequest req) => J(await spaces.Send(name, req)));
        app.MapGet("/api/spaces/{name}/events", (string name, long? since) => J(spaces.Events(name, since ?? 0)));
        app.MapGet("/api/nuget/search", async (string? q, int? take) => J(await spaces.Search(q, take)));
        app.MapGet("/api/nuget/versions", async (string? id) => J(await spaces.Versions(id)));
        MapDebug(app, spaces, runner, json);   // the time-travel debugger (CodeSpaces.Debug.cs, CodeDebugger.cs)
        app.Lifetime.ApplicationStopping.Register(spaces.Dispose);
        return spaces;
    }
}
