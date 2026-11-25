using System.Text;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// JavaScript / TypeScript code intelligence without Node: a tokenizer and a forgiving parser that
/// understands declarations and scopes well enough for go to definition, find references, hover and
/// completion (names in scope, members of the learner's classes / object literals / interfaces,
/// imports between the given files, and the members of common built-ins).
/// It does not type-check: types are inferred only where they are obvious.
/// </summary>
public static partial class JsIntel
{
    static readonly CodeIntel.Response Empty = new(null, null, null, null, null);

    static bool IsJs(string p) => Regex.IsMatch(p, @"\.(m|c)?(j|t)sx?$", RegexOptions.IgnoreCase);

    public static CodeIntel.Response Run(CodeIntel.Request req)
    {
        var files = (req.Files ?? []).Where(f => f.Path == req.Path || IsJs(f.Path)).ToList();
        if (files.All(f => f.Path != req.Path)) return Empty;
        var project = new Project(files.Select(f => (f.Path, (f.Code ?? "").Replace("\r\n", "\n")))) { IsTs = req.Language == "typescript" };
        var file = project.Files.First(f => f.Path == req.Path);
        var code = files.First(f => f.Path == req.Path).Code ?? "";
        var pos = Math.Clamp(req.Position, 0, code.Length);
        pos -= Regex.Matches(code[..pos], "\r\n").Count;
        try
        {
            return req.Action switch
            {
                "complete" => new(project.Complete(file, pos), null, null, null, null),
                "definition" => project.Definition(file, pos),
                "references" => new(null, null, null, project.References(file, pos), null),
                "hover" => new(null, null, null, null, project.Hover(file, pos)),
                _ => Empty,
            };
        }
        catch (Exception e) when (e is IndexOutOfRangeException or ArgumentOutOfRangeException or InvalidOperationException or NullReferenceException or KeyNotFoundException)
        {
            return Empty;   // a parse this forgiving can still trip on very broken code; never break the editor
        }
    }

    // ================================================================ tokens

    enum Tk { Ident, Num, Str, Template, Regex, Punct, Eof }

    sealed record Tok(Tk Kind, string Text, int Start, int End, bool Nl)
    {
        public bool Is(string s) => Text == s && Kind is Tk.Punct or Tk.Ident;
    }

    static readonly HashSet<string> Reserved = [.. "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await implements interface package private protected public".Split(' ')];
    // Words that are never names of the learner's things (TS type keywords too).
    static readonly HashSet<string> NotNames = [.. Reserved.Except(["static", "let", "await", "yield", "implements", "package", "private", "protected", "public", "interface"]), "string", "number", "boolean", "any", "unknown", "never", "object", "symbol", "bigint", "undefined", "keyof", "readonly", "infer", "is", "asserts", "satisfies", "as", "declare", "abstract", "override", "type", "namespace", "module", "of", "from", "async", "get", "set", "accessor"];
    static readonly string[] Puncts = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];

    sealed class Lexed
    {
        public List<Tok> T = [];
        public List<(int Start, int End, string Text)> Comments = [];
    }

    static Lexed Lex(string s)
    {
        var lx = new Lexed();
        var t = lx.T;
        int i = 0, n = s.Length;
        bool nl = true;
        var tmpl = new Stack<int>();   // brace depth at each open ${
        int braces = 0;
        bool RegexAllowed()
        {
            if (t.Count == 0) return true;
            var p = t[^1];
            if (p.Kind is Tk.Num or Tk.Str or Tk.Template or Tk.Regex) return false;
            if (p.Kind == Tk.Ident) return Reserved.Contains(p.Text) && p.Text is not ("this" or "super" or "null" or "true" or "false");
            return p.Text is not (")" or "]" or "}");
        }
        void Template(int start)
        {
            // i is just past the opening ` or the } that closes a ${ ... }
            var sb = start;
            while (i < n)
            {
                if (s[i] == '\\') { i += 2; continue; }
                if (s[i] == '`') { i++; t.Add(new(Tk.Template, s[sb..i], sb, i, nl)); nl = false; return; }
                if (s[i] == '$' && i + 1 < n && s[i + 1] == '{') { i += 2; t.Add(new(Tk.Template, s[sb..i], sb, i, nl)); nl = false; tmpl.Push(braces); return; }
                i++;
            }
            t.Add(new(Tk.Template, s[sb..Math.Min(i, n)], sb, Math.Min(i, n), nl));
        }
        while (i < n)
        {
            var c = s[i];
            if (c == '\n') { nl = true; i++; continue; }
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '/' && i + 1 < n && s[i + 1] == '/')
            {
                var e = s.IndexOf('\n', i); if (e < 0) e = n;
                lx.Comments.Add((i, e, s[i..e])); i = e; continue;
            }
            if (c == '/' && i + 1 < n && s[i + 1] == '*')
            {
                var e = s.IndexOf("*/", i + 2, StringComparison.Ordinal); e = e < 0 ? n : e + 2;
                lx.Comments.Add((i, e, s[i..e]));
                if (s.AsSpan(i, e - i).Contains('\n')) nl = true;
                i = e; continue;
            }
            var start = i;
            if (char.IsLetter(c) || c == '_' || c == '$' || c == '#' || c > 127 && char.IsLetterOrDigit(c))
            {
                i++;
                while (i < n && (char.IsLetterOrDigit(s[i]) || s[i] == '_' || s[i] == '$')) i++;
                t.Add(new(Tk.Ident, s[start..i], start, i, nl)); nl = false; continue;
            }
            if (char.IsDigit(c) || c == '.' && i + 1 < n && char.IsDigit(s[i + 1]))
            {
                i++;
                while (i < n && (char.IsLetterOrDigit(s[i]) || s[i] == '.' || s[i] == '_')) i++;
                t.Add(new(Tk.Num, s[start..i], start, i, nl)); nl = false; continue;
            }
            if (c is '"' or '\'')
            {
                i++;
                while (i < n && s[i] != c && s[i] != '\n') i += s[i] == '\\' ? 2 : 1;
                if (i < n && s[i] == c) i++;
                i = Math.Min(i, n);
                t.Add(new(Tk.Str, s[start..i], start, i, nl)); nl = false; continue;
            }
            if (c == '`') { i++; Template(start); continue; }
            if (c == '}' && tmpl.Count > 0 && tmpl.Peek() == braces) { tmpl.Pop(); i++; Template(start); continue; }
            if (c == '/' && RegexAllowed())
            {
                i++;
                var cls = false;
                while (i < n && s[i] != '\n' && (s[i] != '/' || cls))
                {
                    if (s[i] == '\\') i++;
                    else if (s[i] == '[') cls = true;
                    else if (s[i] == ']') cls = false;
                    i++;
                }
                if (i < n && s[i] == '/') i++;
                while (i < n && char.IsLetter(s[i])) i++;
                i = Math.Min(i, n);
                t.Add(new(Tk.Regex, s[start..i], start, i, nl)); nl = false; continue;
            }
            var p = Puncts.FirstOrDefault(x => string.CompareOrdinal(s, i, x, 0, x.Length) == 0);
            // "?." followed by a digit is a ternary, not optional chaining.
            if (p == "?." && i + 2 < n && char.IsDigit(s[i + 2])) p = null;
            p ??= c.ToString();
            if (p == "{") braces++;
            else if (p == "}") braces--;
            i += p.Length;
            t.Add(new(Tk.Punct, p, start, i, nl)); nl = false;
        }
        t.Add(new(Tk.Eof, "", n, n, true));
        return lx;
    }

    // ================================================================ model

    sealed class Scope(string kind, Scope? parent, JsFile file)
    {
        public string Kind = kind;
        public Scope? Parent = parent;
        public JsFile File = file;
        public int End = int.MaxValue;           // last token index inside
        public Dictionary<string, Binding> Names = [];
        public JsType? This;
        public List<int> Returns = [];
        public bool IsFunction => Kind is "function" or "program";
    }

    sealed class Binding(string name, string kind, JsFile file, int tok, Scope scope)
    {
        public string Name = name, Kind = kind;
        public JsFile File = file;
        public int Tok = tok;                    // the name's token (-1: none)
        public Scope Scope = scope;
        public int InitStart = -1, InitEnd = -1; // initializer tokens [start, end)
        public int AnnStart = -1, AnnEnd = -1;   // TS type annotation tokens [start, end)
        public ClassInfo? Class;                 // class bindings
        public ObjInfo? Obj;                     // interfaces, type literals, enums
        public FuncInfo? Func;
        public string? Spec, Imported;           // imports: module specifier and the name imported ("default", "*")
        public string? DestructKey;              // const { key } = init
        public bool Shorthand;                   // { a } in an object literal: the value is the variable a
        public bool Static;
        public ClassInfo? Owner;
        public ObjInfo? OwnerObj;
    }

    sealed class ClassInfo(string name, JsFile file)
    {
        public string Name = name;
        public JsFile File = file;
        public Binding? Binding;
        public Dictionary<string, Binding> Inst = [], Static = [];
        public int ExtStart = -1, ExtEnd = -1;
        public Scope? Outer;
    }

    sealed class ObjInfo(string? name)
    {
        public string? Name = name;
        public Dictionary<string, Binding> Members = [];
        public bool IsEnum;
        public int ExtStart = -1, ExtEnd = -1;   // interface ... extends A, B
        public JsFile? File;
    }

    sealed class FuncInfo
    {
        public int Open = -1, Close = -1, RetStart = -1, RetEnd = -1, ExprStart = -1, ExprEnd = -1;
        public Scope? Scope;
        public bool Arrow;
    }

    enum OccKind { Name, Member, Decl, ImportName }

    sealed record Occ(int Tok, OccKind Kind, Scope Scope, Binding? Binding = null);

    sealed class JsFile
    {
        public string Path = "", Code = "";
        public List<Tok> T = [];
        public int[] Match = [];
        public List<(int Start, int End, string Text)> Comments = [];
        public Scope Program = null!;
        public Scope[] TokScope = [];
        public List<Occ> Occs = [];
        public Dictionary<int, ObjInfo> Objects = [];         // '{' of an object literal -> its members
        public Dictionary<int, FuncInfo> Funcs = [];          // 'function' keyword or arrow parameter start -> the function
        public Dictionary<int, ClassInfo> Classes = [];       // 'class' keyword -> the class
        public Dictionary<string, Binding> Exports = [];
        public List<(string Local, string Exported)> PendingExports = [];
        public List<(string Spec, string Name, string As)> Reexports = [];
        public List<string> StarExports = [];
        public int[] LineStarts = [];
        public Tok At(int i) => i >= 0 && i < T.Count ? T[i] : T[^1];

        public (int Line, int Col) Lc(int offset)
        {
            var i = Array.BinarySearch(LineStarts, offset);
            if (i < 0) i = ~i - 1;
            return (i + 1, offset - LineStarts[i]);
        }
        public string LineText(int line) => line >= 1 && line <= LineStarts.Length
            ? Code[LineStarts[line - 1]..(line < LineStarts.Length ? LineStarts[line] - 1 : Code.Length)] : "";
    }

    // ================================================================ types

    abstract record JsType;
    sealed record ClassT(ClassInfo C, bool Instance) : JsType;
    sealed record ObjT(ObjInfo O) : JsType;
    sealed record BuiltinT(string Name) : JsType { public JsType? Elem { get; init; } }   // Elem: what an array holds, when known
    sealed record ModuleT(JsFile F) : JsType;
    sealed record FuncT(Binding? B, FuncInfo F, JsFile File) : JsType;
    sealed record ExternalModuleT(string Spec) : JsType;
    sealed record BuiltinFnT(string Owner, Member M) : JsType { public JsType? Self { get; init; } }

    /// <summary>What an identifier refers to: one of the learner's bindings, a built-in, or a module.</summary>
    abstract record Target;
    sealed record UserTarget(Binding B) : Target;
    sealed record BuiltinTarget(string Owner, string Name, Member? M) : Target { public JsType? Self { get; init; } }
    sealed record ModuleTarget(JsFile F) : Target;
    sealed record ExternalTarget(string Spec) : Target;
}
