using System.Diagnostics;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// The Messaging builder's simulators (ui/rabbitsim.js, ui/kafkasim.js) are plain ES modules, so they are
/// checked by msgsim.test.mjs under Node: every graded challenge's setup fails, its solution passes with
/// 3 stars, the sandbox runs, and the simulations are deterministic. Returns early when Node is missing.
/// </summary>
public class MsgSimTests
{
    static string RepoRoot([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        for (var d = new DirectoryInfo(Path.GetDirectoryName(here)!); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "ui", "rabbitsim.js"))) return d.FullName;
        throw new DirectoryNotFoundException("repository root (ui/rabbitsim.js)");
    }

    [Fact]
    public async Task Messaging_simulators_pass_their_node_checks()
    {
        var node = CodeSpaces.NodeExe();
        if (node is null) return;                           // no Node on this machine
        var root = RepoRoot();
        var script = Path.Combine(root, "tests", "CodeDojo.Tests", "msgsim.test.mjs");
        Assert.True(File.Exists(script), script);

        var psi = new ProcessStartInfo(node) { WorkingDirectory = root, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        psi.ArgumentList.Add(script);
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(120));
        await p.WaitForExitAsync(cts.Token);
        var output = await stdout + await stderr;

        Assert.True(p.ExitCode == 0, output);
        Assert.Contains("checks passed", output);
    }
}
