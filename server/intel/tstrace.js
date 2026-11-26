// code-dojo: trace a TypeScript (or JavaScript) program line by line with the real V8 debugger.
//   node --no-warnings tstrace.js main.ts trace.jsonl
// The program runs on the main thread exactly as `node main.ts` runs it (Node strips the types and keeps every
// line and column where it was). A worker thread attaches the inspector to the main thread
// (inspector.Session.connectToMainThread), sets a breakpoint on every possible location of main.ts and, at each
// pause, records the line, the call stack, every variable in scope and the objects they point to. Objects get
// small ids, so two variables holding the same array show the same id: aliasing and mutation are visible.
// Each step is one JSON line in trace.jsonl, written synchronously, so a run that is stopped keeps its steps.
'use strict';
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { pathToFileURL } = require('node:url');

const MAX_STEPS = 800;
const MAX_ITEMS = 30;
const MAX_OBJECTS = 60;

if (isMainThread) mainThread(); else controller();

function lineOf(err, file) {
  const m = String(err && err.stack || '').match(new RegExp(path.basename(file).replace(/\./g, '\\.') + ':(\\d+)'));
  return m ? Number(m[1]) : 0;
}

function mainThread() {
  const file = path.resolve(process.argv[2]);
  const outFile = path.resolve(process.argv[3]);
  fs.writeFileSync(outFile, '');
  const write = o => fs.appendFileSync(outFile, JSON.stringify(o) + '\n');
  const out = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = (...a) => { out.push(util.format(...a) + '\n'); };

  const ids = new WeakMap();
  let nextId = 1;
  const idOf = o => { let i = ids.get(o); if (!i) { i = nextId++; ids.set(o, i); } return i; };
  const SKIP = new Set(['exports', 'require', 'module', '__filename', '__dirname']);

  function header(fn) {
    let src = '';
    try { src = Function.prototype.toString.call(fn); } catch { }
    const cut = src.search(/=>|\{/);
    const head = (cut > 0 ? src.slice(0, cut) : src).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
    if (/^class\b/.test(head)) return head;
    const params = (head.match(/\(([^)]*)\)/) || [, head.replace(/^async\s+/, '').trim()])[1];
    return (fn.name || 'anonymous') + '(' + params + ')';
  }

  function encode(v, heap, depth) {
    switch (typeof v) {
      case 'undefined': return { v: 'undefined' };
      case 'number': return { v: Object.is(v, -0) ? '-0' : String(v) };
      case 'bigint': return { v: v + 'n' };
      case 'boolean': return { v: String(v) };
      case 'string': return { v: JSON.stringify(v.length > 60 ? v.slice(0, 57) + '…' : v) };
      case 'symbol': return { v: v.toString() };
    }
    if (v === null) return { v: 'null' };
    const r = idOf(v);
    const key = String(r);
    if (heap[key] || Object.keys(heap).length >= MAX_OBJECTS) return { r };
    const node = {};
    heap[key] = node;
    const more = depth < 4;
    const enc = x => more ? encode(x, heap, depth + 1) : { v: util.inspect(x, { depth: 0, breakLength: Infinity }).slice(0, 30) };
    const take = (list, map) => { const res = []; for (const x of list) { if (res.length >= MAX_ITEMS) { node.more = true; break; } res.push(map(x)); } return res; };
    try {
      if (typeof v === 'function') {
        node.kind = /^class\b/.test(Function.prototype.toString.call(v)) ? 'class' : 'function';
        node.type = node.kind;
        node.name = node.kind === 'class' ? 'class ' + v.name : header(v);
      } else if (Array.isArray(v)) {
        node.kind = 'list'; node.type = 'Array'; node.items = take(v, enc);
      } else if (v instanceof Map) {
        node.kind = 'dict'; node.type = 'Map'; node.pairs = take(v, ([k, x]) => [enc(k), enc(x)]);
      } else if (v instanceof Set) {
        node.kind = 'set'; node.type = 'Set'; node.items = take(v, enc);
      } else if (v instanceof Promise || v instanceof Date || v instanceof RegExp || v instanceof Error || ArrayBuffer.isView(v)) {
        node.kind = 'value'; node.type = v.constructor?.name || 'Object';
        node.repr = util.inspect(v, { depth: 0, breakLength: Infinity }).split('\n')[0].slice(0, 80);
      } else {
        node.kind = 'object';
        node.type = (Object.getPrototypeOf(v) === null ? 'Object' : v.constructor?.name) || 'Object';
        const pairs = [];
        for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
          if (pairs.length >= MAX_ITEMS) { node.more = true; break; }
          if (!d.enumerable) continue;
          pairs.push([{ v: k }, 'value' in d ? enc(d.value) : { v: '(getter)' }]);
        }
        node.pairs = pairs;
      }
    } catch (e) { node.kind = 'value'; node.repr = '(could not show)'; }
    return { r };
  }

  // Called by the controller while the program is paused (Runtime.callFunctionOn), with the scope objects.
  Object.defineProperty(globalThis, '__dojoSnap', {
    enumerable: false,
    value(meta, scopes, ret) {
      const heap = {};
      const frames = meta.frames.map(f => {
        const vars = [];
        const seen = new Set();
        let top = false;
        for (const s of f.scopes) {
          const obj = scopes[s.i];
          let names = [];
          try { names = Object.getOwnPropertyNames(obj); } catch { }
          const wrapper = names.includes('__filename') && names.includes('require');
          if (wrapper || s.type === 'module') { if (s.type === 'closure') continue; top = true; }
          for (const n of names) {
            if (SKIP.has(n) || n.startsWith('__dojo') || seen.has(n)) continue;
            if (meta.hide.includes(n) && f.depth === 0) continue;
            let val;
            try { val = obj[n]; } catch { continue; }   // a let/const not declared yet (temporal dead zone)
            seen.add(n);
            vars.push([n, encode(val, heap, 0), s.type === 'closure' ? 'closure' : '']);
          }
        }
        return { name: top ? 'top level' : f.name || '(anonymous)', line: f.line, vars };
      });
      const res = { frames, heap, o: out.splice(0).join('') };
      if (meta.hasRet) res.ret = encode(ret, heap, 0);
      return res;
    },
  });

  process.on('uncaughtException', e => {
    write({ error: { message: (e && e.name ? e.name + ': ' : '') + (e && e.message || String(e)), line: lineOf(e, file) } });
    process.exit(1);
  });
  process.on('exit', () => { try { write({ end: true, o: out.splice(0).join('') }); } catch { } });

  const w = new Worker(__filename, { workerData: { file, outFile } });
  w.on('error', e => { write({ error: { message: 'The tracer failed: ' + e.message, line: 0 } }); });
  w.once('message', async () => {
    w.unref();
    try { await import(pathToFileURL(file).href); }
    catch (e) { write({ error: { message: (e.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' ? 'Node cannot strip this syntax: ' : (e.name ? e.name + ': ' : '')) + e.message.split('\n')[0], line: lineOf(e, file) } }); }
  });
}

function controller() {
  setInterval(() => { }, 1 << 30);     // keep this thread alive; the main thread unrefs it, so it never holds the process open
  const inspector = require('node:inspector');
  const { file, outFile } = workerData;
  const write = o => fs.appendFileSync(outFile, JSON.stringify(o) + '\n');
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const s = new inspector.Session();
  s.connectToMainThread();
  const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  const url = pathToFileURL(file).href;
  const base = path.basename(file);
  // Node compiles a CommonJS .ts file without a URL, so the script is recognised by the id of the first breakpoint it hits.
  let firstBp = null, scriptId = null;
  const mine = f => f.location.scriptId === scriptId;

  // Names declared further down (let/const/class) are hidden at the top level until their line is reached.
  const declared = new Map();
  source.forEach((text, i) => {
    for (const m of text.matchAll(/\b(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/g)) if (!declared.has(m[1])) declared.set(m[1], i + 1);
  });

  let armed = false, count = 0, last = '', stopped = false;
  s.on('Debugger.paused', async ({ params }) => {
    try {
      if (stopped) return;
      if (!armed && (params.hitBreakpoints || []).includes(firstBp)) scriptId = params.callFrames[0].location.scriptId;
      const frames = params.callFrames.filter(mine);
      if (!frames.length) { await post('Debugger.resume'); return; }
      if (!armed) {
        armed = true;
        const { locations } = await post('Debugger.getPossibleBreakpoints', { start: { scriptId, lineNumber: 0, columnNumber: 0 } });
        for (const loc of locations) await post('Debugger.setBreakpoint', { location: { scriptId, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber } }).catch(() => { });
      }
      const top = frames[0];
      const line = top.location.lineNumber + 1;
      const isReturn = !!top.returnValue;
      const key = `${line}|${frames.length}|${top.functionName}|${isReturn}`;
      if (key === last || line > source.length) { await post('Debugger.resume'); return; }
      last = key;

      // Every scope object of every user frame goes to __dojoSnap in one call.
      const scopeIds = [];
      const meta = { frames: [], hide: [], hasRet: isReturn };
      frames.forEach((f, depth) => {
        const scopes = [];
        for (const sc of f.scopeChain) {
          if (!['local', 'block', 'catch', 'closure', 'module', 'script'].includes(sc.type) || !sc.object.objectId) continue;
          scopes.push({ i: scopeIds.length, type: sc.type });
          scopeIds.push(sc.object.objectId);
        }
        meta.frames.push({ name: f.functionName, line: f.location.lineNumber + 1, depth, scopes });
      });
      // Judged at the outermost frame's own line: inside a call, the top level is paused at the call site.
      const outerLine = frames[frames.length - 1].location.lineNumber + 1;
      for (const [n, at] of declared) if (at > outerLine) meta.hide.push(n);
      // The bottom frame is the outermost: it is the only one where "hide" applies (depth 0 is the innermost here, so flip it).
      meta.frames.forEach((f, i) => { f.depth = i === meta.frames.length - 1 ? 0 : 1; });
      if (!scopeIds.length) { await post('Debugger.resume'); return; }
      const args = [{ value: meta }, ...scopeIds.slice(1).map(objectId => ({ objectId }))];
      const ret = top.returnValue;
      args.push(ret ? (ret.objectId ? { objectId: ret.objectId } : ret.unserializableValue ? { unserializableValue: ret.unserializableValue } : { value: ret.value }) : { value: null });
      const r = await post('Runtime.callFunctionOn', {
        objectId: scopeIds[0],
        functionDeclaration: 'function (meta, ...rest) { const ret = rest.pop(); return globalThis.__dojoSnap(meta, [this, ...rest], ret); }',
        arguments: args, returnByValue: true, silent: true,
      });
      const snap = r.result && r.result.value;
      if (snap) {
        // Innermost frame first from the debugger; the trace lists the stack outermost first.
        write({ l: line, ev: isReturn ? 'return' : 'line', s: snap.frames.reverse(), h: snap.heap, o: snap.o, ...(isReturn ? { ret: snap.ret } : {}) });
        if (++count >= MAX_STEPS) {
          stopped = true;
          write({ stop: true });
          await post('Runtime.evaluate', { expression: 'process.exit(0)' }).catch(() => { });
          return;
        }
      }
      await post('Debugger.resume');
    } catch (e) {
      try { write({ error: { message: 'The tracer failed: ' + e.message, line: 0 } }); await post('Debugger.resume'); } catch { }
    }
  });

  (async () => {
    await post('Debugger.enable');
    // Pause at the first statement of main.ts; every other location is armed from there (its script id is known then).
    firstBp = (await post('Debugger.setBreakpointByUrl', { lineNumber: 0, urlRegex: '[\\\\/]' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' })).breakpointId;
    parentPort.postMessage('ready');
  })().catch(e => { write({ error: { message: 'The tracer could not start: ' + e.message, line: 0 } }); parentPort.postMessage('ready'); });
}
