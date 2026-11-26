using System.Diagnostics;
using System.Text;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>
/// The line-based terminals' support for full-screen tools: the image freshness label (DockerImage.cs), the page
/// editor's file reads and writes (ContainerFiles.cs), the shell stand-ins (netlabs/images/shell/dojo-linerc) and the
/// marker parsing in the page (ui/termmarks.js, under Node). The container tests use alpine:3.20 (BusyBox sh) and
/// return early when Docker is off or that image is not pulled.
/// </summary>
public class LineTermTests
{
    static string Root([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        for (var d = new DirectoryInfo(Path.GetDirectoryName(here)!); d is not null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "netlabs", "images"))) return d.FullName;
        throw new DirectoryNotFoundException("netlabs/images");
    }

    static string TempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dojo-ctx-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    // ---------------------------------------------------------------- image freshness

    [Fact]
    public void Context_hash_follows_every_file_but_not_line_endings()
    {
        var dir = TempDir();
        try
        {
            File.WriteAllText(Path.Combine(dir, "Dockerfile"), "FROM debian\nCOPY rc /rc\n");
            File.WriteAllText(Path.Combine(dir, "rc"), "echo one\n");
            var first = DockerImage.ContextHash(dir);
            Assert.Equal(16, first.Length);
            Assert.Equal(first, DockerImage.ContextHash(dir));

            File.WriteAllText(Path.Combine(dir, "Dockerfile"), "FROM debian\r\nCOPY rc /rc\r\n");      // a CRLF checkout
            Assert.Equal(first, DockerImage.ContextHash(dir));

            File.WriteAllText(Path.Combine(dir, "rc"), "echo two\n");                                // a copied file changed
            var second = DockerImage.ContextHash(dir);
            Assert.NotEqual(first, second);

            Directory.CreateDirectory(Path.Combine(dir, "sub"));
            File.WriteAllText(Path.Combine(dir, "sub", "extra"), "");                                // a new (empty) file
            Assert.NotEqual(second, DockerImage.ContextHash(dir));

            File.Delete(Path.Combine(dir, "sub", "extra"));
            File.WriteAllText(Path.Combine(dir, "sub", "other"), "");                                // same content, other name
            Assert.NotEqual(second, DockerImage.ContextHash(dir));
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Image_is_current_only_when_its_label_matches_the_folder()
    {
        Assert.Equal(DockerImage.Freshness.Missing, DockerImage.Compare(false, "", "abc"));
        Assert.Equal(DockerImage.Freshness.Current, DockerImage.Compare(true, "abc\n", "abc"));
        Assert.Equal(DockerImage.Freshness.Outdated, DockerImage.Compare(true, "abd", "abc"));
        // Built before images were labelled: `{{index .Config.Labels ...}}` prints "<no value>" or nothing.
        Assert.Equal(DockerImage.Freshness.Outdated, DockerImage.Compare(true, "<no value>", "abc"));
        Assert.Equal(DockerImage.Freshness.Outdated, DockerImage.Compare(true, "", "abc"));
    }

    [Fact]
    public void The_real_image_folders_hash()
    {
        foreach (var image in new[] { "shell", "toolbox" })
            Assert.Matches("^[0-9a-f]{16}$", DockerImage.ContextHash(Path.Combine(Root(), "netlabs", "images", image)));
    }

    // ---------------------------------------------------------------- file editor: text in and out

    [Fact]
    public void Decode_keeps_text_and_remembers_line_endings()
    {
        Assert.Equal(("a\nb\n", "lf"), ContainerFiles.Decode(Encoding.UTF8.GetBytes("a\nb\n")));
        Assert.Equal(("a\nb", "crlf"), ContainerFiles.Decode(Encoding.UTF8.GetBytes("a\r\nb")));
        Assert.Equal(("grüße ✓", "lf"), ContainerFiles.Decode(Encoding.UTF8.GetBytes("grüße ✓")));
        Assert.Equal(("", "lf"), ContainerFiles.Decode([]));
        Assert.Null(ContainerFiles.Decode([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));     // an ELF binary: has NUL bytes
        Assert.Null(ContainerFiles.Decode([0x66, 0xff, 0xfe, 0x6f]));                   // not UTF-8
    }

    [Fact]
    public void Encode_writes_the_files_own_line_endings()
    {
        Assert.Equal("a\nb\n", Encoding.UTF8.GetString(ContainerFiles.Encode("a\nb\n", "lf")));
        Assert.Equal("a\r\nb\r\n", Encoding.UTF8.GetString(ContainerFiles.Encode("a\nb\n", "crlf")));
        Assert.Equal("a\nb", Encoding.UTF8.GetString(ContainerFiles.Encode("a\r\nb", null)));
        var original = Encoding.UTF8.GetBytes("x = 1\r\ny = 2\r\n");
        var (text, eol) = ContainerFiles.Decode(original)!.Value;
        Assert.Equal(original, ContainerFiles.Encode(text, eol));                         // round trip, byte for byte
        Assert.Equal(ContainerFiles.Hash(original), ContainerFiles.Hash(ContainerFiles.Encode(text, eol)));
        Assert.Equal(ContainerFiles.NewFile, ContainerFiles.Hash(null));
    }

    [Theory]
    [InlineData("/etc/hosts", true)]
    [InlineData("~/notes.txt", true)]
    [InlineData("work/app.yaml", true)]
    [InlineData("/tmp/with space.txt", true)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("/etc/hosts\nrm -rf /", false)]
    [InlineData("/etc/\u0007bell", false)]
    public void Only_plain_paths_are_accepted(string path, bool ok) => Assert.Equal(ok, ContainerFiles.ValidPath(path));

    [Fact]
    public void Errors_say_what_to_do()
    {
        Assert.Contains("read-only", ContainerFiles.Friendly("sh: can't create /lab/x: Read-only file system", "/lab/x"));
        Assert.Contains("as root", ContainerFiles.Friendly("sh: /etc/shadow: Permission denied", "/etc/shadow"));
        Assert.Equal("odd", ContainerFiles.Friendly("odd", "/x"));
    }

    // ---------------------------------------------------------------- the page's marker parsing (Node)

    [Fact]
    public async Task Terminal_markers_pass_their_node_checks()
    {
        var node = CodeSpaces.NodeExe();
        if (node is null) return;
        var psi = new ProcessStartInfo(node) { WorkingDirectory = Root(), RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        psi.ArgumentList.Add(Path.Combine(Root(), "tests", "CodeDojo.Tests", "termmarks.test.mjs"));
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync(new CancellationTokenSource(TimeSpan.FromSeconds(60)).Token);
        var output = await stdout + await stderr;
        Assert.True(p.ExitCode == 0, output);
        Assert.Contains("checks passed", output);
    }

    // ---------------------------------------------------------------- in a real container (BusyBox sh)

    const string Alpine = "alpine:3.20";

    static async Task<bool> DockerAndAlpine() =>
        (await NetLabs.Probe()).Ok && (await NetLabs.Docker(["image", "inspect", Alpine], TimeSpan.FromSeconds(20))).Ok;

    static async Task<string> Start()
    {
        var name = "cdtest-lineterm-" + Guid.NewGuid().ToString("N")[..8];
        var r = await NetLabs.Docker(["run", "-d", "--rm", "--name", name, "--network", "none", Alpine, "sleep", "120"], TimeSpan.FromMinutes(1));
        Assert.True(r.Ok, r.Err);
        return name;
    }

    [Fact]
    public async Task Standins_work_in_busybox_sh()
    {
        if (!await DockerAndAlpine()) return;
        var name = await Start();
        try
        {
            var rc = File.ReadAllText(Path.Combine(Root(), "netlabs", "images", "shell", "dojo-linerc")).Replace("\r", "");
            async Task<NetLabs.Result> Sh(string cmd, bool page = true)
            {
                var args = new List<string> { "exec", "-w", "/root", "-e", "DOJO_RC=" + rc };
                if (page) args.AddRange(["-e", "DOJO_EDITOR=page"]);
                args.AddRange([name, "sh", "-c", "printf '%s\\n' \"$DOJO_RC\" > /tmp/rc; . /tmp/rc; " + cmd]);
                return await NetLabs.Docker(args, TimeSpan.FromSeconds(30));
            }
            var nano = await Sh("nano /etc/hosts");
            Assert.Contains("\u001b]dojo;edit;/etc/hosts\u0007", nano.Out);
            Assert.Equal(0, nano.Code);
            Assert.Contains("\u001b]dojo;edit;/root/notes.txt\u0007", (await Sh("vim +3 notes.txt")).Out);         // relative to $PWD, +N skipped
            Assert.Contains("\u001b]dojo;sudoedit;/etc/motd\u0007", (await Sh("sudo nano /etc/motd")).Out);
            Assert.Contains("is a folder", (await Sh("vi /etc")).Err);
            Assert.Contains("needs a full-screen terminal", (await Sh("nano /etc/hosts", page: false)).Err);   // no page editor: explain
            Assert.Contains("localhost", (await Sh("less -R /etc/hosts")).Out);
            Assert.Contains("piped", (await Sh("echo piped | more")).Out);
            Assert.Contains("PID", (await Sh("top")).Out);                                                  // top -b -n 1: prints once
            var cron = await Sh("crontab -e");
            Assert.NotEqual(0, cron.Code);
            Assert.Contains("| crontab -", cron.Err);
            Assert.Equal("cat||cat", (await Sh("printf '%s|%s|%s' \"$PAGER\" \"$SYSTEMD_PAGER\" \"$GIT_PAGER\"")).Out.Trim());
        }
        finally { await NetLabs.Docker(["rm", "-f", name], TimeSpan.FromMinutes(1)); }
    }

    [Fact]
    public async Task Files_round_trip_and_keep_owner_and_mode()
    {
        if (!await DockerAndAlpine()) return;
        var name = await Start();
        try
        {
            var setup = await NetLabs.Docker(["exec", name, "sh", "-c",
                "adduser -D -u 1234 kim && printf 'a=1\\r\\nb=2\\r\\n' > /home/kim/app.conf && chown kim:kim /home/kim/app.conf && chmod 640 /home/kim/app.conf"], TimeSpan.FromSeconds(30));
            Assert.True(setup.Ok, setup.Err);

            var read = await ContainerFiles.Read(name, null, "/root", "/home/kim/app.conf");
            Assert.Equal("ok", read.State);
            Assert.Equal("a=1\nb=2\n", read.Text);
            Assert.Equal("crlf", read.Eol);

            var write = await ContainerFiles.Write(name, null, "/root", read.Path, "a=1\nb=3\n", read.Eol, read.Hash);
            Assert.True(write.Ok, write.Message);
            var stat = await NetLabs.Docker(["exec", name, "sh", "-c", "stat -c '%U:%G %a' /home/kim/app.conf; od -c /home/kim/app.conf | head -2"], TimeSpan.FromSeconds(20));
            Assert.StartsWith("kim:kim 640", stat.Out.Trim());
            Assert.Contains(@"\r  \n", stat.Out);                                                      // CRLF kept

            // Changed behind the editor's back: not overwritten without asking.
            await NetLabs.Docker(["exec", name, "sh", "-c", "echo c=4 >> /home/kim/app.conf"], TimeSpan.FromSeconds(20));
            Assert.Equal("changed", (await ContainerFiles.Write(name, null, "/root", read.Path, "x\n", "lf", write.Hash)).State);

            // A new file under ~ (resolved as the exec user), as that user.
            var fresh = await ContainerFiles.Read(name, "kim", "/home/kim", "~/new.txt");
            Assert.Equal("new", fresh.State);
            Assert.Equal("/home/kim/new.txt", fresh.Path);
            Assert.True((await ContainerFiles.Write(name, "kim", "/home/kim", fresh.Path, "hello\n", "lf", fresh.Hash)).Ok);
            Assert.Equal("kim hello", (await NetLabs.Docker(["exec", name, "sh", "-c", "echo $(stat -c %U /home/kim/new.txt) $(cat /home/kim/new.txt)"], TimeSpan.FromSeconds(20))).Out.Trim());

            // Not allowed for that user: says so, suggests root.
            var denied = await ContainerFiles.Write(name, "kim", "/home/kim", "/etc/hosts", "x\n", "lf", null);
            Assert.Equal("failed", denied.State);
            Assert.Contains("as root", denied.Message);
            Assert.Equal("failed", (await ContainerFiles.Read(name, null, "/root", "/bin/busybox")).State);   // binary
            Assert.Equal("failed", (await ContainerFiles.Read(name, null, "/root", "/nope/x")).State);        // no such folder
        }
        finally { await NetLabs.Docker(["rm", "-f", name], TimeSpan.FromMinutes(1)); }
    }
}
