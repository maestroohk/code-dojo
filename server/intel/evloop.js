// code-dojo: record what the event loop does while a program runs (PolyViz.cs runs this).
//   node --no-warnings evloop.js main.ts      > one line "\u0002EVLOOP {json}" on stdout at exit
// The program runs for real on Node. Timers, queueMicrotask and process.nextTick are wrapped so every callback
// is seen when it is queued and when it runs; promise jobs (then/catch/finally callbacks and the resumption after
// an await) are seen through V8's promise hooks (v8.promiseHooks): a job is queued when its promise's parent
// settles (or at once, when the parent had already settled) and runs between the hooks' before/after. Every
// console.log is recorded with the call stack at that moment, so the page can replay exactly why the output
// comes out in the order it does.
'use strict';
const v8 = require('node:v8');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const file = path.resolve(process.argv[2]);
const base = path.basename(file);
const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
const MAX_EVENTS = 400;
const events = [];
let current = null;          // the job whose callback is running now (null: the main script, or nothing)
let scriptDone = false;
let busy = false;
let seq = 0;

const emit = e => {
  if (events.length < MAX_EVENTS) events.push(e);
  else if (events.length === MAX_EVENTS) events.push({ k: 'stop' });
};

/** The user's frames on the stack, innermost first: { fn, line, col }. */
function frames() {
  const holder = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  Error.captureStackTrace(holder, frames);
  Error.stackTraceLimit = limit;
  const out = [];
  const lines = String(holder.stack).split('\n').slice(1).filter(l => !l.includes(__filename));
  // The innermost frames, builtins included ("at Promise.then (<anonymous>)", "at Function.all (<anonymous>)"):
  // they tell a .then() callback from a Promise.all step from an await.
  out.native = [];
  for (const l of lines) { if (!/\(<anonymous>\)\s*$/.test(l)) break; out.native.push(l.trim().replace(/^at /, '').replace(/ \(<anonymous>\)$/, '')); }
  for (const l of lines) {
    const m = l.match(/^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m || !(m[2].endsWith('/' + base) || m[2].endsWith('\\' + base))) continue;
    let fn = m[1] || null;
    if (fn && /<anonymous>|^Object\.|^Module\./.test(fn)) fn = fn.includes('.') && !fn.includes('<') ? fn.split('.').pop() : null;
    out.push({ fn, line: Number(m[3]), col: Number(m[4]) });
  }
  return out;
}

/** The call stack as the page draws it, outermost first. */
function stackNow(fs_ = frames()) {
  const names = fs_.slice().reverse().map(f => f.fn ? f.fn + '()' : 'anonymous');
  if (current) { if (names.length) names[0] = current.label; else names.push(current.label); }
  else if (!scriptDone) { if (names.length) names[0] = 'main script'; else names.push('main script'); }
  return names;
}

/** A short piece of the source starting at line:col, with brackets balanced: "then(() => log('A'))". */
function snippet(line, col, max = 46) {
  const text = (src[line - 1] || '').slice(Math.max(0, col - 1));
  let depth = 0, end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth <= 0) { end = i + 1; break; } }
    else if (depth === 0 && (c === ';' || c === ',')) { end = i; break; }
  }
  const s = text.slice(0, end).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------- console

for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  console[m] = (...args) => {
    busy = true;
    try {
      const f = frames();
      emit({ k: 'log', text: util.format(...args), line: f[0]?.line ?? 0, stack: stackNow(f) });
    } finally { busy = false; }
  };
}

// ---------------------------------------------------------------- timers and explicit queues

function job(q, label, line, extra = {}) {
  const j = { id: ++seq, q, label, line, ...extra };
  return j;
}

function runJob(j, fn, self, args) {
  const prev = current;
  current = j;
  emit({ k: 'run', id: j.id, q: j.q, line: j.line });
  try { return fn.apply(self, args); }
  finally { emit({ k: 'done', id: j.id, q: j.q }); current = prev; }
}

const real = {
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate, queueMicrotask: globalThis.queueMicrotask, nextTick: process.nextTick,
};
const byHandle = new WeakMap();

function where() { busy = true; try { const f = frames(); return { f, line: f[0]?.line ?? 0, col: f[0]?.col ?? 0 }; } finally { busy = false; } }

globalThis.setTimeout = function setTimeout(cb, ms, ...args) {
  const w = where();
  const delay = Math.max(0, Number(ms) || 0);
  const j = job('macro', `setTimeout callback (${delay} ms)`, w.line, { delay, code: snippet(w.line, w.col) });
  emit({ k: 'enq', ...j, stack: stackNow(w.f) });
  const h = real.setTimeout(function () { return runJob(j, cb, this, args); }, ms);
  byHandle.set(h, j);
  return h;
};
globalThis.clearTimeout = function clearTimeout(h) {
  const j = h && typeof h === 'object' ? byHandle.get(h) : undefined;
  if (j) emit({ k: 'cancel', id: j.id, q: j.q });
  return real.clearTimeout(h);
};
globalThis.setInterval = function setInterval(cb, ms, ...args) {
  const w = where();
  const delay = Math.max(1, Number(ms) || 1);
  let j = job('macro', `setInterval callback (${delay} ms)`, w.line, { delay, code: snippet(w.line, w.col) });
  emit({ k: 'enq', ...j, stack: stackNow(w.f) });
  let h;
  h = real.setInterval(function () {
    const mine = j;
    try { return runJob(mine, cb, this, args); }
    finally {
      if (byHandle.get(h) === mine) {   // not cleared inside the callback: the next tick is queued again
        j = job('macro', mine.label, mine.line, { delay, code: mine.code });
        byHandle.set(h, j);
        emit({ k: 'enq', ...j, stack: [] });
      }
    }
  }, ms);
  byHandle.set(h, j);
  return h;
};
globalThis.clearInterval = function clearInterval(h) {
  const j = h && typeof h === 'object' ? byHandle.get(h) : undefined;
  if (j) { emit({ k: 'cancel', id: j.id, q: j.q }); byHandle.delete(h); }
  return real.clearInterval(h);
};
globalThis.setImmediate = function setImmediate(cb, ...args) {
  const w = where();
  const j = job('macro', 'setImmediate callback', w.line, { code: snippet(w.line, w.col), immediate: true });
  emit({ k: 'enq', ...j, stack: stackNow(w.f) });
  return real.setImmediate(function () { return runJob(j, cb, this, args); });
};
globalThis.queueMicrotask = function queueMicrotask(cb) {
  const w = where();
  const j = job('micro', 'queueMicrotask callback', w.line, { code: snippet(w.line, w.col) });
  emit({ k: 'enq', ...j, stack: stackNow(w.f) });
  return real.queueMicrotask(function () { return runJob(j, cb, this, []); });
};
process.nextTick = function nextTick(cb, ...args) {
  const w = where();
  const j = job('tick', 'process.nextTick callback', w.line, { code: snippet(w.line, w.col) });
  emit({ k: 'enq', ...j, stack: stackNow(w.f) });
  return real.nextTick.call(process, function () { return runJob(j, cb, this, args); });
};

// ---------------------------------------------------------------- promise jobs

const info = new WeakMap();      // promise -> { parent, settled, job, children: [] }
const PENDING = 0;

function queue(p, rec, stack) {
  if (rec.job || rec.settled) return;
  rec.job = rec.pending;
  delete rec.pending;
  if (!stack) { const was = busy; busy = true; try { stack = stackNow(); } finally { busy = was; } }
  emit({ k: 'enq', ...rec.job, stack });
}

v8.promiseHooks.createHook({
  init(p, parent) {
    if (busy || !parent) { if (!busy) info.set(p, { settled: false, children: [] }); return; }
    busy = true;
    try {
      const f = frames();
      if (!f.length && !current) return;                 // a promise made inside Node itself
      const at = f[0] || { line: current?.line ?? 0, col: 1, fn: null };
      const code = snippet(at.line, at.col);
      // What made this job, read from the source at the position V8 reports: "await ...", ".then(...)", or a combinator's own step.
      let label, shown;
      const nat = f.native || [];
      const combinator = nat.map(n => n.match(/^(?:Function|Promise)\.(all|allSettled|race|any)$/)).find(Boolean);
      const method = (nat[0] || '').match(/^Promise\.(then|catch|finally)$/);
      if (combinator) { label = `Promise.${combinator[1]}() step`; shown = code; }
      else if (method) { label = `.${method[1]}() callback`; shown = /^(then|catch|finally)\b/.test(code) ? '.' + code : code; }
      else if (!nat.length && at.fn !== undefined && /\bawait\b/.test(src[at.line - 1] || '')) {
        label = `resume ${at.fn ? at.fn + '()' : 'async function'} after await`;
        const line = (src[at.line - 1] || '').trim();
        shown = (line.match(/await\b.*?(?=;?\s*$)/) || [code])[0].slice(0, 46);
      }
      else { label = 'promise job'; shown = code; }
      const rec = { settled: false, children: [], pending: { id: ++seq, q: 'micro', label, line: at.line, code: shown } };
      info.set(p, rec);
      const pr = info.get(parent);
      if (pr && pr.settled) queue(p, rec, stackNow(f));
      else if (pr) pr.children.push(p);
      else rec.orphan = true;                            // parent made by Node: queued when it runs
    } finally { busy = false; }
  },
  settled(p) {
    const rec = info.get(p);
    if (!rec) return;
    rec.settled = true;
    for (const c of rec.children) { const cr = info.get(c); if (cr) queue(c, cr); }
    rec.children = [];
  },
  before(p) {
    const rec = info.get(p);
    if (!rec) return;
    if (!rec.job && rec.pending) queue(p, rec);       // its parent was made by Node (an "orphan"): seen only now
    if (!rec.job) return;
    rec.prev = current;
    current = rec.job;
    emit({ k: 'run', id: rec.job.id, q: 'micro', line: rec.job.line });
  },
  after(p) {
    const rec = info.get(p);
    if (!rec || !rec.job || current !== rec.job) return;
    emit({ k: 'done', id: rec.job.id, q: 'micro' });
    current = rec.prev || null;
  },
});

// ---------------------------------------------------------------- run it

process.on('exit', code => {
  fs.writeSync(1, '\u0002EVLOOP ' + JSON.stringify({ events, code: code || 0 }) + '\n');
});
process.on('uncaughtException', e => {
  const m = String(e && e.stack || '').match(new RegExp(base.replace(/\./g, '\\.') + ':(\\d+)'));
  emit({ k: 'error', text: (e && e.name ? e.name + ': ' : '') + (e && e.message || String(e)), line: m ? Number(m[1]) : 0 });
  process.exit(1);
});

emit({ k: 'start', stack: ['main script'] });
try { require(file); }
catch (e) {
  if (e && e.code === 'ERR_REQUIRE_ASYNC_MODULE') {
    emit({ k: 'error', text: 'Top-level await is not shown in this view: put the code in an async function main() and call it.', line: 0 });
  } else throw e;
}
scriptDone = true;
emit({ k: 'scriptEnd', stack: [] });
