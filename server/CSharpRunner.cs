using System.Diagnostics;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

namespace CodeDojo;

public record Diag(string Severity, string Id, string Message, int Line, int Col, string File);
public record Mark(string Name, bool Pass, string Detail);
public record RunOutput(string Stdout, string Stderr, int ExitCode, bool TimedOut, bool Truncated, long Ms, List<Mark> Marks);

/// <summary>A compiled learner program sitting in its own temp folder. Dispose deletes it.</summary>
public sealed class Compiled(string dir, string dll, bool web = false, bool efCore = false) : IDisposable
{
    public string Dir => dir;
    public string Dll => dll;
    /// <summary>An ASP.NET Core program: runs with a private port and is tested over HTTP.</summary>
    public bool Web => web;
    /// <summary>Uses EF Core + SQLite (framework "efcore"): loads the EF assemblies from the shared cache and gets a larger CPU budget.</summary>
    public bool EfCore => efCore;
    public void Dispose()
    {
        try { Directory.Delete(dir, true); } catch { /* a locked temp folder is not worth failing over */ }
    }
}

/// <summary>
/// Compiles learner C# with Roslyn in-process, then runs the result in a separate
/// `dotnet` process so an infinite loop or a crash can never take the dojo down.
/// One run at a time: this is a laptop tool, not a build farm.
/// </summary>
public sealed class CSharpRunner
{
    public const string UserFile = "Program.cs";
    public const string TestFile = "tests";
    const char MarkStart = '\u001e';
    const char MarkSep = '\u001f';
    const int OutputCap = 100_000;

    static readonly SemaphoreSlim Gate = new(1, 1);
    static readonly CSharpParseOptions Parse = new(LanguageVersion.Latest);

    readonly List<MetadataReference> _refs;
    readonly string _dotnet;
    readonly string _runtimeConfig;
    readonly SyntaxTree _support;
    readonly List<MetadataReference> _webRefs;
    readonly string _webRuntimeConfig;
    readonly SyntaxTree _webSupport;
    readonly SyntaxTree _liveSupport;
    readonly Lazy<EfLib> _ef;
    readonly Lazy<List<MetadataReference>> _intelRefs;
    public string DotnetPath => _dotnet;

    public CSharpRunner()
    {
        var coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        // Only the base runtime: learner programs run against Microsoft.NETCore.App alone.
        _refs = FrameworkRefs.In(coreDir);

        var exe = OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet";
        var guess = Path.GetFullPath(Path.Combine(coreDir, "..", "..", "..", exe));
        _dotnet = File.Exists(guess) ? guess : "dotnet";

        _runtimeConfig = System.Text.Json.JsonSerializer.Serialize(new
        {
            runtimeOptions = new
            {
                tfm = $"net{Environment.Version.Major}.0",
                framework = new { name = "Microsoft.NETCore.App", version = Environment.Version.ToString() },
            },
        });
        _support = CSharpSyntaxTree.ParseText(SupportSource, Parse, path: "Dojo.cs", encoding: Encoding.UTF8);

        // Project steps marked "framework": "web" also get ASP.NET Core, the same one this server runs on.
        var webDir = Path.GetDirectoryName(typeof(Microsoft.AspNetCore.Builder.WebApplication).Assembly.Location)!;
        _webRefs = [.. _refs, .. FrameworkRefs.In(webDir)];
        _webRuntimeConfig = System.Text.Json.JsonSerializer.Serialize(new
        {
            runtimeOptions = new
            {
                tfm = $"net{Environment.Version.Major}.0",
                frameworks = new[]
                {
                    new { name = "Microsoft.NETCore.App", version = Environment.Version.ToString() },
                    new { name = "Microsoft.AspNetCore.App", version = Path.GetFileName(webDir) },
                },
            },
        });
        _webSupport = CSharpSyntaxTree.ParseText(WebSupportSource, Parse, path: "DojoWeb.cs", encoding: Encoding.UTF8);
        _liveSupport = CSharpSyntaxTree.ParseText(LiveSupportSource, Parse, path: "DojoLive.cs", encoding: Encoding.UTF8);
        _ef = new(() => EfLib.Prepare(webDir), LazyThreadSafetyMode.ExecutionAndPublication);
        _intelRefs = new(() =>
        {
            try { return [.. _webRefs, .. _ef.Value.Refs]; }
            catch { return _webRefs; }   // no EF assemblies next to the server: intelligence still works for everything else
        });
    }

    /// <summary>
    /// EF Core for learner programs ("framework": "efcore"). The server references
    /// Microsoft.EntityFrameworkCore.Sqlite, so its output folder holds the managed assemblies
    /// (EF Core, Microsoft.Data.Sqlite, SQLitePCLRaw) and runtimes/&lt;rid&gt;/native/e_sqlite3.
    /// Those are copied once into a cache folder keyed by their versions; every run then points
    /// at that folder through a runtimeconfig property ("Dojo.LibDir") and a resolver compiled
    /// into the program (DojoEf), so a run copies nothing. Microsoft.Extensions.* come from the
    /// ASP.NET Core shared framework, which EF runs list next to Microsoft.NETCore.App.
    /// </summary>
    sealed class EfLib
    {
        public required List<MetadataReference> Refs { get; init; }
        public required string Dir { get; init; }
        public required string RuntimeConfig { get; init; }
        public required SyntaxTree Support { get; init; }
        public required SyntaxTree ConsoleSupport { get; init; }

        static readonly string[] Managed = ["Microsoft.EntityFrameworkCore*.dll", "Microsoft.Data.Sqlite.dll", "SQLitePCLRaw.*.dll", "Microsoft.Extensions.DependencyModel.dll"];

        public static EfLib Prepare(string webDir)
        {
            var src = Path.GetDirectoryName(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location)!;
            var managed = Managed.SelectMany(p => Directory.GetFiles(src, p)).Distinct().Order().ToList();
            var rid = System.Runtime.InteropServices.RuntimeInformation.RuntimeIdentifier;
            var nativeDir = Path.Combine(src, "runtimes", rid, "native");
            var native = Directory.Exists(nativeDir) ? Directory.GetFiles(nativeDir, "*e_sqlite3*").ToList() : [];
            if (native.Count == 0 && Directory.GetFiles(src, "*e_sqlite3*") is { Length: > 0 } flat) native = [.. flat];   // a RID-specific publish puts it flat

            // Key the cache by every file's name, size and timestamp, so a package upgrade gets a fresh folder.
            var key = string.Join("|", managed.Concat(native).Select(f => { var i = new FileInfo(f); return $"{i.Name}:{i.Length}:{i.LastWriteTimeUtc.Ticks}"; }));
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..12].ToLowerInvariant();
            var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "efcore-" + hash);
            var ready = Path.Combine(dir, ".ready");
            if (!File.Exists(ready))
            {
                // Build beside the final folder and move it into place, so two processes (the server and the tests) never see half a cache.
                var staging = dir + "-" + Guid.NewGuid().ToString("N")[..8];
                Directory.CreateDirectory(staging);
                foreach (var f in managed.Concat(native)) File.Copy(f, Path.Combine(staging, Path.GetFileName(f)), true);
                File.WriteAllText(Path.Combine(staging, ".ready"), key);
                try { Directory.Move(staging, dir); }
                catch (IOException) { try { Directory.Delete(staging, true); } catch { } }   // someone else won the race
                if (!File.Exists(ready)) throw new InvalidOperationException("could not prepare the EF Core library folder " + dir);
            }

            return new EfLib
            {
                Dir = dir,
                Refs = managed.Select(f => (MetadataReference)MetadataReference.CreateFromFile(Path.Combine(dir, Path.GetFileName(f)))).ToList(),
                RuntimeConfig = System.Text.Json.JsonSerializer.Serialize(new
                {
                    runtimeOptions = new
                    {
                        tfm = $"net{Environment.Version.Major}.0",
                        frameworks = new[]
                        {
                            new { name = "Microsoft.NETCore.App", version = Environment.Version.ToString() },
                            new { name = "Microsoft.AspNetCore.App", version = Path.GetFileName(webDir) },
                        },
                        configProperties = new Dictionary<string, object> { ["Dojo.LibDir"] = dir },
                    },
                }),
                Support = CSharpSyntaxTree.ParseText(EfSupportSource, Parse, path: "DojoEf.cs", encoding: Encoding.UTF8),
                ConsoleSupport = CSharpSyntaxTree.ParseText("global using Microsoft.Extensions.Logging;\nglobal using Microsoft.Extensions.DependencyInjection;\n", Parse, path: "DojoEfConsole.cs", encoding: Encoding.UTF8),
            };
        }
    }

    /// <summary>
    /// Compiled into EF Core programs: the usings an EF lesson needs, and a resolver that loads the
    /// EF assemblies and the native SQLite library from the cache folder named in the runtimeconfig.
    /// </summary>
    const string EfSupportSource = """
        global using Microsoft.EntityFrameworkCore;
        global using Microsoft.EntityFrameworkCore.ChangeTracking;
        global using Microsoft.EntityFrameworkCore.Diagnostics;
        global using Microsoft.EntityFrameworkCore.Infrastructure;
        global using Microsoft.EntityFrameworkCore.Metadata.Builders;
        global using Microsoft.EntityFrameworkCore.Migrations;
        global using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
        global using Microsoft.Data.Sqlite;
        global using System.ComponentModel.DataAnnotations;
        global using System.ComponentModel.DataAnnotations.Schema;

        #nullable enable
        internal static class DojoEf
        {
            [System.Runtime.CompilerServices.ModuleInitializer]
            internal static void Init()
            {
                var dir = System.AppContext.GetData("Dojo.LibDir") as string;
                if (string.IsNullOrEmpty(dir)) return;
                var alc = System.Runtime.Loader.AssemblyLoadContext.Default;
                alc.Resolving += (ctx, name) =>
                {
                    var path = System.IO.Path.Combine(dir, name.Name + ".dll");
                    return System.IO.File.Exists(path) ? ctx.LoadFromAssemblyPath(path) : null;
                };
                alc.ResolvingUnmanagedDll += (assembly, name) =>
                {
                    foreach (var file in new[] { name, name + ".dll", "lib" + name + ".so", "lib" + name + ".dylib" })
                    {
                        var path = System.IO.Path.Combine(dir, file);
                        if (System.IO.File.Exists(path)) return System.Runtime.InteropServices.NativeLibrary.Load(path);
                    }
                    return System.IntPtr.Zero;
                };
            }
        }
        """;

    /// <summary>Wrap learner code so compiler line numbers point at what they typed.</summary>
    static string BuildSource(string code, string? template)
    {
        if (string.IsNullOrEmpty(template))
            return $"#line 1 \"{UserFile}\"\n{code}\n";
        var at = template.IndexOf("{{CODE}}", StringComparison.Ordinal);
        if (at < 0) throw new InvalidOperationException("template has no {{CODE}} marker");
        var before = template[..at].TrimEnd('\r', '\n');
        var after = template[(at + 8)..].TrimStart('\r', '\n');
        return $"#line 1 \"{TestFile}\"\n{before}\n#line 1 \"{UserFile}\"\n{code}\n#line 1 \"{TestFile}\"\n{after}\n";
    }

    /// <summary>
    /// A step's "framework" value: "web", "efcore", or both ("web+efcore"). Anything else is plain C#.
    /// </summary>
    public static (bool Web, bool EfCore) Frameworks(string? framework)
    {
        var parts = (framework ?? "").Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        return (parts.Contains("web", StringComparer.OrdinalIgnoreCase), parts.Contains("efcore", StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>Workbench apps carry no step metadata, so EF Core is switched on when the code plainly uses it.</summary>
    static bool LooksLikeEfCore(string code) =>
        code.Contains("DbContext", StringComparison.Ordinal) || code.Contains("EntityFrameworkCore", StringComparison.Ordinal);

    /// <param name="live">A web app for the Workbench: no tests, plus a tracer that reports every request it handles.</param>
    /// <param name="efCore">Reference EF Core + SQLite (the packages this server ships with) and make them loadable at run time.</param>
    /// <param name="extra">More source files compiled with it: the learner's earlier pieces a step "uses" (Pacing.cs).</param>
    public (Compiled? Program, List<Diag> Diagnostics) Compile(string code, string? template = null, bool web = false, bool live = false, bool efCore = false,
        IEnumerable<(string Path, string Text)>? extra = null)
    {
        var tree = CSharpSyntaxTree.ParseText(BuildSource(code, template), Parse, path: "Source.cs", encoding: Encoding.UTF8);
        web |= live;
        efCore |= live && LooksLikeEfCore(code);
        SyntaxTree[] trees = live ? [tree, _support, _webSupport, _liveSupport] : web ? [tree, _support, _webSupport] : [tree, _support];
        IEnumerable<MetadataReference> refs = web ? _webRefs : _refs;
        if (efCore)
        {
            var ef = _ef.Value;
            // EF Core's own dependencies (DI, logging, caching) live in the ASP.NET Core shared framework.
            refs = _webRefs.Concat(ef.Refs);
            trees = web ? [.. trees, ef.Support] : [.. trees, ef.Support, ef.ConsoleSupport];
        }
        if (extra is not null)
            trees = [.. trees, .. extra.Select(e => CSharpSyntaxTree.ParseText(e.Text, Parse, path: e.Path, encoding: Encoding.UTF8))];
        var comp = CSharpCompilation.Create("Exercise", trees, refs,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication,
                nullableContextOptions: NullableContextOptions.Enable,
                optimizationLevel: OptimizationLevel.Debug,
                concurrentBuild: false));
        // [GeneratedRegex] needs the regex source generator that ships in the SDK's targeting pack, as in a real build.
        if (trees.Any(t => t.ToString().Contains("GeneratedRegex", StringComparison.Ordinal)) && RegexGenerator.Value is { } generator)
        {
            CSharpGeneratorDriver.Create([generator], parseOptions: Parse).RunGeneratorsAndUpdateCompilation(comp, out var generated, out _);
            comp = (CSharpCompilation)generated;
        }

        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "run-" + Guid.NewGuid().ToString("N")[..12]);
        Directory.CreateDirectory(dir);
        var dll = Path.Combine(dir, "Exercise.dll");
        EmitResult emit;
        using (var pe = File.Create(dll))
        using (var pdb = File.Create(Path.Combine(dir, "Exercise.pdb")))
            emit = comp.Emit(pe, pdb, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));

        var diags = emit.Diagnostics
            .Where(d => d.Severity >= DiagnosticSeverity.Warning)
            .Select(ToDiag)
            .Where(d => d.Severity == "error" || d.File == UserFile)   // warnings in the hidden tests are noise
            .OrderBy(d => d.Severity == "error" ? 0 : 1).ThenBy(d => d.Line)
            .ToList();

        if (!emit.Success)
        {
            try { Directory.Delete(dir, true); } catch { }
            return (null, diags);
        }
        File.WriteAllText(Path.Combine(dir, "Exercise.runtimeconfig.json"), efCore ? _ef.Value.RuntimeConfig : web ? _webRuntimeConfig : _runtimeConfig);
        return (new Compiled(dir, dll, web, efCore), diags);
    }

    /// <summary>
    /// System.Text.RegularExpressions.Generator from the SDK's Microsoft.NETCore.App.Ref pack (the one that matches this
    /// runtime, else the newest with the same major version), so learner code can use [GeneratedRegex]. Null when no SDK
    /// pack is installed; such code then fails to compile with the usual "partial method has no implementation" error.
    /// </summary>
    static readonly Lazy<ISourceGenerator?> RegexGenerator = new(() =>
    {
        try
        {
            var coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var packs = Path.GetFullPath(Path.Combine(coreDir, "..", "..", "..", "packs", "Microsoft.NETCore.App.Ref"));
            if (!Directory.Exists(packs)) return null;
            var version = Path.GetFileName(coreDir);
            var dirs = Directory.GetDirectories(packs)
                .Where(d => Path.GetFileName(d).StartsWith(Environment.Version.Major + ".", StringComparison.Ordinal))
                .OrderByDescending(d => Path.GetFileName(d) == version).ThenByDescending(d => Version.TryParse(Path.GetFileName(d).Split('-')[0], out var v) ? v : new Version());
            foreach (var dir in dirs)
            {
                var dll = Path.Combine(dir, "analyzers", "dotnet", "cs", "System.Text.RegularExpressions.Generator.dll");
                if (!File.Exists(dll)) continue;
                var asm = System.Reflection.Assembly.LoadFrom(dll);
                // The assembly also holds code fixers that need Roslyn's Workspaces layer, which this server does not ship.
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (System.Reflection.ReflectionTypeLoadException e) { types = e.Types.Where(t => t is not null).ToArray()!; }
                var type = types.FirstOrDefault(t => typeof(IIncrementalGenerator).IsAssignableFrom(t) && !t.IsAbstract);
                if (type is not null && Activator.CreateInstance(type) is IIncrementalGenerator g) return g.AsSourceGenerator();
            }
        }
        catch { /* no generator: [GeneratedRegex] code reports a compile error instead */ }
        return null;
    }, LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>A compilation of plain learner code (no #line mapping), for semantic analysis only.</summary>
    public CSharpCompilation Analyze(SyntaxTree tree) =>
        CSharpCompilation.Create("Analysis", [tree, _support], _refs,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication, nullableContextOptions: NullableContextOptions.Enable, concurrentBuild: false));

    public static CSharpParseOptions ParseOptions => Parse;

    /// <summary>Everything learner code can see (BCL + ASP.NET Core + the Dojo helpers), for the code-intelligence service.</summary>
    public IReadOnlyList<MetadataReference> IntelReferences => _intelRefs.Value;
    public SyntaxTree[] SupportTrees => [_support, _webSupport];
    /// <summary>EF Core's implicit usings, for code intelligence over code that uses EF Core (null when EF is unavailable).</summary>
    public SyntaxTree? EfSupportTree { get { try { return _ef.Value.Support; } catch { return null; } } }

    /// <summary>Cheap check used by the puzzle validator: does this compile, without emitting anything?</summary>
    public bool CompilesClean(string code)
    {
        var tree = CSharpSyntaxTree.ParseText(BuildSource(code, null), Parse, path: "Source.cs", encoding: Encoding.UTF8);
        if (tree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)) return false;
        var comp = CSharpCompilation.Create("Probe", [tree, _support], _refs,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication, nullableContextOptions: NullableContextOptions.Enable, concurrentBuild: false));
        return !comp.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
    }

    static Diag ToDiag(Diagnostic d)
    {
        var span = d.Location.GetMappedLineSpan();
        var file = span.HasMappedPath ? span.Path : (d.Location.SourceTree?.FilePath ?? "");
        return new Diag(d.Severity == DiagnosticSeverity.Error ? "error" : "warning", d.Id,
            d.GetMessage(), span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1, file);
    }

    public const int CpuLimitMs = 4000;
    public const int WallLimitMs = 15000;
    /// <summary>
    /// EF Core programs JIT a large library and build a model before the first query: about a second of CPU on
    /// its own, more with ASP.NET Core on top. They get a larger CPU budget so a busy machine does not fail
    /// a correct answer; a runaway loop is still stopped well inside the wall-clock limit.
    /// </summary>
    public const int EfCpuLimitMs = 8000;

    public async Task<RunOutput> Run(Compiled program, string? stdin, int wallMs = WallLimitMs, int cpuMs = CpuLimitMs)
    {
        if (program.EfCore && cpuMs == CpuLimitMs) cpuMs = EfCpuLimitMs;
        await Gate.WaitAsync();
        try
        {
            var (result, _) = await RunCore(program, stdin, wallMs, cpuMs);
            // A non-zero exit with no output at all: a C# exception always prints something,
            // so silence means the runtime itself failed to start. Try once more.
            var neverStarted = result.ExitCode != 0 && !result.TimedOut && result.Stdout.Length == 0
                               && result.Stderr.Length == 0 && result.Marks.Count == 0;
            if (neverStarted) (result, _) = await RunCore(program, stdin, wallMs, cpuMs);
            return result;
        }
        finally { Gate.Release(); }
    }

    bool _lastExited;
    int _lastThreads;

    /// <summary>One raw run with no retry, plus what the process looked like if it timed out.</summary>
    public async Task<(long Ms, bool TimedOut, TimeSpan Cpu, bool Exited, int Threads, string Stdout)> RunDiagnostic(Compiled program)
    {
        var (r, cpu) = await RunCore(program, null, WallLimitMs, CpuLimitMs);
        return (r.Ms, r.TimedOut, cpu, _lastExited, _lastThreads, r.Stdout);
    }

    async Task<(RunOutput Result, TimeSpan Cpu)> RunCore(Compiled program, string? stdin, int wallMs, int cpuMs)
    {
        var psi = new ProcessStartInfo(_dotnet)
        {
            WorkingDirectory = program.Dir,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            StandardInputEncoding = new UTF8Encoding(false),
        };
        psi.ArgumentList.Add(program.Dll);
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["DOTNET_gcServer"] = "0";
        psi.Environment["DOTNET_TieredPGO"] = "0";
        if (program.Web)
        {
            // A free loopback port for this run only. The test thread compiled into the program
            // (DojoWeb) waits for the server to listen there, calls it, reports, and exits.
            int port;
            using (var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0))
            {
                probe.Start();
                port = ((System.Net.IPEndPoint)probe.LocalEndpoint).Port;
            }
            var url = $"http://127.0.0.1:{port}";
            psi.Environment["DOJO_WEB_URL"] = url;
            psi.Environment["ASPNETCORE_URLS"] = url;
            psi.Environment["ASPNETCORE_ENVIRONMENT"] = "Production";
            psi.Environment["Logging__LogLevel__Default"] = "Warning";
            psi.Environment["Logging__LogLevel__Microsoft.AspNetCore"] = "Error";
            psi.Environment["DOTNET_hostBuilder__reloadConfigOnChange"] = "false";
        }

        var sw = Stopwatch.StartNew();
        using var proc = Process.Start(psi)!;
        try { proc.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }

        var truncated = false;
        void Kill() { try { proc.Kill(entireProcessTree: true); } catch { } }

        async Task<string> Pump(StreamReader reader)
        {
            var sb = new StringBuilder();
            var buf = new char[4096];
            int n;
            while ((n = await reader.ReadAsync(buf)) > 0)
            {
                if (sb.Length < OutputCap) sb.Append(buf, 0, Math.Min(n, OutputCap - sb.Length));
                if (sb.Length >= OutputCap && !truncated) { truncated = true; Kill(); }
            }
            return sb.ToString();
        }

        var outTask = Pump(proc.StandardOutput);
        var errTask = Pump(proc.StandardError);
        try
        {
            if (!string.IsNullOrEmpty(stdin)) await proc.StandardInput.WriteAsync(stdin);
            proc.StandardInput.Close();
        }
        catch (IOException) { /* program exited without reading its input */ }

        // Two limits. CPU time catches a runaway loop quickly. Wall-clock time is generous, because
        // on some machines a security scanner pauses a freshly compiled program for several seconds
        // before it runs a single instruction, and that must not fail a correct answer.
        var timedOut = false;
        var cpu = TimeSpan.Zero;
        var exit = proc.WaitForExitAsync();
        while (await Task.WhenAny(exit, Task.Delay(100)) != exit)
        {
            try { cpu = proc.TotalProcessorTime; } catch { /* already gone */ }
            if (cpu.TotalMilliseconds <= cpuMs && sw.ElapsedMilliseconds <= wallMs) continue;
            timedOut = true;
            try { _lastExited = proc.HasExited; _lastThreads = _lastExited ? 0 : proc.Threads.Count; } catch { }
            Kill();
            break;
        }
        await exit;

        var stdout = await outTask;
        var stderr = await errTask;
        sw.Stop();

        var marks = new List<Mark>();
        var visible = new StringBuilder();
        foreach (var line in stdout.Replace("\r\n", "\n").Split('\n'))
        {
            var at = line.IndexOf(MarkStart);
            if (at < 0) { visible.Append(line).Append('\n'); continue; }
            if (at > 0) visible.Append(line[..at]).Append('\n');
            var parts = line[(at + 1)..].Split(MarkSep);
            if (parts.Length >= 3)
                marks.Add(new Mark(parts[1], parts[0] == "PASS", parts.Length > 2 ? parts[2].Replace("\\n", "\n") : ""));
        }
        if (visible.Length > 0) visible.Length--;   // undo the newline added after the final segment

        return (new RunOutput(visible.ToString(), CleanStderr(stderr), timedOut ? -1 : proc.ExitCode,
            timedOut, truncated, sw.ElapsedMilliseconds, marks), cpu);
    }

    /// <summary>Trim runtime noise from a stack trace so the learner sees their own frames.</summary>
    static string CleanStderr(string stderr)
    {
        var lines = stderr.Replace("\r\n", "\n").Split('\n')
            .Where(l => !l.Contains(" in Dojo.cs:") && !l.Contains(" in DojoWeb.cs:") && !l.Contains("at Dojo.") && !l.Contains("at DojoWeb."))
            .Select(l => l.Replace("Program.<<Main>$>g__", "").Replace("Program.<Main>$(String[] args)", "top-level code"));
        return string.Join("\n", lines).Trim();
    }

    /// <summary>
    /// Compiled into Workbench apps only. Listens to ASP.NET Core's and HttpClient's diagnostic events
    /// (no change to the learner's pipeline) and prints one line per request, marked so the host can
    /// separate it from the app's own output:
    ///   \u001eTRACE\u001f{json}
    /// </summary>
    const string LiveSupportSource = """
        #nullable enable
        public static class DojoLive
        {
            [System.Runtime.CompilerServices.ModuleInitializer]
            internal static void Start()
            {
                if (Environment.GetEnvironmentVariable("DOJO_LIVE") != "1") return;
                System.Diagnostics.DiagnosticListener.AllListeners.Subscribe(new Watcher());
            }

            static readonly object Gate = new();
            static readonly System.IO.TextWriter Out = Console.Out;

            static void Emit(object record)
            {
                var json = JsonSerializer.Serialize(record);
                lock (Gate) { Out.WriteLine("\u001eTRACE\u001f" + json); Out.Flush(); }
            }

            sealed class Watcher : IObserver<System.Diagnostics.DiagnosticListener>
            {
                public void OnNext(System.Diagnostics.DiagnosticListener l)
                {
                    if (l.Name is "Microsoft.AspNetCore" or "HttpHandlerDiagnosticListener") l.Subscribe(new Events());
                }
                public void OnError(Exception e) { }
                public void OnCompleted() { }
            }

            sealed class Events : IObserver<KeyValuePair<string, object?>>
            {
                public void OnNext(KeyValuePair<string, object?> e)
                {
                    try { Handle(e.Key, e.Value); } catch { /* tracing must never break the app */ }
                }
                public void OnError(Exception e) { }
                public void OnCompleted() { }
            }

            static void Handle(string name, object? payload)
            {
                switch (name)
                {
                    case "Microsoft.AspNetCore.Hosting.HttpRequestIn.Start" when payload is HttpContext ctx:
                        ctx.Items["dojo.t0"] = System.Diagnostics.Stopwatch.GetTimestamp();
                        break;
                    case "Microsoft.AspNetCore.Routing.EndpointMatched" when payload is HttpContext ctx:
                        ctx.Items["dojo.matched"] = System.Diagnostics.Stopwatch.GetTimestamp();
                        break;
                    case "Microsoft.AspNetCore.Hosting.UnhandledException" or "Microsoft.AspNetCore.Diagnostics.UnhandledException":
                        var ex = payload?.GetType().GetProperty("exception")?.GetValue(payload) as Exception;
                        var hc = payload?.GetType().GetProperty("httpContext")?.GetValue(payload) as HttpContext;
                        if (hc is not null && ex is not null) hc.Items["dojo.error"] = ex.GetType().Name + ": " + ex.Message;
                        break;
                    case "Microsoft.AspNetCore.Hosting.HttpRequestIn.Stop" when payload is HttpContext ctx:
                    {
                        var t0 = ctx.Items["dojo.t0"] is long a ? a : System.Diagnostics.Stopwatch.GetTimestamp();
                        var ms = System.Diagnostics.Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
                        var ep = ctx.GetEndpoint();
                        var route = (ep as Microsoft.AspNetCore.Routing.RouteEndpoint)?.RoutePattern.RawText;
                        var values = ctx.Request.RouteValues.Where(kv => kv.Key is not "controller" and not "action")
                            .ToDictionary(kv => kv.Key, kv => kv.Value?.ToString());
                        Emit(new
                        {
                            kind = "in",
                            trace = ctx.Request.Headers["X-Dojo-Trace"].ToString(),
                            method = ctx.Request.Method,
                            path = ctx.Request.Path.Value,
                            query = ctx.Request.QueryString.Value,
                            contentType = ctx.Request.ContentType,
                            status = ctx.Response.StatusCode,
                            ms = Math.Round(ms, 1),
                            matched = ctx.Items.ContainsKey("dojo.matched"),
                            route,
                            endpoint = ep?.DisplayName,
                            routeValues = values,
                            error = ctx.Items["dojo.error"] as string,
                            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        });
                        break;
                    }
                    case "System.Net.Http.HttpRequestOut.Stop":
                    {
                        var req = payload?.GetType().GetProperty("Request")?.GetValue(payload) as HttpRequestMessage;
                        var res = payload?.GetType().GetProperty("Response")?.GetValue(payload) as HttpResponseMessage;
                        if (req is null) break;
                        Emit(new
                        {
                            kind = "out",
                            method = req.Method.Method,
                            url = req.RequestUri?.ToString(),
                            status = res is null ? 0 : (int)res.StatusCode,
                            ms = Math.Round((System.Diagnostics.Activity.Current?.Duration ?? TimeSpan.Zero).TotalMilliseconds, 1),
                            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        });
                        break;
                    }
                }
            }
        }
        """;

    /// <summary>
    /// Compiled into web projects. The learner writes a real Program.cs that ends in app.Run().
    /// A background thread waits for Kestrel, then runs DojoTests.Run(HttpClient) from the hidden
    /// template against the live server and ends the process.
    /// </summary>
    const string WebSupportSource = """
        global using Microsoft.AspNetCore.Builder;
        global using Microsoft.AspNetCore.Http;
        global using Microsoft.AspNetCore.Mvc;
        global using Microsoft.AspNetCore.Routing;
        global using Microsoft.Extensions.DependencyInjection;
        global using Microsoft.Extensions.Hosting;
        global using Microsoft.Extensions.Logging;
        global using System.Net;
        global using System.Net.Http;
        global using System.Net.Http.Json;
        global using System.Text.Json;

        #nullable enable
        public static class DojoWeb
        {
            [System.Runtime.CompilerServices.ModuleInitializer]
            internal static void Start()
            {
                var url = Environment.GetEnvironmentVariable("DOJO_WEB_URL");
                if (string.IsNullOrEmpty(url)) return;
                new Thread(() => RunTests(url).GetAwaiter().GetResult()) { IsBackground = true, Name = "dojo-tests" }.Start();
            }

            static async Task RunTests(string url)
            {
                var uri = new Uri(url);
                var up = false;
                for (var i = 0; i < 100 && !up; i++)
                {
                    try { using var probe = new System.Net.Sockets.TcpClient(); await probe.ConnectAsync(uri.Host, uri.Port); up = true; }
                    catch { await Task.Delay(100); }
                }
                if (!up)
                {
                    Dojo.Report("The server starts", false, "Nothing was listening after 10 seconds. Does your program build the app and end with app.Run()?");
                    Environment.Exit(0);
                }

                using var http = new HttpClient { BaseAddress = uri, Timeout = TimeSpan.FromSeconds(5) };
                var tests = System.Reflection.Assembly.GetEntryAssembly()?.GetType("DojoTests")?.GetMethod("Run",
                    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
                try
                {
                    if (tests?.Invoke(null, new object[] { http }) is Task running) await running;
                }
                catch (Exception e)
                {
                    var real = e is System.Reflection.TargetInvocationException { InnerException: { } inner } ? inner : e;
                    Dojo.Report("The tests could finish", false, real.GetType().Name + ": " + real.Message);
                }
                Console.Out.Flush();
                Environment.Exit(0);
            }

            /// <summary>Read a response body as text (empty when there is none).</summary>
            public static async Task<string> Text(HttpResponseMessage response) => await response.Content.ReadAsStringAsync();

            /// <summary>Parse a response body as JSON. Returns a default element when the body is not JSON.</summary>
            public static async Task<JsonElement> Json(HttpResponseMessage response)
            {
                var text = await response.Content.ReadAsStringAsync();
                try { return JsonDocument.Parse(text).RootElement.Clone(); }
                catch (JsonException) { return default; }
            }

            /// <summary>One row: did the response have this status code?</summary>
            public static void Status(string name, int expected, HttpResponseMessage response)
            {
                var actual = (int)response.StatusCode;
                Dojo.Check(name, actual == expected, "expected status " + expected + " but got " + actual + " " + response.StatusCode);
            }

            /// <summary>Read a property from a JSON object without throwing. Missing gives null.</summary>
            public static string? Prop(JsonElement json, string name)
            {
                if (json.ValueKind != JsonValueKind.Object) return null;
                foreach (var p in json.EnumerateObject())
                    if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))
                        return p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : p.Value.GetRawText();
                return null;
            }
        }
        """;

    /// <summary>
    /// The same program with its top-level statements moved above its type declarations (usings stay first),
    /// or null when there is nothing to move.
    /// </summary>
    public static string? StatementsFirst(string code)
    {
        var root = CSharpSyntaxTree.ParseText(code, Parse).GetCompilationUnitRoot();
        var statements = root.Members.OfType<Microsoft.CodeAnalysis.CSharp.Syntax.GlobalStatementSyntax>().ToList();
        var others = root.Members.Where(m => m is not Microsoft.CodeAnalysis.CSharp.Syntax.GlobalStatementSyntax).ToList();
        if (statements.Count == 0 || others.Count == 0) return null;
        var head = string.Concat(root.Externs.Select(e => e.ToFullString())) + string.Concat(root.Usings.Select(u => u.ToFullString()))
                 + string.Concat(root.AttributeLists.Select(a => a.ToFullString()));
        return head + string.Concat(statements.Select(s => s.ToFullString())) + "\n" + string.Concat(others.Select(o => o.ToFullString()));
    }

    /// <summary>Extra global usings for free runs only (never graded): the namespaces lesson samples use most.</summary>
    public static readonly (string Path, string Text)[] PlaygroundUsings =
    [("Playground.cs", """
        global using System.Diagnostics;
        global using System.Globalization;
        global using System.Collections.Concurrent;
        global using System.Net;
        global using System.Net.Http;
        global using System.Security.Cryptography;
        global using System.Security.Cryptography.X509Certificates;
        global using System.Text.Json;
        global using System.Text.Json.Serialization;
        global using System.Text.RegularExpressions;
        """)];

    /// <summary>Compiled into every learner program: test helpers plus predictable console behaviour.</summary>
    const string SupportSource = """
        global using System;
        global using System.Collections.Generic;
        global using System.IO;
        global using System.Linq;
        global using System.Text;
        global using System.Threading;
        global using System.Threading.Tasks;

        #nullable enable
        public static class Dojo
        {
            static System.IO.TextWriter _real = System.Console.Out;

            [System.Runtime.CompilerServices.ModuleInitializer]
            internal static void Init()
            {
                System.Console.OutputEncoding = new System.Text.UTF8Encoding(false);
                var culture = System.Globalization.CultureInfo.GetCultureInfo("en-US");
                System.Globalization.CultureInfo.DefaultThreadCurrentCulture = culture;
                System.Globalization.CultureInfo.DefaultThreadCurrentUICulture = culture;
                System.Globalization.CultureInfo.CurrentCulture = culture;
                _real = System.Console.Out;
            }

            internal static void Report(string name, bool ok, string detail)
            {
                System.Console.Out.Flush();
                _real.WriteLine("\u001e" + (ok ? "PASS" : "FAIL") + "\u001f" + name + "\u001f" +
                                detail.Replace("\r", "").Replace("\n", "\\n"));
                _real.Flush();
            }

            public static string Show(object? value)
            {
                if (value is null) return "null";
                if (value is string s) return "\"" + s + "\"";
                if (value is char c) return "'" + c + "'";
                if (value is bool b) return b ? "true" : "false";
                if (value is System.Collections.IDictionary d)
                {
                    var parts = new List<string>();
                    foreach (System.Collections.DictionaryEntry e in d) parts.Add(Show(e.Key) + ": " + Show(e.Value));
                    return "{" + string.Join(", ", parts) + "}";
                }
                if (value is System.Collections.IEnumerable seq)
                {
                    var parts = new List<string>();
                    foreach (var item in seq) parts.Add(Show(item));
                    return "[" + string.Join(", ", parts) + "]";
                }
                return System.Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "";
            }

            static bool Same(object? a, object? b)
            {
                if (a is null || b is null) return a is null && b is null;
                if (a is string || b is string) return a.Equals(b);
                if (a is System.Collections.IEnumerable ea && b is System.Collections.IEnumerable eb)
                {
                    var la = ea.Cast<object?>().ToList();
                    var lb = eb.Cast<object?>().ToList();
                    return la.Count == lb.Count && la.Zip(lb).All(p => Same(p.First, p.Second));
                }
                if (a is double da && b is double db) return System.Math.Abs(da - db) < 1e-9;
                return a.Equals(b);
            }

            /// <summary>Pass when the condition holds.</summary>
            public static void Check(string name, bool ok, string detail = "")
                => Report(name, ok, ok ? "" : detail);

            /// <summary>Pass when actual equals expected. Sequences compare element by element.</summary>
            public static void Eq<T>(string name, T expected, T actual)
            {
                var ok = Same(expected, actual);
                Report(name, ok, ok ? "" : "expected " + Show(expected) + " but got " + Show(actual));
            }

            /// <summary>Pass when the action throws TException (or a subclass).</summary>
            public static void Throws<TException>(string name, Action action) where TException : Exception
            {
                try { action(); }
                catch (TException) { Report(name, true, ""); return; }
                catch (Exception e) { Report(name, false, "expected " + typeof(TException).Name + " but got " + e.GetType().Name); return; }
                Report(name, false, "expected " + typeof(TException).Name + " but nothing was thrown");
            }

            /// <summary>Pass when awaiting the action throws TException (or a subclass).</summary>
            public static async Task ThrowsAsync<TException>(string name, Func<Task> action) where TException : Exception
            {
                try { await action(); }
                catch (TException) { Report(name, true, ""); return; }
                catch (Exception e) { Report(name, false, "expected " + typeof(TException).Name + " but got " + e.GetType().Name); return; }
                Report(name, false, "expected " + typeof(TException).Name + " but nothing was thrown");
            }

            /// <summary>Async version of Try: an exception becomes a failed check instead of a crash.</summary>
            public static async Task TryAsync(string name, Func<Task> body)
            {
                try { await body(); }
                catch (Exception e) { Report(name, false, e.GetType().Name + ": " + e.Message); }
            }

            /// <summary>Run the action and return everything it wrote to the console.</summary>
            public static string Capture(Action action)
            {
                var old = System.Console.Out;
                var writer = new System.IO.StringWriter();
                System.Console.SetOut(writer);
                try { action(); }
                finally { System.Console.SetOut(old); }
                return writer.ToString().Replace("\r\n", "\n").TrimEnd();
            }

            /// <summary>Run a test body; an exception becomes a failed check instead of a crash.</summary>
            public static void Try(string name, Action body)
            {
                try { body(); }
                catch (Exception e) { Report(name, false, e.GetType().Name + ": " + e.Message); }
            }
        }
        """;
}
