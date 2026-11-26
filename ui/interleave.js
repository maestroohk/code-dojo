// Threads in motion: a profiler-style timeline of real threads run under a deterministic scheduler
// (server/Interleave.cs). Each thread is a swim lane; each column is one step of the interleaving. Lanes show
// what ran (read, write, lock, unlock, atomic, statement), when a thread was blocked on a lock, and which locks it
// held; value rows under the lanes show the shared state changing like a logic analyser trace. The learner can
// play and scrub, pick which thread runs next at any point (the program is re-run with that schedule), and try
// every interleaving to see all the outcomes the code can produce.
import { h, api, highlight } from './util.js';
import { createEditor } from './editor.js';

const LANE = ['#36b3ff', '#e7a33e', '#3fcf9b', '#f0788c'];
const LOCK = ['#d6b443', '#6cc4d4', '#d98a5f', '#9fb4c7'];
const KIND = {
  0: { tag: '·', cls: 'local', name: 'local statement' },
  1: { tag: 'R', cls: 'read', name: 'read of shared state' },
  2: { tag: 'W', cls: 'write', name: 'write to shared state' },
  3: { tag: 'L', cls: 'lock', name: 'takes a lock' },
  4: { tag: 'U', cls: 'unlock', name: 'releases a lock' },
  5: { tag: 'S', cls: 'shared', name: 'statement that touches shared state' },
  6: { tag: 'A', cls: 'atomic', name: 'atomic operation (Interlocked)' },
  7: { tag: '·', cls: 'local', name: 'loop test' },
  8: { tag: '?', cls: 'shared', name: 'loop test on shared state' },
  9: { tag: 'P', cls: 'lock', name: 'semaphore wait (takes a slot)' },
  10: { tag: 'V', cls: 'unlock', name: 'semaphore release (gives a slot back)' },
  11: { tag: 'R', cls: 'read', name: 'reads shared state and computes' },
};
const text = v => (Array.isArray(v) ? v.join('\n') : v ?? '');

/**
 * @param spec  { setup, threads: [{ name, code }], code?, watch?, result?, expect?, schedules?: [{ name, pick }], editable? }
 * @param opts  { schedule?: number[] (start with this interleaving), title?, atEnd?: true (open on the last step) }
 */
export function interleaveCard(spec, opts = {}) {
  let src = {
    setup: text(spec.setup), code: text(spec.code), result: spec.result || null, watch: spec.watch || null,
    threads: (spec.threads || []).map((t, i) => ({ name: t.name || `T${i + 1}`, code: text(t.code) })),
  };
  const expect = spec.expect == null ? null : [].concat(spec.expect).map(String);
  const presets = [{ name: 'Default: a thread runs until it blocks or ends', pick: [] }, ...(spec.schedules || [])];
  let schedule = opts.schedule || presets[spec.schedules?.length && spec.start != null ? spec.start + 1 : 0].pick || [];
  let data = null, at = 0, timer = null, speed = 700, explored = null, busy = false;

  const status = h('div.il-status.small');
  const timeline = h('div.il-timeline');
  const panes = h('div.il-panes');
  const now = h('div.il-now');
  const chooser = h('div.il-choose');
  const outcome = h('div.il-outcome');
  const explorePanel = h('div.il-explore');
  const slider = h('input.ct-slider', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Step', oninput: e => { pause(); go(Number(e.target.value)); } });
  const playBtn = h('button.btn.primary.small', { type: 'button', onclick: () => (timer ? pause() : play()) }, '▶ Play');
  const presetSel = h('select.ct-speed.il-preset', { title: 'Interleaving', onchange: e => { const p = presets[Number(e.target.value)]; if (p) { schedule = p.pick || []; load({ cursor: 0 }); } } },
    presets.map((p, i) => h('option', { value: i }, p.name)), h('option', { value: -1, hidden: true }, 'Your own interleaving'));
  const exploreBtn = h('button.btn.ghost.small', { type: 'button', onclick: explore, title: 'Run the code under every distinct order of its shared-memory steps' }, 'Try every interleaving');

  // ---------------------------------------------------------------- running

  async function load({ cursor = null } = {}) {
    pause();
    busy = true; status.replaceChildren(h('span.muted', 'Running on real threads…'));
    try { data = await api('interleave', { ...src, mode: 'trace', schedule }); }
    catch { data = { error: 'Could not reach the dojo server.' }; }
    busy = false;
    if (data.error) { paintError(); return; }
    data.steps ||= [];
    slider.max = data.steps.length;
    const i = presets.findIndex(p => JSON.stringify(p.pick || []) === JSON.stringify(schedule));
    presetSel.value = i >= 0 ? String(i) : '-1';
    go(cursor == null ? (opts.atEnd ? data.steps.length : 0) : cursor);
  }

  async function explore() {
    exploreBtn.disabled = true;
    explorePanel.replaceChildren(h('div.muted.small', 'Running every interleaving…'));
    let r;
    try { r = await api('interleave', { ...src, mode: 'explore' }); } catch { r = { error: 'Could not reach the dojo server.' }; }
    exploreBtn.disabled = false;
    explored = r;
    paintExplore();
  }

  function choose(t) {
    // Keep the steps up to the cursor, run thread t next, then let the default policy finish.
    schedule = [...(data.chosen || []).slice(0, at), t];
    load({ cursor: at + 1 });
  }

  function go(i) { if (!data?.steps) return; at = Math.max(0, Math.min(i, data.steps.length)); slider.value = at; paint(); }
  function play() {
    if (!data?.steps?.length) return;
    if (at >= data.steps.length) at = 0;
    playBtn.textContent = '❚❚ Pause';
    const tick = () => { if (at < data.steps.length) { go(at + 1); timer = setTimeout(tick, speed); } else pause(); };
    tick();
  }
  function pause() { clearTimeout(timer); timer = null; playBtn.textContent = '▶ Play'; }

  // ---------------------------------------------------------------- derived state

  const names = () => data.threads || src.threads.map(t => t.name);
  const stateBefore = i => (i === 0 ? data.init?.s : data.steps[i - 1].s) || [];
  function carried(field, i) {           // the last value of v / h at or before step i-1 (after i steps)
    for (let k = i - 1; k >= 0; k--) if (data.steps[k][field]) return data.steps[k][field];
    return data.init?.[field] || [];
  }
  const lineOf = (g, l) => data.regions?.[g]?.lines?.[l - 1]?.trim() || '';
  function opText(k, x, g, l, step) {
    const line = lineOf(g, l);
    switch (k) {
      case 1: return step ? `reads ${x} = ${step.r}` : `reads ${x}`;
      case 11: return step ? `reads ${x} and computes ${step.r}` : `reads ${x} and computes the new value`;
      case 2: return step ? `writes ${x} = ${step.w ?? '?'}` : `writes ${x}`;
      case 3: return `takes lock ${x}`;
      case 4: return `releases lock ${x}`;
      case 9: return `takes a slot of ${x}`;
      case 10: return `gives a slot of ${x} back`;
      case 6: return `atomic: ${line}`;
      case 7: case 8: return `tests ${line.replace(/^(for|while)\s*\(/, '').replace(/\)\s*$/, '') || 'the loop'}`;
      default: return line || 'runs';
    }
  }
  function holder(lockName, i) {
    const held = carried('h', i).find(e => e[0] === lockName);
    return held && held[1] === 'lock' && held[2] >= 0 ? names()[held[2]] : null;
  }

  // ---------------------------------------------------------------- painting

  function paintError() {
    status.replaceChildren(h('span.bad', data.error));
    const errs = (data.diagnostics || []).filter(d => d.severity === 'error');
    timeline.replaceChildren(...errs.slice(0, 5).map(d => h('div.diag.error', h('span.diag-where', `${d.file === 'Program.cs' ? 'shared code' : d.file?.startsWith('T') ? names0(d.file) : d.file} line ${d.line}`), ' ', d.message)));
    panes.replaceChildren(); now.replaceChildren(); chooser.replaceChildren(); outcome.replaceChildren();
  }
  const names0 = f => src.threads[Number(f.slice(1))]?.name || f;

  function paint() {
    const steps = data.steps;
    const n = names();
    const cur = steps[at - 1];
    status.replaceChildren(
      h('b', `Step ${at} of ${steps.length}`),
      cur ? h('span', ' · ', h('b', { style: `color:${LANE[cur.t]}` }, n[cur.t]), ' ', opText(cur.k, cur.x, cur.g, cur.l, cur), cur.e ? h('span.bad', ` · throws ${cur.e}`) : '')
        : h('span.muted', ' · nothing has run yet: pick a thread below, or press Play'));
    paintTimeline(n);
    paintPanes(n);
    paintNow(n);
    paintChooser(n);
    paintOutcome();
  }

  function paintTimeline(n) {
    const steps = data.steps;
    const cols = `var(--il-label) repeat(${Math.max(steps.length, 1)}, var(--il-col))`;
    const row = (cls, label, cells, extra = '') => h(`div.il-row.${cls}`, { style: `grid-template-columns:${cols};${extra}` }, h('div.il-label', label), cells);
    const col = (i, span = 1) => ({ gridColumn: `${i + 2} / span ${span}` });
    const cell = (i, cls, content, title, span = 1) => {
      const el = h(`div.il-cell.${cls}${i >= at ? '.future' : ''}${i === at - 1 ? '.cur' : ''}`, { title, onclick: () => { pause(); go(i + 1); } }, content);
      Object.assign(el.style, col(i, span));
      return el;
    };

    const axis = row('il-axis', h('span.muted.small', 'step'), steps.map((_, i) => cell(i, 'tick', (i + 1) % 5 === 0 || i === 0 ? String(i + 1) : '', `step ${i + 1}`)));
    const lanes = n.map((name, j) => {
      const cells = steps.map((s, i) => {
        if (s.t === j) {
          const kd = KIND[s.k] || KIND[0];
          return cell(i, `run.${kd.cls}`, kd.tag, `${name} ${opText(s.k, s.x, s.g, s.l, s)} · ${kd.name}`);
        }
        const st = stateBefore(i)[j] || [];
        if (st[0] === 1) return cell(i, 'blocked', '', `${name} is blocked: waiting for ${st[4]}${holder(st[4], i) ? ` (held by ${holder(st[4], i)})` : ''}`);
        if (st[0] === 2) return cell(i, 'done', '', `${name} has finished`);
        return cell(i, 'ready', '', `${name} is ready but not running`);
      });
      // Lock bands: the locks this lane holds after each step, drawn as spans.
      const bands = [];
      const lockNames = [...new Set(steps.flatMap(s => (s.h || []).filter(e => e[1] === 'lock').map(e => e[0])).concat((data.init?.h || []).filter(e => e[1] === 'lock').map(e => e[0])))];
      lockNames.forEach((ln, li) => {
        let start = -1;
        for (let i = 0; i <= steps.length; i++) {
          const held = i < steps.length && carried('h', i + 1).some(e => e[0] === ln && e[1] === 'lock' && e[2] === j);
          if (held && start < 0) start = i;
          if (!held && start >= 0) {
            const b = h(`div.il-band${start >= at ? '.future' : ''}`, { title: `${name} holds lock ${ln}`, style: `--lock:${LOCK[li % LOCK.length]}` }, h('span', ln));
            Object.assign(b.style, col(start, i - start), { gridRow: String(li + 1) });
            bands.push(b); start = -1;
          }
        }
      });
      const st = stateBefore(at)[j] || [];
      const chip = st[0] === 2 ? h('span.il-chip.done', 'done') : st[0] === 1 ? h('span.il-chip.blocked', 'blocked') : h('span.il-chip', 'ready');
      return [
        row('il-lane', h('span.il-lname', name, chip), cells, `--lane:${LANE[j]}`),
        bands.length ? row('il-locks', h('span.muted.small', 'holds'), bands) : null,
      ];
    });

    // Value rows: one per watched expression, a segment per value (like a logic analyser bus).
    const watchNames = data.watchNames || [];
    const values = watchNames.map((w, wi) => {
      const segs = [];
      const vs = steps.map((_, i) => carried('v', i + 1)[wi]);   // the value after each step
      let start = 0;
      for (let i = 1; i <= vs.length; i++) {
        if (i < vs.length && vs[i] === vs[start]) continue;
        const changed = start > 0 || vs[0] !== (data.init?.v || [])[wi];
        const seg = h(`div.il-seg${start >= at ? '.future' : ''}${changed ? '.changed' : ''}`, { title: `${w} = ${vs[start]} from step ${start + 1}` }, h('span', vs[start] ?? ''));
        Object.assign(seg.style, col(start, i - start));
        segs.push(seg);
        start = i;
      }
      return row('il-value', h('code', w), segs);
    });

    const scroller = h('div.il-scroll', { style: `--il-col:${steps.length <= 12 ? 56 : steps.length <= 32 ? 34 : 26}px` }, axis, lanes, values.length ? h('div.il-sep') : null, values);
    timeline.replaceChildren(scroller,
      h('div.il-legend.small', Object.entries({ R: 'read', W: 'write', L: 'lock', U: 'unlock', A: 'atomic', S: 'shared statement', '·': 'local' })
        .map(([k, v]) => h('span', h(`span.il-key.${{ R: 'read', W: 'write', L: 'lock', U: 'unlock', A: 'atomic', S: 'shared', '·': 'local' }[k]}`, k), v)),
        h('span', h('span.il-key.blocked'), 'blocked'), h('span', h('span.il-key.ready'), 'ready, not running')));
    const curEl = scroller.querySelector('.il-lane .il-cell.cur');
    if (curEl) { const sl = curEl.offsetLeft - scroller.clientWidth / 2; if (curEl.offsetLeft < scroller.scrollLeft + 140 || curEl.offsetLeft > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = Math.max(0, sl); }
  }

  function paintPanes(n) {
    const states = stateBefore(at);
    const cur = data.steps[at - 1];
    const regions = data.regions || [];
    const panesOut = regions.map((r, g) => {
      if (!r.lines?.length) return null;
      const title = g < n.length ? n[g] : 'Shared code';
      return h('div.il-pane', { style: g < n.length ? `--lane:${LANE[g]}` : '' },
        h('div.il-pane-head', g < n.length ? h('span.il-dot') : null, title),
        h('div.il-code', r.lines.map((line, li) => {
          const here = states.map((s, j) => (s && s[0] !== 2 && s[1] === g && s[2] === li + 1 ? j : -1)).filter(j => j >= 0);
          const ran = cur && cur.g === g && cur.l === li + 1;
          return h(`div.il-line${ran ? '.ran' : ''}`, { style: ran ? `--lane:${LANE[cur.t]}` : '' },
            h('span.il-ln', li + 1),
            h('span.il-src', { html: highlight(line, 'csharp') || ' ' }),
            here.length ? h('span.il-marks', here.map(j => h('span.il-mark', { style: `--lane:${LANE[j]}`, title: `${n[j]} is about to run this line` }, n[j]))) : null);
        })));
    });
    panes.replaceChildren(...panesOut.filter(Boolean));
  }

  function paintNow(n) {
    const steps = data.steps;
    const vals = carried('v', at);
    const prevVals = at > 0 ? carried('v', at - 1) : vals;
    const watchNames = data.watchNames || [];
    // Registers: a value a thread has read but not yet written back (the heart of a lost update).
    const regs = [];
    n.forEach((name, j) => {
      let reg = null;
      for (let i = 0; i < at; i++) {
        const s = steps[i];
        if (s.t !== j) continue;
        if (s.k === 1 || s.k === 11) reg = { x: s.x, v: s.r, step: i + 1, computed: s.k === 11 };
        else if (s.k === 2) reg = null;
      }
      if (reg) {
        const wi = watchNames.indexOf(reg.x);
        const nowVal = wi >= 0 ? vals[wi] : null;
        const stale = !reg.computed && nowVal != null && nowVal !== reg.v;
        regs.push(h(`div.il-reg${stale ? '.stale' : ''}`, h('b', { style: `color:${LANE[j]}` }, name), ` holds ${reg.x} = ${reg.v} in a register (${reg.computed ? 'computed' : 'read'} at step ${reg.step})`,
          stale ? h('span.bad', ` · stale: ${reg.x} is now ${nowVal}, and its write will overwrite that`) : null));
      }
    });
    const held = carried('h', at);
    const states = stateBefore(at);
    now.replaceChildren(...[
      h('div.ct-panel', h('div.ct-head', 'Shared state'),
        watchNames.length ? watchNames.map((w, i) => h(`div.ct-var${vals[i] !== prevVals[i] ? '.changed' : ''}`, h('span.ct-name', w), h('span.ct-val', vals[i] ?? ''))) : h('span.muted.small', 'nothing watched')),
      held.length ? h('div.ct-panel', h('div.ct-head', 'Locks and semaphores'),
        held.map(([name, kind, owner, depth]) => {
          const waiting = states.map((s, j) => (s && s[0] === 1 && s[4] === name ? n[j] : null)).filter(Boolean);
          return h('div.il-lockrow', h('code', name),
            kind === 'sem' ? h('span', `${owner} slot${owner === 1 ? '' : 's'} free`)
              : owner >= 0 ? h('span', 'held by ', h('b', { style: `color:${LANE[owner]}` }, n[owner]), depth > 1 ? ` (${depth} deep)` : '') : h('span.muted', 'free'),
            waiting.length ? h('span.bad', ` · ${waiting.join(', ')} waiting`) : null);
        })) : null,
      regs.length ? h('div.ct-panel', h('div.ct-head', 'Registers (read, not yet written)'), regs) : null].filter(Boolean));
  }

  function paintChooser(n) {
    const states = stateBefore(at);
    const nextInRun = data.steps[at]?.t;
    const done = states.every(s => s?.[0] === 2);
    if (done || (at === data.steps.length && data.status !== 'done' && data.status !== 'limit' && data.status !== 'deadlock')) { chooser.replaceChildren(); return; }
    if (at === data.steps.length && data.status === 'deadlock') { chooser.replaceChildren(h('span.muted.small', 'No thread can move: every thread that has not finished is waiting for a lock another one holds.')); return; }
    chooser.replaceChildren(h('span.il-choose-label.small', 'Run next:'),
      ...n.map((name, j) => {
        const s = states[j] || [];
        if (s[0] === 2) return h('button.btn.ghost.small.il-pick', { type: 'button', disabled: true }, `${name} finished`);
        if (s[0] === 1) return h('button.btn.ghost.small.il-pick.blocked', { type: 'button', disabled: true, title: 'A blocked thread cannot run until the lock is free' },
          `${name} blocked on ${s[4]}${holder(s[4], at) ? ` (held by ${holder(s[4], at)})` : ''}`);
        const mine = nextInRun === j;
        return h(`button.btn.small.il-pick${mine ? '.primary' : '.ghost'}`, { type: 'button', style: `--lane:${LANE[j]}`, disabled: busy,
          title: mine ? 'This is what the current interleaving does next' : `Re-run with ${name} going next here`,
          onclick: () => (mine ? (pause(), go(at + 1)) : choose(j)) },
          h('span.il-dot'), `${name}: ${opText(s[3], s[4], s[1], s[2])}`, mine ? h('span.il-this', ' · this run') : null);
      }));
  }

  function paintOutcome() {
    if (at < data.steps.length) { outcome.replaceChildren(); return; }
    const good = data.status === 'deadlock' ? false : expect ? expect.includes(data.outcome) : null;
    outcome.replaceChildren(h(`div.il-result${good === true ? '.good' : good === false ? '.bad' : ''}`,
      h('b', data.status === 'deadlock' ? 'Deadlock. ' : data.status === 'limit' ? 'Still running. ' : 'Result: '),
      data.status === 'deadlock' ? data.deadlock : h('code', src.result ? `${src.result} = ${data.outcome}` : data.outcome),
      expect && data.status !== 'deadlock' ? h('span', good ? ' · as expected' : ` · expected ${expect.join(' or ')}`) : null));
  }

  function paintExplore() {
    const r = explored;
    if (r.error) { explorePanel.replaceChildren(h('div.bad.small', r.error)); return; }
    const outs = r.outcomes || [];
    const total = outs.reduce((a, o) => a + o.count, 0) || 1;
    const scope = r.complete && r.bound == null ? `All ${r.runs} distinct interleavings`
      : r.complete ? `All ${r.runs} interleavings with up to ${r.bound} preemptions (the search CHESS and Coyote use when there are too many)`
        : `${r.runs} interleavings (a sample: there are too many to run them all)`;
    explorePanel.replaceChildren(
      h('div.il-explore-head', h('b', scope), h('span.muted.small', ` · ${outs.length} different outcome${outs.length === 1 ? '' : 's'}`)),
      ...outs.map(o => {
        const good = o.status === 'deadlock' ? false : expect ? expect.includes(o.outcome) : null;
        return h(`div.il-bar${good === true ? '.good' : good === false ? '.bad' : ''}`,
          h('div.il-bar-label', h('code', o.status === 'deadlock' ? 'deadlock' : src.result ? `${src.result} = ${o.outcome}` : o.outcome)),
          h('div.il-bar-track', h('div.il-bar-fill', { style: `width:${Math.max(3, (100 * o.count) / total)}%` })),
          h('div.il-bar-count.small', `${o.count} of ${total}`),
          h('button.btn.ghost.small', { type: 'button', onclick: () => { schedule = o.schedule; load({ cursor: 0 }).then(play); } }, 'Show one'));
      }));
  }

  // ---------------------------------------------------------------- edit

  let editors = null;
  const editBox = h('div.il-edit', { hidden: true });
  function openEdit() {
    if (editors) { editBox.hidden = !editBox.hidden; return; }
    const ed = (label, value, lines = 3) => { const e = createEditor({ value, minLines: lines, onRun: () => apply() }); return { label, e }; };
    editors = { setup: ed('Shared state (runs first)', src.setup, 2), threads: src.threads.map(t => ed(t.name, t.code, 3)), code: ed('Shared code (classes)', src.code, 4) };
    const block = x => h('div.il-edit-block', h('div.ct-head', x.label), x.e.el);
    editBox.replaceChildren(block(editors.setup), h('div.il-edit-threads', editors.threads.map(block)), block(editors.code),
      h('div.ct-edit-bar', h('button.btn.primary.small', { type: 'button', onclick: apply }, 'Run this code'), h('span.muted.small', 'Ctrl + Enter')));
    editBox.hidden = false;
  }
  function apply() {
    src = { ...src, setup: editors.setup.e.value, code: editors.code.e.value, threads: src.threads.map((t, i) => ({ ...t, code: editors.threads[i].e.value })) };
    schedule = []; explored = null; explorePanel.replaceChildren();
    load({ cursor: 0 });
  }

  const keys = e => {
    if (e.target.matches('textarea, input, select')) return;
    if (e.key === 'ArrowRight') { pause(); go(at + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { pause(); go(at - 1); e.preventDefault(); }
  };

  const root = h('div.ct.il', { tabindex: 0, onkeydown: keys },
    h('div.il-title',
      h('b', opts.title || 'Threads in motion'),
      h('span.il-badge', { title: 'Your C# runs on real threads. A scheduler compiled into the program lets one thread move at a time and switches only between statements, at loop tests, at lock and semaphore operations, and between the read and the write of x++ or x += n. It shows every ordering of those steps; it does not show CPU memory reordering or torn reads.' }, 'Real run · deterministic scheduler'),
      h('span.muted.small', ' ← → to step · click a column to jump')),
    h('div.ct-controls', playBtn,
      h('button.btn.ghost.small', { type: 'button', title: 'Back one step', onclick: () => { pause(); go(at - 1); } }, '◀'),
      h('button.btn.ghost.small', { type: 'button', title: 'Forward one step', onclick: () => { pause(); go(at + 1); } }, '▶'),
      slider,
      h('select.ct-speed', { title: 'Speed', onchange: e => { speed = Number(e.target.value); } },
        [[1200, 'slow'], [700, 'normal'], [300, 'fast']].map(([v, l]) => h('option', { value: v, selected: v === speed }, l)))),
    h('div.il-bar-row', h('span.muted.small', 'Interleaving'), presetSel, exploreBtn,
      spec.editable === false ? null : h('button.btn.ghost.small', { type: 'button', onclick: openEdit }, 'Edit the code')),
    editBox,
    status, timeline, chooser, outcome, explorePanel,
    h('div.il-grid', panes, now));
  load();
  return root;
}

/** A failing check's detail may end with "\u0002interleave:{json}": the interleaving that broke the learner's code. */
export function splitInterleaveDetail(detail) {
  const at = typeof detail === 'string' ? detail.indexOf('\u0002interleave:') : -1;
  if (at < 0) return { text: detail, viz: null };
  let viz = null;
  try { viz = JSON.parse(detail.slice(at + 12)); } catch { /* plain text only */ }
  return { text: detail.slice(0, at).trimEnd(), viz };
}

/** The detail of a failing check, with the interleaving drawn when there is one. */
export function interleaveDetail(detail) {
  const { text: plain, viz } = splitInterleaveDetail(detail);
  if (!viz) return h('pre.test-detail', plain);
  return h('div', h('pre.test-detail', plain),
    interleaveCard({ ...viz, editable: false }, { schedule: viz.schedule, atEnd: true, title: 'The interleaving that breaks it' }));
}
