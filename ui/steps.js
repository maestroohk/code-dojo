// One renderer per exercise type. Each returns:
//   { el, ready(), check() -> Promise<{ correct, detail? }>, reveal(), lock(on), focus?() }
import { h, md, inline, esc, shuffle, tidy, highlight, codeBlock, api, ask, langId } from './util.js';
import { enableDrag, Board } from './dnd.js';
import { createEditor } from './editor.js';
import { state, save } from './game.js';
import { linqViz } from './linqviz.js';
import { codeTrace } from './codetrace.js';
import { sqlGrid } from './sqlgrid.js';
import { overTime, clock } from './pacing.js';
// "terminal" (a real shell in a container) and "lab" (a visual or live lab challenge): labsteps.js.
import { EXTRA_STEPS, EXTRA_LABELS } from './labsteps.js';
import { regexStep } from './regexstep.js';
import { regexCard } from './regex-ui.js';

export const DRAG_TYPES = new Set(['order', 'blanks', 'match', 'sort']);

export const TYPE_LABEL = {
  learn: 'Learn', mcq: 'Quiz', predict: 'Predict the output', order: 'Put in order',
  blanks: 'Fill the gaps', match: 'Match', sort: 'Sort', code: 'Code', regex: 'Regex',
};
Object.assign(TYPE_LABEL, EXTRA_LABELS);

const rich = text => (/\n|```/.test(text) ? md(text) : inline(text));
const prompt = step => h('div.prompt', { html: md(step.prompt || '') });

export function renderStep(step, ctx) {
  if (EXTRA_STEPS[step.type]) return EXTRA_STEPS[step.type](step, ctx);
  const make = { learn, mcq, predict, order, blanks, match, sort, code, regex: regexStep }[step.type];
  if (!make) return { el: h('div.callout.warn', `Unknown step type "${step.type}".`), ready: () => true, check: async () => ({ correct: true }), reveal() {}, lock() {} };
  return make(step, ctx);
}

// ---------------------------------------------------------------- learn

/** Ignore layout and comments when comparing typed code to a target. */
const squash = code => code.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');

/** Is the typing preference on? Clicking a mode toggle anywhere remembers the choice. */
const prefersTyping = () => !!state.settings.typing;
const rememberTyping = on => { state.settings.typing = on; save(); };

/** A two-way switch between dragging and typing. Returns the element, with lock(on). */
function modeToggle(typing, onChange) {
  const drag = h('button.mode', { type: 'button', onclick: () => set(false) }, '✋ Drag');
  const type = h('button.mode', { type: 'button', onclick: () => set(true) }, '⌨ Type');
  const el = h('div.mode-toggle', { role: 'group', 'aria-label': 'How to answer' }, drag, type);
  const paint = on => { drag.classList.toggle('on', !on); type.classList.toggle('on', on); };
  const set = on => { if (el.dataset.locked || on === typing) return; typing = on; paint(on); onChange(on); };
  paint(typing);
  el.lock = on => { on ? el.dataset.locked = '1' : delete el.dataset.locked; drag.disabled = type.disabled = on; };
  return el;
}

/**
 * A typing drill: retype a code sample. Layout and comments do not matter, every other
 * character does. Shows how far the typed text matches and where it first goes wrong.
 */
function typeDrill(target, ctx, onClose) {
  const goal = squash(target);
  const meter = h('div.drill-meter', h('div.drill-fill'));
  const note = h('div.drill-note.muted.small', 'Type the sample above. Spacing and comments do not matter.');
  const out = h('div.output', { hidden: true });
  let done = false;

  const editor = createEditor({
    assist: false,          // typing practice: no suggestions or auto-closing
    minLines: Math.max(4, target.split('\n').length + 1),
    onRun: () => run(),
    // The large view shows the sample to copy, the progress and the output beside the editor.
    popout: { title: 'Type it', side: () => [h('div', h('div.field-label', 'The sample'), h('pre.code', { html: highlight(target) })), meter, note, out] },
    onChange(value) {
      const mine = squash(value);
      let same = 0;
      while (same < mine.length && same < goal.length && mine[same] === goal[same]) same++;
      meter.firstChild.style.width = `${(same / goal.length) * 100}%`;
      const wrong = same < mine.length;
      meter.classList.toggle('off', wrong);
      if (mine === goal) {
        note.className = 'drill-note good';
        if (!done) { done = true; const xp = ctx.bonus?.(3, 'typed') ?? 0; note.textContent = `Typed it from start to finish.${xp ? ` +${xp} XP` : ''}`; }
        else note.textContent = 'Typed it from start to finish.';
      } else if (wrong) {
        note.className = 'drill-note bad small';
        note.textContent = `Differs after “${goal.slice(Math.max(0, same - 14), same)}”: expected “${goal[same] ?? 'the end'}” but found “${mine[same]}”.`;
      } else {
        note.className = 'drill-note muted small';
        note.textContent = `${Math.round((same / goal.length) * 100)}% typed. Keep going.`;
      }
    },
  });
  const run = async () => {
    out.hidden = false;
    out.replaceChildren(h('span.muted.small', 'Compiling and running…'));
    try { const r = await api('run', { track: ctx.track, code: editor.value, setup: ctx.dataSetup }); editor.mark(r.diagnostics); renderRunOutput(out, r); }
    catch { out.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?')); }
  };
  const el = h('div.drill', meter, editor.el,
    h('div.code-tools', h('button.btn.ghost', { type: 'button', onclick: run }, '▶ Run'),
      h('button.btn.ghost', { type: 'button', onclick: onClose }, 'Close'), note), out);
  setTimeout(() => editor.focus());
  return el;
}

/**
 * Python samples on cards often use the usual aliases (pd, np, plt) without importing them, as notebooks do.
 * "Try it" adds the import lines at the top, in plain sight, so the sample runs on its own.
 */
const PY_ALIASES = [[/\bpd\./, 'import pandas as pd'], [/\bnp\./, 'import numpy as np'], [/\bplt\./, 'import matplotlib.pyplot as plt']];
export function withImports(source, lang) {
  if (lang !== 'python') return source;
  const missing = PY_ALIASES.filter(([use, line]) => use.test(source) && !source.includes(line)).map(([, line]) => line);
  return missing.length ? [...missing, '', source].join('\n') : source;
}

/** The code samples of a learn card's body in the given language, in order (fences as md() reads them). */
function cardSamples(body, lang) {
  const lines = (Array.isArray(body) ? body.join('\n') : String(body ?? '')).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s*```([\w+-]*)(?:\s+(fragment|continues))?\s*$/);
    if (!f) continue;
    const code = [];
    while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
    if (langId(f[1] || lang) === lang) out.push(code.join('\n'));
  }
  return out;
}

/** An editor pre-filled with a sample, to change and run. */
function tryIt(source, ctx, onClose) {
  const out = h('div.output', { hidden: true });
  // A sample that reads input gets a box for what you would type at the keyboard.
  const reads = /\binput\(|Console\.ReadLine|\breadline\(|process\.stdin/.test(source);
  const stdin = reads ? h('textarea.answer.mono.stdin-box', { rows: 2, spellcheck: false, placeholder: 'What you would type when it asks, one line per answer' }) : null;
  const editor = createEditor({ value: source, minLines: Math.max(4, source.split('\n').length + 1), onRun: () => run(), popout: { title: 'Try it', side: () => [out] } });
  const run = async () => {
    out.hidden = false;
    out.replaceChildren(h('span.muted.small', 'Compiling and running…'));
    try { const r = await api('run', { track: ctx.track, code: editor.value, setup: ctx.dataSetup, stdin: stdin?.value }); editor.mark(r.diagnostics); renderRunOutput(out, r); }
    catch { out.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?')); }
  };
  setTimeout(() => editor.focus());
  return h('div.drill', ctx.dataSetup && sqlData(ctx.dataSetup, ctx), editor.el,
    stdin && h('label.field', h('span.field-label', 'Input'), stdin),
    h('div.code-tools', h('button.btn.ghost', { type: 'button', onclick: run }, '▶ Run'),
      h('button.btn.ghost', { type: 'button', onclick: onClose }, 'Close'),
      h('span.muted.small', ctx.dataSetup ? 'Change anything and run it. It runs against the tables above; your changes are thrown away when you close it.' : 'Change anything and run it.')), out);
}

/**
 * The tables a SQL step starts with, drawn as grids: a fold that loads them from the server the first time it opens.
 * `setup` is the step's setup SQL (a string or an array of lines).
 */
function sqlData(setup, ctx, { open = false, label = 'The tables' } = {}) {
  const body = h('div.sql-data-body', h('span.muted.small', 'Loading the tables…'));
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const r = await api('run', { track: ctx.track, code: '', setup });
      const tables = r.tables || [];
      if (!tables.length) { body.replaceChildren(h('span.muted.small', (r.diagnostics || [])[0]?.message || 'This step starts with no tables.')); return; }
      body.replaceChildren(...tables.map(t => h('div.sql-table-peek', h('div.sql-table-name', t.title), sqlGrid(t, { cap: 50 }))));
      summary.textContent = `${label}: ${tables.map(t => `${t.title} (${t.rows.length}${t.truncated ? '+' : ''} rows)`).join(', ')}`;
    } catch { loaded = false; body.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?')); }
  };
  const summary = h('summary.out-title', label);
  const el = h('details.sql-data', { open }, summary, body);
  el.addEventListener('toggle', () => { if (el.open) load(); });
  if (open) load();
  return el;
}

function learn(step, ctx) {
  const prose = h('div.prose', { html: md(step.body) });
  const trackLang = langId(document.documentElement.dataset.codeLang || 'csharp');
  // The lesson's earlier samples in the track's language (earlier cards, then this card), for "continues" samples.
  const earlier = (ctx.earlierCards || []).flatMap(card => cardSamples(card.body, trackLang));
  // Every code sample can be typed out or experimented with, right under the card.
  for (const pre of prose.querySelectorAll('pre.code[data-code]')) {
    const sample = pre.dataset.code;
    const sameLang = langId(pre.dataset.lang) === trackLang;
    // A "continues" sample runs after the lesson's samples before it, like a notebook cell, so "Try it" opens the whole program.
    const source = pre.dataset.continues && earlier.length
      ? [...earlier, `${trackLang === 'python' ? '#' : trackLang === 'sql' ? '--' : '//'} ---- this sample, after the earlier ones in the lesson ----`, sample].join('\n')
      : sample;
    if (sameLang) earlier.push(sample);
    const runSource = withImports(source, trackLang);
    if (squash(sample).length < 12) continue;
    // "Try it" only where the sample can really run here: the track's own language, and not a marked fragment.
    const runnable = !pre.dataset.fragment && sameLang;
    const slot = h('div.sample-slot');
    let paid = false;       // a sample earns its typing XP once per visit to the card
    const once = { ...ctx, bonus: (xp, kind) => (paid ? 0 : ((paid = true), ctx.bonus?.(xp, kind) ?? 0)) };
    const open = make => { slot.replaceChildren(make(make === typeDrill ? sample : runSource, once, () => slot.replaceChildren())); };
    const bar = h('div.sample-bar',
      h('button.mini', { type: 'button', onclick: () => open(typeDrill), title: 'Retype this sample to build muscle memory' }, '⌨ Type it'),
      runnable && h('button.mini', { type: 'button', onclick: () => open(tryIt), title: 'Edit and run this sample' }, '▶ Try it'));
    pre.after(bar, slot);
  }
  return {
    el: h('div.learn', step.title && h('h2', step.title), prose, step.toolkit && toolkitCard(step.toolkit), step.linq && linqViz(step.linq), step.trace && codeTrace(step.trace), step.regex && regexCard(step.regex)),
    ready: () => true, check: async () => ({ correct: true }), reveal() {}, lock() {},
  };
}

/**
 * A senior's toolkit: the commands (or APIs) someone experienced reaches for, each with what it is for,
 * the flags that matter and a real example, with a copy button. Entries:
 *   { "cmd": "git log --oneline --graph --all", "what": "...", "flags": [["--graph", "draw the branch lines"]],
 *     "example": "git log -S'retryCount' --oneline", "when": "optional: the situation it is for", "lang": "bash" }
 */
function toolkitCard(entries) {
  const copy = (text, btn) => {
    navigator.clipboard?.writeText(text).then(() => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); }).catch(() => {});
  };
  return h('div.toolkit',
    h('div.toolkit-head', h('span.toolkit-badge', 'Senior’s toolkit'), h('span.muted.small', 'What experienced people type, and why. Copy any line.')),
    entries.map(e => {
      const lang = e.lang || 'bash';
      const ex = e.example ?? e.cmd;
      const btn = h('button.mini', { type: 'button', title: 'Copy the example', onclick: () => copy(ex, btn) }, 'Copy');
      return h('div.toolkit-item',
        h('div.toolkit-cmd', h('code', { html: highlight(e.cmd, lang) }), btn),
        h('div.toolkit-what', { html: inline(e.what || '') }),
        e.when && h('div.toolkit-when.muted.small', { html: inline('When: ' + e.when) }),
        e.flags?.length && h('dl.toolkit-flags', e.flags.map(([flag, meaning]) => [h('dt', h('code', flag)), h('dd', { html: inline(meaning) })])),
        e.example && e.example !== e.cmd && h('pre.code.toolkit-ex', h('code', { html: highlight(e.example, lang) })));
    }));
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
    el: h('div.predict', prompt(step), step.setup && sqlData(step.setup, ctx, { open: true, label: 'The data this query runs on' }), h('div', { html: codeBlock(step.code, document.documentElement.dataset.codeLang || 'csharp') }),
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

  // Typing mode: the shuffled lines stay on screen as raw material, and you type the program.
  const strip = s => s.replace(/\s+/g, '');
  let typing = prefersTyping();
  const editor = createEditor({
    assist: false, minLines: step.lines.length + 1, onChange: () => ctx.onChange(), onRun: () => ctx.submit(),
    popout: { title: 'Put in order', runLabel: 'Check', side: () => [list] },
  });
  const typedBox = h('div.typed-box', h('p.muted', 'Type the lines above in the right order. Spacing does not matter.'), editor.el);
  const dragHelp = h('p.muted', 'Drag the lines, or use the arrows.');
  const apply = () => {
    typedBox.hidden = !typing;
    dragHelp.hidden = typing;
    list.classList.toggle('reference', typing);
    typing ? list.dataset.locked = '1' : delete list.dataset.locked;
  };
  const toggle = modeToggle(typing, on => { typing = on; rememberTyping(on); clear(); apply(); ctx.onChange(); if (on) editor.focus(); });
  apply();

  const typedCheck = () => {
    const mine = editor.value.split('\n').map(strip).filter(Boolean);
    const scored = valid.map(v => {
      const want = v.map(strip);
      let same = 0;
      while (same < mine.length && same < want.length && mine[same] === want[same]) same++;
      return { same, ok: same === want.length && mine.length === want.length };
    });
    // Also accept the right text with different line breaks.
    const flat = strip(editor.value);
    if (scored.some(s => s.ok) || valid.some(v => strip(v.join('')) === flat)) return { correct: true, typed: true };
    const best = Math.max(...scored.map(s => s.same));
    return { correct: false, detail: best === 0 ? 'The first line is not right yet.' : `The first ${best} line${best === 1 ? ' is' : 's are'} right. Check line ${best + 1}.` };
  };

  return {
    el: h('div.order', h('div.step-head', prompt(step), toggle), dragHelp, list, typedBox),
    ready: () => !typing || editor.value.trim().length > 0,
    focus() { if (typing) editor.focus(); },
    async check() {
      if (typing) return typedCheck();
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
      if (typing) editor.value = step.lines.join('\n');
    },
    lock(on) { on || typing ? list.dataset.locked = '1' : delete list.dataset.locked; toggle.lock(on); },
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

  // Typing mode: the gaps become text boxes and the chips are hidden, so you recall instead of recognise.
  const typedHtml = highlight(step.code).replace(/__(\d+)__/g, (_, n) => `<input class="slot-input" data-n="${n}" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Gap ${n}">`);
  const typedEl = h('pre.code.blanks-code', h('code', { html: typedHtml }));
  const inputs = [...typedEl.querySelectorAll('input')].sort((a, b) => a.dataset.n - b.dataset.n);
  const strip = s => s.replace(/\s+/g, '');
  inputs.forEach((input, i) => {
    input.style.width = `${Math.min(Math.max(...accept[i].map(a => a.length), 3), 24) + 3}ch`;
    input.addEventListener('input', () => { input.classList.remove('right', 'wrong'); ctx.onChange(); });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = inputs.find(x => !x.value.trim());
      next ? next.focus() : ctx.submit();
    });
  });

  let typing = prefersTyping();
  const typedHelp = h('p.muted', 'Type what belongs in each gap. Enter moves to the next one.');
  const apply = () => { codeEl.hidden = typing; bank.hidden = typing; typedEl.hidden = !typing; typedHelp.hidden = !typing; };
  const toggle = modeToggle(typing, on => { typing = on; rememberTyping(on); apply(); ctx.onChange(); if (on) inputs[0]?.focus(); });

  const el = h('div.blanks', h('div.step-head', prompt(step), toggle), typedHelp, codeEl, typedEl, bank);
  const board = new Board(el, { tokens, zones, bank, onChange: () => { board.clearMarks(); ctx.onChange(); } });
  const text = id => tokens.find(t => t.id === id).text;
  apply();

  const drag = boardStep(el, board, {
    accepts: zoneId => accept[Number(zoneId.slice(1)) - 1],
    labelOf: text,
    readyWhen: () => board.slotsFilled,
  });

  return {
    ...drag,
    ready: () => (typing ? inputs.every(i => i.value.trim()) : drag.ready()),
    focus() { if (typing) inputs[0]?.focus(); },
    async check() {
      if (!typing) return drag.check();
      let right = 0;
      inputs.forEach((input, i) => {
        const ok = accept[i].some(a => strip(a) === strip(input.value));
        if (ok) right++;
        input.classList.remove('right', 'wrong');
        input.classList.add(ok ? 'right' : 'wrong');
      });
      const ok = right === inputs.length;
      return { correct: ok, typed: true, detail: ok ? '' : `${right} of ${inputs.length} are right. Capital letters matter.` };
    },
    lock(on) { drag.lock(on); inputs.forEach(i => { i.disabled = on; }); toggle.lock(on); },
    reveal() {
      inputs.forEach((input, i) => { input.value = accept[i][0]; input.classList.remove('wrong'); input.classList.add('right'); });
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
      // An error inside an earlier piece this step uses ("uses"): name the file, it is not the code in the editor.
      : [h('span.diag-where', d.file && !['Program.cs', 'Source.cs'].includes(d.file) && r.uses?.some(u => u.file === d.file) ? `${d.file} line ${d.line}` : `Line ${d.line}`),
        h('span', `${d.message} `), h('span.muted', d.id)]);

  // "uses": which earlier pieces ran with this step, and whose they were.
  if (r.uses?.length) {
    panel.append(h('div.out-section.uses-notes',
      h('div.out-title', 'Built on your earlier pieces'),
      r.uses.map(u => h(`div.uses-note.${u.source}`, h('span.uses-mark', u.source === 'yours' ? '✓' : '◇'), h('span', u.note))),
      r.usesProblems?.length > 0 && h('p.muted.small', r.usesProblems.join(' '))));
  }

  if (r.sql) return renderSqlOutput(panel, r, errors, diagRow);
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
  if (r.images?.length) panel.append(h('div.out-section', h('div.out-title', r.images.length === 1 ? 'Chart' : 'Charts'), h('div.out-charts', r.images.map(src => h('img.out-chart', { src, alt: 'A chart your program drew' })))));
  if (r.stderr) panel.append(h('div.out-section', h('div.out-title.bad', 'Runtime error'), h('pre.out.err', r.stderr)));
  if (warnings.length) panel.append(h('div.out-section', h('div.out-title.warn', 'Compiler warnings'), warnings.slice(0, 6).map(diagRow)));
  if (r.ms != null) panel.append(h('div.muted.small.out-time', `${r.ms} ms`));
}

/** SQL steps: the error, the checks, the result as a grid, and a peek at every table. */
function renderSqlOutput(panel, r, errors, diagRow) {
  if (errors.length) {
    panel.append(h('div.out-section', h('div.out-title.bad', 'Your SQL has an error'), errors.slice(0, 4).map(diagRow),
      r.timedOut ? null : h('p.muted.small', 'Check the spelling of table and column names, commas between columns, and quotes around text.')));
  }
  if (r.tests?.length) {
    const failed = r.tests.filter(t => !t.pass).length;
    panel.append(h('div.out-section',
      h(`div.out-title.${failed ? 'bad' : 'good'}`, failed ? `${r.tests.length - failed} of ${r.tests.length} checks pass` : r.tests.length === 1 ? 'The check passes' : `All ${r.tests.length} checks pass`),
      r.tests.map(t => h(`div.test.${t.pass ? 'pass' : 'fail'}`,
        h('span.test-mark', t.pass ? '✓' : '✗'),
        h('div', h('div.test-name', t.name), !t.pass && t.detail && h('pre.test-detail', t.detail))))));
  }
  if (r.table) panel.append(h('div.out-section', h('div.out-title', r.table.title || 'Result'), sqlGrid(r.table)));
  else if (!errors.length && !r.tests?.length && !r.tables?.length) panel.append(h('div.out-section', h('div.out-title', 'Result'), h('p.muted.small', 'No statement returned rows.')));
  if (r.stdout) panel.append(h('div.out-section', h('div.out-title', 'Messages'), h('pre.out', r.stdout)));
  if (r.tables?.length) {
    panel.append(h('details.out-section.sql-tables', { open: !r.table && !errors.length },
      h('summary.out-title', `Tables in the database (${r.tables.length})`),
      r.tables.map(t => h('div.sql-table-peek', h('div.sql-table-name', t.title), sqlGrid(t, { cap: 50 })))));
  }
  if (r.ms != null) panel.append(h('div.muted.small.out-time', `${r.ms} ms`));
}

function code(step, ctx) {
  // A cold rebuild (pacing.js): blank editor, no hints, no solution, no autocomplete, no saved draft to peek at.
  const cold = !!step.cold;
  const draftKey = cold ? null : ctx.draftKey;
  // In a project, a stage opens with the learner's own program from the stage before.
  const starter = cold ? '' : (step.carry && ctx.carried) || (step.starter ?? '');
  const panel = h('div.output', { hidden: true });
  const status = h('span.muted.small');
  let busy = false, passed = false;
  const started = Date.now();
  let passedMs = null;

  const editor = createEditor({
    value: (draftKey && state.drafts[draftKey]) ?? starter,
    onChange: v => { if (draftKey) { state.drafts[draftKey] = v; save(); } ctx.onChange(); },
    onRun: () => ctx.submit(),
    minLines: Math.max(cold ? 10 : 6, starter.split('\n').length + 2),
    assist: !cold,
    // The large view keeps the task, the buttons and the results beside the code.
    popout: { title: step.title || 'Code', runLabel: 'Run checks', side: () => [coldBanner, promptEl, toolsEl, panel] },
  });

  // A gentle timer for a cold step with a "timeLimit": it never fails the step, but going over costs a star.
  const timer = cold && step.timeLimit ? h('span.cold-timer', { role: 'timer', 'aria-live': 'off' }) : null;
  const tick = () => {
    if (!timer) return;
    const ms = (passedMs ?? Date.now() - started);
    const over = overTime(ms, step.timeLimit);
    timer.textContent = over ? `${clock(ms)}: over ${clock(step.timeLimit * 1000)}, keep going` : `${clock(ms)} / ${clock(step.timeLimit * 1000)}`;
    timer.classList.toggle('over', over);
  };
  const interval = timer ? setInterval(tick, 1000) : null;
  tick();

  const firstInput = step.tests?.find(t => t.stdin)?.stdin;
  const setBusy = (on, label) => { busy = on; runBtn.disabled = on; status.textContent = on ? label : ''; ctx.onChange(); };

  const run = async () => {
    if (busy) return;
    setBusy(true, 'Compiling and running…');
    try {
      const r = await api('run', { track: ctx.track, code: editor.value, stdin: firstInput || step.stdin || '', template: step.template, framework: step.framework, setup: step.setup });
      editor.mark(r.diagnostics);
      renderRunOutput(panel, r, { stdin: firstInput });
    } catch (e) {
      panel.hidden = false;
      panel.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?'));
    }
    setBusy(false);
  };

  const runBtn = h('button.btn.ghost', { type: 'button', onclick: run, title: 'Run without grading' }, '▶ Run');
  // SQL steps: look at the tables the exercise starts with, before writing anything.
  const dataBtn = h('button.btn.ghost', { type: 'button', title: 'Show every table the exercise starts with', onclick: async () => {
    if (busy) return;
    setBusy(true, 'Loading the tables…');
    try { renderRunOutput(panel, await api('run', { track: ctx.track, code: '', setup: step.setup })); }
    catch { panel.hidden = false; panel.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?')); }
    setBusy(false);
  } }, '▦ Show the data');
  const resetBtn = h('button.btn.ghost', {
    type: 'button', title: 'Back to the starting code',
    onclick: async () => {
      if (editor.value !== starter && !(await ask('Replace your code with the starting code?', { ok: 'Reset' }))) return;
      editor.value = starter;
      if (draftKey) { delete state.drafts[draftKey]; save(); }
    },
  }, '↺ Reset');

  const coldBanner = cold ? h('div.cold-banner',
      h('div', h('b', ctx.mode === 'practice' ? 'Can you still do it?' : 'Cold rebuild: from memory'),
        h('div.muted.small', ctx.mode === 'practice'
          ? 'You proved this before. Write it again from memory: no starter, no hints, no autocomplete.'
          : 'No starter, no hints, no autocomplete, no solution to reveal. Same tests as before. Write what you remember.')),
      timer) : null;
  const promptEl = prompt(step);
  const toolsEl = h('div.code-tools', !step.template && runBtn, step.setup && dataBtn, resetBtn, status, h('span.spacer'), h('span.muted.small', 'Ctrl + Enter to check · Ctrl + Shift + F: large view'));
  const el = h(`div.code-step${cold ? '.cold' : ''}`,
    coldBanner,
    h('div.code-head', step.title && h('h2', step.title), step.mode === 'fix' && h('span.tag.fix', '🐞 Fix the bug'),
      (step.framework || '').split('+').includes('web') && h('span.tag.web', '🌐 Live web server'),
      (step.framework || '').split('+').includes('efcore') && h('span.tag.web', '🗄 EF Core + SQLite'),
      step.carry && ctx.carried && h('span.tag', 'Your code so far')),
    promptEl,
    editor.el,
    toolsEl,
    panel);

  return {
    el,
    ready: () => !busy && editor.value.trim().length > 0,
    async check() {
      setBusy(true, 'Running the checks…');
      try {
        const r = await api('check', { track: ctx.track, module: ctx.module, lesson: ctx.lesson, step: ctx.idx, code: editor.value, dream: step.variant, uses: ctx.uses?.(step) });
        editor.mark(r.diagnostics);
        renderRunOutput(panel, r);
        passed = r.passed;
        const ms = Date.now() - started;
        const late = cold && overTime(ms, step.timeLimit);
        if (r.passed) { passedMs = ms; tick(); if (interval) clearInterval(interval); ctx.onPassed?.(editor.value, { cold, ms, inTime: !late }); editor.popIn(); }
        const failed = r.tests.filter(t => !t.pass).length;
        return {
          correct: r.passed, overTime: r.passed && late,
          detail: r.passed ? '' : !r.compiled ? (r.sql ? 'Your SQL has an error. Read it below.' : 'It does not compile yet. Read the first error below.') : `${failed} check${failed === 1 ? '' : 's'} failed. The details are below.`,
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
    destroy() { if (interval) clearInterval(interval); },
  };
}
