// Visualizers for Python and TypeScript, run for real on the server (server/PolyViz.cs):
//   memoryTrace(spec, { lang })  steps through a program like a debugger: the line about to run, every frame on the
//                                call stack with its names, and the objects those names point to, drawn as arrows.
//                                Two names pointing at one list share one box, so aliasing and mutation are visible.
//   eventLoop(spec)              replays what Node's event loop did: the call stack, the microtask queue (promise
//                                callbacks, resumption after await), the macrotask queue (timers) and the console,
//                                one event at a time, with a sentence saying why it happened.
// Both scrub forwards and backwards (← →, the bar, or Play).
import { h, api, highlight, esc } from './util.js';
import { createEditor } from './editor.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Shared transport: play / pause, step, scrub, speed. Calls go(i) with the new position. */
function transport(label, { count, go, at }) {
  let timer = null, speed = 700;
  const play = h('button.btn.primary.small', { type: 'button', onclick: () => (timer ? pause() : start()) }, '▶ ' + label);
  const slider = h('input.ct-slider', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Step', oninput: e => { pause(); go(Number(e.target.value)); } });
  function start() {
    if (!count()) return;
    if (at() >= count() - 1) go(0);
    play.textContent = '❚❚ Pause';
    const tick = () => { if (at() < count() - 1) { go(at() + 1); timer = setTimeout(tick, speed); } else pause(); };
    timer = setTimeout(tick, 120);
  }
  function pause() { clearTimeout(timer); timer = null; play.textContent = '▶ ' + label; }
  const el = h('div.ct-controls',
    play,
    h('button.btn.ghost.small', { type: 'button', title: 'Back one step (←)', 'aria-label': 'Back one step', onclick: () => { pause(); go(at() - 1); } }, '◀'),
    h('button.btn.ghost.small', { type: 'button', title: 'Forward one step (→)', 'aria-label': 'Forward one step', onclick: () => { pause(); go(at() + 1); } }, '▶'),
    slider,
    h('select.ct-speed', { title: 'Speed', onchange: e => { speed = Number(e.target.value); } },
      [[1200, 'slow'], [700, 'normal'], [300, 'fast'], [90, 'very fast']].map(([v, l]) => h('option', { value: v, selected: v === speed }, l))));
  const keys = e => {
    if (e.target.matches('textarea, input, select, [contenteditable]')) return;
    if (e.key === 'ArrowRight') { pause(); go(at() + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { pause(); go(at() - 1); e.preventDefault(); }
  };
  return { el, slider, pause, keys };
}

function codePane(lines, lang, now, was) {
  return lines.map((text, i) => h(`div.ct-line${now === i + 1 ? '.now' : ''}${was === i + 1 && now !== i + 1 ? '.was' : ''}`,
    h('span.ct-ln', i + 1), h('span.ct-src', { html: highlight(text, lang) || ' ' })));
}

// ================================================================= memory trace (Python, TypeScript)

/**
 * @param spec  { code, stdin? }  code may be a string or an array of lines
 * @param opts  { lang: 'python' | 'typescript', editable }
 */
export function memoryTrace(spec, { lang = 'python', editable = false } = {}) {
  let code = Array.isArray(spec.code) ? spec.code.join('\n') : spec.code || '';
  let data = null, at = 0;
  const py = lang === 'python';

  const codeView = h('div.ct-code.pv-code');
  const framesView = h('div.pv-frames');
  const heapView = h('div.pv-heap');
  const arrows = document.createElementNS(SVG, 'svg');
  arrows.classList.add('pv-arrows');
  const memory = h('div.pv-memory', arrows, h('div.pv-col', h('div.ct-head', 'Frames'), framesView), h('div.pv-col', h('div.ct-head', py ? 'Objects' : 'Objects (heap)'), heapView));
  const outView = h('pre.ct-out');
  const status = h('div.ct-status.small');
  const editor = editable ? createEditor({ value: code, minLines: 10, onRun: () => load() }) : null;
  const t = transport('Run step by step', { count: () => data?.steps.length || 0, at: () => at, go: i => go(i) });

  async function load() {
    t.pause();
    if (editor) code = editor.value;
    status.textContent = 'Running…';
    try { data = await api(py ? 'viz/pytrace' : 'viz/tstrace', { code, stdin: spec.stdin }); }
    catch { data = { error: 'Could not reach the dojo server.', steps: [], lines: code.split('\n') }; }
    data.steps = data.steps || [];
    t.slider.max = Math.max(0, data.steps.length - 1);
    go(0);
  }

  function go(i) {
    if (!data) return;
    at = Math.max(0, Math.min(i, data.steps.length - 1));
    t.slider.value = at;
    paint();
  }

  // An inline value, or a dot that an arrow leaves from.
  function cell(enc, heap, prevHeap) {
    if (!enc) return h('span.pv-val', '?');
    if (enc.r == null) return h('span.pv-val', enc.v);
    const node = heap[enc.r];
    return h('span.pv-ref', { dataset: { ref: enc.r }, title: node ? `${node.type || node.kind} #${enc.r}` : `#${enc.r}`,
      onmouseenter: () => mark(enc.r, true), onmouseleave: () => mark(enc.r, false) }, h('span.pv-dot'));
  }

  function mark(id, on) {
    for (const el of memory.querySelectorAll(`[data-id="${id}"], [data-ref="${id}"]`)) el.classList.toggle('hot', on);
    for (const p of arrows.querySelectorAll(`[data-to="${id}"]`)) p.classList.toggle('hot', on);
  }

  function objectBox(id, node, heap, prev) {
    const before = prev?.[id];
    const changed = before && JSON.stringify(before) !== JSON.stringify(node);
    const fresh = prev && !before;
    const label = node.kind === 'function' ? (py ? 'function' : 'function') : node.kind === 'class' ? 'class' : node.type || node.kind;
    const head = h('div.pv-obj-head', h('span.pv-type', label), h('span.pv-id', '#' + id));
    let body;
    if (node.kind === 'list' || node.kind === 'tuple' || node.kind === 'set') {
      const old = before?.items || [];
      body = h(`div.pv-items${node.kind === 'set' ? '.set' : ''}`, node.items?.length ? node.items.map((it, k) =>
        h(`div.pv-item${old[k] && JSON.stringify(old[k]) !== JSON.stringify(it) ? '.changed' : ''}${before && !old[k] ? '.changed' : ''}`,
          node.kind !== 'set' && h('span.pv-idx', k), cell(it, heap))) : h('span.muted.small', 'empty'),
        node.more && h('span.muted.small', '…'));
    } else if (node.kind === 'dict' || node.kind === 'object') {
      const old = new Map((before?.pairs || []).map(([k, v]) => [JSON.stringify(k), JSON.stringify(v)]));
      body = h('div.pv-pairs', node.pairs?.length ? node.pairs.map(([k, v]) => {
        const key = JSON.stringify(k);
        const diff = before && old.get(key) !== JSON.stringify(v);
        return h(`div.pv-pair${diff ? '.changed' : ''}`, h('span.pv-key', k.r != null ? cell(k, heap) : node.kind === 'object' ? k.v : k.v), cell(v, heap));
      }) : h('span.muted.small', 'empty'), node.more && h('span.muted.small', '…'));
    } else if (node.kind === 'generator') {
      body = h('div.pv-plain', h('code', node.name + '()'), h('span.muted.small', ' · ' + node.state));
    } else if (node.kind === 'function' || node.kind === 'class' || node.kind === 'module') {
      body = h('div.pv-plain', h('code', node.name || '?'));
    } else {
      body = h('div.pv-plain', h('code', node.repr || ''));
    }
    return h(`div.pv-obj.k-${node.kind}${changed ? '.changed' : ''}${fresh ? '.fresh' : ''}`, { dataset: { id } }, head, body);
  }

  function paint() {
    const step = data.steps[at];
    const prev = data.steps[at - 1];
    const lines = data.lines || code.split('\n');
    codeView.replaceChildren(...codePane(lines, lang, step && !step.end ? step.l : 0, prev && !prev.end ? prev.l : 0));
    const nowEl = codeView.querySelector('.now');
    if (nowEl) codeView.scrollTop = Math.max(0, nowEl.offsetTop - codeView.clientHeight / 2);

    if (data.error && !data.steps.length) {
      status.replaceChildren(h('span.bad', data.error));
      framesView.replaceChildren(); heapView.replaceChildren(); outView.textContent = ''; arrows.replaceChildren();
      return;
    }
    const heap = step?.h || {};
    const prevHeap = prev?.h;
    const frames = step?.s || [];
    const prevFrames = new Map((prev?.s || []).map((f, i) => [i + f.name, new Map(f.vars.map(([n, v]) => [n, JSON.stringify(v)]))]));

    framesView.replaceChildren(...(frames.length ? frames.map((f, i) => {
      const top = i === frames.length - 1 && !step.end;
      const old = prevFrames.get(i + f.name);
      const rows = f.vars.map(([n, v, kind]) => {
        const changed = old && old.get(n) !== JSON.stringify(v);
        return h(`div.pv-var${changed ? '.changed' : ''}${kind === 'closure' ? '.closure' : ''}`, h('span.pv-name', n), cell(v, heap), kind === 'closure' && h('span.pv-tag', 'captured'));
      });
      if (top && step.ev === 'return' && step.ret) rows.push(h('div.pv-var.ret', h('span.pv-name', step.yield ? 'yields' : 'returns'), cell(step.ret, heap)));
      return h(`div.pv-frame${top ? '.top' : ''}`,
        h('div.pv-frame-head', h('span', f.name), !top && f.line > 0 && h('span.muted.small', ` line ${f.line}`)),
        rows.length ? rows : h('span.muted.small', 'no names yet'));
    }).reverse() : [h('span.muted.small', 'Nothing on the stack.')]));

    // Objects in the order the names reach them, nested objects after their owner.
    const order = [];
    const seen = new Set();
    const visit = enc => {
      if (!enc || enc.r == null || seen.has(enc.r) || !heap[enc.r]) return;
      seen.add(enc.r); order.push(enc.r);
      const n = heap[enc.r];
      (n.items || []).forEach(visit);
      (n.pairs || []).forEach(([k, v]) => { visit(k); visit(v); });
    };
    for (const f of frames.slice().reverse()) for (const [, v] of f.vars) visit(v);
    if (step?.ret) visit(step.ret);
    heapView.replaceChildren(...(order.length ? order.map(id => objectBox(id, heap[id], heap, prevHeap)) : [h('span.muted.small', 'No objects yet.')]));

    outView.textContent = data.steps.slice(0, at + 1).map(s => s.o || '').join('');
    const line = step && !step.end ? lines[step.l - 1]?.trim() : null;
    const shared = sharing(frames);
    status.replaceChildren(
      h('b', `Step ${at + 1} of ${data.steps.length}`),
      step?.end ? h('span', ' · the program has finished')
        : step?.ev === 'return' ? h('span.muted', ` · ${frames.at(-1)?.name || 'the function'} ${step.yield ? 'yields' : 'returns'} (line ${step.l})`)
        : step?.ev === 'exception' ? h('span.bad', ` · ${step.exc} raised on line ${step.l}`)
        : line ? h('span.muted', ` · about to run line ${step.l}: `, h('code', line)) : '',
      shared && h('span.pv-alias', ' · ' + shared),
      data.truncated ? h('span.warn', ' · stopped after 800 steps (is a loop endless?)') : '',
      data.error ? h('span.bad', ' · ' + data.error) : '');
    requestAnimationFrame(drawArrows);
  }

  /** "a and b are the same list (#1)": names that share one mutable object right now. */
  function sharing(frames) {
    const by = new Map();
    for (const f of frames) for (const [n, v] of f.vars) {
      if (v?.r == null) continue;
      const node = data.steps[at].h[v.r];
      if (!node || !['list', 'dict', 'set', 'object'].includes(node.kind)) continue;
      const names = by.get(v.r) || []; names.push(frames.length > 1 ? `${n} (${f.name})` : n); by.set(v.r, names);
    }
    const hit = [...by].find(([, names]) => names.length > 1);
    if (!hit) return '';
    const node = data.steps[at].h[hit[0]];
    return `${hit[1].join(' and ')} are the same ${node.type || node.kind} (#${hit[0]})`;
  }

  function drawArrows() {
    arrows.replaceChildren();
    const box = memory.getBoundingClientRect();
    if (!box.width) return;
    arrows.setAttribute('width', box.width); arrows.setAttribute('height', memory.scrollHeight);
    arrows.setAttribute('viewBox', `0 0 ${box.width} ${memory.scrollHeight}`);
    const defs = document.createElementNS(SVG, 'defs');
    defs.innerHTML = '<marker id="pv-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker>';
    arrows.append(defs);
    for (const dot of memory.querySelectorAll('.pv-ref')) {
      const id = dot.dataset.ref;
      const target = heapView.querySelector(`.pv-obj[data-id="${id}"]`);
      if (!target) continue;
      const a = dot.getBoundingClientRect(), b = target.getBoundingClientRect();
      const x1 = a.left + a.width / 2 - box.left, y1 = a.top + a.height / 2 - box.top + memory.scrollTop;
      const inHeap = !!dot.closest('.pv-heap');
      // Into the object's left edge, near its header; from inside the heap, loop out to the right.
      let x2 = b.left - box.left - 2, y2 = b.top - box.top + 14 + memory.scrollTop, d;
      if (inHeap) { x2 = b.right - box.left + 2; const cx = Math.max(x1, x2) + 46; d = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`; }
      else { const dx = Math.max(30, (x2 - x1) / 2); d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; }
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      p.setAttribute('marker-end', 'url(#pv-head)');
      p.dataset.to = id;
      arrows.append(p);
    }
  }
  new ResizeObserver(() => data && requestAnimationFrame(drawArrows)).observe(memory);

  const root = h('div.ct.pv', { tabindex: 0, onkeydown: t.keys },
    h('div.ct-title', h('b', py ? 'Code in motion · Python' : 'Code in motion · TypeScript'),
      h('span.muted.small', py ? ' runs for real · names on the left, the objects they point to on the right · ← → to step'
        : ' runs for real in Node with the V8 debugger · ← → to step')),
    editable && h('div.ct-edit', editor.el, h('div.ct-edit-bar', h('button.btn.ghost.small', { type: 'button', onclick: load }, 'Trace this code'), h('span.muted.small', 'Ctrl + Enter'))),
    t.el, status,
    h('div.pv-grid',
      codeView,
      h('div.pv-side', h('div.ct-panel.pv-mem-panel', memory), h('div.ct-panel', h('div.ct-head', 'Output'), outView))));
  load();
  return root;
}

// ================================================================= event loop (TypeScript / JavaScript)

const Q_NAME = { micro: 'microtask', macro: 'macrotask', tick: 'nextTick' };

/** @param spec { code }  a small TypeScript program using console.log, setTimeout, promises, async/await */
export function eventLoop(spec, { editable = false } = {}) {
  let code = Array.isArray(spec.code) ? spec.code.join('\n') : spec.code || '';
  let data = null, at = 0, states = [];
  const codeView = h('div.ct-code.ev-code');
  const stackView = h('div.ev-stack');
  const tickView = h('div.ev-queue');
  const microView = h('div.ev-queue');
  const macroView = h('div.ev-queue');
  const consoleView = h('div.ev-console');
  const phaseView = h('div.ev-phases');
  const why = h('div.ev-why');
  const status = h('div.ct-status.small');
  const tickPanel = h('div.ev-lane.tick', h('div.ev-lane-head', h('b', 'process.nextTick queue'), h('span.muted.small', ' runs first, before promise jobs')), tickView);
  const editor = editable ? createEditor({ value: code, minLines: 10, onRun: () => load() }) : null;
  const t = transport('Play', { count: () => states.length, at: () => at, go: i => go(i) });

  async function load() {
    t.pause();
    if (editor) code = editor.value;
    status.textContent = 'Running…';
    try { data = await api('viz/eventloop', { code }); } catch { data = { error: 'Could not reach the dojo server.', events: [], lines: code.split('\n') }; }
    states = replay(data.events || []);
    tickPanel.hidden = !states.some(s => s.tick.length) && !(data.events || []).some(e => e.q === 'tick');
    t.slider.max = Math.max(0, states.length - 1);
    go(0);
  }

  /** Every event becomes one frame of the film: what is on the stack, in each queue and in the console after it. */
  function replay(events) {
    const out = [];
    const jobs = new Map();
    let stack = [], micro = [], macro = [], tick = [], logs = [], phase = 'script', running = null;
    const snap = (e, text, extra = {}) => out.push({ e, text, line: extra.line ?? e.line ?? 0, stack: [...stack], micro: [...micro], macro: [...macro], tick: [...tick], logs: [...logs], phase, running, fresh: extra.fresh, ...extra });
    for (const e of events) {
      const j = e.id && jobs.get(e.id);
      switch (e.k) {
        case 'start':
          stack = ['main script'];
          snap(e, 'The script starts. JavaScript runs one thing at a time, on one call stack.');
          break;
        case 'log': {
          stack = e.stack?.length ? e.stack : stack;
          logs.push({ text: e.text, n: logs.length });
          const inside = running ? ` It runs inside ${running.label}.` : '';
          snap(e, `console.log prints ${JSON.stringify(e.text)}.${inside}`, { newLog: logs.length - 1 });
          break;
        }
        case 'enq': {
          jobs.set(e.id, e);
          if (e.stack?.length) stack = e.stack;
          (e.q === 'micro' ? micro : e.q === 'tick' ? tick : macro).push(e);
          const text = e.q === 'macro'
            ? (e.immediate ? 'setImmediate queues its callback as a macrotask (the check phase of the loop).'
              : `${e.code?.startsWith('setInterval') ? 'setInterval' : 'setTimeout'} gives the callback to the timer system. After ${e.delay ?? 0} ms it waits in the macrotask queue: it runs only when the call stack is empty and every microtask has run.`)
            : e.q === 'tick' ? 'process.nextTick queues a callback. Node runs the nextTick queue before the promise microtasks.'
            : /after await/.test(e.label) ? `${e.label.replace(/^resume /, '').replace(/ after await$/, '')} reached await and is paused. Its value is ready, so "resume it" is queued as a microtask; the function gives the call stack back meanwhile.`
            : /^\.(then|catch|finally)/.test(e.label) ? `The promise is settled, so its ${e.label.replace(' callback', '')} callback is queued as a microtask. It will not run before the current code finishes.`
            : /^Promise\./.test(e.label) ? `${e.label.replace(' step', '')} does its own bookkeeping with a promise job (one more microtask).`
            : 'A promise job is queued as a microtask.';
          snap(e, text, { line: e.line, fresh: e.id });
          break;
        }
        case 'cancel':
          micro = micro.filter(x => x.id !== e.id); macro = macro.filter(x => x.id !== e.id); tick = tick.filter(x => x.id !== e.id);
          snap(e, 'The timer is cleared: its callback leaves the queue and will never run.', { line: jobs.get(e.id)?.line });
          break;
        case 'scriptEnd':
          stack = []; phase = micro.length || tick.length ? 'micro' : 'macro';
          snap(e, (micro.length || tick.length)
            ? 'The script has finished: the call stack is empty. Before anything else, the event loop runs every queued microtask, oldest first, including ones queued while it drains.'
            : 'The script has finished: the call stack is empty. No microtasks are waiting, so the loop moves on to the macrotask queue.', { line: 0 });
          break;
        case 'run': {
          const q = e.q === 'micro' ? micro : e.q === 'tick' ? tick : macro;
          const i = q.findIndex(x => x.id === e.id);
          if (i >= 0) q.splice(i, 1);
          running = j || { label: 'a callback', q: e.q };
          stack = [running.label];
          phase = e.q === 'macro' ? 'macro' : 'micro';
          snap(e, e.q === 'macro'
            ? `No microtasks are left, so the event loop takes the next macrotask: ${running.label}.`
            : e.q === 'tick' ? 'The call stack is empty: first the nextTick queue runs.'
            : `The call stack is empty, so the oldest microtask runs: ${running.label}.`, { line: running.line, runningId: e.id });
          break;
        }
        case 'done':
          stack = []; running = null;
          phase = micro.length || tick.length ? 'micro' : macro.length ? 'macro' : 'idle';
          snap(e, `${j?.label || 'The callback'} has finished and leaves the call stack.${e.q === 'macro' && (micro.length || tick.length) ? ' Microtasks it queued run now, before the next macrotask.' : !micro.length && !macro.length && !tick.length ? ' Both queues are empty.' : ''}`, { line: 0 });
          break;
        case 'error':
          snap(e, `It throws: ${e.text}`, { error: true });
          break;
        case 'stop':
          snap(e, 'Stopped after 400 events.', {});
          break;
      }
    }
    if (out.length) out.push({ ...out[out.length - 1], e: { k: 'end' }, text: `The program is done. Output order: ${logs.map(l => l.text).join(', ') || '(nothing printed)'}.`, stack: [], running: null, phase: 'idle', line: 0, fresh: null, newLog: null });
    return out;
  }

  function go(i) {
    if (!data) return;
    at = Math.max(0, Math.min(i, states.length - 1));
    t.slider.value = at;
    paint();
  }

  const chip = (j, fresh) => h(`div.ev-job.${j.q}${fresh ? '.fresh' : ''}`, { title: j.code || '' },
    h('span.ev-job-label', j.label), j.code && h('code.ev-job-code', j.code), j.line > 0 && h('span.ev-job-line', 'line ' + j.line));

  function paint() {
    const s = states[at];
    const lines = data.lines || code.split('\n');
    codeView.replaceChildren(...codePane(lines, 'typescript', s?.line || 0, 0));
    if (!s) {
      status.replaceChildren(h('span.bad', data.error || 'Nothing ran.'));
      return;
    }
    stackView.replaceChildren(...(s.stack.length ? s.stack.slice().reverse().map((f, i) => h(`div.ev-frame${i === 0 ? '.top' : ''}`, f)) : [h('div.ev-empty', 'empty')]));
    tickView.replaceChildren(...(s.tick.length ? s.tick.map(j => chip(j, j.id === s.fresh)) : [h('div.ev-empty', 'empty')]));
    microView.replaceChildren(...(s.micro.length ? s.micro.map(j => chip(j, j.id === s.fresh)) : [h('div.ev-empty', 'empty')]));
    macroView.replaceChildren(...(s.macro.length ? s.macro.map(j => chip(j, j.id === s.fresh)) : [h('div.ev-empty', 'empty')]));
    consoleView.replaceChildren(...(s.logs.length ? s.logs.map(l => h(`div.ev-log${l.n === s.newLog ? '.fresh' : ''}`, h('span.ev-log-n', l.n + 1), l.text)) : [h('div.ev-empty', 'nothing printed yet')]));
    phaseView.replaceChildren(...[['script', '1 · Run the script'], ['micro', '2 · Drain all microtasks'], ['macro', '3 · Take one macrotask']].map(([k, l]) =>
      h(`span.ev-phase${s.phase === k ? '.on' : ''}`, l)), h('span.ev-loop', '↻ then 2 again'));
    why.replaceChildren(h('span', { html: esc(s.text).replace(/(\.then\(\)|\.catch\(\)|\.finally\(\)|await|setTimeout|setInterval|setImmediate|process\.nextTick|console\.log|queueMicrotask|Promise\.\w+\(\))/g, '<code>$1</code>') }));
    status.replaceChildren(h('b', `Event ${at + 1} of ${states.length}`),
      data.truncated ? h('span.warn', ' · stopped after 400 events') : '',
      data.error ? h('span.bad', ' · ' + data.error) : '');
  }

  const root = h('div.ct.ev', { tabindex: 0, onkeydown: t.keys },
    h('div.ct-title', h('b', 'The event loop'), h('span.muted.small', ' recorded from a real run in Node · ← → to step')),
    editable && h('div.ct-edit', editor.el, h('div.ct-edit-bar', h('button.btn.ghost.small', { type: 'button', onclick: load }, 'Run this code'), h('span.muted.small', 'Ctrl + Enter'))),
    t.el, status, phaseView, why,
    h('div.ev-grid',
      codeView,
      h('div.ev-stack-panel', h('div.ct-head', 'Call stack'), stackView),
      h('div.ev-right',
        tickPanel,
        h('div.ev-lane.micro', h('div.ev-lane-head', h('b', 'Microtask queue'), h('span.muted.small', ' promise callbacks, code after await · all of them run before the next macrotask')), microView),
        h('div.ev-lane.macro', h('div.ev-lane-head', h('b', 'Macrotask queue'), h('span.muted.small', ' setTimeout, setInterval, I/O · one per turn of the loop')), macroView),
        h('div.ev-lane.console', h('div.ev-lane-head', h('b', 'Console'), h('span.muted.small', ' in the order it was printed')), consoleView))));
  load();
  return root;
}
