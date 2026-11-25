using System.Text;
using System.Text.RegularExpressions;

namespace CodeDojo;

public static partial class JsIntel
{
    sealed class Project
    {
        public readonly List<JsFile> Files = [];
        readonly Dictionary<(JsFile, int), JsType?> memo = [];
        readonly HashSet<(JsFile, int)> busy = [];
        int depth;

        public Project(IEnumerable<(string Path, string Code)> files)
        {
            foreach (var (path, code) in files)
            {
                var lx = Lex(code);
                var f = new JsFile { Path = path, Code = code, T = lx.T, Comments = lx.Comments };
                var starts = new List<int> { 0 };
                for (var i = 0; i < code.Length; i++) if (code[i] == '\n') starts.Add(i + 1);
                f.LineStarts = [.. starts];
                f.Match = MatchBrackets(f.T);
                new Parser(f).Parse();
                Files.Add(f);
            }
        }

        static int[] MatchBrackets(List<Tok> t)
        {
            var m = Enumerable.Repeat(-1, t.Count).ToArray();
            var stack = new Stack<int>();
            for (var i = 0; i < t.Count; i++)
            {
                if (t[i].Kind != Tk.Punct) continue;
                var x = t[i].Text;
                if (x is "(" or "[" or "{") stack.Push(i);
                else if (x is ")" or "]" or "}")
                {
                    var want = x == ")" ? "(" : x == "]" ? "[" : "{";
                    // Unbalanced code: drop openers that never closed until one matches.
                    var tmp = new List<int>();
                    while (stack.Count > 0 && t[stack.Peek()].Text != want) tmp.Add(stack.Pop());
                    if (stack.Count == 0) { foreach (var k in Enumerable.Reverse(tmp)) stack.Push(k); continue; }
                    var o = stack.Pop();
                    m[o] = i; m[i] = o;
                    foreach (var k in tmp) m[k] = i - 1 > k ? i - 1 : k;
                }
            }
            while (stack.Count > 0) { var o = stack.Pop(); m[o] = t.Count - 2 > o ? t.Count - 2 : o; }
            return m;
        }

        // ------------------------------------------------------------ modules

        JsFile? Resolve(string? spec, JsFile from)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            string basePath;
            if (spec.StartsWith('.'))
            {
                var dir = from.Path.Contains('/') ? from.Path[..from.Path.LastIndexOf('/')] : "";
                var parts = (dir.Length > 0 ? dir.Split('/') : []).ToList();
                foreach (var seg in spec.Split('/'))
                {
                    if (seg is "." or "") continue;
                    if (seg == "..") { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); }
                    else parts.Add(seg);
                }
                basePath = string.Join('/', parts);
            }
            else if (spec.StartsWith('/')) basePath = spec.TrimStart('/');
            else basePath = spec;
            string Norm(string p) => p.Replace('\\', '/').TrimStart('.', '/');
            var noExt = Regex.Replace(basePath, @"\.(m|c)?js$", "");
            string[] cands = [basePath, .. new[] { ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts" }.Select(e => noExt + e),
                .. new[] { "/index.ts", "/index.tsx", "/index.js", "/index.mjs" }.Select(e => basePath + e)];
            foreach (var c in cands)
            {
                var hit = Files.FirstOrDefault(f => Norm(f.Path) == Norm(c));
                if (hit is not null) return hit;
            }
            if (!spec.StartsWith('.'))   // a bare name: maybe a file of the project (baseUrl-style), else a package
                return Files.FirstOrDefault(f => cands.Any(c => Norm(f.Path).EndsWith("/" + Norm(c))));
            return null;
        }

        Target? Export(JsFile f, string name, int d = 0)
        {
            if (d > 10) return null;
            if (f.Exports.TryGetValue(name, out var b)) return Follow(new UserTarget(b), d + 1);
            foreach (var (spec, local, exported) in f.Reexports)
            {
                if (exported != name) continue;
                var tf = Resolve(spec, f);
                if (tf is null) return new ExternalTarget(spec);
                return local == "*" ? new ModuleTarget(tf) : Export(tf, local, d + 1);
            }
            if (name != "default")
                foreach (var spec in f.StarExports)
                    if (Resolve(spec, f) is { } tf && Export(tf, name, d + 1) is { } hit) return hit;
            return null;
        }

        IEnumerable<string> ExportNames(JsFile f, int d = 0)
        {
            if (d > 6) yield break;
            foreach (var k in f.Exports.Keys) yield return k;
            foreach (var (_, _, exported) in f.Reexports) yield return exported;
            foreach (var spec in f.StarExports)
                if (Resolve(spec, f) is { } tf)
                    foreach (var k in ExportNames(tf, d + 1)) if (k != "default") yield return k;
        }

        bool IsRequire(JsFile f, int s, out string spec)
        {
            spec = "";
            if (f.At(s).Text == "await") s++;
            if (f.At(s).Text != "require" || f.At(s + 1).Text != "(" || f.At(s + 2).Kind != Tk.Str || f.At(s + 3).Text != ")") return false;
            spec = Unquote(f.At(s + 2).Text);
            return true;
        }

        /// <summary>Imports (and destructured requires, shorthand properties) stand for what they name.</summary>
        Target? Follow(Target? t, int d = 0)
        {
            if (t is not UserTarget { B: var b } || d > 12) return t;
            if (b.Kind == "import" && b.Spec is not null)
            {
                var tf = Resolve(b.Spec, b.File);
                if (tf is null) return new ExternalTarget(b.Spec);
                if (b.Imported == "*") return new ModuleTarget(tf);
                var hit = Export(tf, b.Imported ?? b.Name, d + 1);
                if (hit is null && b.Imported == "default" && tf.Exports.Count > 0) return new ModuleTarget(tf);
                return hit ?? t;
            }
            if (b.Shorthand && b.Tok >= 0 && Lookup(b.File.TokScope[b.Tok], b.Name) is UserTarget { B: var v } && v != b)
                return Follow(new UserTarget(v), d + 1);
            if (b.DestructKey is { } key && key is not ("[]" or "...") && b.InitStart >= 0 && IsRequire(b.File, b.InitStart, out var spec))
            {
                var tf = Resolve(spec, b.File);
                if (tf is null) return new ExternalTarget(spec);
                return Export(tf, key, d + 1) ?? t;
            }
            return t;
        }

        // ------------------------------------------------------------ names

        static Target? Lookup(Scope? s, string name)
        {
            for (; s is not null; s = s.Parent)
                if (s.Names.TryGetValue(name, out var b)) return new UserTarget(b);
            if (BuiltinMember("global", name) is { } g) return new BuiltinTarget("global", name, g);
            return null;
        }

        Target? Resolve(JsFile f, Occ o)
        {
            switch (o.Kind)
            {
                case OccKind.Decl or OccKind.ImportName:
                    return o.Binding is null ? null : new UserTarget(o.Binding);
                case OccKind.Name:
                    return Lookup(o.Scope, f.T[o.Tok].Text);
                default:
                    var recv = o.Tok - 2;
                    if (f.At(recv).Text == "!") recv--;
                    return MemberOf(Infer(f, recv), f.T[o.Tok].Text);
            }
        }

        // ------------------------------------------------------------ members

        Target? MemberOf(JsType? t, string name, int d = 0)
        {
            if (t is null || d > 8) return null;
            switch (t)
            {
                case ClassT c:
                    return ClassMember(c.C, name, c.Instance, d);
                case ObjT o:
                    if (o.O.Members.TryGetValue(name, out var b)) return new UserTarget(b);
                    foreach (var bt in Bases(o.O)) if (MemberOf(bt, name, d + 1) is { } hit) return hit;
                    return null;
                case ModuleT mt:
                    return Export(mt.F, name);
                case BuiltinT bt:
                    return BuiltinMember(bt.Name, name) is { } m ? new BuiltinTarget(bt.Name, name, m) { Self = bt } : null;
                case FuncT or BuiltinFnT:
                    return BuiltinMember("Function", name) is { } fm ? new BuiltinTarget("Function", name, fm) : null;
            }
            return null;
        }

        Target? ClassMember(ClassInfo c, string name, bool inst, int d)
        {
            var dict = inst ? c.Inst : c.Static;
            if (dict.TryGetValue(name, out var b)) return new UserTarget(b);
            var bt = Base(c);
            if (bt is ClassT { C: var bc }) return d < 8 ? ClassMember(bc, name, inst, d + 1) : null;
            if (bt is BuiltinT { Name: var n })
            {
                var type = inst ? InstanceOf(n) : n;
                return type is not null && BuiltinMember(type, name) is { } m ? new BuiltinTarget(type, name, m) : null;
            }
            return null;
        }

        JsType? Base(ClassInfo c) => c.ExtStart >= 0 && c.ExtEnd > c.ExtStart ? Infer(c.File, c.ExtEnd - 1) : null;

        IEnumerable<JsType> Bases(ObjInfo o)
        {
            if (o.ExtStart < 0 || o.File is null) yield break;
            for (var k = o.ExtStart; k < o.ExtEnd; k++)
            {
                var x = o.File.At(k);
                if (x.Kind != Tk.Ident || o.File.At(k - 1).Text == ".") continue;
                if (Instance(TypeOf(Lookup(o.File.TokScope[k], x.Text))) is { } bt) yield return bt;
            }
        }

        // ------------------------------------------------------------ types

        static JsType? Instance(JsType? t) => t switch
        {
            ClassT { Instance: false } c => c with { Instance = true },
            BuiltinT { Name: var n } when n.EndsWith(".static") => InstanceOf(n) is { } i ? new BuiltinT(i) : null,
            ObjT or BuiltinT or ClassT => t,
            _ => null,
        };

        JsType? TypeOf(Target? target)
        {
            target = Follow(target);
            switch (target)
            {
                case null: return null;
                case ModuleTarget mt: return new ModuleT(mt.F);
                case ExternalTarget et: return new ExternalModuleT(et.Spec);
                case BuiltinTarget { M: var m } bt:
                    if (m is null) return null;
                    if (m.Kind == "class") return new BuiltinT(m.Ret!);
                    if (m.Kind is "method" or "function") return new BuiltinFnT(bt.Owner, m) { Self = bt.Self };
                    return m.Ret is null ? null : new BuiltinT(m.Ret);
            }
            var b = ((UserTarget)target).B;
            if (++depth > 40) { depth--; return null; }
            try
            {
                switch (b.Kind)
                {
                    case "class": return b.Class is null ? null : new ClassT(b.Class, false);
                    case "interface" or "enum": return b.Obj is null ? null : new ObjT(b.Obj);
                    case "type": return b.Obj is not null ? new ObjT(b.Obj) : b.AnnStart >= 0 ? AnnType(b.File, b.AnnStart, b.AnnEnd) : null;
                    case "function" or "method" or "constructor":
                        return b.Func is null ? null : new FuncT(b, b.Func, b.File);
                    case "namespace": return null;
                    case "import": return b.Spec is null ? null : new ExternalModuleT(b.Spec);
                }
                if (b.Kind == "property" && b.Func is not null && b.AnnStart < 0 && b.InitStart < 0)
                    return b.Owner is not null || b.OwnerObj is not null ? TypeOfAccessor(b) : null;
                if (b.Kind == "enum member") return b.OwnerObj is null ? null : new BuiltinT("Number");
                if (b.AnnStart >= 0 && b.AnnEnd > b.AnnStart) return AnnType(b.File, b.AnnStart, b.AnnEnd);
                if (b.Shorthand) return null;
                if (b.InitStart >= 0)
                {
                    if (b.DestructKey is { } key)
                    {
                        if (key is "[]" or "...") return null;
                        return TypeOf(MemberOf(InitType(b.File, b.InitStart, b.InitEnd), key));
                    }
                    return InitType(b.File, b.InitStart, b.InitEnd, b);
                }
                return null;
            }
            finally { depth--; }
        }

        JsType? TypeOfAccessor(Binding b) => b.Func is { } fi ? ReturnType(fi, b.File) : null;

        /// <summary>The type of an initializer (tokens [s, e)), where it is obvious.</summary>
        JsType? InitType(JsFile f, int s, int e, Binding? owner = null)
        {
            if (s < 0) return null;
            var k = f.At(s);
            var start = k.Text == "async" ? s + 1 : s;
            if (f.Funcs.TryGetValue(start, out var fi)) return new FuncT(owner, fi, f);
            if (f.At(start).Text == "function" && f.Funcs.TryGetValue(start, out fi)) return new FuncT(owner, fi, f);
            if (k.Text == "class" && f.Classes.TryGetValue(s, out var ci)) return new ClassT(ci, false);
            if (IsRequire(f, s, out var spec))
            {
                var tf = Resolve(spec, f);
                if (tf is null) return new ExternalModuleT(spec);
                if (tf.Exports.Count == 1 && tf.Exports.ContainsKey("default")) return TypeOf(new UserTarget(tf.Exports["default"]));
                return new ModuleT(tf);
            }
            if (e <= s) e = ExprEndOf(f, s) + 1;
            return InferRange(f, s, e);
        }

        static int ExprEndOf(JsFile f, int q)
        {
            var start = q;
            while (q < f.T.Count - 1)
            {
                var x = f.T[q];
                if (x.Kind == Tk.Punct)
                {
                    if (x.Text is "(" or "[" or "{") { q = f.Match[q] > q ? f.Match[q] + 1 : q + 1; continue; }
                    if (x.Text is ")" or "]" or "}" or "," or ";") return q - 1;
                }
                if (q > start && x.Nl && x.Kind != Tk.Punct) return q - 1;
                q++;
            }
            return f.T.Count - 2;
        }

        JsType? InferRange(JsFile f, int s, int e)
        {
            if (e <= s) return null;
            // Operators at the top level decide some results by themselves.
            bool str = false, arith = false, cmp = false, other = false;
            for (var q = s; q < e; q++)
            {
                var x = f.At(q);
                if (x.Kind == Tk.Punct && x.Text is "(" or "[" or "{") { q = f.Match[q] > q ? f.Match[q] : q; continue; }
                if (x.Kind is Tk.Str or Tk.Template) str = true;
                if (x.Kind != Tk.Punct) continue;
                if (x.Text is "-" or "*" or "/" or "%" or "**") arith = true;
                else if (x.Text is "===" or "!==" or "==" or "!=" or "<" or ">" or "<=" or ">=" || x.Text == "!" && q == s) cmp = true;
                else if (x.Text is "?" or "||" or "&&" or "??") other = true;
                else if (x.Text == "+") arith |= !str;
            }
            if (f.At(s).Text is "typeof") return new BuiltinT("String");
            if (f.At(s).Text is "await") return null;
            if (!other && cmp) return new BuiltinT("Boolean");
            if (!other && arith && !str && Infer(f, e - 1) is not BuiltinT { Name: "String" }) return new BuiltinT("Number");
            if (!other && str && Enumerable.Range(s, e - s).Any(q => f.At(q).Text == "+")) return new BuiltinT("String");
            return Infer(f, e - 1);
        }

        static bool EndsValue(Tok p) => p.Kind is Tk.Ident && (!Reserved.Contains(p.Text) || p.Text is "this" or "super")
                                        || p.Kind is Tk.Str or Tk.Template || p.Text is ")" or "]";

        int ChainStart(JsFile f, int e)
        {
            var guard = 0;
            while (e > 0 && guard++ < 200)
            {
                var x = f.At(e);
                if (x.Text is ")" or "]" && f.Match[e] >= 0 && f.Match[e] < e)
                {
                    var open = f.Match[e];
                    if (EndsValue(f.At(open - 1))) { e = open - 1; continue; }
                    return open;
                }
                if (f.At(e - 1).Text is "." or "?.") { e -= 2; if (f.At(e).Text == "!") e--; continue; }
                return e;
            }
            return e;
        }

        /// <summary>The type of the expression whose last token is e.</summary>
        JsType? Infer(JsFile f, int e)
        {
            if (e < 0 || e >= f.T.Count) return null;
            if (memo.TryGetValue((f, e), out var known)) return known;
            if (!busy.Add((f, e)) || busy.Count > 80) return null;
            JsType? r;
            try { r = InferCore(f, e); }
            finally { busy.Remove((f, e)); }
            memo[(f, e)] = r;
            return r;
        }

        JsType? InferCore(JsFile f, int e)
        {
            var k = f.T[e];
            switch (k.Kind)
            {
                case Tk.Str or Tk.Template: return new BuiltinT("String");
                case Tk.Num: return new BuiltinT("Number");
                case Tk.Regex: return new BuiltinT("RegExp");
            }
            if (k.Kind == Tk.Ident)
            {
                if (k.Text is "true" or "false") return new BuiltinT("Boolean");
                if (k.Text is "null" or "undefined") return null;
                if (k.Text == "this") return f.TokScope[e]?.This;
                var prev = f.At(e - 1);
                if (prev.Text is "." or "?.")
                {
                    var recv = e - 2;
                    if (f.At(recv).Text == "!") recv--;
                    return TypeOf(MemberOf(Infer(f, recv), k.Text));
                }
                if (prev.Text == "as") return AnnType(f, e, e + 1);
                var t = TypeOf(Lookup(f.TokScope[e], k.Text));
                return prev.Text == "new" ? Instance(t) : t;
            }
            if (k.Text == "!" && e > 0) return Infer(f, e - 1);
            if (k.Text == "]" && f.Match[e] >= 0 && f.Match[e] < e)
            {
                var open = f.Match[e];
                if (open > 0 && EndsValue(f.At(open - 1)))
                {
                    var bt = Infer(f, open - 1);
                    return bt is BuiltinT { Name: "String" } ? bt : bt is BuiltinT { Name: "Array", Elem: { } el } ? el : null;
                }
                return new BuiltinT("Array") { Elem = open + 1 < e ? Infer(f, Math.Min(ExprEndOf(f, open + 1), e - 1)) : null };
            }
            if (k.Text == "}" && f.Match[e] >= 0 && f.Match[e] < e)
                return f.Objects.TryGetValue(f.Match[e], out var o) ? new ObjT(o) : null;
            if (k.Text == ")" && f.Match[e] >= 0 && f.Match[e] < e)
            {
                var open = f.Match[e];
                var before = f.At(open - 1);
                var calleeEnd = open - 1;
                if (before.Text == ">")   // generic call: f<T>(...)
                {
                    var depthA = 0;
                    for (var q = open - 1; q > 0 && q > open - 30; q--)
                    {
                        if (f.At(q).Text == ">") depthA++;
                        else if (f.At(q).Text == "<" && --depthA == 0) { calleeEnd = q - 1; break; }
                    }
                }
                if (calleeEnd >= 0 && EndsValue(f.At(calleeEnd)))
                {
                    if (f.At(calleeEnd).Text == "require" && f.At(open + 1).Kind == Tk.Str)
                        return InitType(f, calleeEnd, e + 1);
                    var start = ChainStart(f, calleeEnd);
                    var callee = Infer(f, calleeEnd);
                    if (f.At(start - 1).Text == "new") return Instance(callee);
                    return CallResult(callee);
                }
                return Infer(f, e - 1);
            }
            return null;
        }

        JsType? CallResult(JsType? callee) => callee switch
        {
            FuncT ft => ReturnType(ft.F, ft.File),
            BuiltinFnT { M: var m, Owner: "Array", Self: BuiltinT { Elem: var el } self } when m.Name is "find" or "findLast" or "at" or "pop" or "shift" => el,
            BuiltinFnT { M: var m, Owner: "Array", Self: BuiltinT self } when m.Ret == "Array" && m.Name is "filter" or "slice" or "sort" or "reverse" or "toSorted" or "toReversed" or "concat" or "splice" or "toSpliced" => self,
            BuiltinFnT { M: var m } => m.Name == "fetch" ? new BuiltinT("Promise") : m.Ret is null ? null : new BuiltinT(m.Ret),
            BuiltinT { Name: "String.static" } => new BuiltinT("String"),
            BuiltinT { Name: "Number.static" } => new BuiltinT("Number"),
            BuiltinT { Name: "Boolean.static" } => new BuiltinT("Boolean"),
            BuiltinT { Name: "Array.static" } => new BuiltinT("Array"),
            BuiltinT { Name: "Date.static" } => new BuiltinT("String"),
            _ => null,
        };

        readonly HashSet<FuncInfo> returning = [];

        JsType? ReturnType(FuncInfo fi, JsFile f)
        {
            if (!returning.Add(fi)) return null;
            try
            {
                if (fi.RetStart >= 0 && fi.RetEnd > fi.RetStart) return AnnType(f, fi.RetStart, fi.RetEnd);
                if (fi.ExprStart >= 0) return InferRange(f, fi.ExprStart, fi.ExprEnd + 1);
                foreach (var r in fi.Scope?.Returns ?? [])
                {
                    var s = r + 1;
                    if (f.At(s).Text is ";" or "}" || f.At(s).Nl) continue;
                    var t = InferRange(f, s, ExprEndOf(f, s) + 1);
                    if (t is not null) return t;
                }
                return null;
            }
            finally { returning.Remove(fi); }
        }

        /// <summary>A TS type annotation (tokens [s, e)) as a type we know members of.</summary>
        JsType? AnnType(JsFile f, int s, int e, int d = 0)
        {
            while (s < e && f.At(s).Text is "|" or "&") s++;
            if (s >= e || d > 6) return null;
            var first = f.At(s);
            // A union: the first part that is not null/undefined.
            for (var q = s; q < e; q++)
            {
                var x = f.At(q);
                if (x.Text is "(" or "[" or "{" or "<") { q = x.Text == "<" ? q : f.Match[q] > q ? f.Match[q] : q; continue; }
                if (x.Text == "|" && q > s)
                {
                    var left = first.Text is "null" or "undefined" ? null : AnnType(f, s, q, d + 1);
                    return left ?? AnnType(f, q + 1, e, d + 1);
                }
            }
            if (e - s >= 3 && f.At(e - 1).Text == "]" && f.At(e - 2).Text == "[") return new BuiltinT("Array") { Elem = AnnType(f, s, e - 2, d + 1) };
            if (first.Text is "Array" or "ReadonlyArray" && f.At(s + 1).Text == "<" && f.At(e - 1).Text == ">")
                return new BuiltinT("Array") { Elem = AnnType(f, s + 2, e - 1, d + 1) };
            if (first.Text == "(" && Enumerable.Range(s, e - s).Any(q => f.At(q).Text == "=>")) return new BuiltinT("Function");
            if (first.Text == "{")
            {
                var open = s;
                if (!f.Objects.TryGetValue(open, out var o))
                {
                    o = new ObjInfo(null);
                    TypeMembers(f, open, o, null);
                    f.Objects[open] = o;
                }
                return new ObjT(o);
            }
            if (first.Kind != Tk.Ident) return null;
            switch (first.Text)
            {
                case "string": return new BuiltinT("String");
                case "number": return new BuiltinT("Number");
                case "boolean": return new BuiltinT("Boolean");
                case "Array" or "ReadonlyArray": return new BuiltinT("Array");
                case "Map" or "ReadonlyMap" or "WeakMap": return new BuiltinT("Map");
                case "Set" or "ReadonlySet" or "WeakSet": return new BuiltinT("Set");
                case "Promise": return new BuiltinT("Promise");
                case "Date": return new BuiltinT("Date");
                case "RegExp": return new BuiltinT("RegExp");
                case "Function": return new BuiltinT("Function");
                case "Error": return new BuiltinT("Error");
                case "Response": return new BuiltinT("Response");
                case "NodeList" or "NodeListOf": return new BuiltinT("NodeList");
            }
            if (Regex.IsMatch(first.Text, "^(HTML\\w*Element|Element|SVGElement)$")) return new BuiltinT("Element");
            var target = Follow(Lookup(f.TokScope[s], first.Text));
            if (target is UserTarget { B: { Kind: "type", Obj: null, AnnStart: >= 0 } alias })
                return AnnType(alias.File, alias.AnnStart, alias.AnnEnd, d + 1);
            return Instance(TypeOf(target));
        }

        // ------------------------------------------------------------ describing things

        static string Text(JsFile f, int from, int toExclusive)
        {
            if (from < 0 || toExclusive <= from) return "";
            var a = f.At(from).Start;
            var b = f.At(toExclusive - 1).End;
            return Regex.Replace(f.Code[a..b], @"\s+", " ").Trim();
        }

        string TypeName(JsType? t) => t switch
        {
            null => "",
            ClassT { Instance: true } c => c.C.Name,
            ClassT c => "typeof " + c.C.Name,
            ObjT { O.Name: { } n } => n,
            ObjT o => "{ " + string.Join("; ", o.O.Members.Keys.Take(4)) + (o.O.Members.Count > 4 ? "; …" : "") + " }",
            BuiltinT { Name: "String" } => "string",
            BuiltinT { Name: "Number" } => "number",
            BuiltinT { Name: "Boolean" } => "boolean",
            BuiltinT { Name: "Array" } => "any[]",
            BuiltinT { Name: var n } when n.EndsWith(".static") => n[..^7] + "Constructor",
            BuiltinT { Name: var n } => n,
            ModuleT m => "module " + m.F.Path,
            ExternalModuleT x => "module '" + x.Spec + "'",
            FuncT ft => FuncSig(ft.F, ft.File, null),
            BuiltinFnT b => b.M.Sig,
            _ => "",
        };

        string FuncSig(FuncInfo fi, JsFile f, string? name)
        {
            var ps = fi.Open >= 0 ? Text(f, fi.Open, fi.Close + 1) : "";
            if (fi.Open < 0 && fi.Scope is not null)
                ps = "(" + string.Join(", ", fi.Scope.Names.Values.Where(b => b.Kind == "parameter").Select(b => b.Name)) + ")";
            string ret;
            if (fi.RetStart >= 0) ret = Text(f, fi.RetStart, fi.RetEnd);
            else ret = TypeName(ReturnType(fi, f));
            if (name is null) return ps + " => " + (ret.Length > 0 ? ret : "any");
            return name + ps + (ret.Length > 0 ? ": " + ret : "");
        }

        string Detail(Binding b)
        {
            var f = b.File;
            switch (b.Kind)
            {
                case "function": return "function " + FuncSig(b.Func!, f, b.Name);
                case "method" or "constructor" when b.Func is not null: return FuncSig(b.Func, f, b.Name);
                case "class":
                    return "class " + b.Name + (b.Class is { ExtStart: >= 0 } c ? " extends " + Text(f, c.ExtStart, c.ExtEnd) : "");
                case "interface": return "interface " + b.Name;
                case "type": return "type " + b.Name + " = " + Truncate(Text(f, b.AnnStart, b.AnnEnd), 80);
                case "enum": return "enum " + b.Name;
                case "namespace": return "namespace " + b.Name;
                case "enum member": return b.Name;
                case "import":
                    var what = b.Imported switch { "default" => b.Name, "*" => "* as " + b.Name, var n when n == b.Name => "{ " + n + " }", var n => "{ " + n + " as " + b.Name + " }" };
                    return "import " + what + " from '" + b.Spec + "'";
            }
            if (b.Kind == "property" && b.Func is not null && b.AnnStart < 0 && b.InitStart < 0)
                return (b.Func.Open >= 0 && b.File.At(b.Func.Open - 2).Text is "get" or "set" ? "get " : "") + b.Name + ": " + TypeName(ReturnType(b.Func, f));
            var ann = b.AnnStart >= 0 ? Text(f, b.AnnStart, b.AnnEnd) : null;
            var t = ann is null ? TypeOf(new UserTarget(b)) : null;
            if (t is FuncT ft) return b.Name + ": " + FuncSig(ft.F, ft.File, null);
            var ty = ann ?? TypeName(t);
            var opt = b.Tok >= 0 && f.At(b.Tok + 1).Text == "?" ? "?" : "";
            return b.Name + opt + (ty.Length > 0 ? ": " + ty : "");
        }

        static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";

        static string KindOf(Binding b) => b.Kind switch
        {
            "var" or "let" or "const" => "variable",
            "parameter" => "parameter",
            "function" => "function",
            "class" => "class",
            "interface" or "type" => "interface",
            "enum" => "enum",
            "enum member" => "constant",
            "method" or "constructor" => "method",
            "namespace" or "import" => "module",
            "property" => b.Func is not null && b.InitStart < 0 && b.AnnStart < 0 && !(b.Func.Open >= 0 && b.File.At(b.Func.Open - 2).Text is "get" or "set") ? "method" : "property",
            _ => "variable",
        };

        string ItemKind(Binding b)
        {
            if (b.Kind == "import") return Follow(new UserTarget(b)) switch
            {
                UserTarget { B: var x } when x != b => ItemKind(x),
                _ => "module",
            };
            var k = KindOf(b);
            if (k is "variable" or "property" && b.InitStart >= 0 && b.AnnStart < 0 && TypeOf(new UserTarget(b)) is FuncT) return k == "property" ? "method" : "function";
            return k;
        }

        string Describe(Target t)
        {
            switch (Follow(t))
            {
                case UserTarget { B: var b }:
                    var label = b.Kind switch
                    {
                        "var" or "let" or "const" => b.Kind,
                        "enum member" => "enum member",
                        "property" when KindOf(b) == "method" => "method",
                        _ => b.Kind,
                    };
                    var owner = b.Owner?.Name ?? b.OwnerObj?.Name;
                    var sig = Detail(b);
                    if (owner is not null && b.Kind is "method" or "property" or "constructor" or "enum member") sig = owner + "." + sig;
                    var sb = new StringBuilder($"({label}) {sig}");
                    if (b.Tok >= 0 && b.Kind is "var" or "let" or "const" or "property" && b.AnnStart < 0)
                    {
                        var line = b.File.LineText(b.File.Lc(b.File.T[b.Tok].Start).Line).Trim();
                        if (line.Length > 0 && !line.Contains(sig)) sb.Append('\n').Append(Truncate(line, 120));
                    }
                    if (Doc(b) is { } doc) sb.Append('\n').Append(doc);
                    return sb.ToString();
                case BuiltinTarget { M: { } m, Owner: var o }:
                    var kind = m.Kind == "variable" ? "global" : m.Kind;
                    var head = o == "global" ? m.Kind == "class" ? $"(class) {m.Name}" : $"({kind}) {m.Sig}" : $"({kind}) {(o.EndsWith(".static") ? o[..^7] : o)}.{m.Sig}";
                    return head + (m.Doc is null ? "" : "\n" + m.Doc);
                case ModuleTarget mt: return "(module) " + mt.F.Path;
                case ExternalTarget et: return "(module) '" + et.Spec + "'";
            }
            return "";
        }

        /// <summary>The first line of a /** doc comment */ just above a declaration.</summary>
        static string? Doc(Binding b)
        {
            if (b.Tok < 0) return null;
            var f = b.File;
            var line = f.Lc(f.T[b.Tok].Start).Line;
            foreach (var c in f.Comments)
            {
                if (!c.Text.StartsWith("/**")) continue;
                var endLine = f.Lc(Math.Max(c.Start, c.End - 1)).Line;
                if (endLine != line - 1 && !(endLine == line && c.End <= f.T[b.Tok].Start)) continue;
                foreach (var raw in c.Text[3..^2].Split('\n'))
                {
                    var l = raw.Trim().TrimStart('*').Trim();
                    if (l.Length > 0 && !l.StartsWith('@')) return Truncate(l, 200);
                }
            }
            return null;
        }

        static CodeIntel.Location Loc(JsFile f, int tok)
        {
            var k = f.T[tok];
            var (line, col) = f.Lc(k.Start);
            var text = f.LineText(line).Trim();
            return new(f.Path, line, col + 1, k.End - k.Start, Truncate(text, 120));
        }

        // ------------------------------------------------------------ the actions

        Occ? OccAt(JsFile f, int pos)
        {
            Occ? best = null;
            foreach (var o in f.Occs)
            {
                var k = f.T[o.Tok];
                if (pos < k.Start || pos > k.End) continue;
                if (best is null || pos < k.End && pos >= f.T[best.Tok].End) best = o;
            }
            return best;
        }

        public CodeIntel.Response Definition(JsFile f, int pos)
        {
            var o = OccAt(f, pos);
            if (o is null) return Empty;
            var t = Follow(Resolve(f, o));
            return t switch
            {
                UserTarget { B: { Tok: >= 0 } b } => new(null, Loc(b.File, b.Tok), null, null, Describe(t)),
                ModuleTarget mt => new(null, new(mt.F.Path, 1, 1, 0, Truncate(mt.F.LineText(1).Trim(), 120)), null, null, null),
                BuiltinTarget => new(null, null, Describe(t) + "\n\nBuilt into JavaScript (no source to open).", null, null),
                ExternalTarget et => new(null, null, $"(module) '{et.Spec}'\n\nNot one of your files (an installed package or a built-in module; no source to open).", null, null),
                _ => Empty,
            };
        }

        public string? Hover(JsFile f, int pos)
        {
            var o = OccAt(f, pos);
            if (o is null) return null;
            var t = Resolve(f, o);
            if (t is null) return null;
            var text = Describe(t);
            return text.Length > 0 ? text : null;
        }

        object? Canon(Target? t) => Follow(t) switch
        {
            UserTarget { B: var b } => b,
            ModuleTarget mt => mt.F,
            BuiltinTarget bt => "builtin:" + bt.Owner + "." + bt.Name,
            ExternalTarget et => "ext:" + et.Spec,
            _ => null,
        };

        public List<CodeIntel.Location> References(JsFile f, int pos)
        {
            var o = OccAt(f, pos);
            if (o is null) return [];
            var target = Resolve(f, o);
            var want = Canon(target);
            if (want is null) return [];
            var names = new HashSet<string> { f.T[o.Tok].Text };
            if (want is Binding wb) names.Add(wb.Name);
            // Imports under another name (import { area as a }) still name the same thing.
            foreach (var file in Files)
                foreach (var b in file.Program.Names.Values)
                    if (b.Kind == "import" && Equals(Canon(new UserTarget(b)), want)) names.Add(b.Name);
            var found = new List<(JsFile F, int Tok)>();
            var seen = new HashSet<(string, int)>();
            foreach (var file in Files)
                foreach (var x in file.Occs)
                {
                    if (!names.Contains(file.T[x.Tok].Text)) continue;
                    if (!Equals(Canon(Resolve(file, x)), want)) continue;
                    if (seen.Add((file.Path, x.Tok))) found.Add((file, x.Tok));
                }
            return found.OrderBy(x => x.F != f).ThenBy(x => x.F.Path).ThenBy(x => x.Tok).Select(x => Loc(x.F, x.Tok)).ToList();
        }

        // ------------------------------------------------------------ completion

        public List<CodeIntel.Item> Complete(JsFile f, int pos)
        {
            var code = f.Code;
            pos = Math.Clamp(pos, 0, code.Length);
            foreach (var c in f.Comments) if (pos > c.Start && pos <= c.End && (c.Text.StartsWith("//") || pos < c.End)) return [];
            foreach (var k in f.T)
            {
                if (k.Start >= pos) break;
                if (k.Kind is Tk.Str or Tk.Regex or Tk.Template && pos > k.Start && (pos < k.End || pos == k.End && !Closed(k)))
                    return [];
            }
            var before = code[..pos];
            var lineStart = before.LastIndexOf('\n') + 1;
            var lineBefore = before[lineStart..];

            // import { | } from './x'  -> what that module exports
            var imp = Regex.Match(lineBefore, @"^\s*(?:import|export)\s+(?:type\s+)?(?:\w+\s*,\s*)?\{[^}]*$");
            if (imp.Success)
            {
                var from = Regex.Match(code[pos..], @"^[^;]*?\}\s*from\s*(['""])(.+?)\1");
                if (from.Success && Resolve(from.Groups[2].Value, f) is { } tf)
                    return MembersOf(new ModuleT(tf));
                return [];
            }

            var word = Regex.Match(before, @"[A-Za-z_$#][\w$]*$");
            var start = pos - (word.Success ? word.Length : 0);
            var lead = code[..start].TrimEnd(' ', '\t');
            if (lead.EndsWith('.') || lead.EndsWith("?."))
            {
                var dotEnd = lead.Length;
                var d = f.T.FindIndex(x => x.Kind == Tk.Punct && x.Text is "." or "?." && x.End == dotEnd);
                if (d <= 0) return [];
                var recv = d - 1;
                if (f.At(recv).Text == "!") recv--;
                return MembersOf(Infer(f, recv));
            }
            // Names in scope where the cursor is.
            var idx = f.T.FindLastIndex(x => x.Start < start && x.Kind != Tk.Eof);
            var at = f.T.FindIndex(x => x.Start == start && x.Kind == Tk.Ident);
            Scope scope;
            if (at >= 0) scope = f.TokScope[at];
            else if (idx >= 0)
            {
                scope = f.TokScope[idx];
                if (f.T[idx].Text == "}" && scope.End <= idx && scope.Parent is not null) scope = scope.Parent;
                if (idx + 1 < f.T.Count - 1 && f.TokScope[idx + 1] is { } nextScope && IsInside(nextScope, scope)) scope = nextScope;
            }
            else scope = f.Program;
            var items = new List<CodeIntel.Item>();
            var names = new HashSet<string>();
            for (var s = scope; s is not null; s = s.Parent)
                foreach (var b in s.Names.Values)
                    if (names.Add(b.Name) && b.Tok != at) items.Add(new(b.Name, ItemKind(b), Safe(() => Detail(b))));
            foreach (var m in Builtins["global"].Values)
                if (names.Add(m.Name)) items.Add(new(m.Name, m.Kind == "variable" ? "variable" : m.Kind, m.Kind == "class" ? "class " + m.Name : m.Sig));
            var ts = Regex.IsMatch(f.Path, @"\.(m|c)?tsx?$", RegexOptions.IgnoreCase) || IsTs;
            foreach (var kw in (JsKeywords + (ts ? TsKeywords : "")).Split(' '))
                if (names.Add(kw)) items.Add(new(kw, "keyword", null));
            return items;
        }

        public bool IsTs;

        static bool IsInside(Scope inner, Scope outer)
        {
            for (var s = inner; s is not null; s = s.Parent) if (s == outer) return true;
            return false;
        }

        static bool Closed(Tok k) => k.Kind switch
        {
            Tk.Str => k.Text.Length >= 2 && k.Text[^1] == k.Text[0],
            Tk.Template => k.Text.Length >= 2 && (k.Text.EndsWith('`') || k.Text.EndsWith("${")),
            Tk.Regex => true,
            _ => true,
        };

        static string? Safe(Func<string> f)
        {
            try { return f(); } catch (Exception e) when (e is IndexOutOfRangeException or ArgumentOutOfRangeException or NullReferenceException or InvalidOperationException) { return null; }
        }

        List<CodeIntel.Item> MembersOf(JsType? t)
        {
            var items = new List<CodeIntel.Item>();
            var names = new HashSet<string>();
            void AddBinding(Binding b) { if (b.Name != "constructor" && names.Add(b.Name)) items.Add(new(b.Name, ItemKind(b), Safe(() => Detail(b)))); }
            void AddBuiltin(string type)
            {
                if (!Builtins.TryGetValue(type, out var ms)) return;
                foreach (var m in ms.Values) if (names.Add(m.Name)) items.Add(new(m.Name, m.Kind, m.Kind == "class" ? "class " + m.Name : m.Sig));
            }
            void AddClass(ClassInfo c, bool inst, int d)
            {
                foreach (var b in (inst ? c.Inst : c.Static).Values) AddBinding(b);
                if (d > 8) return;
                switch (Base(c))
                {
                    case ClassT { C: var bc }: AddClass(bc, inst, d + 1); break;
                    case BuiltinT { Name: var n }: if ((inst ? InstanceOf(n) : n) is { } bt) AddBuiltin(bt); break;
                }
            }
            void AddObj(ObjInfo o, int d)
            {
                foreach (var b in o.Members.Values) AddBinding(b);
                if (d > 6) return;
                foreach (var bt in Bases(o))
                    if (bt is ObjT { O: var bo }) AddObj(bo, d + 1);
                    else if (bt is ClassT { C: var bc }) AddClass(bc, true, d + 1);
            }
            switch (t)
            {
                case ClassT c: AddClass(c.C, c.Instance, 0); break;
                case ObjT o: AddObj(o.O, 0); break;
                case ModuleT mt:
                    foreach (var name in ExportNames(mt.F).Distinct())
                    {
                        if (name == "default" || !names.Add(name)) continue;
                        var target = Export(mt.F, name);
                        items.Add(target is UserTarget { B: var b } ? new(name, ItemKind(b), Safe(() => Detail(b))) : new(name, "module", null));
                    }
                    break;
                case BuiltinT bt: AddBuiltin(bt.Name); break;
                case FuncT or BuiltinFnT: AddBuiltin("Function"); break;
            }
            return items;
        }
    }
}
