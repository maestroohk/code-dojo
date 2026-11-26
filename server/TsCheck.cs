using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// Type checks TypeScript steps with the real compiler: <c>tsc --strict --noEmit</c>, before the code runs.
/// A type error fails the step with the compiler's own message, code (TS2322 ...) and line.
///
/// The compiler is not shipped with the dojo. The first time it is needed it is installed with npm into
/// <c>%USERPROFILE%\code-dojo\tools\tsc</c> (or DOJO_TOOLS\tsc): <c>typescript@7</c> (the native compiler,
/// about 0.1 s per check) and <c>@types/node@22</c> (so <c>process</c>, <c>setTimeout</c> and <c>node:*</c>
/// imports type check the way Node runs them). Without Node/npm or without a network the install fails; the
/// step then still runs, with a warning in the Problems panel that types were not checked, except steps marked
/// <c>"typecheck": "required"</c> (the ones that only teach types), which fail with that message instead.
/// </summary>
public static partial class TsCheck
{
    public const string Packages = "typescript@7 @types/node@22";

    static readonly object Gate = new();
    static Task? install;
    static DateTime installFailed = DateTime.MinValue;
    static string? lastError;

    static string Home => Path.Combine(TsIntel.ToolsDir, "tsc");

    /// <summary>The compiler flags every step is checked with. Positions are kept the way Node's type stripping keeps them.</summary>
    public static readonly string[] Flags =
    [
        "--strict", "--noEmit", "--pretty", "false",
        "--target", "es2022", "--lib", "esnext", "--module", "esnext", "--moduleResolution", "bundler",
        "--moduleDetection", "force", "--allowImportingTsExtensions", "--erasableSyntaxOnly",
        "--skipLibCheck", "--noErrorTruncation", "--types", "node",
    ];

    /// <summary>The command line that runs tsc (the native binary when there is one), or null when it is not installed.</summary>
    public static string[]? Command()
    {
        var modules = Path.Combine(Home, "node_modules");
        if (!File.Exists(Path.Combine(modules, "@types", "node", "package.json"))) return null;
        // typescript@7 is a native program in a per-platform package; run it directly (no Node start-up).
        var native = Path.Combine(modules, "@typescript");
        if (Directory.Exists(native))
            foreach (var d in Directory.GetDirectories(native, "typescript-*"))
            {
                var exe = Path.Combine(d, "lib", OperatingSystem.IsWindows() ? "tsc.exe" : "tsc");
                if (File.Exists(exe)) return [exe];
            }
        var js = Path.Combine(modules, "typescript", "bin", "tsc");
        if (File.Exists(js) && CodeSpaces.NodeExe() is { } node) return [node, js];
        return null;
    }

    public static string TypeRoots => Path.Combine(Home, "node_modules", "@types");

    /// <summary>Is the compiler there? If not, the install is started (once) and awaited up to <paramref name="wait"/>.</summary>
    public static async Task<string[]?> Ensure(TimeSpan wait)
    {
        if (Command() is { } ready) return ready;
        var task = StartInstall();
        if (task is not null) await Task.WhenAny(task, Task.Delay(wait));
        return Command();
    }

    public static Task? StartInstall()
    {
        lock (Gate)
        {
            if (install is { IsCompleted: false }) return install;
            if (Command() is not null) return null;
            if (DateTime.UtcNow - installFailed < TimeSpan.FromMinutes(10)) return null;
            if (CodeSpaces.NodeExe() is null || CodeSpaces.NpmCli() is null) { lastError = "Node.js with npm was not found"; return null; }
            return install = Task.Run(Install);
        }
    }

    static async Task Install()
    {
        try
        {
            Directory.CreateDirectory(Home);
            var manifest = Path.Combine(Home, "package.json");
            if (!File.Exists(manifest))
                File.WriteAllText(manifest, "{\n  \"name\": \"dojo-tsc\",\n  \"private\": true,\n  \"description\": \"The TypeScript compiler code-dojo grades TypeScript steps with (tsc --strict --noEmit).\"\n}\n");
            var psi = new ProcessStartInfo(CodeSpaces.NodeExe()!)
            {
                WorkingDirectory = Home, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            };
            string[] npmArgs = [CodeSpaces.NpmCli()!, "install", .. Packages.Split(' '), "--no-audit", "--no-fund", "--loglevel=error"];
            foreach (var a in npmArgs) psi.ArgumentList.Add(a);
            psi.Environment["npm_config_update_notifier"] = "false";
            psi.Environment["NO_UPDATE_NOTIFIER"] = "1";
            using var p = Process.Start(psi)!;
            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
            var drain = Task.WhenAll(p.StandardOutput.ReadToEndAsync(), p.StandardError.ReadToEndAsync());
            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(4));
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException) { try { p.Kill(true); } catch { } }
            var output = await drain;
            if (!p.HasExited || p.ExitCode != 0 || Command() is null)
            {
                installFailed = DateTime.UtcNow;
                lastError = (output[1].Trim().Split('\n').LastOrDefault() ?? "").Trim() is { Length: > 0 } e ? e : "npm install failed";
            }
        }
        catch (Exception e) { installFailed = DateTime.UtcNow; lastError = e.Message; }
    }

    /// <summary>Why the compiler is missing, in words for the Problems panel.</summary>
    public static string MissingMessage() =>
        "Types were not checked: the TypeScript compiler is not installed yet. The dojo installs it by itself with npm " +
        $"({Packages}) into {Home} the first time a TypeScript step is checked; that needs Node.js with npm and a network" +
        (lastError is { Length: > 0 } e ? $" (last attempt: {e})." : ".") + " Press Check again in a minute.";

    public record Problem(string File, int Line, int Col, string Code, string Message);

    // main.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
    [GeneratedRegex(@"^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\): (?<sev>error|warning) (?<code>TS\d+): (?<msg>.*)$")]
    private static partial Regex TscLine();

    public static List<Problem> Parse(string output)
    {
        var list = new List<Problem>();
        foreach (var raw in output.Replace("\r\n", "\n").Split('\n'))
        {
            if (raw.Length == 0) continue;
            var m = TscLine().Match(raw);
            if (m.Success)
                list.Add(new(m.Groups["file"].Value.Replace('\\', '/'), int.Parse(m.Groups["line"].Value), int.Parse(m.Groups["col"].Value), m.Groups["code"].Value, m.Groups["msg"].Value.Trim()));
            else if (list.Count > 0 && char.IsWhiteSpace(raw[0]))
                list[^1] = list[^1] with { Message = list[^1].Message + "\n" + raw.TrimEnd() };   // "  Type 'x' is missing ..." elaboration lines
            else if (TscGlobal().Match(raw) is { Success: true } g)
                list.Add(new("", 0, 0, g.Groups["code"].Value, g.Groups["msg"].Value.Trim()));
        }
        return list;
    }

    [GeneratedRegex(@"^error (?<code>TS\d+): (?<msg>.*)$")]
    private static partial Regex TscGlobal();

    /// <summary>Declarations of the Dojo test helpers, so templates type check (the helpers are a runtime prelude).</summary>
    public const string DojoTypes = """
        declare const Dojo: {
          eq(name: string, expected: unknown, actual: unknown): void;
          check(name: string, ok: unknown, detail?: string): void;
          throws(name: string, fn: () => unknown): void;
          throwsAsync(name: string, fn: () => unknown): Promise<void>;
          capture(fn: () => unknown): string;
          captureAsync(fn: () => unknown): Promise<string>;
        };
        """;

    /// <summary>
    /// Type check <paramref name="program"/> (the template with the learner's code at {{CODE}}, without the runtime prelude)
    /// plus the used pieces. Returns null when the compiler is not available; otherwise the problems, as diagnostics with the
    /// learner's own line numbers. Errors in the hidden tests get the file "tests" (the UI says the tests could not use the code).
    /// </summary>
    public static async Task<List<Diag>?> Check(string program, int codeFirstLine, int codeLines, IReadOnlyList<(string Path, string Text)>? extra, TimeSpan? wait = null)
    {
        if (await Ensure(wait ?? TimeSpan.FromSeconds(90)) is not { } tsc) return null;
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "tsc-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(dir);
        try
        {
            var utf8 = new UTF8Encoding(false);
            foreach (var (rel, text) in extra ?? [])
            {
                if (Builds.CleanPath(rel, out _) is not { } clean || clean == "main.ts") continue;
                var full = Path.Combine(dir, clean.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                await File.WriteAllTextAsync(full, text, utf8);
            }
            await File.WriteAllTextAsync(Path.Combine(dir, "main.ts"), program, utf8);
            await File.WriteAllTextAsync(Path.Combine(dir, "dojo.d.ts"), DojoTypes, utf8);
            var r = await LangRunner.Exec(dir, [.. tsc, .. Flags, "--typeRoots", TypeRoots, "main.ts", "dojo.d.ts"], null, cpuMs: 20_000, wallMs: 30_000);
            if (r.TimedOut) return [new Diag("warning", "tsc", "The type check took too long and was skipped.", 0, 0, "")];
            var diags = new List<Diag>();
            foreach (var p in Parse(r.Stdout + "\n" + r.Stderr))
            {
                if (p.File is "main.ts" or "")
                {
                    var line = p.Line - codeFirstLine + 1;
                    var inCode = p.File == "" || (line >= 1 && line <= codeLines);
                    diags.Add(new("error", p.Code, p.Message, inCode ? Math.Max(0, line) : p.Line, p.Col, inCode ? "" : "tests"));
                }
                else diags.Add(new("error", p.Code, p.Message, p.Line, p.Col, p.File));
            }
            if (diags.Count == 0 && r.ExitCode != 0)
                diags.Add(new("error", "tsc", (r.Stdout + r.Stderr).Trim() is { Length: > 0 } t ? t : $"tsc exited with code {r.ExitCode}", 0, 0, ""));
            return diags;
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    /// <summary>Is this step graded only by its types (so it must fail when the compiler is missing)?</summary>
    public static bool Required(JsonObject step) => (string?)step["typecheck"] == "required";
}
