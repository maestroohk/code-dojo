// One renderer per exercise type. Each returns:
//   { el, ready(), check() -> Promise<{ correct, detail? }>, reveal(), lock(on), focus?() }
import { h, md, inline, esc, shuffle, tidy, highlight, codeBlock, api } from './util.js';
import { enableDrag, Board } from './dnd.js';
import { createEditor } from './editor.js';
import { state, save } from './game.js';

export const DRAG_TYPES = new Set(['order', 'blanks', 'match', 'sort']);

export const TYPE_LABEL = {
  learn: 'Learn', mcq: 'Quiz', predict: 'Predict the output', order: 'Put in order',
  blanks: 'Fill the gaps', match: 'Match', sort: 'Sort', code: 'Code',
};

const rich = text => (/\n|```/.test(text) ? md(text) : inline(text));
const prompt = step => h('div.prompt', { html: md(step.prompt || '') });

export function renderStep(step, ctx) {
  const make = { learn, mcq, predict, order, blanks, match, sort, code }[step.type];
  if (!make) return { el: h('div.callout.warn', `Unknown step type "${step.type}".`), ready: () => true, check: async () => ({ correct: true }), reveal() {}, lock() {} };
  return make(step, ctx);
}

// ---------------------------------------------------------------- learn

function learn(step) {
  return {
    el: h('div.learn', step.title && h('h2', step.title), h('div.prose', { html: md(step.body) })),
    ready: () => true, check: async () => ({ correct: true }), reveal() {}, lock() {},
  };
}

// ---------------------------------------------------------------- mcq

function mcq(step, ctx) {
  const multi = Array.isArray(step.answer);
  const correct = new Set(multi ? step.answer : [step.answer]);
  const order = step.shuffle === false ? step.options.map((_, i) => i) : shuffle(step.options.map((_, i) => i));
  const chosen = new Set();
  let locked = false;

  const buttons = order.map((optionIndex, n) => h('button.option', {
    type: 'button',
    onclick: () => {
      if (locked) return;
      if (multi) chosen.has(optionIndex) ? chosen.delete(optionIndex) : chosen.add(optionIndex);
      else { chosen.clear(); chosen.add(optionIndex); }
      paint();
      ctx.onChange();
    },
  }, h('span.key', multi ? '' : String(n + 1)), h('span.option-text', { html: rich(step.options[optionIndex]) })));

  const paint = () => buttons.forEach((b, n) => {
    b.classList.toggle('selected', chosen.has(order[n]));
    b.classList.remove('right', 'wrong');
  });
  const el = h('div.mcq', prompt(step), step.code && h('div', { html: codeBlock(step.code) }),
    multi && h('p.muted', 'Select all that apply.'), h(`div.options${multi ? '.multi' : ''}`, buttons));

  const onKey = e => {
    if (locked || e.target.matches('input, textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
    const n = Number(e.key) - 1;
    if (n >= 0 && n < buttons.length) buttons[n].click();
  };
  document.addEventListener('keydown', onKey);

  return {
    el,
    ready: () => chosen.size > 0,
    async check() {
      const ok = chosen.size === correct.size && [...chosen].every(i => correct.has(i));
      buttons.forEach((b, n) => {
        if (chosen.has(order[n])) b.classList.add(correct.has(order[n]) ? 'right' : 'wrong');
      });
      return { correct: ok, detail: !ok && multi ? 'Not quite the right set.' : '' };
    },
    reveal() { buttons.forEach((b, n) => { b.classList.remove('wrong', 'selected'); b.classList.toggle('right', correct.has(order[n])); }); },
    lock(on) { locked = on; el.classList.toggle('locked', on); },
    retry() { paint(); },
    destroy() { document.removeEventListener('keydown', onKey); },
  };
}

// ---------------------------------------------------------------- predict

function predict(step, ctx) {
  const answers = [step.answer, ...(step.accept || [])].map(tidy);
  const multi = answers[0].includes('\n');
  const input = multi
    ? h('textarea.answer.mono', { rows: Math.min(8, answers[0].split('\n').length + 1), spellcheck: false, placeholder: 'Type the output, one line per line' })
    : h('input.answer.mono', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: 'Type the exact output' });
  input.addEventListener('input', () => { input.classList.remove('right', 'wrong'); ctx.onChange(); });
  if (!multi) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ctx.submit(); } });

  const shown = h('div.revealed');
  return {
    el: h('div.predict', prompt(step), h('div', { html: codeBlock(step.code) }),
      h('label.field', h('span.field-label', 'Output'), input), shown),
    ready: () => input.value.trim().length > 0,
    async check() {
      const mine = tidy(input.value);
      const ok = answers.includes(mine);
      input.classList.add(ok ? 'right' : 'wrong');
      let detail = '';
      if (!ok && answers.some(a => a.toLowerCase() === mine.toLowerCase())) detail = 'So close. Check the capitalisation: C# prints `True`, not `true`.';
      else if (!ok && answers.some(a => a.replace(/\s+/g, '') === mine.replace(/\s+/g, ''))) detail = 'Right characters, but check the spaces and line breaks.';
      return { correct: ok, detail };
    },
    reveal() { shown.innerHTML = `<div class="field-label">It prints</div>${codeBlock(answers[0], 'text')}`; },
    lock(on) { input.disabled = on; },
    focus() { input.focus({ preventScroll: true }); },
  };
}

// ---------------------------------------------------------------- order

function order(step, ctx) {
  const valid = [step.lines, ...(step.also || [])];
  let start = shuffle(step.lines);
  for (let i = 0; i < 8 && valid.some(v => v.join('\n') === start.join('\n')); i++) start = shuffle(step.lines);

  const list = h('ol.order-list');
  const row = text => h('li.order-item', { dataset: { text } },
    h('span.grip', { 'aria-hidden': 'true' }, '⋮⋮'),
    h('code.order-code', { html: highlight(text) }),
    h('span.nudge', { dataset: { nodrag: '1' } },
      h('button', { type: 'button', title: 'Move up', 'aria-label': 'Move up', onclick: e => nudge(e, -1) }, '▲'),
      h('button', { type: 'button', title: 'Move down', 'aria-label': 'Move down', onclick: e => nudge(e, 1) }, '▼')));
  list.append(...start.map(row));

  const clear = () => [...list.children].forEach(li => li.classList.remove('right', 'wrong'));
  const nudge = (e, dir) => {
    if (list.dataset.locked) return;
    const li = e.target.closest('li');
    const other = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
    if (!other) return;
    dir < 0 ? other.before(li) : other.after(li);
    clear();
    ctx.onChange();
  };

  enableDrag(list, {
    item: '.order-item',
    onStart: clear,
    onMove(item, _zone, ev) {
      // Slide the real row to wherever the pointer is; the ghost follows the pointer.
      const others = [...list.children].filter(li => li !== item);
      const before = others.find(li => { const r = li.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      before ? before.before(item) : list.append(item);
    },
    onDrop: () => ctx.onChange(),
  });

  const current = () => [...list.children].map(li => li.dataset.text);
  return {
    el: h('div.order', prompt(step), h('p.muted', 'Drag the lines, or use the arrows.'), list),
    ready: () => true,
    async check() {
      const mine = current();
      const ok = valid.some(v => v.join('\n') === mine.join('\n'));
      // Show which rows already sit in the right place (against the closest valid order).
      const best = valid.map(v => v.filter((t, i) => t === mine[i]).length);
      const target = valid[best.indexOf(Math.max(...best))];
      [...list.children].forEach((li, i) => li.classList.add(mine[i] === target[i] ? 'right' : 'wrong'));
      return { correct: ok, detail: ok ? '' : `${Math.max(...best)} of ${mine.length} lines are in the right place.` };
    },
    reveal() {
      const pool = [...list.children];
      for (const text of step.lines) list.append(pool.splice(pool.findIndex(li => li.dataset.text === text), 1)[0]);
      clear();
      [...list.children].forEach(li => li.classList.add('right'));
    },
    lock(on) { on ? list.dataset.locked = '1' : delete list.dataset.locked; },
    retry: clear,
  };
}

// ---------------------------------------------------------------- board-based: blanks, match, sort

function boardStep(el, board, { accepts, labelOf, readyWhen, hint }) {
  // accepts(zoneId) -> array of acceptable labels for chips in that zone
  const judge = () => {
    let right = 0, total = 0;
    board.clearMarks();
    for (const [tokenId, zoneId] of board.where) {
      if (zoneId === null) continue;
      total++;
      const ok = accepts(zoneId).includes(labelOf(tokenId));
      if (ok) right++;
      board.tokens.get(tokenId).el.classList.add(ok ? 'right' : 'wrong');
    }
    return { right, total };
  };
  return {
    el,
    ready: readyWhen,
    async check() {
      const { right, total } = judge();
      const ok = right === total && readyWhen();
      return { correct: ok, detail: ok ? '' : `${right} of ${total} are right. ${hint || ''}`.trim() };
    },
    lock(on) { on ? el.dataset.locked = '1' : delete el.dataset.locked; },
    retry() { board.clearMarks(); },
    judge,
  };
}

function blanks(step, ctx) {
  const accept = step.blanks.map(b => (Array.isArray(b) ? b : [b]));
  const labels = shuffle([...accept.map(a => a[0]), ...(step.bank || [])]);
  const tokens = labels.map((text, i) => ({ id: 't' + i, text, el: h('span.chip-code', text) }));

  const html = highlight(step.code).replace(/__(\d+)__/g, (_, n) => `<span class="slot" data-n="${n}"></span>`);
  const codeEl = h('pre.code.blanks-code', h('code', { html }));
  const width = Math.max(...labels.map(l => l.length), 2);
  const zones = [...codeEl.querySelectorAll('.slot')].map(s => {
    s.style.minWidth = `${Math.min(width, 14) + 1.5}ch`;
    return { id: 's' + s.dataset.n, el: s, capacity: 1 };
  });
  const bank = h('div.chip-bank');
  const el = h('div.blanks', prompt(step), codeEl, bank);
  const board = new Board(el, { tokens, zones, bank, onChange: () => { board.clearMarks(); ctx.onChange(); } });
  const text = id => tokens.find(t => t.id === id).text;

  return {
    ...boardStep(el, board, {
      accepts: zoneId => accept[Number(zoneId.slice(1)) - 1],
      labelOf: text,
      readyWhen: () => board.slotsFilled,
    }),
    reveal() {
      for (const t of tokens) board.place(t.id, null, true);
      accept.forEach((options, i) => {
        const free = tokens.find(t => options.includes(t.text) && board.where.get(t.id) === null);
        if (free) { board.place(free.id, 's' + (i + 1), true); free.el.classList.add('right'); }
      });
    },
  };
}

function match(step, ctx) {
  const rights = shuffle(step.pairs.map(p => p[1]));
  const tokens = rights.map((text, i) => ({ id: 't' + i, text, el: h('span', { html: inline(text) }) }));
  const rows = step.pairs.map((p, i) => {
    const slot = h('div.match-slot');
    return { row: h('div.match-row', h('div.match-left', { html: inline(p[0]) }), h('div.match-arrow', '→'), slot), zone: { id: 's' + i, el: slot, capacity: 1 } };
  });
  const bank = h('div.chip-bank');
  const el = h('div.match', prompt(step), h('div.match-rows', rows.map(r => r.row)), bank);
  const board = new Board(el, { tokens, zones: rows.map(r => r.zone), bank, onChange: () => { board.clearMarks(); ctx.onChange(); } });
  const text = id => tokens.find(t => t.id === id).text;

  return {
    ...boardStep(el, board, {
      accepts: zoneId => [step.pairs[Number(zoneId.slice(1))][1]],
      labelOf: text,
      readyWhen: () => board.slotsFilled,
    }),
    reveal() {
      for (const t of tokens) board.place(t.id, null, true);
      step.pairs.forEach((p, i) => { const t = tokens.find(x => x.text === p[1]); board.place(t.id, 's' + i, true); t.el.classList.add('right'); });
    },
  };
}

function sort(step, ctx) {
  const items = shuffle(step.items.map(([text, bucket], i) => ({ id: 't' + i, text, bucket })));
  const tokens = items.map(it => ({ ...it, el: h('span', { html: inline(it.text) }) }));
  const buckets = step.buckets.map((name, i) => {
    const body = h('div.bucket-body');
    return { col: h('div.bucket', h('div.bucket-title', { html: inline(name) }), body), zone: { id: 'b' + i, el: body, capacity: Infinity } };
  });
  const bank = h('div.chip-bank');
  const el = h('div.sort', prompt(step), h('p.muted', 'Drag each item into a box. Or tap an item, then tap a box.'), bank,
    h('div.buckets', { style: { gridTemplateColumns: `repeat(${step.buckets.length}, minmax(0, 1fr))` } }, buckets.map(b => b.col)));
  const board = new Board(el, { tokens, zones: buckets.map(b => b.zone), bank, onChange: () => { board.clearMarks(); ctx.onChange(); } });

  return {
    ...boardStep(el, board, {
      accepts: zoneId => tokens.filter(t => 'b' + t.bucket === zoneId).map(t => t.id),
      labelOf: id => id,
      readyWhen: () => board.allPlaced,
    }),
    reveal() { for (const t of tokens) { board.place(t.id, 'b' + t.bucket, true); t.el.classList.add('right'); } },
  };
}

// ---------------------------------------------------------------- code

export function renderRunOutput(panel, r, { stdin } = {}) {
  panel.innerHTML = '';
  panel.hidden = false;
  const errors = (r.diagnostics || []).filter(d => d.severity === 'error');
  const warnings = (r.diagnostics || []).filter(d => d.severity !== 'error');

  const diagRow = d => h(`div.diag.${d.severity}`,
    d.file === 'tests'
      ? h('span', { html: `<strong>The tests could not use your code.</strong> ${esc(d.message)} <span class="muted">Check the names and signatures the task asks for.</span>` })
      : [h('span.diag-where', `Line ${d.line}`), h('span', `${d.message} `), h('span.muted', d.id)]);

  if (errors.length) {
    panel.append(h('div.out-section',
      h('div.out-title.bad', `Does not compile: ${errors.length} error${errors.length > 1 ? 's' : ''}`),
      errors.slice(0, 8).map(diagRow),
      h('p.muted.small', 'Fix the first error first. Later ones are often caused by it.')));
    return;
  }
  if (r.tests?.length) {
    const failed = r.tests.filter(t => !t.pass).length;
    panel.append(h('div.out-section',
      h(`div.out-title.${failed ? 'bad' : 'good'}`, failed ? `${r.tests.length - failed} of ${r.tests.length} checks pass` : r.tests.length === 1 ? 'The check passes' : `All ${r.tests.length} checks pass`),
      r.tests.map(t => h(`div.test.${t.pass ? 'pass' : 'fail'}`,
        h('span.test-mark', t.pass ? '✓' : '✗'),
        h('div', h('div.test-name', t.name), !t.pass && t.detail && h('pre.test-detail', t.detail))))));
  }
  if (r.timedOut) panel.append(h('div.diag.error', 'Stopped: it ran for too long. Is there a loop that never ends, or is it waiting for something that never happens?'));
  if (stdin) panel.append(h('div.out-section', h('div.out-title', 'Input given'), h('pre.out', stdin)));
  if (r.stdout || !r.tests?.length) {
    panel.append(h('div.out-section', h('div.out-title', 'Output'),
      h('pre.out', r.stdout || h('span.muted', '(your program printed nothing)'))));
  }
  if (r.truncated) panel.append(h('div.diag.warning', 'Output was cut off: your program printed too much.'));
  if (r.stderr) panel.append(h('div.out-section', h('div.out-title.bad', 'Runtime error'), h('pre.out.err', r.stderr)));
  if (warnings.length) panel.append(h('div.out-section', h('div.out-title.warn', 'Compiler warnings'), warnings.slice(0, 6).map(diagRow)));
  if (r.ms != null) panel.append(h('div.muted.small.out-time', `${r.ms} ms`));
}

function code(step, ctx) {
  const draftKey = ctx.draftKey;
  const starter = step.starter ?? '';
  const panel = h('div.output', { hidden: true });
  const status = h('span.muted.small');
  let busy = false, passed = false;

  const editor = createEditor({
    value: (draftKey && state.drafts[draftKey]) ?? starter,
    onChange: v => { if (draftKey) { state.drafts[draftKey] = v; save(); } ctx.onChange(); },
    onRun: () => ctx.submit(),
    minLines: Math.max(6, starter.split('\n').length + 2),
  });

  const firstInput = step.tests?.find(t => t.stdin)?.stdin;
  const setBusy = (on, label) => { busy = on; runBtn.disabled = on; status.textContent = on ? label : ''; ctx.onChange(); };

  const run = async () => {
    if (busy) return;
    setBusy(true, 'Compiling and running…');
    try {
      const r = await api('run', { track: ctx.track, code: editor.value, stdin: firstInput || step.stdin || '', template: step.template });
      editor.mark(r.diagnostics);
      renderRunOutput(panel, r, { stdin: firstInput });
    } catch (e) {
      panel.hidden = false;
      panel.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?'));
    }
    setBusy(false);
  };

  const runBtn = h('button.btn.ghost', { type: 'button', onclick: run, title: 'Run without grading' }, '▶ Run');
  const resetBtn = h('button.btn.ghost', {
    type: 'button', title: 'Back to the starting code',
    onclick: () => { if (editor.value === starter || confirm('Replace your code with the starting code?')) { editor.value = starter; if (draftKey) { delete state.drafts[draftKey]; save(); } } },
  }, '↺ Reset');

  const el = h('div.code-step',
    h('div.code-head', step.title && h('h2', step.title), step.mode === 'fix' && h('span.tag.fix', '🐞 Fix the bug')),
    prompt(step),
    editor.el,
    h('div.code-tools', !step.template && runBtn, resetBtn, status, h('span.spacer'), h('span.muted.small', 'Ctrl + Enter to check')),
    panel);

  return {
    el,
    ready: () => !busy && editor.value.trim().length > 0,
    async check() {
      setBusy(true, 'Running the checks…');
      try {
        const r = await api('check', { track: ctx.track, module: ctx.module, lesson: ctx.lesson, step: ctx.idx, code: editor.value });
        editor.mark(r.diagnostics);
        renderRunOutput(panel, r);
        passed = r.passed;
        const failed = r.tests.filter(t => !t.pass).length;
        return {
          correct: r.passed,
          detail: r.passed ? '' : !r.compiled ? 'It does not compile yet. Read the first error below.' : `${failed} check${failed === 1 ? '' : 's'} failed. The details are below.`,
        };
      } catch (e) {
        return { correct: false, detail: 'Could not reach the dojo server. Is it still running?', noPenalty: true };
      } finally { setBusy(false); }
    },
    reveal() {
      editor.value = step.solution || editor.value;
      panel.hidden = false;
      panel.replaceChildren(h('div.callout', 'This is one working solution. Read it, then try writing it again from memory later: it will come back in Practice.'));
    },
    lock() { /* the editor stays live so you can keep experimenting after passing */ },
    focus() { if (!passed) editor.focus(); },
  };
}
