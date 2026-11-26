using System.Diagnostics;
using System.Text;

namespace CodeDojo;

/// <summary>
/// The dojo's own Python environment for data science (numpy, pandas, matplotlib, scikit-learn, scipy, statsmodels), set up from the app
/// with one click: a virtual environment in %USERPROFILE%\code-dojo\pyenv (or DOJO_PYENV), kept apart
/// from the system Python. Setup runs in the background; the page polls its log.
/// </summary>
public static class PyEnv
{
    /// <summary>(pip distribution name, import name). tzdata makes zoneinfo work on Windows.</summary>
    public static readonly (string Dist, string Import)[] Wanted =
        [("numpy", "numpy"), ("pandas", "pandas"), ("matplotlib", "matplotlib"), ("scikit-learn", "sklearn"),
         ("scipy", "scipy"), ("statsmodels", "statsmodels"), ("tzdata", "tzdata")];
    public static readonly string[] Packages = [.. Wanted.Select(w => w.Dist)];

    static readonly object Gate = new();
    static readonly List<string> Log = [];
    static Task? _running;
    static string _state = "idle";       // idle | running | done | failed

    public static string Dir => Environment.GetEnvironmentVariable("DOJO_PYENV") is { Length: > 0 } d ? d
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "code-dojo", "pyenv");

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/pyenv", async () => Results.Json(await Status()));
        app.MapPost("/api/pyenv/setup", () =>
        {
            lock (Gate)
            {
                if (_running is { IsCompleted: false }) return Results.Json(new { started = false, state = _state });
                Log.Clear();
                _state = "running";
                _running = Task.Run(Setup);
            }
            return Results.Json(new { started = true, state = _state });
        });
        app.MapGet("/api/pyenv/log", () => { lock (Gate) return Results.Json(new { state = _state, log = Log.ToArray() }); });
    }

    /// <summary>Is the environment there, and which of the packages import?</summary>
    static async Task<object> Status()
    {
        var python = LangRunner.PyEnvPython();
        var system = await Probe("python", "--version");
        if (python is null) return new { ready = false, dir = Dir, systemPython = system.Ok ? system.Out.Trim() : null, packages = Array.Empty<object>(), state = _state };
        var check = await Probe(python, "-c",
            "import importlib.util as u, importlib.metadata as m\n" +
            $"for d, i in [{string.Join(", ", Wanted.Select(w => $"('{w.Dist}', '{w.Import}')"))}]:\n" +
            "    print(d, m.version(d) if u.find_spec(i) else '-')");
        var packages = check.Out.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim().Split(' ')).Where(p => p.Length == 2)
            .Select(p => new { name = p[0], version = p[1] == "-" ? null : p[1] }).ToArray();
        var ready = packages.Length == Packages.Length && packages.All(p => p.version is not null);
        return new { ready, dir = Dir, systemPython = system.Ok ? system.Out.Trim() : null, packages, state = _state };
    }

    static async Task Setup()
    {
        void Say(string line) { lock (Gate) { Log.Add(line); if (Log.Count > 2000) Log.RemoveAt(0); } }
        try
        {
            if (LangRunner.PyEnvPython() is null)
            {
                Say($"Creating a Python environment in {Dir} …");
                var made = await Stream("python", ["-m", "venv", Dir], Say);
                if (made != 0) throw new InvalidOperationException("Could not create the environment. Is Python 3 installed and on PATH? (python --version)");
            }
            var py = LangRunner.PyEnvPython() ?? throw new InvalidOperationException("The environment was created but its Python was not found.");
            Say($"Installing {string.Join(", ", Packages)} from PyPI (about 250 MB, a few minutes) …");
            var code = await Stream(py, ["-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off", .. Packages], Say);
            if (code != 0) throw new InvalidOperationException("pip could not install the packages. Check that this machine can reach pypi.org.");
            Say("Done. Data science lessons and the Python playground now use this environment.");
            lock (Gate) _state = "done";
        }
        catch (Exception e)
        {
            Say("Failed: " + e.Message);
            lock (Gate) _state = "failed";
        }
    }

    static async Task<int> Stream(string exe, string[] args, Action<string> say)
    {
        var psi = new ProcessStartInfo(exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        async Task Pump(StreamReader r) { string? l; while ((l = await r.ReadLineAsync()) is not null) if (l.Trim().Length > 0) say(l); }
        await Task.WhenAll(Pump(p.StandardOutput), Pump(p.StandardError), p.WaitForExitAsync());
        return p.ExitCode;
    }

    static async Task<(bool Ok, string Out)> Probe(string exe, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            var output = await p.StandardOutput.ReadToEndAsync();
            await p.WaitForExitAsync();
            return (p.ExitCode == 0, output);
        }
        catch { return (false, ""); }
    }
}
