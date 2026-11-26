using System.Diagnostics;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// The Kubernetes builder's simulator (ui/kubesim.js) is a plain ES module, so it is checked by
/// kubesim.test.mjs under Node: every graded challenge's setup fails, its solution passes with 3 stars
/// and par is the solution's cost, and the Gateway API routing rules (hostnames, Exact/PathPrefix,
/// precedence, weights, Accepted/ResolvedRefs) hold. Returns early when Node is missing.
/// </summary>
public class KubeSimTests
{
    static string RepoRoot([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        for (var d = new DirectoryInfo(Path.GetDirectoryName(here)!); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "ui", "kubesim.js"))) return d.FullName;
        throw new DirectoryNotFoundException("repository root (ui/kubesim.js)");
    }

    [Fact]
    public async Task Kubernetes_simulator_passes_its_node_checks()
    {
        var node = CodeSpaces.NodeExe();
        if (node is null) return;                           // no Node on this machine
        var root = RepoRoot();
        var script = Path.Combine(root, "tests", "CodeDojo.Tests", "kubesim.test.mjs");
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
    public void Lab_steps_see_every_kubebuild_challenge()
    {
        var all = LabSteps.Challenges(Path.Combine(RepoRoot(), "ui"), "kubebuild");
        foreach (var id in new[] { "expose", "gateway-class", "no-endpoints", "two-apps", "exact-path", "hostname", "canary", "from-ingress", "readiness" })
            Assert.True(all.TryGetValue(id, out var xp) && xp > 0, $"{id} in {string.Join(", ", all.Keys)}");
        Assert.Equal(0, all["sandbox"]);
    }
}
