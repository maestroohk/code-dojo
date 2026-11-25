using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace CodeDojo;

/// <summary>
/// Debugging a code space's console or web project with the time-travel debugger (CodeDebugger.cs). Console
/// programs are recorded whole, or live with interactive input; web apps run live and are recorded per request
/// (CodeDebugger.Live.cs). One live session per space.
/// </summary>
public sealed partial class CodeSpaces
{
    /// <param name="Interactive">Console: keep the program running and ask for input when it reads a line.</param>
    public record DebugRequest(string? Project, string? Stdin, List<CodeDebugger.Breakpoint>? Breakpoints, int? MaxEvents, bool? Interactive = null);
    public record PlainDebugRequest(string? Code, string? Stdin, List<CodeDebugger.Breakpoint>? Breakpoints, int? MaxEvents);
    /// <summary>For a live session: a request to load (Id), a line of input (Text), the breakpoints to mark hits with.</summary>
    public record DebugSessionRequest(int? Id, string? Text, List<CodeDebugger.Breakpoint>? Breakpoints);

    readonly System.Collections.Concurrent.ConcurrentDictionary<string, LiveDebug> _debugSessions = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The usings an SDK web project gets from ImplicitUsings.</summary>
    const string WebImplicitUsings = CodeDebugger.DefaultImplicitUsings + """

        global using global::System.Net.Http.Json;
        global using global::Microsoft.AspNetCore.Builder;
        global using global::Microsoft.AspNetCore.Hosting;
        global using global::Microsoft.AspNetCore.Http;
        global using global::Microsoft.AspNetCore.Routing;
        global using global::Microsoft.Extensions.Configuration;
        global using global::Microsoft.Extensions.DependencyInjection;
        global using global::Microsoft.Extensions.Hosting;
        global using global::Microsoft.Extensions.Logging;
        """;

    /// <summary>The project to debug: the one asked for if it is a console or web app, else the space's first console app, else its web app.</summary>
    string? DebugTarget(string dir, string? project, out string error)
    {
        error = "";
        string? chosen = null;
        if (!string.IsNullOrWhiteSpace(project) && project.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            if (SafePath(dir, project, out error) is not { } full) return null;
            if (!File.Exists(full)) { error = "That is not a project in this space."; return null; }
            chosen = full;
        }
        if (chosen is not null && KindOf(chosen) is "console" or "web") return chosen;
        var projects = ProjectFiles(dir);
        if ((projects.FirstOrDefault(p => KindOf(p) == "console") ?? projects.FirstOrDefault(p => KindOf(p) == "web")) is { } found) return found;
        error = "There is nothing to debug here. Add a console project (OutputType Exe) or a web project.";
        return null;
    }

    /// <summary>The port of the web app being debugged in this space, if one is running.</summary>
    int? DebugPort(string name) =>
        _debugSessions.TryGetValue(name, out var d) && d.Web && !d.Exited && d.Port > 0 ? d.Port : null;

    void StopDebugSession(string name)
    {
        if (_debugSessions.TryRemove(name, out var d)) d.Dispose();
    }

    void StopDebugSessions()
    {
        foreach (var name in _debugSessions.Keys.ToList()) StopDebugSession(name);
    }

    /// <summary>Everything CodeDebugger needs for a console project and the projects it references.</summary>
    public CodeDebugger.Input? DebugInput(string name, DebugRequest req, out string error)
    {
        error = "";
        if (SpaceDir(name) is not { } dir || !Directory.Exists(dir)) { error = "No such space."; return null; }
        if (DebugTarget(dir, req.Project, out error) is not { } main) return null;

        // The project and its references, transitively.
        var closure = new List<string>();
        void Walk(string csproj)
        {
            csproj = Path.GetFullPath(csproj);
            if (closure.Contains(csproj, StringComparer.OrdinalIgnoreCase) || closure.Count > 30 || !File.Exists(csproj)) return;
            if (!csproj.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;   // stay inside the space
            closure.Add(csproj);
            try
            {
                var doc = XDocument.Load(csproj);
                foreach (var r in doc.Descendants().Where(e => e.Name.LocalName == "ProjectReference").Select(e => (string?)e.Attribute("Include")).OfType<string>())
                    Walk(Path.Combine(Path.GetDirectoryName(csproj)!, r.Replace('\\', Path.DirectorySeparatorChar)));
            }
            catch { }
        }
        Walk(main);

        var allProjectDirs = ProjectFiles(dir).Select(p => Path.GetDirectoryName(Path.GetFullPath(p))!).ToList();
        var files = new List<CodeDebugger.SourceFile>();
        var refs = new List<string>();
        var runtime = new List<string>();
        var usings = new List<string>();
        var notes = new List<string>();
        var aspNet = false;
        long total = 0;
        var webDir = Path.GetDirectoryName(typeof(Microsoft.AspNetCore.Builder.WebApplication).Assembly.Location)!;
        var coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        bool InFramework(string dllName, string fwDir) => File.Exists(Path.Combine(fwDir, dllName));

        foreach (var csproj in closure)
        {
            var projDir = Path.GetDirectoryName(csproj)!;
            XDocument doc;
            try { doc = XDocument.Load(csproj); } catch { doc = new XDocument(new XElement("Project")); }
            // Sources: every .cs below the project folder, minus build output and nested projects.
            void Collect(string d)
            {
                foreach (var f in Directory.EnumerateFiles(d, "*.cs").OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
                {
                    if (IsLink(f) || files.Count >= 2000) continue;
                    var size = new FileInfo(f).Length;
                    if (size > 1_000_000 || (total += size) > 20_000_000) { notes.Add($"{Rel(dir, f)} was left out (too large)."); continue; }
                    files.Add(new(Rel(dir, f), Normalize(File.ReadAllText(f))));
                }
                foreach (var sub in Directory.EnumerateDirectories(d))
                {
                    var n = Path.GetFileName(sub);
                    if (SkipDirs.Contains(n) || n.StartsWith('.') || IsLink(sub)) continue;
                    if (allProjectDirs.Any(p => string.Equals(p, Path.GetFullPath(sub), StringComparison.OrdinalIgnoreCase))) continue;
                    Collect(sub);
                }
            }
            Collect(projDir);

            // Packages: compile references and the DLLs to load at run time, from obj/project.assets.json.
            var assets = Path.Combine(projDir, "obj", "project.assets.json");
            if (File.Exists(assets))
            {
                var json = File.ReadAllText(assets);
                foreach (var p in ReadAssets(json))
                {
                    var file = Path.GetFileName(p);
                    if (InFramework(file, coreDir)) continue;
                    if (InFramework(file, webDir)) { aspNet = true; continue; }
                    refs.Add(p);
                }
                runtime.AddRange(ReadAssets(json, "runtime"));
            }
            else if (ReadPackages(doc.ToString()).Count > 0)
                notes.Add($"{Path.GetFileName(csproj)} has packages that are not restored yet: build once so the debugger can find them.");

            var gu = GlobalUsings(projDir, doc);
            var implicitOn = Prop(doc, "ImplicitUsings") is "enable" or "true";
            var webProject = KindOf(csproj) == "web";
            if (webProject) aspNet = true;
            if (implicitOn && !gu.Contains("global using global::System;")) gu = (webProject ? WebImplicitUsings : CodeDebugger.DefaultImplicitUsings) + "\n" + gu;
            usings.AddRange(gu.Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).Where(l => l.StartsWith("global using ")));
        }

        XDocument mainDoc;
        try { mainDoc = XDocument.Load(main); } catch { mainDoc = new XDocument(new XElement("Project")); }
        var asm = Prop(mainDoc, "AssemblyName") is { Length: > 0 } a && System.Text.RegularExpressions.Regex.IsMatch(a, @"^[\w.-]+$") ? a : Path.GetFileNameWithoutExtension(main);
        // Usings that name a framework-only namespace the debugger cannot see would break the whole compile.
        var usingText = string.Join("\n", usings.Distinct(StringComparer.Ordinal));
        return new CodeDebugger.Input
        {
            Files = files,
            References = refs.Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
            RuntimeLibs = runtime.Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
            GlobalUsings = usingText,
            Stdin = req.Stdin,
            WorkingDir = Path.GetDirectoryName(main),
            AssemblyName = asm,
            Nullable = Prop(mainDoc, "Nullable") is "enable" or "warnings" or "annotations",
            Unsafe = Prop(mainDoc, "AllowUnsafeBlocks").Equals("true", StringComparison.OrdinalIgnoreCase),
            AspNetFramework = aspNet,
            MaxEvents = req.MaxEvents ?? CodeDebugger.DefaultMaxEvents,
            Breakpoints = req.Breakpoints,
            Notes = notes,
            Web = KindOf(main) == "web",
        };
    }

    /// <summary>
    /// Record a console program (whole, or live when Interactive), or start a web app live. Live answers carry
    /// "live": the session's state (requests, log, waiting for input).
    /// </summary>
    public async Task<object> Debug(string name, DebugRequest req, string dotnet)
    {
        if (DebugInput(name, req, out var error) is not { } input) return new { error };
        var project = Rel(Path.Combine(Root, name), input.WorkingDir!) is var p && p == "." ? "" : p;
        if (!input.Web && req.Interactive != true)
        {
            StopDebugSession(name);
            return Shape(await CodeDebugger.Run(dotnet, input), project);
        }
        StopDebugSession(name);
        var (session, first) = await Task.Run(() => LiveDebug.Start(dotnet, input));
        if (session is null) return Shape(first, project);
        _debugSessions[name] = session;
        if (input.Web)
        {
            await session.WaitListening(30_000);
            return Shape(session.RequestResult(0, req.Breakpoints), project, session.Summary(req.Breakpoints));
        }
        var snap = await session.Snapshot(req.Breakpoints);
        return Shape(snap, project, session.Summary(req.Breakpoints));
    }

    LiveDebug? Session(string name) => _debugSessions.TryGetValue(name, out var d) ? d : null;
    static readonly object NoSession = new { error = "The debug session has ended. Start debugging again." };

    /// <summary>The live session's state: the request list (with breakpoint hits), the app's output, input wanted.</summary>
    public object DebugSession(string name, DebugSessionRequest req) => Session(name) is { } d ? d.Summary(req.Breakpoints) : NoSession;

    /// <summary>One request's recording (Id 0: the app's startup).</summary>
    public object DebugRequestRecording(string name, DebugSessionRequest req) =>
        Session(name) is { Web: true } d ? Shape(d.RequestResult(req.Id ?? 0, req.Breakpoints), null, d.Summary(req.Breakpoints)) : NoSession;

    /// <summary>A line for the program waiting in Console.ReadLine; answers with the recording up to the next read (or the end).</summary>
    public async Task<object> DebugInputLine(string name, DebugSessionRequest req)
    {
        if (Session(name) is not { Web: false } d) return NoSession;
        var r = await d.Input(req.Text, req.Breakpoints);
        return Shape(r, null, d.Summary(req.Breakpoints));
    }

    public object DebugStop(string name)
    {
        var had = _debugSessions.ContainsKey(name);
        StopDebugSession(name);
        return new { stopped = had };
    }

    static object Shape(CodeDebugger.Result r, string? project, object? live = null) => new
    {
        error = r.Error, diagnostics = r.Diagnostics, files = r.Files, values = r.Values, stacks = r.Stacks, events = r.Events,
        truncated = r.Truncated, timedOut = r.TimedOut, exception = r.Exception, output = r.Output, stderr = r.Stderr,
        exitCode = r.ExitCode, ms = r.Ms, hits = r.Hits, notes = r.Notes, maxEvents = r.MaxEvents, project, live,
    };

    /// <summary>The Playground's single file, with the usings learner code gets everywhere else in the dojo.</summary>
    public static async Task<object> DebugPlain(string dotnet, PlainDebugRequest req)
    {
        var r = await CodeDebugger.Run(dotnet, new CodeDebugger.Input
        {
            Files = [new(CSharpRunner.UserFile, Normalize(req.Code ?? ""))],
            GlobalUsings = CodeDebugger.DefaultImplicitUsings + "\nglobal using global::System.Text;",
            Stdin = req.Stdin,
            MaxEvents = req.MaxEvents ?? CodeDebugger.DefaultMaxEvents,
            Breakpoints = req.Breakpoints,
        });
        return Shape(r, null);
    }

    /// <summary>Package DLL paths of a section ("compile" or "runtime") of a project.assets.json.</summary>
    public static List<string> ReadAssets(string assetsJson, string section)
    {
        if (section == "compile") return ReadAssets(assetsJson);
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
                if (value is not JsonObject lib || (string?)lib["type"] != "package" || lib[section] is not JsonObject items) continue;
                var libPath = (string?)libraries[key]?["path"];
                if (libPath is null) continue;
                foreach (var (file, _) in items)
                {
                    if (!file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) continue;
                    foreach (var folder in folders)
                    {
                        var p = Path.GetFullPath(Path.Combine(folder, libPath, file));
                        if (File.Exists(p)) { result.Add(p); break; }
                    }
                }
            }
        }
        catch { }
        return result;
    }

    static void MapDebug(WebApplication app, CodeSpaces spaces, CSharpRunner runner, JsonSerializerOptions json)
    {
        app.MapPost("/api/spaces/{name}/debug", async (string name, DebugRequest req) => Results.Json(await spaces.Debug(name, req, runner.DotnetPath), json));
        app.MapPost("/api/spaces/{name}/debug/session", (string name, DebugSessionRequest req) => Results.Json(spaces.DebugSession(name, req), json));
        app.MapPost("/api/spaces/{name}/debug/request", (string name, DebugSessionRequest req) => Results.Json(spaces.DebugRequestRecording(name, req), json));
        app.MapPost("/api/spaces/{name}/debug/input", async (string name, DebugSessionRequest req) => Results.Json(await spaces.DebugInputLine(name, req), json));
        app.MapPost("/api/spaces/{name}/debug/stop", (string name) => Results.Json(spaces.DebugStop(name), json));
        app.MapPost("/api/debug", async (PlainDebugRequest req) => Results.Json(await DebugPlain(runner.DotnetPath, req), json));
    }
}
