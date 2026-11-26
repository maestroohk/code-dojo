using System.Security.Cryptography;
using System.Text;

namespace CodeDojo;

/// <summary>
/// Read and write one text file inside a running container, for the page's file editor (ui/fileedit.js): `nano file`,
/// `vim file` in a line-based terminal (netlabs/images/shell/dojo-linerc) or the terminal's "Open file" button. Used by the
/// live labs (NetLabs.cs) and the terminal steps (TermSteps.cs).
///   - The path goes to the container as an argument of a fixed script (`sh -c SCRIPT sh PATH`), never into a command line.
///   - Reading sends the bytes back as base64, so line endings and the last newline survive; binary files and files that
///     are not UTF-8 are refused (the editor would damage them), and so are files over <see cref="MaxBytes"/>.
///   - Writing truncates the file in place (`cat > file`), so an existing file keeps its owner and permissions, exactly as
///     nano or vim would leave it; a new file belongs to the user who saves it (root for sudoedit / sudo nano). When the
///     editor passes the hash it read, a file changed in the meantime is not overwritten (state "changed").
/// Only sh and the tools every image has are needed: base64, wc, cat; sha256sum when present (BusyBox has them all).
/// </summary>
public static class ContainerFiles
{
    public const int MaxBytes = 1_000_000;
    public const string NewFile = "new";

    /// <summary>A path the editor may ask for: absolute, ~/..., or relative to the terminal's start folder; no control characters.</summary>
    public static bool ValidPath(string? path) =>
        path is { Length: > 0 and <= 1024 } && path.Trim().Length > 0 && !path.Any(char.IsControl);

    public static string Hash(byte[]? bytes) => bytes is null ? NewFile : Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>
    /// File bytes as editor text: line endings become \n (a textarea would do that anyway) and are remembered as "lf" or
    /// "crlf". Null when the bytes are not text: a NUL byte, or not valid UTF-8. A UTF-8 byte order mark is kept.
    /// </summary>
    public static (string Text, string Eol)? Decode(byte[] bytes)
    {
        if (Array.IndexOf(bytes, (byte)0) >= 0) return null;
        string text;
        try { text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes); }
        catch (DecoderFallbackException) { return null; }
        var crlf = text.Contains("\r\n");
        return (crlf ? text.Replace("\r\n", "\n") : text, crlf ? "crlf" : "lf");
    }

    /// <summary>Editor text back to file bytes, with the file's line endings.</summary>
    public static byte[] Encode(string text, string? eol)
    {
        var lf = text.Replace("\r\n", "\n");
        return Encoding.UTF8.GetBytes(eol == "crlf" ? lf.Replace("\n", "\r\n") : lf);
    }

    public sealed record ReadResult(string State, string Message, string Path = "", string Text = "", string Eol = "lf", string Hash = NewFile)
    {
        public bool Ok => State is "ok" or "new";
    }

    public sealed record WriteResult(string State, string Message, string Hash = "")
    {
        public bool Ok => State == "ok";
    }

    // $1 = the path. Resolves ~ and relative paths (against the -w folder), prints the full path, then the content.
    const string ResolveSh = """
        f=$1
        case $f in /*) ;; "~") f=$HOME ;; "~/"*) f="${HOME%/}/${f#\~/}" ;; *) f="${PWD%/}/$f" ;; esac
        p=${f%/*}; [ -n "$p" ] || p=/
        """;

    const string ReadSh = ResolveSh + """

        printf '%s\n' "$f"
        if [ -d "$f" ]; then echo "$f is a folder, not a file." >&2; exit 3; fi
        if [ ! -e "$f" ]; then [ -d "$p" ] || { echo "There is no folder $p." >&2; exit 7; }; exit 4; fi
        [ -r "$f" ] || { echo "Permission denied: $f cannot be read by $(id -un 2>/dev/null || id -u). Try sudoedit $f." >&2; exit 5; }
        n=$(wc -c < "$f" | tr -d ' ')
        [ "$n" -le MAXBYTES ] || { echo "$f is $n bytes: too big for the page editor (1 MB at most)." >&2; exit 6; }
        base64 < "$f"
        """;

    // $2 = the hash the editor read ("" = do not compare). The content comes on stdin.
    const string WriteSh = ResolveSh + """

        if [ -d "$f" ]; then echo "$f is a folder, not a file." >&2; exit 3; fi
        [ -d "$p" ] || { echo "There is no folder $p." >&2; exit 7; }
        if [ -n "$2" ] && command -v sha256sum >/dev/null 2>&1; then
          if [ -e "$f" ]; then c=$(sha256sum < "$f" | cut -c1-64); else c=new; fi
          [ "$c" = "$2" ] || { echo "changed" >&2; exit 9; }
        fi
        cat > "$f"
        """;

    static List<string> ExecArgs(string container, string? user, string workdir, bool stdin)
    {
        var args = new List<string> { "exec" };
        if (stdin) args.Add("-i");
        if (user is { Length: > 0 }) { args.Add("-u"); args.Add(user); }
        args.AddRange(["-w", workdir, container]);
        return args;
    }

    /// <summary>Read <paramref name="path"/> in <paramref name="container"/> as <paramref name="user"/> (null: the container's own user).</summary>
    public static async Task<ReadResult> Read(string container, string? user, string workdir, string path)
    {
        if (!ValidPath(path)) return new("failed", "That is not a file path.");
        var args = ExecArgs(container, user, workdir, stdin: false);
        args.AddRange(["sh", "-c", ReadSh.Replace("\r", "").Replace("MAXBYTES", MaxBytes.ToString()), "sh", path]);
        var r = await NetLabs.Docker(args, TimeSpan.FromSeconds(30));
        var nl = r.Out.IndexOf('\n');
        var full = (nl >= 0 ? r.Out[..nl] : r.Out).TrimEnd('\r');
        if (full.Length == 0) full = path;
        var err = r.Err.Trim();
        switch (r.Code)
        {
            case 0: break;
            case 4: return new("new", $"{full} does not exist yet: Save creates it.", full);
            case 3 or 5 or 6 or 7: return new("failed", err, full);
            case 124: return new("failed", "The container did not answer in time.", full);
            default: return new("failed", err.Length > 0 ? err : $"Could not read {full} (exit code {r.Code}).", full);
        }
        byte[] bytes;
        try { bytes = Convert.FromBase64String(nl >= 0 ? r.Out[(nl + 1)..] : ""); }
        catch (FormatException) { return new("failed", $"Could not read {full}: the container's base64 output was not readable.", full); }
        if (Decode(bytes) is not { } text)
            return new("failed", $"{full} is not a text file (or not UTF-8): the page editor would damage it.", full);
        return new("ok", "", full, text.Text, text.Eol, Hash(bytes));
    }

    /// <summary>
    /// Write <paramref name="text"/> to <paramref name="path"/>. With <paramref name="expectHash"/> (the hash Read gave, or
    /// "new"), a file that changed since then is left alone: state "changed".
    /// </summary>
    public static async Task<WriteResult> Write(string container, string? user, string workdir, string path, string text, string? eol, string? expectHash)
    {
        if (!ValidPath(path)) return new("failed", "That is not a file path.");
        var bytes = Encode(text, eol);
        if (bytes.Length > MaxBytes) return new("failed", "The text is too big for the page editor (1 MB at most).");
        var args = ExecArgs(container, user, workdir, stdin: true);
        args.AddRange(["sh", "-c", WriteSh.Replace("\r", ""), "sh", path, expectHash ?? ""]);
        var r = await NetLabs.Docker(args, TimeSpan.FromSeconds(30), input: bytes);
        var err = r.Err.Trim();
        return r.Code switch
        {
            0 => new("ok", "Saved.", Hash(bytes)),
            9 => new("changed", "The file changed in the container since you opened it (a command in the terminal?)."),
            124 => new("failed", "The container did not answer in time."),
            _ => new("failed", Friendly(err, path)),
        };
    }

    /// <summary>The shell's error, with the usual reasons spelled out.</summary>
    public static string Friendly(string err, string path)
    {
        if (err.Contains("Read-only file system", StringComparison.OrdinalIgnoreCase))
            return $"{path} is on a read-only mount (the lab's /lab folder is read-only): save a copy somewhere else, such as /tmp or /root.";
        if (err.Contains("Permission denied", StringComparison.OrdinalIgnoreCase))
            return $"Permission denied: this user cannot write {path}. Save as root (the checkbox), or use sudoedit {path} in the terminal.";
        return err.Length > 0 ? err : $"Could not save {path}.";
    }
}
