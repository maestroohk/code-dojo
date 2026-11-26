"""code-dojo Python intelligence: go to definition, references, hover and completion.

Jedi answers when it is installed (see "Jedi, when it is installed" below); otherwise, and whenever Jedi
is too slow or has nothing to say, the analyser in this file does, with the standard library only.

Run by the dojo server (server/PyIntel.cs) as a long-lived process that reads one JSON request per line
on stdin and writes one JSON answer per line on stdout:

  {"action": "complete"|"definition"|"references"|"hover", "files": [{"path", "code"}], "path", "position",
   "engine": "auto"|"basic"|"jedi", "site": "<a code space's site-packages>"|null, "root": "<its folder>"|null}
  -> {"items", "definition", "external", "references", "hover", "engine", "jediMissing"}

The learner's code is only parsed (ast), never executed. Modules that are already installed (the
standard library, numpy, pandas ...) are imported so their real members and signatures can be shown.
"""
import ast
import builtins
import importlib
import importlib.util
import inspect
import json
import keyword
import os
import pkgutil
import re
import sys
import types
import warnings

PROTO = sys.stdout          # the protocol channel; anything else printed (by imported modules) goes to stderr
sys.stdout = sys.stderr
warnings.simplefilter("ignore")
sys.setrecursionlimit(4000)

PH = "__dojo_cc__"          # placeholder identifier inserted at the cursor for completion
BLOCKED = {"antigravity", "this", "__hello__", "__phello__", "idlelib", "turtledemo", "__main__"}
KEYWORDS = sorted(set(keyword.kwlist) | set(getattr(keyword, "softkwlist", [])) - {"_"})


# ---------------------------------------------------------------- source files

class Src:
    def __init__(self, path, code, protect=None):
        self.path = path
        self.code = code.replace("\r\n", "\n")
        self.lines = self.code.split("\n")
        self.starts = []
        n = 0
        for line in self.lines:
            self.starts.append(n)
            n += len(line) + 1
        key = path.replace("\\", "/")
        while key.startswith("./"):
            key = key[2:]
        key = re.sub(r"\.pyw?$", "", key)
        self.is_pkg = key.endswith("/__init__") or key == "__init__"
        if self.is_pkg:
            key = key[: -len("__init__")].rstrip("/")
        self.key = key
        self.modname = key.replace("/", ".") or "__init__"
        self.dir = key if self.is_pkg else (key.rsplit("/", 1)[0] if "/" in key else "")
        self.tree = parse(self.code, protect)

    def lc(self, pos):
        """Character offset -> (1-based line, 0-based column)."""
        pos = max(0, min(pos, len(self.code)))
        lo, hi = 0, len(self.starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.starts[mid] <= pos:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1, pos - self.starts[lo]

    def col(self, line, byte_col):
        """ast columns count UTF-8 bytes; the editor counts characters."""
        if line < 1 or line > len(self.lines):
            return byte_col
        text = self.lines[line - 1]
        if text.isascii():
            return byte_col
        return len(text.encode("utf-8")[:byte_col].decode("utf-8", "ignore"))

    def text(self, line):
        return self.lines[line - 1] if 1 <= line <= len(self.lines) else ""

    def find(self, line, start, name):
        """Column of the identifier `name` on a line, at or after `start`."""
        m = re.compile(r"(?<![\w])" + re.escape(name) + r"(?![\w])").search(self.text(line), max(0, start))
        return m.start() if m else start


def parse(code, protect=None):
    """ast.parse that survives half-typed code: lines with syntax errors are blanked out (kept indented)
    until the rest parses. Returns None when the protected line itself would have to go."""
    lines = code.split("\n")
    for _ in range(25):
        try:
            return ast.parse("\n".join(lines))
        except (SyntaxError, ValueError) as e:
            n = min(max((getattr(e, "lineno", None) or 1) - 1, 0), len(lines) - 1)
            if protect is not None and n == protect - 1:
                return None
            line = lines[n]
            if not line.strip() or line.strip() == "pass":
                # Already blank: the problem is the line before (an unfinished block or bracket).
                k = n - 1
                while k >= 0 and (not lines[k].strip() or lines[k].strip() == "pass"):
                    k -= 1
                if k < 0 or (protect is not None and k == protect - 1):
                    if isinstance(e, IndentationError):
                        lines[n] = ""
                        continue
                    return None if protect is not None else ast.Module(body=[], type_ignores=[])
                n, line = k, lines[k]
            indent = line[: len(line) - len(line.lstrip())]
            nxt = next((l for l in lines[n + 1:] if l.strip()), "")
            deeper = len(nxt) - len(nxt.lstrip()) > len(indent)
            lines[n] = indent + ("if True:" if deeper else "pass")
    return None if protect is not None else ast.Module(body=[], type_ignores=[])


# ---------------------------------------------------------------- symbols

class Scope:
    def __init__(self, kind, node, parent, src, name=""):
        self.kind, self.node, self.parent, self.src, self.name = kind, node, parent, src, name
        self.bindings = {}      # name -> [Binding] in source order
        self.inst = {}          # class scopes: attributes assigned through self.<name> in methods
        self.globals, self.nonlocals = set(), set()
        self.stars = []         # (module, level) of "from m import *"
        self.cls = None         # function scopes directly inside a class: that class
        self.selfname = None
        self.bases = []         # class scopes: base class expressions (evaluated in parent)
        self.binding = None     # the binding that names this scope (def/class)


class Binding:
    def __init__(self, name, kind, src, line, col, scope, value=None, vscope=None, annotation=None, node=None, extra=None):
        self.name, self.kind, self.src, self.line, self.col = name, kind, src, line, col
        self.scope, self.value, self.vscope, self.annotation, self.node, self.extra = scope, value, vscope or scope, annotation, node, extra
        self.body = None        # def/class: the scope it opens


class Occ:
    """One identifier in the code: a use, a declaration, an attribute, a keyword argument ..."""
    __slots__ = ("src", "line", "col", "length", "name", "kind", "scope", "node", "binding")

    def __init__(self, src, line, col, name, kind, scope, node=None, binding=None):
        self.src, self.line, self.col, self.length, self.name = src, line, col, len(name), name
        self.kind, self.scope, self.node, self.binding = kind, scope, node, binding


class Ext:
    """Something that lives outside the learner's files: a builtin, a module, a member of one."""
    __slots__ = ("obj", "owner", "name")

    def __init__(self, obj, owner=None, name=""):
        self.obj, self.owner, self.name = obj, owner, name


class T:
    """An inferred type. k: 'cls' (user class), 'mod' (user module), 'func' (user function), 'ext' (real object)."""
    __slots__ = ("k", "v", "inst", "owner", "name")

    def __init__(self, k, v, inst=False, owner=None, name=""):
        self.k, self.v, self.inst, self.owner, self.name = k, v, inst, owner, name


def pos_of(src, node):
    line = node.lineno
    return line, src.col(line, node.col_offset)


# ---------------------------------------------------------------- building scopes

class Builder:
    def __init__(self, src, analysis):
        self.src, self.an = src, analysis
        self.occ = []

    def build(self):
        tree = self.src.tree or ast.Module(body=[], type_ignores=[])
        self.module = Scope("module", tree, None, self.src, self.src.modname)
        for stmt in tree.body:
            self.visit(stmt, self.module)
        return self.module

    # -- helpers

    def bind(self, scope, name, kind, line, col, **kw):
        target = scope
        if name in scope.globals:
            target = self.module
        elif name in scope.nonlocals:
            s = scope.parent
            while s is not None and (s.kind == "class" or name not in s.bindings) and s.kind != "module":
                s = s.parent
            target = s if s is not None and s.kind != "module" else scope
        b = Binding(name, kind, self.src, line, col, target, **kw)
        target.bindings.setdefault(name, []).append(b)
        return b

    def add(self, line, col, name, kind, scope, node=None, binding=None):
        o = Occ(self.src, line, col, name, kind, scope, node, binding)
        self.occ.append(o)
        return o

    def visit(self, node, s):
        m = getattr(self, "v_" + type(node).__name__, None)
        if m is not None:
            m(node, s)
        else:
            for child in ast.iter_child_nodes(node):
                self.visit(child, s)

    def visit_all(self, nodes, s):
        for n in nodes:
            if n is not None:
                self.visit(n, s)

    @staticmethod
    def declared(body):
        """global / nonlocal names declared directly in a function body."""
        g, nl = set(), set()
        stack = list(body)
        while stack:
            n = stack.pop()
            if isinstance(n, ast.Global):
                g.update(n.names)
            elif isinstance(n, ast.Nonlocal):
                nl.update(n.names)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            stack.extend(ast.iter_child_nodes(n))
        return g, nl

    # -- definitions

    def v_FunctionDef(self, n, s):
        self.visit_all(n.decorator_list, s)
        a = n.args
        self.visit_all(a.defaults + [d for d in a.kw_defaults if d is not None], s)
        for arg in a.posonlyargs + a.args + a.kwonlyargs + [x for x in (a.vararg, a.kwarg) if x]:
            if arg.annotation is not None:
                self.visit(arg.annotation, s)
        if n.returns is not None:
            self.visit(n.returns, s)
        decos = [d.id if isinstance(d, ast.Name) else d.attr if isinstance(d, ast.Attribute) else "" for d in n.decorator_list]
        kind = "function"
        if s.kind == "class":
            kind = "property" if ("property" in decos or any(isinstance(d, ast.Attribute) and d.attr in ("setter", "getter", "deleter") for d in n.decorator_list) or "cached_property" in decos) else "method"
        line = n.lineno
        col = self.src.find(line, self.src.col(line, n.col_offset), n.name)
        b = self.bind(s, n.name, kind, line, col, node=n)
        self.add(line, col, n.name, "decl", s, n, b)
        fs = Scope("function", n, s, self.src, n.name)
        fs.binding = b
        b.body = fs
        fs.globals, fs.nonlocals = self.declared(n.body)
        params = a.posonlyargs + a.args
        if s.kind == "class":
            fs.cls = s
            if "staticmethod" not in decos and params:
                fs.selfname = params[0].arg
                fs.clsmethod = "classmethod" in decos
        defaults = [None] * (len(params) - len(a.defaults)) + list(a.defaults)
        for arg, d in list(zip(params, defaults)) + list(zip(a.kwonlyargs, a.kw_defaults)):
            self.param(arg, fs, d, s)
        for arg, kind in ((a.vararg, "*"), (a.kwarg, "**")):
            if arg:
                self.param(arg, fs, None, s, star=kind)
        for stmt in n.body:
            self.visit(stmt, fs)

    v_AsyncFunctionDef = v_FunctionDef

    def param(self, arg, fs, default, outer, star=None):
        line, col = pos_of(self.src, arg)
        b = self.bind(fs, arg.arg, "parameter", line, col, value=default, vscope=outer, annotation=arg.annotation, node=arg, extra=star)
        self.add(line, col, arg.arg, "decl", fs, arg, b)

    def v_Lambda(self, n, s):
        a = n.args
        self.visit_all(a.defaults + [d for d in a.kw_defaults if d is not None], s)
        ls = Scope("lambda", n, s, self.src, "<lambda>")
        for arg in a.posonlyargs + a.args + a.kwonlyargs + [x for x in (a.vararg, a.kwarg) if x]:
            self.param(arg, ls, None, s)
        self.visit(n.body, ls)

    def v_ClassDef(self, n, s):
        self.visit_all(n.decorator_list + n.bases + [k.value for k in n.keywords], s)
        line = n.lineno
        col = self.src.find(line, self.src.col(line, n.col_offset), n.name)
        b = self.bind(s, n.name, "class", line, col, node=n)
        self.add(line, col, n.name, "decl", s, n, b)
        cs = Scope("class", n, s, self.src, n.name)
        cs.binding = b
        cs.bases = list(n.bases)
        b.body = cs
        for stmt in n.body:
            self.visit(stmt, cs)

    def comp(self, n, s, elts):
        cs = Scope("comp", n, s, self.src, "<comprehension>")
        for i, g in enumerate(n.generators):
            self.visit(g.iter, s if i == 0 else cs)
            self.target(g.target, cs, ("iter", g.iter), s if i == 0 else cs)
            self.visit_all(g.ifs, cs)
        self.visit_all(elts, cs)

    def v_ListComp(self, n, s): self.comp(n, s, [n.elt])
    def v_SetComp(self, n, s): self.comp(n, s, [n.elt])
    def v_GeneratorExp(self, n, s): self.comp(n, s, [n.elt])
    def v_DictComp(self, n, s): self.comp(n, s, [n.key, n.value])

    # -- bindings

    def target(self, t, s, value, vscope=None, annotation=None):
        if isinstance(t, ast.Name):
            line, col = pos_of(self.src, t)
            b = self.bind(s, t.id, "variable", line, col, value=value, vscope=vscope or s, annotation=annotation, node=t)
            self.add(line, col, t.id, "name", s, t)
            return b
        if isinstance(t, (ast.Tuple, ast.List)):
            vals = None
            if isinstance(value, (ast.Tuple, ast.List)) and len(value.elts) == len(t.elts) and not any(isinstance(e, ast.Starred) for e in t.elts):
                vals = value.elts
            for i, e in enumerate(t.elts):
                self.target(e, s, vals[i] if vals else ("item", value, i) if value is not None and not isinstance(value, tuple) else None, vscope)
            return None
        if isinstance(t, ast.Starred):
            return self.target(t.value, s, ("list",), vscope)
        if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name):
            fs = s
            while fs is not None and fs.kind in ("comp", "lambda"):
                fs = fs.parent
            if fs is not None and fs.kind == "function" and fs.cls is not None and t.value.id == fs.selfname:
                line = t.end_lineno
                col = self.src.col(line, t.end_col_offset) - len(t.attr)
                b = Binding(t.attr, "attribute", self.src, line, col, fs.cls, value=value, vscope=vscope or s, annotation=annotation, node=t)
                fs.cls.inst.setdefault(t.attr, []).append(b)
        self.visit(t, s)
        return None

    def v_Assign(self, n, s):
        self.visit(n.value, s)
        for t in n.targets:
            self.target(t, s, n.value)

    def v_AnnAssign(self, n, s):
        self.visit(n.annotation, s)
        if n.value is not None:
            self.visit(n.value, s)
        self.target(n.target, s, n.value, annotation=n.annotation)

    def v_AugAssign(self, n, s):
        self.visit(n.value, s)
        t = n.target
        if isinstance(t, ast.Name) and not self.resolvable_local(s, t.id):
            self.target(t, s, None)
        else:
            self.visit(t, s)

    @staticmethod
    def resolvable_local(s, name):
        return name in s.bindings or name in s.globals or name in s.nonlocals

    def v_NamedExpr(self, n, s):
        self.visit(n.value, s)
        ts = s
        while ts.kind == "comp":
            ts = ts.parent
        self.target(n.target, ts, n.value, s)

    def v_For(self, n, s):
        self.visit(n.iter, s)
        self.target(n.target, s, ("iter", n.iter))
        self.visit_all(n.body + n.orelse, s)

    v_AsyncFor = v_For

    def v_With(self, n, s):
        for item in n.items:
            self.visit(item.context_expr, s)
            if item.optional_vars is not None:
                self.target(item.optional_vars, s, ("with", item.context_expr))
        self.visit_all(n.body, s)

    v_AsyncWith = v_With

    def v_ExceptHandler(self, n, s):
        if n.type is not None:
            self.visit(n.type, s)
        if n.name:
            line = n.lineno
            m = re.search(r"\bas\s+(" + re.escape(n.name) + r")\b", self.src.text(line))
            col = m.start(1) if m else self.src.col(line, n.col_offset)
            b = self.bind(s, n.name, "variable", line, col, value=("exc", n.type), node=n)
            self.add(line, col, n.name, "decl", s, n, b)
        self.visit_all(n.body, s)

    def v_Import(self, n, s):
        for a in n.names:
            line, col = pos_of(self.src, a) if hasattr(a, "lineno") else pos_of(self.src, n)
            if a.asname:
                ccol = self.src.find(line, col, a.name.split(".")[0])
                self.add(line, ccol, a.name.split(".")[0], "module", s, a, Binding(a.name, "import", self.src, line, ccol, s, extra=a.name))
                acol = self.src.find(line, col + len(a.name), a.asname)
                b = self.bind(s, a.asname, "import", line, acol, node=a, extra=a.name)
                self.add(line, acol, a.asname, "decl", s, a, b)
            else:
                top = a.name.split(".")[0]
                col = self.src.find(line, col, top)
                b = self.bind(s, top, "import", line, col, node=a, extra=top)
                self.add(line, col, top, "decl", s, a, b)

    def v_ImportFrom(self, n, s):
        mod = n.module or ""
        line, col = pos_of(self.src, n)
        if mod:
            mline = line
            m = re.search(r"\bfrom\s+\.*(" + re.escape(mod) + r")", self.src.text(line))
            if m:
                self.add(mline, m.start(1), mod.split(".")[0], "module", s, n, Binding(mod, "import", self.src, mline, m.start(1), s, extra=("from", mod, n.level)))
        for a in n.names:
            if a.name == "*":
                s.stars.append((mod, n.level))
                continue
            aline, acol = pos_of(self.src, a) if hasattr(a, "lineno") else (line, col)
            ncol = self.src.find(aline, acol, a.name)
            extra = (mod, n.level, a.name)
            if a.asname:
                self.add(aline, ncol, a.name, "importname", s, a, Binding(a.name, "importfrom", self.src, aline, ncol, s, extra=extra))
                bcol = self.src.find(aline, ncol + len(a.name), a.asname)
                b = self.bind(s, a.asname, "importfrom", aline, bcol, node=a, extra=extra)
            else:
                bcol = ncol
                b = self.bind(s, a.name, "importfrom", aline, bcol, node=a, extra=extra)
            self.add(aline, bcol, b.name, "decl", s, a, b)

    def v_Global(self, n, s):
        self.names_stmt(n, s)

    v_Nonlocal = v_Global

    def names_stmt(self, n, s):
        line = n.lineno
        start = self.src.col(line, n.col_offset)
        for name in n.names:
            col = self.src.find(line, start + 6, name)
            self.add(line, col, name, "name", s, n)
            start = col + len(name)

    def v_MatchAs(self, n, s):
        if n.pattern is not None:
            self.visit(n.pattern, s)
        if n.name:
            line = n.end_lineno
            col = self.src.col(line, n.end_col_offset) - len(n.name)
            b = self.bind(s, n.name, "variable", line, col, node=n)
            self.add(line, col, n.name, "decl", s, n, b)

    def v_MatchStar(self, n, s):
        if n.name:
            line = n.end_lineno
            col = self.src.col(line, n.end_col_offset) - len(n.name)
            b = self.bind(s, n.name, "variable", line, col, value=("list",), node=n)
            self.add(line, col, n.name, "decl", s, n, b)

    def v_MatchMapping(self, n, s):
        self.visit_all(n.keys + n.patterns, s)
        if n.rest:
            line = n.end_lineno
            col = self.src.find(line, 0, n.rest)
            b = self.bind(s, n.rest, "variable", line, col, node=n)
            self.add(line, col, n.rest, "decl", s, n, b)

    # -- uses

    def v_Name(self, n, s):
        line, col = pos_of(self.src, n)
        self.add(line, col, n.id, "name", s, n)

    def v_Attribute(self, n, s):
        self.visit(n.value, s)
        line = n.end_lineno
        col = self.src.col(line, n.end_col_offset) - len(n.attr)
        self.add(line, col, n.attr, "attr", s, n)

    def v_Call(self, n, s):
        self.visit(n.func, s)
        self.visit_all(n.args, s)
        for k in n.keywords:
            if k.arg and hasattr(k, "lineno"):
                line, col = pos_of(self.src, k)
                self.add(line, col, k.arg, "kw", s, n)
            self.visit(k.value, s)


# ---------------------------------------------------------------- the analysis of a set of files

STR_RET = {"capitalize", "casefold", "center", "expandtabs", "format", "format_map", "join", "ljust", "lower", "lstrip", "removeprefix",
           "removesuffix", "replace", "rjust", "rstrip", "strip", "swapcase", "title", "translate", "upper", "zfill"}
METHOD_RET = {
    str: dict({m: str for m in STR_RET}, split=list, rsplit=list, splitlines=list, partition=tuple, rpartition=tuple, encode=bytes,
              count=int, find=int, index=int, rfind=int, rindex=int, startswith=bool, endswith=bool, isdigit=bool, isalpha=bool,
              isalnum=bool, isspace=bool, isupper=bool, islower=bool, isnumeric=bool, isdecimal=bool, istitle=bool, isidentifier=bool),
    list: {"copy": list, "count": int, "index": int},
    tuple: {"count": int, "index": int},
    dict: {"copy": dict, "keys": type({}.keys()), "values": type({}.values()), "items": type({}.items()), "fromkeys": dict},
    set: {m: set for m in ("union", "intersection", "difference", "symmetric_difference", "copy")} | {"issubset": bool, "issuperset": bool, "isdisjoint": bool},
    bytes: {"decode": str, "hex": str},
    int: {"bit_length": int, "to_bytes": bytes},
    float: {"is_integer": bool, "hex": str},
}
BUILTIN_RET = {"len": int, "input": str, "repr": str, "sorted": list, "round": int, "ord": int, "chr": str, "hex": str, "bin": str,
               "oct": str, "isinstance": bool, "issubclass": bool, "callable": bool, "format": str, "id": int, "hash": int, "ascii": str,
               "any": bool, "all": bool, "dir": list, "vars": dict, "globals": dict, "locals": dict}
NUMPY_ARRAYS = {"array", "asarray", "arange", "zeros", "ones", "empty", "full", "linspace", "logspace", "eye", "identity", "zeros_like",
                "ones_like", "full_like", "empty_like", "concatenate", "stack", "vstack", "hstack", "where", "sort", "unique", "cumsum",
                "reshape", "transpose", "dot", "matmul", "sqrt", "exp", "log", "abs", "sin", "cos", "clip", "diff", "tile", "repeat"}
CLASS_CTORS = {"now", "today", "utcnow", "fromtimestamp", "fromisoformat", "strptime", "fromordinal", "combine"}


class Analysis:
    def __init__(self, files, override=None, protect=None):
        self.srcs = []
        for f in files:
            path, code = f.get("path") or "main.py", f.get("code") or ""
            if override and path == override[0]:
                code = override[1]
                src = Src(path, code, protect)
                if src.tree is None:
                    raise Unparsable()
            else:
                src = Src(path, code)
            self.srcs.append(src)
        self.by_key = {}
        for s in self.srcs:
            self.by_key.setdefault(s.key, s)
        self.mods, self.occ = {}, {}
        for s in self.srcs:
            b = Builder(s, self)
            s.scope = b.build()
            self.occ[s] = b.occ
        self.memo, self.busy = {}, set()

    def src(self, path):
        return next((s for s in self.srcs if s.path == path), None)

    # -- modules

    def user_module(self, name, level=0, importer=None):
        path = name.replace(".", "/")
        cands = []
        if level and importer is not None:
            base = importer.dir.split("/") if importer.dir else []
            if level > 1:
                base = base[: len(base) - (level - 1)] if level - 1 <= len(base) else []
            cands.append("/".join(base + ([path] if path else [])))
        else:
            if importer is not None and importer.dir:
                cands.append(importer.dir + "/" + path)
            cands.append(path)
        for c in cands:
            if c in self.by_key:
                return self.by_key[c]
        if not level and path:
            for s in self.srcs:
                if s.key.endswith("/" + path):
                    return s
        return None

    def ext_module(self, name):
        if not name or name.split(".")[0] in BLOCKED or any(s.key.split("/")[-1] == name.split(".")[0] for s in self.srcs):
            return None
        if name in sys.modules:
            return sys.modules[name]
        try:
            if importlib.util.find_spec(name) is None:
                return None
            return importlib.import_module(name)
        except BaseException:
            return None

    def module_target(self, b):
        """The module an import binding names: a user Src, an Ext(module) or None."""
        e = b.extra
        if isinstance(e, tuple) and e[0] == "from":
            _, mod, level = e
            u = self.user_module(mod, level, b.src)
            if u is not None or level:
                return u
            m = self.ext_module(mod)
            return Ext(m, None, mod) if m else None
        name = e
        top = name.split(".")[0] if b.kind == "import" and b.name == name.split(".")[0] else name
        u = self.user_module(top, 0, b.src)
        if u is not None:
            return u
        m = self.ext_module(top)
        if m is None:
            return None
        return Ext(m, None, top)

    def follow(self, b, depth=0):
        """Imports resolve to what they import; everything else is itself."""
        if not isinstance(b, Binding) or depth > 8:
            return b
        if b.kind == "import":
            return self.module_target(b) or b
        if b.kind == "importfrom":
            mod, level, name = b.extra
            u = self.user_module(mod, level, b.src) if (mod or level) else None
            if u is None and level and not mod:
                u2 = self.user_module(name, level, b.src)
                if u2 is not None:
                    return u2
            if u is not None:
                t = self.module_member(u, name)
                if t is None and u.is_pkg:
                    sub = self.user_module((u.modname + "." + name) if u.modname != "__init__" else name)
                    if sub is not None:
                        return sub
                return self.follow(t, depth + 1) if t is not None else b
            if level:
                return b
            m = self.ext_module(mod)
            if m is None:
                return b
            if hasattr(m, name):
                try:
                    return Ext(getattr(m, name), m, name)
                except BaseException:
                    return b
            sm = self.ext_module(mod + "." + name)
            return Ext(sm, m, name) if sm else b
        return b

    def module_member(self, src, name):
        bs = src.scope.bindings.get(name)
        if bs:
            return bs[0]
        for mod, level in src.scope.stars:
            t = self.star_member(src, mod, level, name)
            if t is not None:
                return t
        return None

    def star_member(self, src, mod, level, name):
        u = self.user_module(mod, level, src)
        if u is not None:
            return self.module_member(u, name) if not name.startswith("_") else None
        m = self.ext_module(mod) if not level else None
        if m is not None and not name.startswith("_") and hasattr(m, name):
            try:
                return Ext(getattr(m, name), m, name)
            except BaseException:
                return None
        return None

    # -- names

    def lookup(self, scope, name):
        s = scope
        if name in s.globals:
            s = self.module_of(s)
            return self.module_member(s.src, name) or self.builtin(name)
        if name in s.nonlocals:
            s = s.parent
        first = True
        while s is not None:
            if (first or s.kind != "class") and name in s.bindings:
                return s.bindings[name][0]
            if s.kind == "module":
                for mod, level in s.stars:
                    t = self.star_member(s.src, mod, level, name)
                    if t is not None:
                        return t
            first = False
            s = s.parent
        return self.builtin(name)

    @staticmethod
    def module_of(s):
        while s.parent is not None:
            s = s.parent
        return s

    @staticmethod
    def builtin(name):
        if hasattr(builtins, name):
            return Ext(getattr(builtins, name), builtins, name)
        return None

    # -- members

    def class_member(self, cs, name, seen=None):
        seen = seen or set()
        if id(cs) in seen:
            return None
        seen.add(id(cs))
        if name in cs.bindings:
            return cs.bindings[name][0]
        if name in cs.inst:
            return cs.inst[name][0]
        for base in cs.bases:
            t = self.infer(base, cs.parent)
            if t is None:
                continue
            if t.k == "cls":
                r = self.class_member(t.v, name, seen)
                if r is not None:
                    return r
            elif t.k == "ext" and isinstance(t.v, type):
                m = static(t.v, name)
                if m is not None:
                    return Ext(m, t.v, name)
        if not cs.bases:
            m = static(object, name)
            if m is not None:
                return Ext(m, object, name)
        return None

    def member(self, t, name):
        if t is None:
            return None
        if t.k == "cls":
            return self.class_member(t.v, name)
        if t.k == "mod":
            r = self.module_member(t.v, name)
            if r is None and t.v.is_pkg:
                r = self.user_module(t.v.key.replace("/", ".") + "." + name if t.v.key else name)
            return r
        if t.k == "ext":
            o = t.v
            if t.inst:
                m = static(o, name)
                return Ext(m, o, name) if m is not None else None
            if inspect.ismodule(o):
                if hasattr(o, name):
                    try:
                        return Ext(getattr(o, name), o, name)
                    except BaseException:
                        return None
                sm = self.ext_module(o.__name__ + "." + name)
                return Ext(sm, o, name) if sm else None
            if isinstance(o, type):
                m = static(o, name)
                return Ext(m, o, name) if m is not None else None
            m = static(type(o), name)
            return Ext(m, type(o), name) if m is not None else None
        if t.k == "func":
            m = static(types.FunctionType, name)
            return Ext(m, types.FunctionType, name) if m is not None else None
        return None

    # -- types

    def infer(self, node, scope):
        if node is None:
            return None
        key = (id(node), id(scope))
        if key in self.memo:
            return self.memo[key]
        if key in self.busy or len(self.busy) > 60:
            return None
        self.busy.add(key)
        try:
            t = self._infer(node, scope)
        except RecursionError:
            t = None
        finally:
            self.busy.discard(key)
        self.memo[key] = t
        return t

    def _infer(self, n, s):
        if isinstance(n, ast.Constant):
            return None if n.value is None or n.value is Ellipsis else T("ext", type(n.value), True)
        if isinstance(n, ast.JoinedStr):
            return T("ext", str, True)
        if isinstance(n, (ast.List, ast.ListComp)):
            return T("ext", list, True)
        if isinstance(n, (ast.Dict, ast.DictComp)):
            return T("ext", dict, True)
        if isinstance(n, (ast.Set, ast.SetComp)):
            return T("ext", set, True)
        if isinstance(n, ast.Tuple):
            return T("ext", tuple, True)
        if isinstance(n, ast.GeneratorExp):
            return T("ext", types.GeneratorType, True)
        if isinstance(n, ast.Lambda):
            return T("ext", types.FunctionType, True)
        if isinstance(n, ast.Compare):
            return T("ext", bool, True)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not):
            return T("ext", bool, True)
        if isinstance(n, ast.Name):
            return self.type_of(self.lookup(s, n.id))
        if isinstance(n, ast.Attribute):
            return self.type_of(self.member(self.infer(n.value, s), n.attr))
        if isinstance(n, ast.Call):
            return self.infer_call(n, s)
        if isinstance(n, ast.BinOp):
            left, right = self.infer(n.left, s), self.infer(n.right, s)
            if isinstance(n.op, ast.Mod) and left is not None and left.k == "ext" and left.v is str:
                return left
            if left is not None and right is not None and left.k == right.k == "ext" and left.v is right.v and left.inst:
                return left if not isinstance(n.op, ast.Div) or left.v is not int else T("ext", float, True)
            if left is not None and right is not None and left.k == right.k == "ext" and {left.v, right.v} == {int, float}:
                return T("ext", float, True)
            if left is not None and left.k == "ext" and left.inst and left.v.__module__.split(".")[0] in ("numpy", "pandas"):
                return left
            return None
        if isinstance(n, ast.IfExp):
            return self.infer(n.body, s) or self.infer(n.orelse, s)
        if isinstance(n, ast.Await):
            return None
        if isinstance(n, ast.NamedExpr):
            return self.infer(n.value, s)
        if isinstance(n, ast.Subscript):
            base = self.infer(n.value, s)
            if base is not None and base.k == "ext" and base.inst and base.v in (str, list, tuple) and isinstance(n.slice, ast.Slice):
                return base
            if base is not None and base.k == "ext" and base.inst and base.v is str:
                return base
            return None
        return None

    def infer_call(self, n, s):
        f = self.infer(n.func, s)
        if f is None:
            return None
        if f.k == "cls":
            return T("cls", f.v, True) if not f.inst else None
        if f.k == "func":
            return self.returns(f.v)
        if f.k == "ext" and not f.inst:
            o = f.v
            if isinstance(o, type):
                return T("ext", o, True)
            return self.ext_returns(o, f.owner, f.name)
        return None

    def returns(self, b):
        node = b.node
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or b.body is None:
            return None
        if node.returns is not None:
            return self.annotation(node.returns, b.scope)
        stack = list(node.body)
        while stack:
            x = stack.pop(0)
            if isinstance(x, ast.Return) and x.value is not None:
                t = self.infer(x.value, b.body)
                if t is not None:
                    return t
            if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            stack.extend(c for c in ast.iter_child_nodes(x) if isinstance(c, ast.stmt) or isinstance(c, ast.excepthandler))
        return None

    def ext_returns(self, o, owner, name):
        if owner is builtins and name in BUILTIN_RET:
            return T("ext", BUILTIN_RET[name], True)
        if owner is builtins and name == "open":
            import io
            return T("ext", io.TextIOWrapper, True)
        if isinstance(owner, type) and owner in METHOD_RET and name in METHOD_RET[owner]:
            return T("ext", METHOD_RET[owner][name], True)
        top = (getattr(o, "__module__", None) or getattr(owner, "__name__", "") or "").split(".")[0]
        if top == "numpy" and name in NUMPY_ARRAYS:
            np = sys.modules.get("numpy")
            if np is not None:
                return T("ext", np.ndarray, True)
        if isinstance(owner, type) and name in CLASS_CTORS:
            return T("ext", owner, True)
        try:
            ann = inspect.signature(o).return_annotation
        except BaseException:
            return None
        if ann is inspect.Signature.empty or ann is None:
            return None
        if isinstance(ann, type):
            return T("ext", ann, True)
        if isinstance(ann, str):
            m = re.match(r"\s*([A-Za-z_][\w.]*)", ann)
            if not m:
                return None
            word = m.group(1).split(".")[-1]
            if word in ("Self",) and isinstance(owner, type):
                return T("ext", owner, True)
            g = getattr(o, "__globals__", {}) or {}
            cand = g.get(word)
            if cand is None:
                pkg = sys.modules.get(top)
                cand = getattr(pkg, word, None) if pkg is not None else None
            if cand is None and hasattr(builtins, word):
                cand = getattr(builtins, word)
            if isinstance(cand, type):
                return T("ext", cand, True)
        return None

    def annotation(self, a, scope):
        if a is None:
            return None
        if isinstance(a, ast.Constant) and isinstance(a.value, str):
            try:
                a = ast.parse(a.value, mode="eval").body
            except SyntaxError:
                return None
        if isinstance(a, ast.Subscript):
            base = self.infer(a.value, scope)
            if base is not None and base.k == "ext" and getattr(base.v, "__name__", "") in ("Optional", "Annotated", "ClassVar", "Final"):
                inner = a.slice.elts[0] if isinstance(a.slice, ast.Tuple) else a.slice
                return self.annotation(inner, scope)
            if base is not None and base.k == "ext" and getattr(base.v, "_name", "") in ("List", "Dict", "Set", "Tuple"):
                return T("ext", {"List": list, "Dict": dict, "Set": set, "Tuple": tuple}[base.v._name], True)
            return self.as_instance(base)
        if isinstance(a, ast.BinOp) and isinstance(a.op, ast.BitOr):
            return self.annotation(a.left, scope) or self.annotation(a.right, scope)
        if isinstance(a, ast.Constant) and a.value is None:
            return None
        return self.as_instance(self.infer(a, scope))

    @staticmethod
    def as_instance(t):
        if t is None:
            return None
        if t.k == "cls" and not t.inst:
            return T("cls", t.v, True)
        if t.k == "ext" and not t.inst and isinstance(t.v, type):
            return T("ext", t.v, True)
        return None

    def type_of(self, target):
        target = self.follow(target)
        if target is None:
            return None
        if isinstance(target, Src):
            return T("mod", target)
        if isinstance(target, Ext):
            o = target.obj
            if inspect.ismodule(o) or isinstance(o, type):
                return T("ext", o, False)
            if callable(o) or isinstance(o, (staticmethod, classmethod)) or inspect.ismethoddescriptor(o):
                return T("ext", o, False, target.owner, target.name)
            if isinstance(o, property):
                return self.ext_returns(o.fget, target.owner, target.name) if o.fget else None
            if inspect.isgetsetdescriptor(o) or inspect.ismemberdescriptor(o):
                return None
            return T("ext", type(o), True)
        b = target
        if b.kind in ("function", "method"):
            return T("func", b)
        if b.kind == "property":
            return self.returns(b)
        if b.kind == "class":
            return T("cls", b.body, False)
        if b.kind == "parameter":
            if b.annotation is not None:
                t = self.annotation(b.annotation, b.vscope)
                if t is not None:
                    return t
            fs = b.scope
            if fs.kind == "function" and fs.cls is not None and fs.selfname == b.name:
                return T("cls", fs.cls, not getattr(fs, "clsmethod", False))
            if b.extra == "*":
                return T("ext", tuple, True)
            if b.extra == "**":
                return T("ext", dict, True)
            return self.infer(b.value, b.vscope) if isinstance(b.value, ast.AST) else None
        if b.kind in ("variable", "attribute"):
            for x in (b.scope.bindings.get(b.name, []) if b.kind == "variable" else b.scope.inst.get(b.name, [])) or [b]:
                if x.annotation is not None:
                    t = self.annotation(x.annotation, x.vscope)
                    if t is not None:
                        return t
            if b.kind == "attribute" and b.name in b.scope.bindings:
                return self.type_of(b.scope.bindings[b.name][0])
            for x in (b.scope.bindings.get(b.name, []) if b.kind == "variable" else b.scope.inst.get(b.name, [])) or [b]:
                t = self.value_type(x)
                if t is not None:
                    return t
        return None

    def value_type(self, b):
        v = b.value
        if v is None:
            return None
        if isinstance(v, ast.AST):
            return self.infer(v, b.vscope)
        if v[0] == "list":
            return T("ext", list, True)
        if v[0] == "iter":
            return self.element(v[1], b.vscope)
        if v[0] == "with":
            t = self.infer(v[1], b.vscope)
            if t is not None and t.k == "ext" and t.inst and getattr(t.v, "__module__", "") in ("_io", "io"):
                return t
            if t is not None and t.k == "cls" and t.inst:
                enter = self.class_member(t.v, "__enter__")
                if isinstance(enter, Binding):
                    return self.returns(enter) or t
            return t
        if v[0] == "exc":
            t = self.infer(v[1], b.vscope) if v[1] is not None and not isinstance(v[1], ast.Tuple) else None
            return self.as_instance(t) if t is not None else T("ext", Exception, True)
        if v[0] == "item":
            t = self.infer(v[1], b.vscope)
            if t is not None and t.k == "ext" and t.inst and t.v is str:
                return t
        return None

    def element(self, it, scope):
        """The type of the items of an iterable, where it is obvious."""
        if isinstance(it, (ast.List, ast.Tuple, ast.Set)) and it.elts:
            return self.infer(it.elts[0], scope)
        if isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "range":
            return T("ext", int, True)
        t = self.infer(it, scope)
        if t is not None and t.k == "ext" and t.inst:
            if t.v is str:
                return t
            if getattr(t.v, "__module__", "") in ("_io", "io"):
                return T("ext", str, True)
        if isinstance(it, ast.Name):
            b = self.lookup(scope, it.id)
            if isinstance(b, Binding) and b.kind == "variable" and isinstance(b.value, (ast.List, ast.Tuple, ast.Set)) and b.value.elts:
                return self.infer(b.value.elts[0], b.vscope)
        return None

    # -- occurrences

    def occ_at(self, src, pos):
        line, col = src.lc(pos)
        best = None
        for o in self.occ.get(src, []):
            if o.line == line and o.col <= col <= o.col + o.length:
                if best is None or (o.col <= col < o.col + o.length and not (best.col <= col < best.col + best.length)):
                    best = o
        return best

    def resolve(self, o):
        """What an occurrence refers to: a Binding, a Src (module), an Ext, or None."""
        if o.binding is not None:
            return o.binding
        if o.kind == "name":
            return self.lookup(o.scope, o.name)
        if o.kind == "attr":
            return self.member(self.infer(o.node.value, o.scope), o.name)
        if o.kind == "kw":
            f = self.infer(o.node.func, o.scope)
            if f is not None and f.k == "cls" and not f.inst:
                init = self.class_member(f.v, "__init__")
                if isinstance(init, Binding) and init.body is not None:
                    return init.body.bindings.get(o.name, [None])[0]
                fields = self.class_member(f.v, o.name)
                return fields if isinstance(fields, Binding) else None
            if f is not None and f.k == "func" and f.v.body is not None:
                return f.v.body.bindings.get(o.name, [None])[0]
            return None
        return None

    def canonical(self, target):
        t = self.follow(target)
        if isinstance(t, Binding):
            if t.kind == "attribute":
                return ("b", id(t.scope), t.name)
            if t.scope.kind == "class":
                return ("b", id(t.scope), t.name)
            return ("b", id(t.scope), t.name)
        if isinstance(t, Src):
            return ("m", t.key)
        if isinstance(t, Ext):
            try:
                return ("e", id(t.obj))
            except BaseException:
                return None
        return None


class Unparsable(Exception):
    pass


def static(t, name):
    try:
        m = inspect.getattr_static(t, name)
    except BaseException:
        return None
    if isinstance(m, (staticmethod, classmethod)):
        m = m.__func__
    return m


# ---------------------------------------------------------------- describing things

def first_line(doc):
    if not doc:
        return ""
    for line in inspect.cleandoc(doc).split("\n"):
        if line.strip():
            return line.strip()[:200]
    return ""


def signature(o):
    try:
        return str(inspect.signature(o))
    except BaseException:
        return None


def qualify(t):
    mod = getattr(t, "__module__", "") or ""
    name = getattr(t, "__qualname__", None) or getattr(t, "__name__", "?")
    if mod in ("builtins", "") or mod.startswith("_"):
        return name
    return mod.split(".")[0] + "." + name


def type_name(t):
    if t is None:
        return None
    if t.k == "cls":
        return t.v.name if t.inst else "type[" + t.v.name + "]"
    if t.k == "mod":
        return "module"
    if t.k == "func":
        return "function"
    o = t.v
    if t.inst:
        return qualify(o)
    if inspect.ismodule(o):
        return "module"
    if isinstance(o, type):
        return "type[" + qualify(o) + "]"
    return "function"


def ext_kind(o, in_module):
    if inspect.ismodule(o):
        return "module"
    if isinstance(o, type):
        return "class"
    if isinstance(o, (property, types.GetSetDescriptorType, types.MemberDescriptorType)) or type(o).__name__ in ("cached_property", "getset_descriptor"):
        return "property"
    if callable(o) or inspect.ismethoddescriptor(o):
        return "function" if in_module else "method"
    return "variable"


def ext_detail(name, o, in_module):
    kind = ext_kind(o, in_module)
    if kind == "module":
        return "module " + getattr(o, "__name__", name)
    if kind == "class":
        sig = signature(o)
        return "class " + name + (sig if sig and sig != "(*args, **kwargs)" else "")
    if kind in ("function", "method"):
        sig = signature(o)
        if sig:
            return name + sig
        doc = first_line(getattr(o, "__doc__", None))
        at = doc.find(name + "(")           # "S.count(sub[, start[, end]]) -> int"
        return doc[at:] if at >= 0 else name + "(...)"
    if kind == "property":
        return name
    return name + ": " + qualify(type(o))


def describe_ext(e, name=None):
    o = e.obj
    name = name or e.name or getattr(o, "__name__", "?")
    owner = e.owner
    in_module = owner is None or inspect.ismodule(owner)
    kind = ext_kind(o, in_module)
    if kind == "module":
        head = "(module) " + getattr(o, "__name__", name)
    else:
        prefix = ""
        if inspect.ismodule(owner) and owner is not builtins:
            prefix = owner.__name__ + "."
        elif isinstance(owner, type) and owner is not object:
            prefix = qualify(owner) + "."
        head = "(" + kind + ") " + prefix + ext_detail(name, o, in_module)
    doc = "" if kind == "variable" else first_line(getattr(o, "__doc__", None))
    return head + ("\n" + doc if doc else "")


def where_ext(e):
    o = e.obj
    if inspect.ismodule(o):
        return o.__name__
    mod = getattr(o, "__module__", None) or (e.owner.__name__ if inspect.ismodule(e.owner) else getattr(e.owner, "__module__", None))
    return mod or "a library"


def user_detail(an, b):
    n = b.node
    if b.kind in ("function", "method", "property") and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = ast.unparse(n.args)
        ret = " -> " + ast.unparse(n.returns) if n.returns is not None else ""
        if not ret:
            t = an.returns(b)
            if t is not None:
                ret = " -> " + type_name(t)
        return ("async def " if isinstance(n, ast.AsyncFunctionDef) else "def ") + n.name + "(" + args + ")" + ret
    if b.kind == "class" and isinstance(n, ast.ClassDef):
        bases = ", ".join(ast.unparse(x) for x in n.bases)
        return "class " + n.name + ("(" + bases + ")" if bases else "")
    if b.kind == "import":
        return "import " + str(b.extra if isinstance(b.extra, str) else b.extra[1]) + ("" if b.name == b.extra else " as " + b.name)
    if b.kind == "importfrom":
        return "from " + "." * b.extra[1] + b.extra[0] + " import " + b.extra[2] + ("" if b.name == b.extra[2] else " as " + b.name)
    t = an.type_of(b)
    tn = type_name(t)
    if b.kind == "parameter" and b.annotation is not None:
        tn = ast.unparse(b.annotation)
    star = b.extra if b.kind == "parameter" and b.extra in ("*", "**") else ""
    return star + b.name + (": " + tn if tn else "")


def user_kind(b):
    if b.kind == "attribute":
        return "variable"
    if b.kind in ("import", "importfrom"):
        return "module"
    return b.kind


def describe_user(an, b):
    f = an.follow(b)
    if isinstance(f, Ext):
        return describe_ext(f, f.name)
    if isinstance(f, Src):
        doc = first_line(ast.get_docstring(f.tree)) if f.tree else ""
        return "(module) " + f.modname + ("\n" + doc if doc else "")
    b = f
    kind = {"attribute": "attribute", "variable": "variable", "parameter": "parameter"}.get(b.kind, b.kind)
    prefix = ""
    if b.kind == "attribute" or (b.scope.kind == "class" and b.kind in ("method", "property", "variable")):
        prefix = b.scope.name + "."
        if b.kind == "variable":
            kind = "attribute"
    detail = user_detail(an, b)
    if prefix and b.kind in ("variable", "attribute"):
        detail = prefix + detail
    text = "(" + kind + ") " + detail
    if b.kind in ("function", "method", "property", "class") and isinstance(b.node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        doc = first_line(ast.get_docstring(b.node))
        if doc:
            text += "\n" + doc
    return text


def location(src, line, col, length):
    text = src.text(line).strip()
    return {"path": src.path, "line": line, "column": col + 1, "length": length, "preview": text if len(text) <= 120 else text[:120] + "…"}


def binding_location(b):
    return location(b.src, b.line, b.col, len(b.name))


# ---------------------------------------------------------------- actions

CACHE = []


def analysis_for(files):
    key = tuple((f.get("path"), f.get("code")) for f in files)
    for k, a in CACHE:
        if k == key:
            return a
    a = Analysis(files)
    CACHE.insert(0, (key, a))
    del CACHE[4:]
    return a


def target_at(an, path, pos):
    src = an.src(path)
    if src is None:
        return None, None
    o = an.occ_at(src, pos)
    if o is None:
        return None, None
    return o, an.resolve(o)


def do_definition(req):
    an = analysis_for(req["files"])
    o, t = target_at(an, req["path"], req.get("position", 0))
    if o is None or t is None:
        return {}
    f = an.follow(t)
    if isinstance(f, Binding):
        return {"definition": binding_location(f), "hover": describe_user(an, f)}
    if isinstance(f, Src):
        return {"definition": location(f, 1, 0, 0)}
    if isinstance(f, Ext):
        return {"external": describe_ext(f, f.name or o.name) + "\n\nDeclared in " + where_ext(f) + " (no source to open)."}
    return {}


def do_hover(req):
    an = analysis_for(req["files"])
    o, t = target_at(an, req["path"], req.get("position", 0))
    if o is None or t is None:
        return {}
    if isinstance(t, Binding):
        return {"hover": describe_user(an, t)}
    if isinstance(t, Src):
        doc = first_line(ast.get_docstring(t.tree)) if t.tree else ""
        return {"hover": "(module) " + t.modname + ("\n" + doc if doc else "")}
    if isinstance(t, Ext):
        return {"hover": describe_ext(t, t.name or o.name)}
    return {}


def do_references(req):
    an = analysis_for(req["files"])
    o, t = target_at(an, req["path"], req.get("position", 0))
    if o is None or t is None:
        return {"references": []}
    want = an.canonical(t)
    if want is None:
        return {"references": []}
    found, seen = [], set()
    f = an.follow(t)
    # imports under another name ("import numpy as np") still name the same thing
    names = {o.name, getattr(f, "name", o.name)} | alias_names(an, want)
    if isinstance(f, Src):
        names |= {f.modname, f.modname.split(".")[0]}
    for src in an.srcs:
        for x in an.occ[src]:
            if x.name not in names:
                continue
            try:
                k = an.canonical(an.resolve(x))
            except BaseException:
                k = None
            if k == want and (src.path, x.line, x.col) not in seen:
                seen.add((src.path, x.line, x.col))
                found.append(location(src, x.line, x.col, x.length))
    found.sort(key=lambda l: (l["path"] != req["path"], l["path"], l["line"], l["column"]))
    return {"references": found}


def alias_names(an, want):
    names = set()
    for src in an.srcs:
        for s_name, bs in src.scope.bindings.items():
            for b in bs:
                if b.kind in ("import", "importfrom") and an.canonical(b) == want:
                    names.add(s_name)
    return names


def closers(text):
    """The brackets a line leaves open (None when it ends inside a string or a comment)."""
    stack, i, quote = [], 0, None
    while i < len(text):
        c = text[i]
        if quote:
            if c == "\\":
                i += 1
            elif text.startswith(quote, i):
                i += len(quote) - 1
                quote = None
        elif c in "\"'":
            quote = text[i:i + 3] if text[i:i + 3] in ('"""', "'''") else c
            i += len(quote) - 1
        elif c == "#":
            return None
        elif c in "([{":
            stack.append({"(": ")", "[": "]", "{": "}"}[c])
        elif c in ")]}" and stack:
            stack.pop()
        i += 1
    if quote:
        return None
    return "".join(reversed(stack))


def receiver_chain(text):
    """The expression before a trailing '.', e.g. 'self.items' or '"a,b"' or 'df.head()'."""
    i = len(text)
    depth = 0
    while i > 0:
        c = text[i - 1]
        if c in ")]":
            depth += 1
        elif c in "([":
            if depth == 0:
                break
            depth -= 1
        elif c in "\"'" and depth == 0:
            q = c
            j = text.rfind(q, 0, i - 1)
            if j < 0:
                break
            i = j
            while i > 0 and text[i - 1] in "rbfuRBFU":
                i -= 1
            continue
        elif depth == 0 and not (c.isalnum() or c == "_" or c == "."):
            break
        i -= 1
    return text[i:].strip()


def module_names(prefix):
    if "." in prefix:
        pkg_name = prefix.rsplit(".", 1)[0]
        pkg = Analysis([]).ext_module(pkg_name)
        if pkg is None:
            return []
        if not hasattr(pkg, "__path__"):        # a module with modules as attributes (os.path)
            return [{"label": n, "kind": "module", "detail": "module " + getattr(pkg, n).__name__} for n in dir(pkg) if not n.startswith("_") and inspect.ismodule(getattr(pkg, n, None))]
        return [{"label": m.name, "kind": "module", "detail": "module " + pkg_name + "." + m.name} for m in pkgutil.iter_modules(pkg.__path__) if not m.name.startswith("_")]
    global ALL_MODULES
    if ALL_MODULES is None:
        names = set(sys.builtin_module_names) | set(getattr(sys, "stdlib_module_names", ()))
        try:
            names |= {m.name for m in pkgutil.iter_modules()}
        except BaseException:
            pass
        ALL_MODULES = sorted(n for n in names if not n.startswith("_") and n not in BLOCKED)
    return [{"label": n, "kind": "module", "detail": "module " + n} for n in ALL_MODULES]


ALL_MODULES = None
MEMBER_CACHE = {}


def ext_members(o, inst, include_private):
    key = (id(o), inst)
    if key not in MEMBER_CACHE:
        items = []
        in_module = inspect.ismodule(o)
        try:
            names = dir(o)
        except BaseException:
            names = []
        for name in names:
            try:
                m = getattr(o, name) if in_module else static(o, name)
            except BaseException:
                continue
            if in_module and inspect.ismodule(m) is False and name.startswith("_"):
                pass
            try:
                items.append({"label": name, "kind": ext_kind(m, in_module), "detail": ext_detail(name, m, in_module)})
            except BaseException:
                items.append({"label": name, "kind": "variable", "detail": None})
        if isinstance(o, type) and not inst:
            items = [i for i in items if i["label"] not in ("mro",)]
        MEMBER_CACHE[key] = items
    items = MEMBER_CACHE[key]
    return [i for i in items if include_private or not i["label"].startswith("_")]


def user_members(an, cs, include_private, seen=None):
    seen = seen or set()
    if id(cs) in seen:
        return []
    seen.add(id(cs))
    items, names = [], set()
    for name, bs in list(cs.bindings.items()) + list(cs.inst.items()):
        if name in names:
            continue
        names.add(name)
        b = bs[0]
        kind = {"method": "method", "property": "property", "class": "class", "function": "method"}.get(b.kind, "variable")
        items.append({"label": name, "kind": kind, "detail": user_detail(an, b)})
    for base in cs.bases:
        t = an.infer(base, cs.parent)
        if t is None:
            continue
        if t.k == "cls":
            more = user_members(an, t.v, True, seen)
        elif t.k == "ext" and isinstance(t.v, type):
            more = ext_members(t.v, True, True)
        else:
            more = []
        items += [i for i in more if i["label"] not in names]
        names |= {i["label"] for i in more}
    return [i for i in items if include_private or not i["label"].startswith("__")]


def members_of(an, t, prefix):
    priv = prefix.startswith("_")
    if t is None:
        return []
    if t.k == "cls":
        items = user_members(an, t.v, priv)
        if not priv:
            items = [i for i in items if not i["label"].startswith("_")] + [i for i in items if i["label"].startswith("_") and not i["label"].startswith("__")]
        return items
    if t.k == "mod":
        src = t.v
        items = []
        for name, bs in src.scope.bindings.items():
            if name.startswith("_") and not priv:
                continue
            b = bs[0]
            items.append({"label": name, "kind": user_kind(b) if b.kind != "variable" else "variable", "detail": user_detail(an, b)})
        if src.is_pkg:
            for s in an.srcs:
                if s is not src and s.key.startswith(src.key + "/" if src.key else "") and "/" not in s.key[len(src.key) + 1:]:
                    items.append({"label": s.key.split("/")[-1], "kind": "module", "detail": "module " + s.modname})
        return items
    if t.k == "ext":
        o = t.v
        if t.inst or inspect.ismodule(o) or isinstance(o, type):
            return ext_members(o, t.inst, priv)
        return ext_members(type(o), True, priv)
    if t.k == "func":
        return ext_members(types.FunctionType, True, priv)
    return []


def scope_names(an, scope):
    items, names = [], set()
    s, first = scope, True
    rank = 0
    while s is not None:
        if first or s.kind != "class":
            for name, bs in s.bindings.items():
                if name in names or name == PH:
                    continue
                b = bs[0]
                names.add(name)
                f = an.follow(b)
                kind = user_kind(f) if isinstance(f, Binding) else "module" if isinstance(f, Src) else ext_kind(f.obj, True)
                if kind == "parameter":
                    kind = "variable"
                items.append({"label": name, "kind": kind, "detail": user_detail(an, b), "rank": rank})
            if s.kind == "module":
                for mod, level in s.stars:
                    u = an.user_module(mod, level, s.src)
                    if u is not None:
                        for name, bs in u.scope.bindings.items():
                            if name not in names and not name.startswith("_"):
                                names.add(name)
                                items.append({"label": name, "kind": user_kind(bs[0]), "detail": user_detail(an, bs[0]), "rank": rank})
                    elif not level:
                        m = an.ext_module(mod)
                        if m is not None:
                            for i in ext_members(m, False, False):
                                if i["label"] not in names:
                                    names.add(i["label"])
                                    items.append(dict(i, rank=rank))
        first = False
        rank += 1
        s = s.parent
    for i in ext_members(builtins, False, False):
        if i["label"] not in names:
            items.append(dict(i, rank=rank))
    items.sort(key=lambda i: (i.pop("rank"), i["label"].lower()))
    items += [{"label": k, "kind": "keyword", "detail": None} for k in KEYWORDS]
    return items


def do_complete(req):
    files, path, pos = req["files"], req["path"], req.get("position", 0)
    me = next((f for f in files if f.get("path") == path), None)
    if me is None:
        return {"items": []}
    code = (me.get("code") or "").replace("\r\n", "\n")
    pos = max(0, min(pos, len(code)))
    before = code[:pos]
    line_start = before.rfind("\n") + 1
    line_before = before[line_start:]
    line_end = code.find("\n", pos)
    line_end = len(code) if line_end < 0 else line_end
    line_no = before.count("\n") + 1

    m = re.match(r"^\s*(?:import|from)\s+([\w.]*)$", line_before)
    if m and not re.match(r"^\s*from\s+[\w.]+\s+import", line_before):
        typed = m.group(1)
        if re.match(r"^\s*from\s+\.", line_before):
            return {"items": []}
        users = [{"label": s.modname, "kind": "module", "detail": "module " + s.modname} for s in Analysis(files).srcs if s.path != path and s.path.endswith(".py")]
        return {"items": users + module_names(typed)}
    m = re.match(r"^\s*from\s+(\.*)([\w.]*)\s+import\s+(?:\(?\s*)?(?:[\w\s,]*,\s*)?(\w*)$", line_before)
    if m:
        level, mod = len(m.group(1)), m.group(2)
        an = Analysis(files)
        u = an.user_module(mod, level, an.src(path))
        if u is not None:
            return {"items": members_of(an, T("mod", u), m.group(3))}
        ext = an.ext_module(mod) if not level else None
        if ext is None:
            return {"items": []}
        items = ext_members(ext, False, m.group(3).startswith("_"))
        if hasattr(ext, "__path__"):
            have = {i["label"] for i in items}
            items = items + [{"label": s.name, "kind": "module", "detail": "module " + mod + "." + s.name} for s in pkgutil.iter_modules(ext.__path__) if not s.name.startswith("_") and s.name not in have]
        return {"items": items}

    close = closers(line_before)
    if close is None:
        return {"items": []}          # inside a string or a comment
    word = re.search(r"[A-Za-z_]\w*$", line_before)
    prefix = word.group() if word else ""
    start = pos - len(prefix)
    rest = re.match(r"\w*", code[pos:]).group()
    head = code[:line_start]
    tail = code[line_end:]
    indent = re.match(r"[ \t]*", line_before).group()
    is_attr = line_before[: len(line_before) - len(prefix)].rstrip().endswith(".")
    nxt = next((l for l in tail.split("\n")[1:] if l.strip()), "")
    deeper = len(nxt) - len(nxt.lstrip()) > len(indent)

    attempts = [
        code[:start] + PH + code[pos + len(rest):],
        head + line_before[: len(line_before) - len(prefix)] + PH + close + tail,
    ]
    if is_attr:
        chain = receiver_chain(line_before[: len(line_before) - len(prefix)].rstrip()[:-1])
        if chain:
            body = chain + "." + PH
            attempts.append(head + indent + ("if " + body + ":" if deeper else body) + tail)
    else:
        attempts.append(head + indent + ("if " + PH + ":" if deeper else PH) + tail)
    for text in attempts:
        try:
            an = Analysis(files, override=(path, text), protect=line_no)
        except Unparsable:
            continue
        src = an.src(path)
        hit = next((o for o in an.occ[src] if o.name == PH), None)
        if hit is None:
            continue
        if hit.kind == "attr":
            items = members_of(an, an.infer(hit.node.value, hit.scope), prefix)
        elif hit.kind == "name":
            items = scope_names(an, hit.scope)
        elif hit.kind == "kw":
            items = scope_names(an, hit.scope)
            f = an.infer(hit.node.func, hit.scope)
            fn = f.v.body if f is not None and f.k == "func" else None
            if f is not None and f.k == "cls" and not f.inst:
                init = an.class_member(f.v, "__init__")
                fn = init.body if isinstance(init, Binding) else None
            if fn is not None:
                items = [{"label": n + "=", "kind": "variable", "detail": user_detail(an, bs[0])} for n, bs in fn.bindings.items() if bs[0].kind == "parameter" and n not in ("self", "cls")] + items
        else:
            items = []
        return {"items": [i for i in items if i["label"] != PH]}
    return {"items": []}


ACTIONS = {"complete": do_complete, "definition": do_definition, "hover": do_hover, "references": do_references}


# ---------------------------------------------------------------- Jedi, when it is installed
#
# Jedi (a real Python analyser) answers first when it can be imported: from the dojo's Python environment,
# or from the tools folder the server passes with --tools. It runs in one worker thread with a time budget,
# so a slow answer (a big package being read for the first time) falls back to the analyser above instead
# of keeping the learner waiting; the worker finishes in the background and is warm for the next request.

JEDI = None
JEDI_TRIED = 0.0
JEDI_ENV = None
TOOLS = None
WORKER = None
BUSY = None                 # the Future of a Jedi job that ran past its budget
JEDI_BUDGET = 3.0
PROJECTS = {}
WRITTEN = {}


def get_jedi():
    """The jedi module, or None. A missing Jedi is looked for again now and then (the server may be installing it)."""
    global JEDI, JEDI_TRIED, JEDI_ENV, WORKER
    if JEDI is not None:
        return JEDI
    import time
    if time.time() - JEDI_TRIED < 15:
        return None
    JEDI_TRIED = time.time()
    if TOOLS and os.path.isdir(TOOLS) and TOOLS not in sys.path:
        sys.path.append(TOOLS)
    importlib.invalidate_caches()
    try:
        import jedi
        JEDI_ENV = jedi.InterpreterEnvironment()     # in this process: no extra Python started per request
    except BaseException:
        # Half installed (pip is still writing it): forget the pieces so the next try starts clean.
        for name in [m for m in sys.modules if m.split(".")[0] in ("jedi", "parso")]:
            del sys.modules[name]
        return None
    import concurrent.futures
    import threading
    threading.stack_size(64 * 1024 * 1024)          # Jedi recurses deeply; the default thread stack is small
    WORKER = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    JEDI = jedi
    WORKER.submit(lambda: jedi.Script("''.up", environment=JEDI_ENV).complete(1, 5))   # load the builtins once, now
    return JEDI


def safe_rel(path):
    rel = (path or "main.py").replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or ".." in parts or ":" in parts[0]:
        return None
    return "/".join(parts)


def jedi_project(req):
    """The request's files written to a folder of their own (Jedi reads the other modules from disk)."""
    import hashlib
    import tempfile
    files = req["files"]
    site = req.get("site") or None
    key = hashlib.sha1(("|".join(sorted(f.get("path") or "" for f in files)) + "|" + (req.get("root") or "")).encode("utf-8")).hexdigest()[:12]
    base = os.path.join(tempfile.gettempdir(), "code-dojo", "jedi", key)
    written = WRITTEN.setdefault(key, {})
    for f in files:
        rel = safe_rel(f.get("path"))
        code = (f.get("code") or "").replace("\r\n", "\n")
        if rel is None or written.get(rel) == code:
            continue
        full = os.path.join(base, *rel.split("/"))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(code)
        written[rel] = code
    pk = (key, site)
    if pk not in PROJECTS:
        # A code space's .venv: its packages are found as if the learner's program ran there.
        PROJECTS[pk] = JEDI.Project(base, added_sys_path=[site] if site else [], smart_sys_path=True)
    return base, PROJECTS[pk]


def jedi_rel(base, module_path):
    if module_path is None:
        return None
    try:
        rel = os.path.relpath(str(module_path), base)
    except ValueError:      # another drive
        return None
    if rel.startswith("..") or os.path.isabs(rel):
        return None
    return rel.replace("\\", "/")


def jedi_location(req, rel, line, col, length):
    code = next(((f.get("code") or "").replace("\r\n", "\n") for f in req["files"] if safe_rel(f.get("path")) == rel), "")
    path = next((f.get("path") for f in req["files"] if safe_rel(f.get("path")) == rel), rel)
    lines = code.split("\n")
    text = lines[line - 1].strip() if 1 <= line <= len(lines) else ""
    return {"path": path, "line": line, "column": col + 1, "length": length, "preview": text if len(text) <= 120 else text[:120] + "…"}


def jedi_signature(n):
    try:
        sigs = n.get_signatures()
    except BaseException:
        sigs = []
    if not sigs:
        return None
    try:
        return sigs[0].to_string()
    except BaseException:
        return None


def jedi_type(n):
    try:
        found = n.infer()
    except BaseException:
        return None
    names = []
    for t in found[:3]:
        name = t.name if t.type != "module" else "module"
        if name and name not in names:
            names.append(name)
    return " | ".join(names) or None


def jedi_describe(n):
    kind = n.type
    parent = None
    try:
        parent = n.parent()
    except BaseException:
        pass
    in_class = parent is not None and parent.type == "class"
    doc = ""
    if kind in ("function", "class", "module"):
        try:
            doc = first_line(n.docstring(raw=True))
        except BaseException:
            doc = ""
    if kind == "function":
        sig = jedi_signature(n) or n.name + "(...)"
        head = ("(method) " + parent.name + "." if in_class else "(function) ") + "def " + sig
    elif kind == "class":
        head = "(class) class " + n.name
    elif kind == "module":
        head = "(module) " + (n.full_name or n.name)
    elif kind == "param":
        t = jedi_type(n)
        head = "(parameter) " + n.name + (": " + t if t else "")
    elif kind == "property":
        t = jedi_type(n)
        head = "(property) " + (parent.name + "." if in_class else "") + n.name + (": " + t if t else "")
    else:
        t = jedi_type(n)
        head = ("(attribute) " + parent.name + "." if in_class else "(variable) ") + n.name + (": " + t if t else "")
    return head + ("\n" + doc if doc else "")


def jedi_answer(req):
    base, project = jedi_project(req)
    rel = safe_rel(req["path"])
    me = next(f for f in req["files"] if f.get("path") == req["path"])
    code = (me.get("code") or "").replace("\r\n", "\n")
    pos = max(0, min(req.get("position", 0), len(code)))
    line = code.count("\n", 0, pos) + 1
    col = pos - (code.rfind("\n", 0, pos) + 1)
    script = JEDI.Script(code, path=os.path.join(base, *rel.split("/")), project=project, environment=JEDI_ENV)
    action = req["action"]

    if action == "complete":
        before = code[code.rfind("\n", 0, pos) + 1:pos]
        prefix = re.search(r"\w*$", before).group()
        attr = before[: len(before) - len(prefix)].rstrip().endswith(".")
        items = []
        for c in script.complete(line, col):
            if c.name.startswith("__") and not prefix.startswith("_"):
                continue
            kind = {"module": "module", "class": "class", "function": "method" if attr else "function", "keyword": "keyword",
                    "property": "property", "path": "module"}.get(c.type, "variable")
            label = c.name_with_symbols if c.type == "param" else c.name
            detail = None
            if len(items) < 40:      # signatures and types cost a lookup each: only for the first ones the popup shows
                if c.type in ("function", "class"):
                    detail = jedi_signature(c)
                elif c.type in ("instance", "statement", "param", "property"):
                    t = jedi_type(c)
                    detail = c.name + (": " + t if t else "")
                elif c.type == "module":
                    detail = "module " + (c.full_name or c.name)
            items.append({"label": label, "kind": kind, "detail": detail})
            if len(items) >= 300:
                break
        return {"items": items} if items else None

    if action == "hover":
        names = script.goto(line, col, follow_imports=True)
        if not names:
            names = script.infer(line, col)
        return {"hover": jedi_describe(names[0])} if names else None

    if action == "definition":
        names = script.goto(line, col, follow_imports=True)
        if not names:
            return None
        n = names[0]
        hover = jedi_describe(n)
        where = jedi_rel(base, n.module_path)
        if where is not None:
            if n.line is None:
                return {"definition": jedi_location(req, where, 1, 0, 0), "hover": hover}
            return {"definition": jedi_location(req, where, n.line, n.column, len(n.name)), "hover": hover}
        return {"external": hover + "\n\nDeclared in " + (n.module_name or "a library") + " (no source to open)."}

    if action == "references":
        found, seen = [], set()
        for r in script.get_references(line, col, include_builtins=False):
            where = jedi_rel(base, r.module_path)
            if where is None or r.line is None or (where, r.line, r.column) in seen:
                continue
            seen.add((where, r.line, r.column))
            found.append(jedi_location(req, where, r.line, r.column, len(r.name)))
        if not found:
            return None
        found.sort(key=lambda l: (l["path"] != req["path"], l["path"], l["line"], l["column"]))
        return {"references": found}
    return None


def try_jedi(req, strict):
    """Jedi's answer, or None (not installed, busy, too slow, nothing to say)."""
    global BUSY
    if get_jedi() is None or safe_rel(req.get("path")) is None:
        return None
    if BUSY is not None and not BUSY.done():
        return None
    BUSY = None
    job = WORKER.submit(jedi_answer, req)
    try:
        return job.result(timeout=120 if strict else JEDI_BUDGET)
    except BaseException as e:
        import concurrent.futures
        if isinstance(e, concurrent.futures.TimeoutError):
            BUSY = job
        return None


def handle(req):
    fn = ACTIONS.get(req.get("action"))
    if fn is None:
        return {}
    if not any(f.get("path") == req.get("path") for f in req.get("files") or []):
        return {}
    engine = req.get("engine") or "auto"
    if engine == "basic":
        return dict(fn(req), engine="basic")
    res = try_jedi(req, engine == "jedi")
    missing = JEDI is None          # the server installs it in the background when it hears this
    if res is not None:
        return dict(res, engine="jedi")
    if engine == "jedi":            # tests ask for Jedi alone, to know it answered
        return {"engine": "unavailable" if missing else "none", "jediMissing": missing}
    return dict(fn(req), engine="basic", jediMissing=missing)


def main():
    global TOOLS
    if "--tools" in sys.argv[1:-1]:
        TOOLS = sys.argv[sys.argv.index("--tools") + 1]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            res = handle(json.loads(line))
        except BaseException as e:      # never die on one bad request
            res = {"error": type(e).__name__ + ": " + str(e)}
        try:
            out = json.dumps(res, default=str)
        except BaseException as e:
            out = json.dumps({"error": "unserialisable: " + str(e)})
        PROTO.write(out + "\n")
        PROTO.flush()


if __name__ == "__main__":
    main()
