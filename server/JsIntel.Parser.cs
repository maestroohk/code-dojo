namespace CodeDojo;

public static partial class JsIntel
{
    /// <summary>
    /// One pass over the tokens with a stack of open brackets and a stack of scopes. It recognises
    /// declarations (var/let/const with destructuring, functions, arrows, classes and their members,
    /// object literal members, imports/exports, TS interfaces/types/enums) and records every
    /// identifier as an occurrence in the scope it appears in. Everything else is skipped over.
    /// </summary>
    sealed class Parser
    {
        readonly JsFile f;
        readonly List<Tok> t;
        readonly int[] m;
        readonly List<Scope> scopes = [];
        readonly List<Ctx> ctx = [];
        readonly Dictionary<int, Arrow> arrows = [];
        readonly Dictionary<int, Scope> bodies = [];
        readonly Dictionary<int, ClassInfo> classBodies = [];
        readonly Stack<Decl> decls = new();
        bool exportNext, exportDefault;

        sealed record Ctx(string Open, int Index, string Kind, ClassInfo? Class = null, ObjInfo? Obj = null);
        sealed record Arrow(int ParamStart, int ParamEnd, int At, bool Single, int End);
        sealed class Decl(string kind, int depth, Scope scope)
        {
            public string Kind = kind;
            public int Depth = depth;
            public Scope Scope = scope;
            public List<Binding> Pending = [];
        }

        Scope Cur => scopes[^1];
        Tok At(int i) => f.At(i);
        int M(int i) => i >= 0 && i < m.Length && m[i] > i ? m[i] : t.Count - 2;

        public Parser(JsFile file)
        {
            f = file;
            t = file.T;
            m = file.Match;
        }

        public void Parse()
        {
            f.Program = new Scope("program", null, f) { End = t.Count };
            scopes.Add(f.Program);
            f.TokScope = new Scope[t.Count];
            FindArrows();
            var i = 0;
            var guard = 0;
            while (i < t.Count - 1 && guard++ < t.Count * 4)
            {
                while (scopes.Count > 1 && Cur.End < i) scopes.RemoveAt(scopes.Count - 1);
                f.TokScope[i] ??= Cur;
                var next = Step(i);
                i = next > i ? next : i + 1;
            }
            for (var k = 0; k < t.Count; k++) f.TokScope[k] ??= k > 0 ? f.TokScope[k - 1] : f.Program;
            foreach (var (local, exported) in f.PendingExports)
                if (f.Program.Names.TryGetValue(local, out var b)) f.Exports.TryAdd(exported, b);
            CommonJs();
        }

        void Mark(int from, int to, Scope s)
        {
            for (var k = Math.Max(0, from); k <= to && k < t.Count; k++) f.TokScope[k] ??= s;
        }

        static bool EndsExpr(Tok p) => p.Kind switch
        {
            Tk.Ident => !Reserved.Contains(p.Text) || p.Text is "this" or "super" or "null" or "true" or "false",
            Tk.Num or Tk.Str or Tk.Regex => true,
            Tk.Template => p.Text.EndsWith('`'),
            Tk.Punct => p.Text is ")" or "]" or "}" or "++" or "--",
            _ => false,
        };

        int ExprEnd(int q)
        {
            var start = q;
            while (q < t.Count - 1)
            {
                var x = t[q];
                if (x.Kind == Tk.Punct)
                {
                    if (x.Text is "(" or "[" or "{") { q = M(q) + 1; continue; }
                    if (x.Text is ")" or "]" or "}" or "," or ";") return q - 1;
                }
                if (q > start && x.Nl && x.Kind != Tk.Punct && EndsExpr(At(q - 1))) return q - 1;
                q++;
            }
            return t.Count - 2;
        }

        int SkipExpr(int q, int limit)
        {
            while (q < limit && q < t.Count - 1)
            {
                var x = t[q];
                if (x.Kind == Tk.Punct)
                {
                    if (x.Text is "(" or "[" or "{") { q = M(q) + 1; continue; }
                    if (x.Text is "," or ")" or "]" or "}" or ";") return q;
                }
                q++;
            }
            return Math.Min(q, limit);
        }

        /// <summary>Past a TS type: stops at , ) ] } = ; (and { when a body follows a return type).</summary>
        int SkipType(int q, bool stopBrace, int limit = int.MaxValue)
        {
            var start = q;
            var angle = 0;
            while (q < t.Count - 1 && q < limit)
            {
                var x = t[q];
                if (x.Kind == Tk.Punct)
                {
                    if (x.Text is "(" or "[" or "{")
                    {
                        if (x.Text == "{" && stopBrace && angle == 0 && q > start && At(q - 1).Text is not (":" or "|" or "&" or "<" or ",")) break;
                        q = M(q) + 1; continue;
                    }
                    if (x.Text == "<") { angle++; q++; continue; }
                    if (x.Text == ">") { if (angle > 0) angle--; q++; continue; }
                    if (x.Text == ">>") { angle = Math.Max(0, angle - 2); q++; continue; }
                    if (x.Text == ">>>") { angle = Math.Max(0, angle - 3); q++; continue; }
                    if (x.Text is ")" or "]" or "}" or ";") break;
                    if (angle == 0 && x.Text is "," or "=") break;
                }
                else if (angle == 0 && q > start && x.Nl && At(q - 1) is { } p && (p.Kind is Tk.Ident or Tk.Str or Tk.Num || p.Text is "]" or ")" or "}" or ">")
                         && At(q - 1).Text is not ("keyof" or "typeof" or "readonly")) break;
                q++;
            }
            return q;
        }

        int SkipAngles(int q)
        {
            var depth = 0;
            while (q < t.Count - 1)
            {
                var x = t[q].Text;
                if (x == "<") depth++;
                else if (x == ">") depth--;
                else if (x == ">>") depth -= 2;
                else if (x is "(" or "[" or "{") { q = M(q); }
                else if (x is ";" or ")" or "}") return q;
                q++;
                if (depth <= 0) return q;
            }
            return q;
        }

        /// <summary>Identifier uses inside a stretch we do not otherwise parse (defaults, type annotations, extends clauses).</summary>
        void Refs(int from, int to)
        {
            for (var k = from; k < to && k < t.Count - 1; k++)
            {
                f.TokScope[k] ??= Cur;
                var x = t[k];
                if (x.Kind != Tk.Ident || NotNames.Contains(x.Text)) continue;
                var p = At(k - 1);
                var member = p.Kind == Tk.Punct && p.Text is "." or "?.";
                // { key: Type } inside a type: the key is not a use of anything.
                if (!member && At(k + 1).Text is ":" or "?" && p.Text is "{" or ";" or ",") continue;
                f.Occs.Add(new(k, member ? OccKind.Member : OccKind.Name, Cur));
            }
        }

        Binding Declare(Scope scope, string name, string kind, int tok)
        {
            var b = new Binding(name, kind, f, tok, scope);
            if (!scope.Names.TryGetValue(name, out var first)) scope.Names[name] = first = b;
            f.Occs.Add(new(tok, OccKind.Decl, scope, first));
            f.TokScope[tok] ??= scope;
            if (exportNext && scope == f.Program) f.Exports.TryAdd(exportDefault ? "default" : name, first);
            return first == b ? b : first;
        }

        void ResetExport() { exportNext = false; exportDefault = false; }

        Scope FunctionScope(Scope s)
        {
            while (!s.IsFunction && s.Parent is not null) s = s.Parent;
            return s;
        }

        bool IsExpressionPosition(int i)
        {
            var p = At(i - 1);
            if (p.Text == "async") p = At(i - 2);
            if (i == 0 || p.Kind == Tk.Eof) return false;
            if (p.Kind == Tk.Punct) return p.Text is not (";" or "}" or "{" or ")");
            return p.Kind == Tk.Ident && p.Text is "return" or "typeof" or "await" or "yield" or "new" or "in" or "of" or "case" or "void" or "throw";
        }

        // ------------------------------------------------------------ pre-pass: arrow functions

        void FindArrows()
        {
            for (var i = 1; i < t.Count - 1; i++)
            {
                if (t[i].Kind != Tk.Punct || t[i].Text != "=>") continue;
                var p = t[i - 1];
                int ps, pe;
                var single = false;
                if (p.Kind == Tk.Ident && !Reserved.Contains(p.Text)) { ps = pe = i - 1; single = true; }
                else
                {
                    var close = -1;
                    if (p.Text == ")") close = i - 1;
                    else
                        for (var k = i - 2; k > 0 && k > i - 40; k--)
                            if (t[k].Text == ")" && At(k + 1).Text == ":") { close = k; break; }
                    if (close < 0 || m[close] < 0 || m[close] >= close) continue;
                    ps = m[close]; pe = close;
                }
                var body = i + 1;
                var end = At(body).Text == "{" ? M(body) : ExprEnd(body);
                arrows[ps] = new(ps, pe, i, single, end);
            }
        }

        int BeginArrow(int i, Arrow a)
        {
            var fs = new Scope("function", Cur, f) { End = a.End, This = Cur.This };
            var fi = new FuncInfo { Arrow = true, Open = a.Single ? -1 : a.ParamStart, Close = a.Single ? -1 : a.ParamEnd, Scope = fs };
            f.Funcs[i] = fi;
            scopes.Add(fs);
            if (a.Single) Declare(fs, t[i].Text, "parameter", i);
            else Params(a.ParamStart, a.ParamEnd, fs, null);
            if (At(a.ParamEnd + 1).Text == ":" && a.ParamEnd + 2 < a.At)
            {
                fi.RetStart = a.ParamEnd + 2; fi.RetEnd = a.At;
                Refs(fi.RetStart, fi.RetEnd);
            }
            Mark(i, a.At, fs);
            var body = a.At + 1;
            if (At(body).Text == "{") bodies[body] = fs;
            else { fi.ExprStart = body; fi.ExprEnd = a.End; }
            return body;
        }

        // ------------------------------------------------------------ the walk

        int Step(int i)
        {
            if (arrows.TryGetValue(i, out var a)) return BeginArrow(i, a);
            var k = t[i];
            var top = ctx.Count > 0 ? ctx[^1] : null;
            if (top is { Kind: "object" } && k.Kind is Tk.Ident or Tk.Str or Tk.Num && (i - 1 == top.Index || At(i - 1).Text == "," && At(i - 1).Kind == Tk.Punct))
                return ObjectMember(i, top.Obj!);
            if (k.Kind == Tk.Punct) return Punct(i);
            CheckDeclEnd(i);
            if (k.Kind == Tk.Ident) return Word(i, top);
            return i + 1;
        }

        void CheckDeclEnd(int i)
        {
            if (decls.Count == 0) return;
            var d = decls.Peek();
            if (ctx.Count == d.Depth && t[i].Nl && t[i].Kind != Tk.Punct && EndsExpr(At(i - 1))) FinishDecl(i);
        }

        void FinishDecl(int i)
        {
            var d = decls.Pop();
            foreach (var b in d.Pending)
                if (b.InitStart >= 0 && b.InitEnd < 0) b.InitEnd = i;
            if (d.Scope == f.Program) ResetExport();
        }

        int Punct(int i)
        {
            var x = t[i].Text;
            switch (x)
            {
                case "(" or "[":
                    ctx.Add(new(x, i, "code"));
                    return i + 1;
                case "{":
                    return OpenBrace(i);
                case ")" or "]" or "}":
                    var open = m[i];
                    var at = ctx.FindLastIndex(c => c.Index == open);
                    if (at >= 0) ctx.RemoveRange(at, ctx.Count - at);
                    else if (ctx.Count > 0) ctx.RemoveAt(ctx.Count - 1);
                    while (decls.Count > 0 && decls.Peek().Depth > ctx.Count) FinishDecl(i);
                    return i + 1;
                case ",":
                    if (decls.Count > 0 && decls.Peek().Depth == ctx.Count)
                    {
                        var d = decls.Peek();
                        foreach (var b in d.Pending) if (b.InitStart >= 0 && b.InitEnd < 0) b.InitEnd = i;
                        d.Pending.Clear();
                        return Declarator(i + 1);
                    }
                    return i + 1;
                case ";":
                    if (decls.Count > 0 && decls.Peek().Depth == ctx.Count) FinishDecl(i);
                    return i + 1;
                default:
                    return i + 1;
            }
        }

        int OpenBrace(int i)
        {
            if (bodies.ContainsKey(i)) { ctx.Add(new("{", i, "code")); return i + 1; }
            if (classBodies.TryGetValue(i, out var ci))
            {
                ctx.Add(new("{", i, "class", ci));
                var cs = new Scope("class", Cur, f) { End = M(i), This = new ClassT(ci, true) };
                scopes.Add(cs);
                return i + 1;
            }
            var p = At(i - 1);
            var top = ctx.Count > 0 ? ctx[^1] : null;
            var obj = i > 0 && (p.Kind == Tk.Punct && p.Text is "=" or "(" or "," or "[" or "?" or "??" or "||" or "&&" or "!" or "..." or "+" or "-" or "*" or "/" or "%"
                                    or "<" or ">" or "==" or "===" or "!=" or "!==" or "+=" or "-=" or "|" or "&" or "??=" or "||=" or "&&="
                               || p.Text == ":" && top is { Kind: "object" } or { Open: "(" or "[" }
                               || p.Kind == Tk.Ident && p.Text is "return" or "typeof" or "await" or "yield" or "case" or "in" or "of" or "default" or "void" or "throw" or "delete");
            if (obj && !(p.Text == "default" && At(i - 2).Text != "export"))
            {
                var o = new ObjInfo(null);
                f.Objects[i] = o;
                ctx.Add(new("{", i, "object", null, o));
                return i + 1;
            }
            ctx.Add(new("{", i, "code"));
            scopes.Add(new Scope("block", Cur, f) { End = M(i), This = Cur.This });
            return i + 1;
        }

        int Word(int i, Ctx? top)
        {
            var w = t[i].Text;
            var prev = At(i - 1);
            var next = At(i + 1);
            if (prev.Kind == Tk.Punct && prev.Text is "." or "?.")
            {
                MemberAssignment(i, next);
                f.Occs.Add(new(i, OccKind.Member, Cur));
                return i + 1;
            }
            if (top is { Kind: "class" } && IsMemberStart(i, top)) return ClassMember(i, top.Class!);
            switch (w)
            {
                case "var" or "let" or "const" when next.Kind == Tk.Ident && !Reserved.Contains(next.Text) || next.Text is "{" or "[":
                    decls.Push(new Decl(w, ctx.Count, w == "var" ? FunctionScope(Cur) : Cur));
                    return Declarator(i + 1);
                case "function":
                    return Function(i);
                case "class":
                    return Class(i);
                case "import" when next.Text is not ("(" or "."):
                    return Import(i);
                case "export":
                    return Export(i);
                case "interface" when next.Kind == Tk.Ident && !Reserved.Contains(next.Text) && !EndsExpr(prev):
                    return Interface(i);
                case "type" when next.Kind == Tk.Ident && At(i + 2).Text is "=" or "<" && !EndsExpr(prev):
                    return TypeAlias(i);
                case "enum" when next.Kind == Tk.Ident:
                    return Enum(i);
                case "namespace" or "module" when next.Kind == Tk.Ident && At(i + 2).Text == "{":
                    Declare(Cur, next.Text, "namespace", i + 1);
                    return i + 2;
                case "catch" when next.Text == "(":
                    return Catch(i);
                case "for":
                    {
                        var open = next.Text == "(" ? i + 1 : next.Text == "await" && At(i + 2).Text == "(" ? i + 2 : -1;
                        if (open < 0) return i + 1;
                        var close = M(open);
                        var end = At(close + 1).Text == "{" ? M(close + 1) : ExprEnd(close + 1) + 1;
                        scopes.Add(new Scope("block", Cur, f) { End = end, This = Cur.This });
                        return i + 1;
                    }
                case "return":
                    FunctionScope(Cur).Returns.Add(i);
                    return i + 1;
                case "of" or "in" when decls.Count > 0 && decls.Peek().Depth == ctx.Count:
                    FinishDecl(i);
                    return i + 1;
            }
            if (NotNames.Contains(w)) return i + 1;
            if (next.Text == ":" && prev.Text is ";" or "{" or "}" && !EndsExpr(prev) && top is not { Kind: "object" }) return i + 1;   // a label
            f.Occs.Add(new(i, OccKind.Name, Cur));
            return i + 1;
        }

        /// <summary>this.x = ... declares a field; exports.x = ... exports.</summary>
        void MemberAssignment(int i, Tok next)
        {
            if (next.Text != "=") return;
            var name = t[i].Text;
            var recv = At(i - 2);
            if (recv.Text == "this" && Cur.This is ClassT { Instance: true } ct && !ct.C.Inst.ContainsKey(name))
                ct.C.Inst[name] = new Binding(name, "property", f, i, Cur) { Owner = ct.C, InitStart = i + 2, InitEnd = ExprEnd(i + 2) + 1 };
            else if (recv.Text == "this" && Cur.This is ObjT ot && !ot.O.Members.ContainsKey(name))
                ot.O.Members[name] = new Binding(name, "property", f, i, Cur) { OwnerObj = ot.O, InitStart = i + 2, InitEnd = ExprEnd(i + 2) + 1 };
            else if (recv.Text == "exports" && (At(i - 3).Text != "." || At(i - 4).Text == "module"))
                f.Exports.TryAdd(name, new Binding(name, "const", f, i, f.Program) { InitStart = i + 2, InitEnd = ExprEnd(i + 2) + 1 });
        }

        // ------------------------------------------------------------ declarations

        int Declarator(int j)
        {
            var d = decls.Peek();
            var list = new List<Binding>();
            var p = j;
            Pattern(ref p, d.Scope, d.Kind, list, null);
            if (At(p).Text == "!") p++;
            if (At(p).Text == ":")
            {
                var e = SkipType(p + 1, false);
                if (list.Count == 1) { list[0].AnnStart = p + 1; list[0].AnnEnd = e; }
                Refs(p + 1, e);
                p = e;
            }
            Mark(j, p, Cur);
            if (At(p).Text == "=")
            {
                foreach (var b in list) if (b.InitStart < 0) { b.InitStart = p + 1; d.Pending.Add(b); }
                return p + 1;
            }
            return p;
        }

        void Pattern(ref int p, Scope scope, string kind, List<Binding> list, string? key)
        {
            var k = At(p);
            if (k.Kind == Tk.Ident && !Reserved.Contains(k.Text))
            {
                var b = Declare(scope, k.Text, kind, p);
                if (b.Tok == p) b.DestructKey = key;
                list.Add(b);
                p++;
                if (At(p).Text == "?") p++;
                return;
            }
            if (k.Kind == Tk.Punct && k.Text is "{" or "[")
            {
                var obj = k.Text == "{";
                var close = M(p);
                var q = p + 1;
                while (q < close)
                {
                    var before = q;
                    var x = At(q);
                    if (x.Text == ",") { q++; continue; }
                    if (x.Text == "...") { q++; Pattern(ref q, scope, kind, list, "..."); }
                    else if (obj && x.Text == "[")
                    {
                        var c = M(q); Refs(q + 1, c); q = c + 1;
                        if (At(q).Text == ":") { q++; Pattern(ref q, scope, kind, list, "[]"); }
                    }
                    else if (obj && x.Kind is Tk.Ident or Tk.Str or Tk.Num)
                    {
                        var keyName = x.Kind == Tk.Str ? Unquote(x.Text) : x.Text;
                        if (At(q + 1).Text == ":") { q += 2; Pattern(ref q, scope, kind, list, keyName); }
                        else if (x.Kind == Tk.Ident)
                        {
                            var b = Declare(scope, x.Text, kind, q);
                            if (b.Tok == q) b.DestructKey = keyName;
                            list.Add(b);
                            q++;
                        }
                        else q++;
                    }
                    else if (!obj) Pattern(ref q, scope, kind, list, "[]");
                    if (At(q).Text == "=") { var e = SkipExpr(q + 1, close); Refs(q + 1, e); q = e; }
                    if (q == before) q++;
                }
                Mark(p, close, scope);
                p = close + 1;
                return;
            }
            p++;
        }

        void Params(int open, int close, Scope fs, ClassInfo? ctorOf)
        {
            var q = open + 1;
            while (q < close)
            {
                var before = q;
                var prop = false;
                while (At(q).Kind == Tk.Ident && At(q).Text is "public" or "private" or "protected" or "readonly" or "override"
                       && (At(q + 1).Kind == Tk.Ident || At(q + 1).Text is "{" or "[")) { prop = true; q++; }
                if (At(q).Text == "@") { q += 2; if (At(q).Text == "(") q = M(q) + 1; continue; }
                if (At(q).Text == "...") q++;
                if (At(q).Text == "this" && At(q + 1).Text == ":") { q = SkipType(q + 2, false, close); if (At(q).Text == ",") q++; continue; }
                var list = new List<Binding>();
                Pattern(ref q, fs, "parameter", list, null);
                if (At(q).Text == "?") q++;
                if (At(q).Text == ":")
                {
                    var e = SkipType(q + 1, false, close);
                    if (list.Count == 1) { list[0].AnnStart = q + 1; list[0].AnnEnd = e; }
                    Refs(q + 1, e);
                    q = e;
                }
                if (At(q).Text == "=")
                {
                    var e = SkipExpr(q + 1, close);
                    Refs(q + 1, e);
                    if (list.Count == 1 && list[0].InitStart < 0) { list[0].InitStart = q + 1; list[0].InitEnd = e; }
                    q = e;
                }
                if (prop && ctorOf is not null && list.Count == 1)
                {
                    var pb = list[0];
                    ctorOf.Inst.TryAdd(pb.Name, new Binding(pb.Name, "property", f, pb.Tok, Cur) { Owner = ctorOf, AnnStart = pb.AnnStart, AnnEnd = pb.AnnEnd });
                }
                if (At(q).Text == ",") q++;
                if (q == before) q++;
            }
            Mark(open, close, fs);
        }

        int Function(int i)
        {
            var isExpr = IsExpressionPosition(i);
            var j = i + 1;
            if (At(j).Text == "*") j++;
            var nameTok = -1;
            if (At(j).Kind == Tk.Ident && !Reserved.Contains(At(j).Text)) nameTok = j++;
            if (At(j).Text == "<") j = SkipAngles(j);
            if (At(j).Text != "(") return j;
            var open = j;
            var close = M(open);
            var fi = new FuncInfo { Open = open, Close = close };
            f.Funcs[i] = fi;
            var k = close + 1;
            if (At(k).Text == ":")
            {
                fi.RetStart = k + 1;
                k = SkipType(k + 1, true);
                fi.RetEnd = k;
                Refs(fi.RetStart, k);
            }
            var hasBody = At(k).Text == "{";
            var fs = new Scope("function", Cur, f) { End = hasBody ? M(k) : close };
            fi.Scope = fs;
            if (nameTok >= 0)
            {
                var b = Declare(isExpr ? fs : Cur, t[nameTok].Text, "function", nameTok);
                b.Func ??= fi;
            }
            if (!isExpr) ResetExport();
            scopes.Add(fs);
            Params(open, close, fs, null);
            Mark(i, k - 1, fs);
            if (hasBody) bodies[k] = fs;
            return k;
        }

        int Class(int i)
        {
            var isExpr = IsExpressionPosition(i);
            var j = i + 1;
            var nameTok = -1;
            if (At(j).Kind == Tk.Ident && At(j).Text is not ("extends" or "implements") && !Reserved.Contains(At(j).Text)) nameTok = j++;
            if (At(j).Text == "<") j = SkipAngles(j);
            var ci = new ClassInfo(nameTok >= 0 ? t[nameTok].Text : "(anonymous class)", f) { Outer = Cur };
            if (At(j).Text == "extends")
            {
                var s = j + 1;
                var e = s;
                while (e < t.Count - 1 && At(e).Text is not ("{" or "implements"))
                {
                    if (At(e).Text == "<") { e = SkipAngles(e); continue; }
                    if (At(e).Text is "(" or "[") e = M(e);
                    e++;
                }
                ci.ExtStart = s; ci.ExtEnd = e;
                Refs(s, e);
                j = e;
            }
            if (At(j).Text == "implements")
            {
                var e = j + 1;
                while (e < t.Count - 1 && At(e).Text != "{") e++;
                Refs(j + 1, e);
                j = e;
            }
            if (nameTok >= 0)
            {
                var b = Declare(Cur, t[nameTok].Text, "class", nameTok);
                b.Class ??= ci;
                ci.Binding = b;
            }
            if (!isExpr) ResetExport();
            f.Classes[i] = ci;
            Mark(i, j, Cur);
            if (At(j).Text == "{") classBodies[j] = ci;
            return j;
        }

        bool IsMemberStart(int i, Ctx top)
        {
            var p = At(i - 1);
            if (i - 1 == top.Index) return true;
            if (p.Kind == Tk.Punct && p.Text is ";" or "}") return true;
            return t[i].Nl && EndsExpr(p);
        }

        static readonly HashSet<string> Modifiers = ["static", "public", "private", "protected", "readonly", "abstract", "override", "declare", "async", "accessor"];

        int ClassMember(int i, ClassInfo ci)
        {
            var j = i;
            bool isStatic = false, accessor = false;
            while (true)
            {
                var x = At(j);
                var nx = At(j + 1);
                var nameFollows = nx.Kind is Tk.Ident or Tk.Str or Tk.Num || nx.Text is "[" or "*";
                if (x.Kind == Tk.Ident && x.Text == "static" && nx.Text == "{") return j + 1;   // static { } block
                if (x.Kind == Tk.Ident && Modifiers.Contains(x.Text) && nameFollows) { isStatic |= x.Text == "static"; j++; continue; }
                if (x.Kind == Tk.Ident && x.Text is "get" or "set" && nameFollows) { accessor = true; j++; continue; }
                if (x.Text == "*") { j++; continue; }
                break;
            }
            var nameTok = At(j);
            string? name = null;
            var nameIdx = j;
            if (nameTok.Kind is Tk.Ident or Tk.Num) { name = nameTok.Text; j++; }
            else if (nameTok.Kind == Tk.Str) { name = Unquote(nameTok.Text); j++; }
            else if (nameTok.Text == "[") { Refs(j + 1, M(j)); j = M(j) + 1; }
            else return j + 1;
            if (At(j).Text is "?" or "!") j++;
            var dict = isStatic ? ci.Static : ci.Inst;
            if (At(j).Text is "(" or "<")
            {
                if (At(j).Text == "<") j = SkipAngles(j);
                var open = j;
                var close = M(open);
                var fi = new FuncInfo { Open = open, Close = close };
                var k = close + 1;
                if (At(k).Text == ":")
                {
                    fi.RetStart = k + 1;
                    k = SkipType(k + 1, true);
                    fi.RetEnd = k;
                    Refs(fi.RetStart, k);
                }
                var hasBody = At(k).Text == "{";
                var fs = new Scope("function", Cur, f) { End = hasBody ? M(k) : close, This = new ClassT(ci, !isStatic) };
                fi.Scope = fs;
                if (name is not null)
                {
                    var kind = name == "constructor" ? "constructor" : accessor ? "property" : "method";
                    var b = Member(ci, dict, name, kind, nameIdx);
                    b.Func ??= fi;
                    b.Static = isStatic;
                }
                scopes.Add(fs);
                Params(open, close, fs, name == "constructor" ? ci : null);
                Mark(i, k - 1, fs);
                if (hasBody) { bodies[k] = fs; return k; }
                return At(k).Text == ";" ? k + 1 : k;
            }
            if (name is not null)
            {
                var b = Member(ci, dict, name, "property", nameIdx);
                b.Static = isStatic;
                if (At(j).Text == ":")
                {
                    var e = SkipType(j + 1, false);
                    b.AnnStart = j + 1; b.AnnEnd = e;
                    Refs(j + 1, e);
                    j = e;
                }
                Mark(i, j, Cur);
                if (At(j).Text == "=") { b.InitStart = j + 1; b.InitEnd = ExprEnd(j + 1) + 1; return j + 1; }
            }
            return j;
        }

        Binding Member(ClassInfo ci, Dictionary<string, Binding> dict, string name, string kind, int tok)
        {
            if (!dict.TryGetValue(name, out var b)) dict[name] = b = new Binding(name, kind, f, tok, Cur) { Owner = ci };
            f.Occs.Add(new(tok, OccKind.Decl, Cur, b));
            return b;
        }

        int ObjectMember(int i, ObjInfo o)
        {
            var j = i;
            while (At(j).Kind == Tk.Ident && At(j).Text is "get" or "set" or "async" && (At(j + 1).Kind is Tk.Ident or Tk.Str or Tk.Num || At(j + 1).Text is "[" or "*") || At(j).Text == "*") j++;
            var x = At(j);
            if (x.Kind is not (Tk.Ident or Tk.Str or Tk.Num))
                return j == i ? (x.Kind == Tk.Punct ? Punct(j) : j + 1) : j;
            var name = x.Kind == Tk.Str ? Unquote(x.Text) : x.Text;
            var nameIdx = j++;
            var nx = At(j);
            if (nx.Text == ":")
            {
                var b = ObjMember(o, name, "property", nameIdx, true);
                b.InitStart = j + 1;
                b.InitEnd = ExprEnd(j + 1) + 1;
                return j + 1;
            }
            if (nx.Text is "(" or "<")
            {
                if (nx.Text == "<") j = SkipAngles(j);
                var open = j;
                var close = M(open);
                var fi = new FuncInfo { Open = open, Close = close };
                var k = close + 1;
                if (At(k).Text == ":") { fi.RetStart = k + 1; k = SkipType(k + 1, true); fi.RetEnd = k; Refs(fi.RetStart, k); }
                var hasBody = At(k).Text == "{";
                var fs = new Scope("function", Cur, f) { End = hasBody ? M(k) : close, This = new ObjT(o) };
                fi.Scope = fs;
                var b = ObjMember(o, name, "method", nameIdx, true);
                b.Func ??= fi;
                scopes.Add(fs);
                Params(open, close, fs, null);
                Mark(i, k - 1, fs);
                if (hasBody) bodies[k] = fs;
                return k;
            }
            if (x.Kind == Tk.Ident && nx.Text is "," or "}" or "=")
            {
                var b = ObjMember(o, name, "property", nameIdx, false);
                b.Shorthand = true;
                f.Occs.Add(new(nameIdx, OccKind.Name, Cur));
                return j;
            }
            if (x.Kind == Tk.Ident && !NotNames.Contains(x.Text)) f.Occs.Add(new(nameIdx, OccKind.Name, Cur));
            return j;
        }

        Binding ObjMember(ObjInfo o, string name, string kind, int tok, bool decl)
        {
            if (!o.Members.TryGetValue(name, out var b)) o.Members[name] = b = new Binding(name, kind, f, tok, Cur) { OwnerObj = o };
            if (decl) f.Occs.Add(new(tok, OccKind.Decl, Cur, b));
            return b;
        }

        int Interface(int i)
        {
            var b = Declare(Cur, t[i + 1].Text, "interface", i + 1);
            var o = b.Obj ??= new ObjInfo(b.Name);
            var j = i + 2;
            if (At(j).Text == "<") j = SkipAngles(j);
            if (At(j).Text == "extends")
            {
                var e = j + 1;
                while (e < t.Count - 1 && At(e).Text != "{") { if (At(e).Text == "<") { e = SkipAngles(e); continue; } e++; }
                o.ExtStart = j + 1; o.ExtEnd = e; o.File = f;
                Refs(j + 1, e);
                j = e;
            }
            ResetExport();
            Mark(i, j, Cur);
            if (At(j).Text != "{") return j;
            TypeMembers(f, j, o, this);
            return M(j) + 1;
        }

        int TypeAlias(int i)
        {
            var b = Declare(Cur, t[i + 1].Text, "type", i + 1);
            var j = i + 2;
            if (At(j).Text == "<") j = SkipAngles(j);
            ResetExport();
            if (At(j).Text != "=") return j;
            var s = j + 1;
            var e = SkipType(s, false);
            b.AnnStart = s; b.AnnEnd = e;
            Mark(i, e, Cur);
            if (At(s).Text == "{" && M(s) == e - 1) { b.Obj = new ObjInfo(b.Name); TypeMembers(f, s, b.Obj, this); }
            else Refs(s, e);
            return e;
        }

        int Enum(int i)
        {
            var b = Declare(Cur, t[i + 1].Text, "enum", i + 1);
            var o = b.Obj ??= new ObjInfo(b.Name) { IsEnum = true };
            ResetExport();
            var j = i + 2;
            if (At(j).Text != "{") return j;
            var close = M(j);
            var q = j + 1;
            while (q < close)
            {
                var before = q;
                var x = At(q);
                if (x.Kind is Tk.Ident or Tk.Str)
                {
                    var name = x.Kind == Tk.Str ? Unquote(x.Text) : x.Text;
                    if (!o.Members.ContainsKey(name)) o.Members[name] = new Binding(name, "enum member", f, q, Cur) { OwnerObj = o };
                    f.Occs.Add(new(q, OccKind.Decl, Cur, o.Members[name]));
                    q++;
                    if (At(q).Text == "=") { var e = SkipExpr(q + 1, close); Refs(q + 1, e); q = e; }
                }
                if (At(q).Text == ",") q++;
                if (q == before) q++;
            }
            Mark(i, close, Cur);
            return close + 1;
        }

        int Catch(int i)
        {
            var open = i + 1;
            var close = M(open);
            var body = close + 1;
            var s = new Scope("block", Cur, f) { End = At(body).Text == "{" ? M(body) : close, This = Cur.This };
            scopes.Add(s);
            var q = open + 1;
            Pattern(ref q, s, "let", [], null);
            if (At(q).Text == ":") Refs(q + 1, SkipType(q + 1, false, close));
            Mark(i, close, s);
            if (At(body).Text == "{") bodies[body] = s;
            return body;
        }

        // ------------------------------------------------------------ modules

        int Import(int i)
        {
            var j = i + 1;
            if (At(j).Text == "type" && (At(j + 1).Text == "{" || At(j + 1).Kind == Tk.Ident && At(j + 2).Text is "from" or ",")) j++;
            var made = new List<Binding>();
            if (At(j).Kind == Tk.Str) { Mark(i, j, Cur); return j + 1; }
            if (At(j).Kind == Tk.Ident && At(j).Text != "from")
            {
                var b = Declare(f.Program, At(j).Text, "import", j);
                b.Imported = "default";
                made.Add(b);
                j++;
                if (At(j).Text == ",") j++;
            }
            else if (At(j).Kind == Tk.Ident && At(j).Text == "from" && At(j + 1).Text == "from")
            {
                var b = Declare(f.Program, "from", "import", j);   // import from from 'x' (silly but legal)
                b.Imported = "default"; made.Add(b); j++;
            }
            if (At(j).Text == "*" && At(j + 1).Text == "as" && At(j + 2).Kind == Tk.Ident)
            {
                var b = Declare(f.Program, At(j + 2).Text, "import", j + 2);
                b.Imported = "*";
                made.Add(b);
                j += 3;
            }
            if (At(j).Text == "{")
            {
                var close = M(j);
                var q = j + 1;
                while (q < close)
                {
                    var before = q;
                    if (At(q).Text == "type" && At(q + 1).Kind is Tk.Ident or Tk.Str && At(q + 1).Text != "as") q++;
                    if (At(q).Kind is Tk.Ident or Tk.Str)
                    {
                        var nameTok = q;
                        var name = At(q).Kind == Tk.Str ? Unquote(At(q).Text) : At(q).Text;
                        q++;
                        var alias = nameTok;
                        if (At(q).Text == "as" && At(q + 1).Kind == Tk.Ident)
                        {
                            var orig = new Binding(name, "import", f, nameTok, f.Program) { Imported = name };
                            made.Add(orig);
                            f.Occs.Add(new(nameTok, OccKind.ImportName, f.Program, orig));
                            alias = q + 1;
                            q += 2;
                        }
                        var b = Declare(f.Program, At(alias).Text, "import", alias);
                        b.Imported = name;
                        made.Add(b);
                    }
                    if (At(q).Text == ",") q++;
                    if (q == before) q++;
                }
                j = close + 1;
            }
            if (At(j).Text == "from" && At(j + 1).Kind == Tk.Str)
            {
                var spec = Unquote(At(j + 1).Text);
                foreach (var b in made) b.Spec ??= spec;
                j += 2;
            }
            Mark(i, j, Cur);
            return j;
        }

        int Export(int i)
        {
            var nx = At(i + 1);
            if (nx.Text == "default")
            {
                var x = At(i + 2);
                if (x.Text is "function" or "class" or "async" or "abstract") { exportNext = true; exportDefault = true; return i + 2; }
                if (x.Kind == Tk.Ident && !Reserved.Contains(x.Text) && (At(i + 3).Text == ";" || At(i + 3).Nl || At(i + 3).Kind == Tk.Eof))
                {
                    f.PendingExports.Add((x.Text, "default"));
                    return i + 2;
                }
                f.Exports.TryAdd("default", new Binding("default", "const", f, -1, f.Program) { InitStart = i + 2, InitEnd = ExprEnd(i + 2) + 1 });
                return i + 2;
            }
            var listAt = nx.Text == "{" ? i + 1 : nx.Text == "type" && At(i + 2).Text == "{" ? i + 2 : -1;
            if (listAt >= 0)
            {
                var close = M(listAt);
                var pairs = new List<(int Tok, string Local, string As)>();
                var q = listAt + 1;
                while (q < close)
                {
                    var before = q;
                    if (At(q).Text == "type" && At(q + 1).Kind == Tk.Ident) q++;
                    if (At(q).Kind is Tk.Ident or Tk.Str)
                    {
                        var local = At(q).Kind == Tk.Str ? Unquote(At(q).Text) : At(q).Text;
                        var tok = q++;
                        var name = local;
                        if (At(q).Text == "as") { name = At(q + 1).Kind == Tk.Str ? Unquote(At(q + 1).Text) : At(q + 1).Text; q += 2; }
                        pairs.Add((tok, local, name));
                    }
                    if (At(q).Text == ",") q++;
                    if (q == before) q++;
                }
                var j = close + 1;
                if (At(j).Text == "from" && At(j + 1).Kind == Tk.Str)
                {
                    var spec = Unquote(At(j + 1).Text);
                    foreach (var (tok, local, name) in pairs)
                    {
                        f.Reexports.Add((spec, local, name));
                        f.Occs.Add(new(tok, OccKind.ImportName, f.Program, new Binding(local, "import", f, tok, f.Program) { Spec = spec, Imported = local }));
                    }
                    j += 2;
                }
                else
                    foreach (var (tok, local, name) in pairs)
                    {
                        f.PendingExports.Add((local, name));
                        f.Occs.Add(new(tok, OccKind.Name, f.Program));
                    }
                Mark(i, j, Cur);
                return j;
            }
            if (nx.Text == "*")
            {
                if (At(i + 2).Text == "as" && At(i + 4).Text == "from")
                {
                    f.Reexports.Add((Unquote(At(i + 5).Text), "*", At(i + 3).Text));
                    return i + 6;
                }
                if (At(i + 2).Text == "from") { f.StarExports.Add(Unquote(At(i + 3).Text)); return i + 4; }
                return i + 2;
            }
            if (nx.Text == "=") return i + 1;
            exportNext = true;
            exportDefault = false;
            return i + 1;
        }

        /// <summary>module.exports = { a, b } and module.exports = name.</summary>
        void CommonJs()
        {
            for (var i = 0; i + 4 < t.Count; i++)
            {
                if (t[i].Text != "module" || t[i + 1].Text != "." || t[i + 2].Text != "exports" || t[i + 3].Text != "=") continue;
                if (f.Objects.TryGetValue(i + 4, out var o))
                    foreach (var (name, b) in o.Members) f.Exports.TryAdd(name, b);
                else if (t[i + 4].Kind == Tk.Ident && f.Program.Names.TryGetValue(t[i + 4].Text, out var d))
                    f.Exports.TryAdd("default", d);
            }
        }
    }

    /// <summary>Members of a TS interface body or type literal: name?: Type; method(a: T): R;</summary>
    static void TypeMembers(JsFile f, int open, ObjInfo o, Parser? recorder)
    {
        var t = f.T;
        var close = f.Match[open] > open ? f.Match[open] : t.Count - 2;
        var q = open + 1;
        while (q < close)
        {
            var before = q;
            while (f.At(q).Text is "readonly" or "public" or "private" or "protected" && f.At(q + 1).Kind is Tk.Ident or Tk.Str) q++;
            var x = f.At(q);
            if (x.Text == "[")
            {
                // index signature [key: string]: T  — skip it
                q = f.Match[q] > q ? f.Match[q] + 1 : q + 1;
            }
            else if (x.Kind is Tk.Ident or Tk.Str or Tk.Num)
            {
                var name = x.Kind == Tk.Str ? Unquote(x.Text) : x.Text;
                var nameIdx = q++;
                if (f.At(q).Text == "?") q++;
                Binding b;
                if (!o.Members.TryGetValue(name, out var existing)) o.Members[name] = b = new Binding(name, "property", f, nameIdx, f.TokScope[nameIdx] ?? f.Program) { OwnerObj = o };
                else b = existing;
                if (recorder is not null) f.Occs.Add(new(nameIdx, OccKind.Decl, f.TokScope[nameIdx] ?? f.Program, b));
                if (f.At(q).Text is "(" or "<")
                {
                    if (f.At(q).Text == "<") while (q < close && f.At(q).Text != "(") q++;
                    var po = q;
                    var pc = f.Match[po] > po ? f.Match[po] : close;
                    b.Kind = "method";
                    b.Func ??= new FuncInfo { Open = po, Close = pc };
                    q = pc + 1;
                    if (f.At(q).Text == ":") { var e = TypeEnd(f, q + 1, close); b.Func.RetStart = q + 1; b.Func.RetEnd = e; q = e; }
                }
                else if (f.At(q).Text == ":")
                {
                    var e = TypeEnd(f, q + 1, close);
                    b.AnnStart = q + 1; b.AnnEnd = e;
                    q = e;
                }
            }
            while (q < close && f.At(q).Text is ";" or ",") q++;
            if (q == before) q++;
        }
    }

    /// <summary>The end of a type inside a type literal (stops at ; , or newline at depth 0).</summary>
    static int TypeEnd(JsFile f, int q, int limit)
    {
        var start = q;
        var angle = 0;
        while (q < limit)
        {
            var x = f.At(q);
            if (x.Kind == Tk.Punct)
            {
                if (x.Text is "(" or "[" or "{") { q = f.Match[q] > q ? f.Match[q] + 1 : q + 1; continue; }
                if (x.Text == "<") angle++;
                else if (x.Text == ">") angle = Math.Max(0, angle - 1);
                else if (angle == 0 && x.Text is ";" or ",") break;
            }
            else if (angle == 0 && q > start && x.Nl && f.At(q - 1).Text is not ("|" or "&" or ":" or "=>")) break;
            q++;
        }
        return q;
    }

    static string Unquote(string s) => s.Length >= 2 && (s[0] is '"' or '\'' or '`') ? s[1..^1] : s;
}
