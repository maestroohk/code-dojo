# code-dojo: trace a Python program line by line (PolyViz.cs runs this).
#   python -I -X utf8 pytrace.py main.py  > JSON on stdout
# Every step is the moment before a line runs (or a function returns): the line, every frame on the call
# stack with its local names, and the objects those names point to. Names hold references ({"r": id});
# small immutable values are shown inline ({"v": "3"}). Two names that point at the same list point at the
# same heap id, which is how aliasing and mutation become visible.
import sys, io, json, types, builtins, traceback, dis

YIELD = dis.opmap.get("YIELD_VALUE", -1)

MAX_STEPS = 800
MAX_ITEMS = 30
MAX_OBJECTS = 60
FILE = "<main>"

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    source = f.read()

real_out = sys.stdout
buf = io.StringIO()
steps = []
ids = {}            # id(obj) -> small number
keep = []           # holds every object we numbered, so CPython cannot reuse its id()
error = None
truncated = False


class _Stop(BaseException):
    pass


def ref(obj):
    k = id(obj)
    if k not in ids:
        ids[k] = len(ids) + 1
        keep.append(obj)
    return ids[k]


INLINE = (int, float, complex, bool, type(None), str, bytes)


def short(text, n=80):
    return text if len(text) <= n else text[: n - 1] + "â€¦"


def describe(obj, heap, depth):
    """Encode a value: inline for small immutables, else a reference to a heap entry (filled in here)."""
    if isinstance(obj, INLINE):
        if isinstance(obj, str) and len(obj) > 60:
            return {"v": repr(obj[:57]) + "â€¦"}
        return {"v": repr(obj)}
    r = ref(obj)
    key = str(r)
    if key in heap or len(heap) >= MAX_OBJECTS:
        return {"r": r}
    node = {"type": type(obj).__name__}
    heap[key] = node
    more = depth < 4

    def items(seq):
        out = []
        for i, x in enumerate(seq):
            if i >= MAX_ITEMS:
                node["more"] = True
                break
            out.append(describe(x, heap, depth + 1) if more else {"v": short(repr(x), 30)})
        return out

    if isinstance(obj, (list, tuple)):
        node["kind"] = "list" if isinstance(obj, list) else "tuple"
        node["items"] = items(obj)
    elif isinstance(obj, (set, frozenset)):
        node["kind"] = "set"
        try:
            node["items"] = items(sorted(obj, key=repr))
        except Exception:
            node["items"] = items(list(obj))
    elif isinstance(obj, dict):
        node["kind"] = "dict"
        pairs = []
        for i, (k, v) in enumerate(obj.items()):
            if i >= MAX_ITEMS:
                node["more"] = True
                break
            pairs.append([describe(k, heap, depth + 1), describe(v, heap, depth + 1) if more else {"v": short(repr(v), 30)}])
        node["pairs"] = pairs
    elif isinstance(obj, types.GeneratorType):
        node["kind"] = "generator"
        fr = obj.gi_frame
        node["name"] = obj.__name__
        import inspect
        st = inspect.getgeneratorstate(obj)
        node["state"] = {"GEN_CREATED": "not started", "GEN_RUNNING": "running", "GEN_CLOSED": "finished"}.get(st) or f"paused at line {fr.f_lineno}"
    elif isinstance(obj, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
        node["kind"] = "function"
        try:
            import inspect
            node["name"] = getattr(obj, "__qualname__", getattr(obj, "__name__", "?")) + str(inspect.signature(obj))
        except Exception:
            node["name"] = getattr(obj, "__name__", "?") + "(â€¦)"
    elif isinstance(obj, type):
        node["kind"] = "class"
        node["name"] = obj.__name__
    elif isinstance(obj, types.ModuleType):
        node["kind"] = "module"
        node["name"] = obj.__name__
    else:
        fields = getattr(obj, "__dict__", None)
        if isinstance(fields, dict) and (type(obj).__repr__ is object.__repr__ or hasattr(type(obj), "__dataclass_fields__")):
            node["kind"] = "object"
            node["pairs"] = [[{"v": k}, describe(v, heap, depth + 1) if more else {"v": short(repr(v), 30)}]
                             for k, v in list(fields.items())[:MAX_ITEMS] if not k.startswith("__")]
        else:
            node["kind"] = "value"
            try:
                node["repr"] = short(repr(obj))
            except Exception:
                node["repr"] = "<" + type(obj).__name__ + ">"
    return {"r": r}


def user_names(frame):
    names = frame.f_locals if frame.f_code.co_name != "<module>" else frame.f_globals
    out = []
    for k, v in list(names.items()):
        if k.startswith("__") or isinstance(v, types.ModuleType):
            continue
        out.append((k, v))
    return out


def frame_name(fr):
    co = fr.f_code
    if co.co_name == "<module>":
        return "top level"
    if co.co_flags & 0x20:   # CO_GENERATOR
        return co.co_name + " (generator)"
    return co.co_name


def snapshot(frame, event, arg):
    global truncated
    stack = []
    f = frame
    while f is not None:
        if f.f_code.co_filename == FILE:
            stack.append(f)
        f = f.f_back
    stack.reverse()
    heap = {}
    frames = []
    for fr in stack:
        frames.append({"name": frame_name(fr), "line": fr.f_lineno,
                       "vars": [[k, describe(v, heap, 0)] for k, v in user_names(fr)]})
    step = {"l": frame.f_lineno, "ev": event, "s": frames, "h": heap, "o": buf.getvalue()}
    buf.seek(0)
    buf.truncate(0)
    if event == "return":
        step["ret"] = describe(arg, heap, 0)
        if frame.f_code.co_flags & 0x20:
            try:
                step["yield"] = frame.f_code.co_code[frame.f_lasti] == YIELD
            except Exception:
                pass
    if event == "exception":
        step["exc"] = f"{arg[0].__name__}: {arg[1]}"
    steps.append(step)
    if len(steps) >= MAX_STEPS:
        truncated = True
        raise _Stop()


def tracer(frame, event, arg):
    if frame.f_code.co_filename != FILE:
        return None
    if event == "return" and frame.f_code.co_name == "<module>":
        return tracer
    if event in ("line", "return", "exception"):
        snapshot(frame, event, arg)
    return tracer


code = None
try:
    code = compile(source, FILE, "exec")
except SyntaxError as e:
    error = {"message": f"SyntaxError: {e.msg}", "line": e.lineno or 0}

if code is not None:
    g = {"__name__": "__main__", "__builtins__": builtins}
    sys.stdout = buf
    sys.settrace(tracer)
    try:
        exec(code, g)
    except _Stop:
        pass
    except SystemExit:
        pass
    except BaseException as e:
        tb = traceback.extract_tb(e.__traceback__)
        line = next((t.lineno for t in reversed(tb) if t.filename == FILE), 0)
        error = {"message": f"{type(e).__name__}: {e}", "line": line}
    finally:
        sys.settrace(None)
        sys.stdout = real_out
    heap = {}
    final = [[k, describe(v, heap, 0)] for k, v in list(g.items()) if not k.startswith("__") and not isinstance(v, types.ModuleType)]
    steps.append({"l": 0, "ev": "end", "s": [{"name": "top level", "line": 0, "vars": final}], "h": heap, "o": buf.getvalue(), "end": True})

real_out.write(json.dumps({"steps": steps, "truncated": truncated, "error": error}))
real_out.flush()
