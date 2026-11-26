using System.Diagnostics;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// The System design board's simulator (ui/sdsim.js) is a plain ES module, so it is checked by sdsim.test.mjs
/// under Node: the queueing and popularity maths, every graded challenge's setup fails and its solution passes
/// with 3 stars, the wrong fixes fail, the sandbox runs with every incident, and runs are deterministic.
/// Returns early when Node is missing.
/// </summary>
public class SdSimTests
{
    static string RepoRoot([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        for (var d = new DirectoryInfo(Path.GetDirectoryName(here)!); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "ui", "sdsim.js"))) return d.FullName;
        throw new DirectoryNotFoundException("repository root (ui/sdsim.js)");
    }

    [Fact]
    public async Task System_design_simulator_passes_its_node_checks()
    {
        var node = CodeSpaces.NodeExe();
        if (node is null) return;                           // no Node on this machine
        var root = RepoRoot();
        var script = Path.Combine(root, "tests", "CodeDojo.Tests", "sdsim.test.mjs");
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

    [Fact]
    public void Lab_steps_know_the_board_and_its_challenges()
    {
        var all = LabSteps.Challenges(Path.Combine(RepoRoot(), "ui"), "sysdesign");
        Assert.Equal(0, all["sandbox"]);
        Assert.True(all.Count(c => c.Value > 0) >= 10, string.Join(", ", all.Keys));
        Assert.Contains("photo-share", all.Keys);
    }
}
