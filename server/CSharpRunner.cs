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
public sealed class Compiled(string dir, string dll, bool web = false) : IDisposable
{
    public string Dir => dir;
    public string Dll => dll;
    /// <summary>An ASP.NET Core program: runs with a private port and is tested over HTTP.</summary>
    public bool Web => web;
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

    public CSharpRunner()
    {
        var coreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var tpa = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        // Only the base runtime: learner programs run against Microsoft.NETCore.App alone.
        _refs = tpa.Where(p => string.Equals(Path.GetDirectoryName(p), coreDir, StringComparison.OrdinalIgnoreCase))
                   .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
                   .ToList();

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
        _webRefs = _refs.Concat(tpa.Where(p => string.Equals(Path.GetDirectoryName(p), webDir, StringComparison.OrdinalIgnoreCase))
                                   .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))).ToList();
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
    }

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

    public (Compiled? Program, List<Diag> Diagnostics) Compile(string code, string? template = null, bool web = false)
    {
        var tree = CSharpSyntaxTree.ParseText(BuildSource(code, template), Parse, path: "Source.cs", encoding: Encoding.UTF8);
        SyntaxTree[] trees = web ? [tree, _support, _webSupport] : [tree, _support];
        var comp = CSharpCompilation.Create("Exercise", trees, web ? _webRefs : _refs,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication,
                nullableContextOptions: NullableContextOptions.Enable,
                optimizationLevel: OptimizationLevel.Debug,
                concurrentBuild: false));

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
        File.WriteAllText(Path.Combine(dir, "Exercise.runtimeconfig.json"), web ? _webRuntimeConfig : _runtimeConfig);
        return (new Compiled(dir, dll, web), diags);
    }

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

    public async Task<RunOutput> Run(Compiled program, string? stdin, int wallMs = WallLimitMs, int cpuMs = CpuLimitMs)
    {
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
