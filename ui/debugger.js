// The time-travel debugger's UI. The server records the whole run (server/CodeDebugger.cs): every step's
// file, line, locals and call stack, plus exceptions and output. Here you move through that recording like a
// live debugger: continue to the next breakpoint, step over / into / out, and the same backwards.
// Used by Code spaces (many files: ui/codespaces.js) and the Playground (one file: ui/app.js).
import { h, api } from './util.js';

const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

/** The key scheme, shown in tooltips and the help line. "Alt" is the backwards modifier. */
export const DEBUG_KEYS = {
  start: 'F5', run: 'Ctrl+F5', cont: 'F5', rcont: 'Alt+F5', over: 'F10', into: 'F11', out: 'Shift+F11',
  back: 'Alt+F10', backInto: 'Alt+F11', backOut: 'Alt+Shift+F11', restart: 'Ctrl+Shift+F5', stop: 'Shift+F5', toggle: 'F9',
};

/** Breakpoints: { file: Set(lines) }, saved under a localStorage key. */
export function breakpointStore(key) {
  let map = new Map();
  try { for (const [f, lines] of Object.entries(JSON.parse(localStorage.getItem(key) || '{}'))) map.set(f, new Set(lines)); } catch { }
  const save = () => { try { localStorage.setItem(key, JSON.stringify(Object.fromEntries([...map].filter(([, s]) => s.size).map(([f, s]) => [f, [...s].sort((a, b) => a - b)])))); } catch { } };
  return {
    lines: file => map.get(file) || new Set(),
    has: (file, line) => !!map.get(file)?.has(line),
    toggle(file, line) {
      const s = map.get(file) || new Set();
      s.has(line) ? s.delete(line) : s.add(line);
      map.set(file, s); save();
      return s.has(line);
    },
    rename(from, to) { if (map.has(from)) { map.set(to, map.get(from)); map.delete(from); save(); } },
    clear() { map = new Map(); save(); },
    list: () => [...map].flatMap(([file, s]) => [...s].map(line => ({ file, line }))),
    count: () => [...map.values()].reduce((n, s) => n + s.size, 0),
  };
}

/**
 * @param show(file, line, kind)  put the editor on a location ('' kind: current line, 'exception', 'frame'); show(null) clears
 * @param breakpoints            a breakpointStore
 * @param onRestart / onStop      host actions (restart records the run again)
 * @param watchKey               localStorage key for the watch list
 */
export function createDebugger({ show, breakpoints, onRestart, onStop, watchKey = 'dojo-debug-watch' }) {
  let data = null, at = 0, depth = [], outEnd = [], frameSel = -1;
  let watches = [];
  try { watches = JSON.parse(localStorage.getItem(watchKey) || '[]'); } catch { }
  const expanded = new Set();

  // ---------------------------------------------------------------- elements
  const K = DEBUG_KEYS;
  const btn = (label, title, fn, cls = '') => h(`button.btn.ghost.small.dbg-btn${cls}`, { type: 'button', title, onclick: fn }, label);
  const slider = h('input.dbg-slider', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Timeline', oninput: e => go(Number(e.target.value)) });
  const ticks = h('div.dbg-ticks', { 'aria-hidden': 'true' });
  const status = h('div.dbg-status');
  const banner = h('div.dbg-banner', { hidden: true });
  const notes = h('div.dbg-notes.small.muted', { hidden: true });
  const bar = h('div.dbg-bar',
    h('div.dbg-controls',
      btn('▶ Continue', `Continue to the next breakpoint (${K.cont})`, () => cont(1), '.primary-ish'),
      btn('⤼ Over', `Step over (${K.over})`, () => stepOver(1)),
      btn('↓ Into', `Step into (${K.into})`, () => stepInto(1)),
      btn('↑ Out', `Step out (${K.out})`, () => stepOut(1)),
      h('span.dbg-sep'),
      btn('◀◀ Reverse', `Reverse continue: back to the previous breakpoint (${K.rcont})`, () => cont(-1)),
      btn('⤽ Back', `Step back (${K.back}); back into: ${K.backInto}; back out: ${K.backOut}`, () => stepOver(-1)),
      h('span.dbg-sep'),
      btn('↻ Restart', `Record the run again (${K.restart})`, () => onRestart?.()),
      btn('■ Stop', `Stop debugging (${K.stop})`, () => onStop?.()),
      h('span.spacer'),
      h('span.dbg-pos.small.mono')),
    h('div.dbg-timeline', ticks, slider),
    status, banner, notes);
  const pos = bar.querySelector('.dbg-pos');

  const varsEl = h('div.dbg-vars');
  const watchList = h('div.dbg-watch');
  const watchInput = h('input.dbg-watch-input.mono', { placeholder: 'Add a watch: total, cart.Count, items[0].Name', spellcheck: false,
    onkeydown: e => { if (e.key === 'Enter' && watchInput.value.trim()) { watches.push(watchInput.value.trim()); watchInput.value = ''; saveWatches(); paintWatch(); } } });
  const stackEl = h('div.dbg-stack');
  const outEl = h('pre.dbg-out');
  const varsHead = h('span.small.muted');
  const side = h('div.dbg-side',
    h('section.dbg-panel', h('div.dbg-head', h('b', 'Variables'), varsHead), varsEl),
    h('section.dbg-panel', h('div.dbg-head', h('b', 'Watch'), h('span.small.muted', 'locals, .Property, [index], ["key"]')), watchList, watchInput),
    h('section.dbg-panel', h('div.dbg-head', h('b', 'Call stack'), h('span.small.muted', 'click a frame to look at it')), stackEl));
  const saveWatches = () => { try { localStorage.setItem(watchKey, JSON.stringify(watches)); } catch { } };

  // ---------------------------------------------------------------- loading
  /**
   * @param d     a recording (server/CodeSpaces.Debug.cs Shape); d.live is a live session's state
   * @param from  the recording continues an earlier one (interactive input): move on from this step instead of the start
   */
  function load(d, { from = -1 } = {}) {
    data = d;
    const ev = data.events || [];
    depth = ev.map(e => (e.s >= 0 && data.stacks[e.s] ? data.stacks[e.s].length : 0));
    let n = 0;
    outEnd = ev.map(e => (n += (e.o || '').length));
    slider.max = Math.max(0, ev.length - 1);
    paintTicks();
    put(notes, (data.notes || []).map(t => h('div', t)), data.truncated && h('div', `The recording stopped after ${(data.maxEvents || ev.length).toLocaleString()} steps (is a loop endless?). Everything up to there is here.`));
    notes.hidden = !notes.childNodes.length;
    // Start where a live debugger would stop first: a breakpoint, else a crash, else where the program waits
    // for input, else the first step (or, continuing after input, the step after it).
    from = Math.min(from, ev.length - 1);
    let first = next(from, 1, i => isHit(i) || isCrash(i));
    if (first < 0 && isWaiting(last())) first = last();
    if (first < 0 && from >= 0) first = Math.min(from + 1, last());
    go(first >= 0 ? first : 0);
  }
  /** The program is blocked in Console.ReadLine at this (last) step of a live session. */
  const isWaiting = i => ev(i)?.k === 'input' && i === last() && !!data?.live?.waiting;
  const ev = i => data?.events?.[i];
  const isStep = i => { const e = ev(i); return !!e && !e.k; };
  const isCrash = i => ev(i)?.k === 'crash';
  const isHit = i => { const e = ev(i); return !!e && !e.k && e.f >= 0 && breakpoints.has(data.files[e.f], e.l); };
  /** The first index after (dir 1) or before (dir -1) i that matches, or -1. */
  function next(i, dir, test) {
    const n = data?.events?.length || 0;
    for (let j = i + dir; j >= 0 && j < n; j += dir) if (test(j)) return j;
    return -1;
  }
  const located = j => { const e = ev(j); return !!e && e.k !== 'end' && e.f >= 0; };
  const last = () => (data?.events?.length || 1) - 1;

  // ---------------------------------------------------------------- moving
  function go(i) {
    if (!data?.events?.length) { paint(); return; }
    at = Math.max(0, Math.min(i, last()));
    frameSel = -1;
    slider.value = at;
    paint();
  }
  const stepInto = dir => go(dir > 0 ? at + 1 : at - 1);
  function stepOver(dir) {
    const d = depth[at];
    const j = next(at, dir, k => located(k) && depth[k] <= d);
    go(j >= 0 ? j : dir > 0 ? last() : 0);
  }
  function stepOut(dir) {
    const d = depth[at];
    const j = next(at, dir, k => located(k) && depth[k] < d);
    go(j >= 0 ? j : dir > 0 ? last() : 0);
  }
  function cont(dir) {
    const j = next(at, dir, k => isHit(k) || (dir > 0 && isCrash(k)));
    go(j >= 0 ? j : dir > 0 ? last() : 0);
  }
  /** Re-mark the timeline after breakpoints change. */
  function breakpointsChanged() { paintTicks(); paintStatus(); }

  // ---------------------------------------------------------------- painting
  function paintTicks() {
    const n = data?.events?.length || 0;
    const marks = [];
    if (n > 1) {
      let count = 0;
      for (let i = 0; i < n && count < 400; i++) {
        const e = data.events[i];
        const kind = e.k === 'crash' ? 'crash' : e.k === 'throw' ? 'throw' : isHit(i) ? 'hit' : null;
        if (!kind) continue;
        count++;
        marks.push(h(`span.dbg-tick.${kind}`, { style: { left: `${(i / (n - 1)) * 100}%` } }));
      }
    }
    put(ticks, marks);
  }

  const where = (f, l) => (f >= 0 ? `${data.files[f]}:${l}` : '(no source)');

  function paintStatus() {
    const e = ev(at);
    const n = data?.events?.length || 0;
    pos.textContent = n ? `step ${(at + 1).toLocaleString()} / ${n.toLocaleString()}` : '';
    if (!e) { put(status, h('span.muted', data?.error || 'Nothing was recorded.')); return; }
    const top = data.stacks[e.s]?.at(-1);
    put(status,
      e.k === 'end' && e.req ? h('span', h('b', 'The request finished: '), e.req, h('span.muted', ` Step back (${K.back}) or drag the timeline to look at any moment of it.`))
      : e.k === 'end' ? h('span', h('b', 'The program finished.'), h('span.muted', ` Step back (${K.back}) or drag the timeline to look at any moment of the run.`))
      : e.k === 'input' ? (isWaiting(at)
        ? h('span.warn', h('b', 'Waiting for input '), `at ${where(e.f, e.l)}: type a line in the Debug output panel and press Enter.`)
        : h('span', h('b', 'Console.ReadLine '), h('span.muted', `at ${where(e.f, e.l)}: the program read a line of input here.`)))
        : e.k === 'crash' ? h('span.bad', h('b', 'Stopped on an unhandled exception '), `at ${where(e.f, e.l)}`)
          : e.k === 'throw' ? h('span.warn', h('b', `${short(e.ty)} thrown `), `at ${where(e.f, e.l)} (the program may still catch it)`)
            : h('span', isHit(at) && h('span.dbg-bp-dot', { title: 'Breakpoint' }), h('b', top?.m || 'top level'), h('span.muted', ` · ${where(e.f, e.l)}`)));
  }
  const short = t => (t || '').split('.').pop();

  function paintBanner() {
    const x = data?.exception;
    banner.hidden = !x;
    if (!x) return;
    put(banner,
      h('div', h('b', `Unhandled ${short(x.ty)}`), h('span', `: ${x.msg}`)),
      h('div.small.muted', `${x.ty} · thrown at ${where(x.f, x.l)}`),
      !isCrash(at) && h('button.btn.ghost.small', { type: 'button', onclick: () => go(next(-1, 1, isCrash)) }, 'Go to the exception'));
  }

  /** The step whose locals belong to the selected frame: the current step, or the step in that frame that made the call. */
  function frameStep() {
    const e = ev(at);
    if (!e || frameSel < 0) return at;
    const frames = data.stacks[e.s] || [];
    if (frameSel >= frames.length - 1) return at;
    for (let j = at - 1; j >= 0; j--) if (located(j) && depth[j] === frameSel + 1) return j;
    return at;
  }
  /** The previous step in the same frame, for change highlighting. */
  function previousInFrame(i) {
    const e = ev(i);
    if (!e) return null;
    const name = data.stacks[e.s]?.at(-1)?.m;
    for (let j = i - 1; j >= 0; j--) {
      if (!located(j)) continue;
      if (depth[j] < depth[i]) return null;   // the frame started after j
      if (depth[j] === depth[i]) return data.stacks[ev(j).s]?.at(-1)?.m === name ? j : null;
    }
    return null;
  }
  const varsOf = i => (ev(i)?.v || []).map(id => data.values[id]).filter(Boolean);

  function paintVars() {
    const i = frameStep();
    const vars = varsOf(i);
    const p = previousInFrame(i);
    const before = p == null ? null : new Map(varsOf(p).map(v => [v.n, v]));
    const frames = data?.stacks?.[ev(at)?.s] || [];
    varsHead.textContent = frameSel >= 0 && frameSel < frames.length - 1 ? `in ${frames[frameSel].m}, at the call` : frames.at(-1)?.m || '';
    if (!vars.length) { put(varsEl, h('div.muted.small.dbg-pad', ev(at) ? 'No variables here yet.' : '')); return; }
    put(varsEl, vars.map(v => {
      const old = before?.get(v.n);
      const changed = before && old && JSON.stringify(old) !== JSON.stringify(v);
      const fresh = before && !old;
      const kids = v.props?.length ? v.props.map(p => [p.n, p.t, p.ty]) : v.items?.length ? v.items.map((t, k) => [v.keys ? v.keys[k] : `[${k}]`, t]) : null;
      const open = expanded.has(v.n);
      return h(`div.dbg-var${changed ? '.changed' : ''}${fresh ? '.fresh' : ''}`,
        h('div.dbg-var-row', { onclick: kids ? () => { open ? expanded.delete(v.n) : expanded.add(v.n); paintVars(); } : null, style: { cursor: kids ? 'pointer' : 'default' } },
          h('span.dbg-twisty', kids ? (open ? '▾' : '▸') : ''),
          h('span.dbg-name.mono', v.n),
          h('span.dbg-val.mono', { title: v.t }, v.t),
          h('span.dbg-type.small', v.ty ? v.ty + (v.c != null ? ` (${v.c})` : '') : '')),
        open && kids && h('div.dbg-kids', kids.map(([n, t, ty]) => h('div.dbg-kid', h('span.dbg-name.mono', n), h('span.dbg-val.mono', { title: t }, t), h('span.dbg-type.small', ty || ''))),
          v.c > (v.items?.length || 0) && !v.props?.length ? h('div.small.muted.dbg-kid', `… ${v.c - v.items.length} more (the first ${v.items.length} are recorded)`) : null));
    }));
  }

  // ---------------------------------------------------------------- watch: locals and their members, evaluated from the recording
  function evaluate(expr, vars) {
    const tokens = [];
    const rx = /\s*(?:([A-Za-z_]\w*)|\.\s*([A-Za-z_]\w*)|\[\s*(-?\d+|"(?:[^"\\]|\\.)*"|'.')\s*\])/y;
    let m, i = 0;
    rx.lastIndex = 0;
    while (i < expr.length && (m = rx.exec(expr))) { tokens.push(m); i = rx.lastIndex; }
    if (expr.slice(i).trim() || !tokens.length || !tokens[0][1]) return { error: 'Use a local, then .Member, [index] or ["key"]' };
    const byName = new Map(vars.map(v => [v.n, v]));
    let cur = byName.get(tokens[0][1]);
    if (!cur) {
      const self = byName.get('this')?.props?.find(p => p.n === tokens[0][1]);
      if (!self) return { error: `${tokens[0][1]} is not in scope here` };
      cur = self;
    }
    for (const t of tokens.slice(1)) {
      if (t[2]) {
        const name = t[2];
        if ((name === 'Count' || name === 'Length') && cur.c != null) { cur = { t: String(cur.c), ty: 'int' }; continue; }
        const p = cur.props?.find(x => x.n === name);
        if (!p) return { error: cur.props ? `no member ${name} was recorded` : `${name}: only one level of members is recorded` };
        cur = p;
      } else {
        const raw = t[3];
        if (!cur.items) return { error: 'not a recorded collection' };
        let k;
        if (cur.keys) {
          const key = raw.startsWith("'") ? raw : raw;
          k = cur.keys.indexOf(key);
          if (k < 0) return { error: `no key ${raw} among the recorded ones` };
        } else {
          k = Number(raw);
          if (!Number.isInteger(k)) return { error: 'use a number index' };
          if (k < 0 || k >= (cur.c ?? cur.items.length)) return { error: `index ${k} is out of range (count ${cur.c})` };
          if (k >= cur.items.length) return { error: `only the first ${cur.items.length} items are recorded` };
        }
        const props = cur.iprops?.[k];
        cur = { t: cur.items[k], props: Array.isArray(props) ? props : undefined };
      }
    }
    return { value: cur.t, ty: cur.ty };
  }

  function paintWatch() {
    const vars = varsOf(frameStep());
    const p = previousInFrame(frameStep());
    const pv = p == null ? null : varsOf(p);
    put(watchList, watches.length ? watches.map((w, k) => {
      const r = data?.events?.length ? evaluate(w, vars) : { error: 'not running' };
      const old = pv ? evaluate(w, pv) : null;
      const changed = old && !old.error && !r.error && old.value !== r.value;
      return h(`div.dbg-var${changed ? '.changed' : ''}`, h('div.dbg-var-row',
        h('span.dbg-twisty', ''),
        h('span.dbg-name.mono', w),
        r.error ? h('span.dbg-val.muted.small', r.error) : h('span.dbg-val.mono', { title: r.value }, r.value),
        h('button.icon-btn.small.dbg-x', { type: 'button', title: 'Remove', onclick: () => { watches.splice(k, 1); saveWatches(); paintWatch(); } }, '×')));
    }) : h('div.muted.small.dbg-pad', 'Type an expression below and press Enter.'));
  }

  function paintStack() {
    const e = ev(at);
    const frames = data?.stacks?.[e?.s] || [];
    if (!frames.length) { put(stackEl, h('div.muted.small.dbg-pad', e?.k === 'end' ? 'The program has finished.' : '')); return; }
    const sel = frameSel < 0 ? frames.length - 1 : frameSel;
    put(stackEl, frames.map((f, k) => h(`button.dbg-frame${k === sel ? '.active' : ''}${k === frames.length - 1 ? '.top' : ''}`, {
      type: 'button', disabled: f.f < 0,
      onclick: () => {
        frameSel = k === frames.length - 1 ? -1 : k;
        if (f.f >= 0) show(data.files[f.f], f.l, k === frames.length - 1 ? currentKind() : 'frame');
        paintVars(); paintWatch(); paintStack();
      },
    }, h('span.dbg-frame-m.mono', f.m), h('span.dbg-frame-at.small.mono', f.f >= 0 ? `${data.files[f.f].split('/').pop()}:${f.l}` : 'no stops recorded'))).reverse());
  }

  function paintOutput() {
    const text = data?.output || '';
    outEl.textContent = text.slice(0, outEnd[at] ?? 0);
    outEl.scrollTop = outEl.scrollHeight;
  }

  const currentKind = () => (ev(at)?.k === 'crash' || ev(at)?.k === 'throw' ? 'exception' : '');
  function paint() {
    const e = ev(at);
    paintStatus(); paintBanner(); paintVars(); paintWatch(); paintStack(); paintOutput();
    if (e && e.f >= 0 && e.k !== 'end') show(data.files[e.f], e.l, currentKind());
    else show(null);
  }

  // ---------------------------------------------------------------- keys (Alt is the backwards modifier)
  function key(e) {
    if (!data) return false;
    const alt = e.altKey, shift = e.shiftKey, ctrl = e.ctrlKey || e.metaKey;
    const act = {
      F5: () => (ctrl && shift ? onRestart?.() : shift ? onStop?.() : !ctrl && cont(alt ? -1 : 1)),
      F10: () => !ctrl && !shift && stepOver(alt ? -1 : 1),
      F11: () => !ctrl && (shift ? stepOut(alt ? -1 : 1) : stepInto(alt ? -1 : 1)),
    }[e.key];
    if (!act) return false;
    if (e.key === 'F5' && ctrl && !shift) return false;   // Ctrl+F5 is Run, the host's business
    e.preventDefault(); e.stopPropagation();
    act();
    return true;
  }

  return {
    bar, side, output: outEl,
    load, key, breakpointsChanged,
    get active() { return !!data; },
    get data() { return data; },
    /** Leave the session: forget the recording and clear the highlight. */
    close() { data = null; show(null); },
    /** Repaint after the host re-opened a file (to put the highlight back). */
    refresh() { if (data) paint(); },
  };
}

/**
 * The same debugger for the Playground's single C# file. The editor must be created with
 * onGutterClick: line => pg.toggle(line). Returns { button, panel, toggle, dispose }.
 * Keys: F5 debug / continue, Ctrl+F5 run (calls run), F9 breakpoint, and the stepping keys while debugging.
 */
export function playgroundDebugger(editor, { stdin = () => '', run } = {}) {
  const FILE = 'Program.cs';
  const bps = breakpointStore('dojo-playground-bps');
  editor.setBreakpoints(bps.lines(FILE));
  let busy = false;
  const note = h('span.small.muted');
  const button = h('button.btn.ghost', { type: 'button', title: `Debug: record the run, then step through it, backwards too (${DEBUG_KEYS.start}). Click a line number for a breakpoint (${DEBUG_KEYS.toggle}).`, onclick: () => start() }, '● Debug');
  const dbg = createDebugger({
    show: (file, line, kind) => editor.setCurrent(file ? line : 0, kind),
    breakpoints: bps,
    onRestart: () => start(),
    onStop: () => stop(),
    watchKey: 'dojo-playground-watch',
  });
  const panel = h('div.pg-debug', { hidden: true },
    dbg.bar,
    h('div.pg-debug-grid', dbg.side, h('div', h('div.dbg-head', h('b', 'Output')), dbg.output)));

  async function start() {
    if (busy) return;
    busy = true; button.disabled = true; button.textContent = '● Recording…';
    let r;
    try { r = await api('debug', { code: editor.value, stdin: stdin(), breakpoints: bps.list() }); }
    catch { r = { error: 'Could not reach the dojo server.' }; }
    busy = false; button.disabled = false; button.textContent = '● Debug';
    editor.mark(r.diagnostics || []);
    if (r.error && !r.events?.length) {
      panel.hidden = false;
      panel.replaceChildren(h('div.dbg-bar', h('div.dbg-status', h('span.bad', r.error)),
        h('div', h('button.btn.ghost.small', { type: 'button', onclick: () => { panel.hidden = true; restore(); } }, 'Close'))));
      return;
    }
    restore();
    panel.hidden = false;
    dbg.load(r);
  }
  const restore = () => { if (!panel.contains(dbg.bar)) panel.replaceChildren(dbg.bar, h('div.pg-debug-grid', dbg.side, h('div', h('div.dbg-head', h('b', 'Output')), dbg.output))); };
  function stop() { dbg.close(); panel.hidden = true; }
  function toggle(line) {
    bps.toggle(FILE, line);
    editor.setBreakpoints(bps.lines(FILE));
    dbg.breakpointsChanged();
  }
  const onKey = e => {
    if (!document.body.contains(button)) { document.removeEventListener('keydown', onKey, true); return; }
    if (dbg.active && dbg.key(e)) return;
    if (e.key === 'F9') { e.preventDefault(); toggle(editor.caretLine()); }
    else if (e.key === 'F5' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); run?.(); }
    else if (e.key === 'F5' && !e.shiftKey && !e.altKey) { e.preventDefault(); start(); }
  };
  document.addEventListener('keydown', onKey, true);
  return { button, panel, note, toggle, dispose: () => document.removeEventListener('keydown', onKey, true) };
}
