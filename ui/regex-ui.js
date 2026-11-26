// Shared regex widgets: a highlighted pattern box, highlighted test text, the explanation tree, the step debugger
// and the small "regex card" used on learn cards. The lab (lab-regex.js) and lesson steps (regexstep.js) build on these.
import { h, esc, api } from './util.js';
import { parse, explain, runTrace } from './regex-core.js';

export const GROUP_COLORS = 8;

/** replaceChildren that skips false and null (replaceChildren itself would print them as text). */
export const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false && k !== ''));
const gcls = n => `rxg${((n - 1) % GROUP_COLORS) + 1}`;

// ---------------------------------------------------------------- highlighted inputs (textarea over a coloured copy)

/** A textarea with a coloured copy of its text behind it. paint(html) sets the backdrop. */
export function hiliteBox({ value = '', rows = 1, placeholder = '', label, onInput, className = '', mono = true, spell = false } = {}) {
  const back = h('div.rx-back', { 'aria-hidden': 'true' });
  const ta = h('textarea.rx-ta', { rows, spellcheck: spell, autocomplete: 'off', autocapitalize: 'off', placeholder, 'aria-label': label || placeholder, value });
  const wrap = h(`div.rx-box${className ? '.' + className : ''}${mono ? '.mono' : ''}`, back, ta);
  const sync = () => { back.scrollTop = ta.scrollTop; back.scrollLeft = ta.scrollLeft; };
  ta.addEventListener('scroll', sync);
  ta.addEventListener('input', () => { autosize(); onInput?.(ta.value); });
  const autosize = () => {
    if (rows > 1) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 20)}px`;
  };
  return {
    el: wrap, ta,
    get value() { return ta.value; },
    set value(v) { ta.value = v; autosize(); onInput?.(v); },
    paint(html) { back.innerHTML = html + '\n'; sync(); },
    focus() { ta.focus(); },
    autosize,
  };
}

/** The pattern, coloured by what each part is. active = [start, end] to outline (explanation hover, debugger). */
export function patternHtml(src, parsed, active) {
  const kind = new Array(src.length).fill('lit');
  const grp = new Array(src.length).fill(0);
  const mark = (s, e, k) => { for (let i = Math.max(0, s); i < Math.min(e, src.length); i++) kind[i] = k; };
  (function walk(n) {
    if (!n || typeof n !== 'object' || !n.type) return;
    switch (n.type) {
      case 'set': case 'class': case 'any': case 'prop': mark(n.start, n.end, 'cls'); break;
      case 'anchor': mark(n.start, n.end, 'anc'); break;
      case 'backref': mark(n.start, n.end, 'bref'); break;
      case 'comment': mark(n.start, n.end, 'cmt'); break;
      case 'mods': mark(n.start, n.end, 'grp'); break;
      case 'char': if (src[n.start] === '\\') mark(n.start, n.end, 'esc'); break;
      case 'quant': walk(n.body); mark(n.qStart, n.end, 'q'); return;
      case 'alt': for (let k = 0; k < n.alts.length - 1; k++) mark(n.alts[k].end, n.alts[k].end + 1, 'alt'); break;
      case 'group': case 'look': {
        const open = n.body ? n.body.start : n.start + 1;
        const k = n.type === 'look' ? 'look' : n.number ? 'gp' : 'grp';
        mark(n.start, open, k); mark(n.end - 1, n.end, k);
        if (n.number) for (const i of [...Array(open - n.start).keys()].map(x => x + n.start).concat([n.end - 1])) grp[i] = n.number;
        break;
      }
      default: break;
    }
    for (const c of [n.body, ...(n.alts || []), ...(n.items || [])]) walk(c);
  })(parsed?.ast);
  for (const [s, e] of parsed?.ignored || []) mark(s, e, 'cmt');
  const err = parsed?.error?.at;
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const cls = ['rxp-' + kind[i]];
    if (grp[i]) cls.push(gcls(grp[i]));
    if (active && i >= active[0] && i < active[1]) cls.push('rxp-now');
    if (err != null && i === Math.min(err, src.length - 1)) cls.push('rxp-err');
    out += `<span class="${cls.join(' ')}">${esc(src[i])}</span>`;
  }
  return out;
}

/**
 * Test text with matches and groups coloured. matches: [{ index, length, groups: [{ number, index, length, success }] }].
 * Alternate matches get alternating tints so neighbours stay apart; an empty match shows as a thin bar.
 */
export function textHtml(text, matches, { selected = -1, spans } = {}) {
  const n = text.length;
  const inMatch = new Int32Array(n).fill(-1);
  const group = new Int32Array(n).fill(0);
  const empties = new Map();
  const list = spans ? spansToMatches(spans) : matches || [];
  list.forEach((m, k) => {
    if (m.length === 0) { empties.set(m.index, k); return; }
    for (let i = m.index; i < m.index + m.length && i < n; i++) inMatch[i] = k;
    const gs = (m.groups || []).filter(g => g.number > 0 && g.success && g.length > 0).sort((a, b) => b.length - a.length);
    for (const g of gs) for (let i = g.index; i < g.index + g.length && i < n; i++) group[i] = g.number;
  });
  let out = '', i = 0;
  const open = k => `<span class="rxt-m ${k % 2 ? 'odd' : 'even'}${k === selected ? ' sel' : ''}">`;
  while (i <= n) {
    if (empties.has(i)) out += `<span class="rxt-empty${empties.get(i) === selected ? ' sel' : ''}" title="empty match at ${i}"></span>`;
    if (i === n) break;
    const k = inMatch[i], g = group[i];
    let j = i;
    while (j < n && inMatch[j] === k && group[j] === g && !(j > i && empties.has(j))) j++;
    const chunk = esc(text.slice(i, j));
    if (k < 0) out += chunk;
    else out += open(k) + (g ? `<span class="rxt-g ${gcls(g)}">${chunk}</span>` : chunk) + '</span>';
    i = j;
  }
  return out;
}

/** Server spans [index, length, group] (group 0 starts a new match) to the matches shape textHtml uses. */
export function spansToMatches(spans) {
  const out = [];
  for (const [index, length, g] of spans || []) {
    if (g === 0) out.push({ index, length, groups: [] });
    else out[out.length - 1]?.groups.push({ number: g, index, length, success: true });
  }
  return out;
}

// ---------------------------------------------------------------- explanation tree

/** The pattern explained line by line. onHover([start, end] | null) lets the page outline that part of the pattern. */
export function explainView(parsed, { onHover } = {}) {
  if (parsed.error) return h('div.rx-explain', h('div.rx-err', h('b', 'The pattern does not parse: '), parsed.error.message, h('span.muted', ` (at position ${parsed.error.at})`)));
  const lines = explain(parsed);
  if (!lines.length) return h('div.rx-explain', h('p.muted', 'Type a pattern to see it explained, part by part.'));
  return h('div.rx-explain', { role: 'list' },
    lines.map(l => h(`div.rx-ex-line.k-${l.kind}`, {
      role: 'listitem', tabindex: 0, style: { '--d': l.depth },
      onmouseenter: () => onHover?.([l.start, l.end]), onmouseleave: () => onHover?.(null),
      onfocus: () => onHover?.([l.start, l.end]), onblur: () => onHover?.(null),
    },
    h(`code.rx-ex-tok${l.group ? '.' + gcls(l.group) : ''}`, l.token.length > 40 ? l.token.slice(0, 38) + '…' : l.token || '∅'),
    h('span.rx-ex-text', l.text))),
    parsed.warnings.length > 0 && h('div.rx-warns', parsed.warnings.map(w => h('div.rx-warn', '⚠ ', w.text))));
}

// ---------------------------------------------------------------- step debugger

const EV_LABEL = { try: 'try', ok: 'match', fail: 'fail', back: 'backtrack', start: 'start', match: 'found' };

/**
 * Watch a backtracking engine walk the text. get() returns { pattern, flags, flavor, text }.
 * The engine here is a teaching model of the same algorithm .NET's interpreter uses; the lab compares its answer with the real one.
 */
export function debuggerView(get, { maxSteps = 200000, onActive } = {}) {
  let run = null, at = 0, timer = null, speed = 120, parsed = null, src = '', text = '';
  const status = h('div.rx-dbg-status', { 'aria-live': 'polite' });
  const patView = h('pre.rx-dbg-pat.mono');
  const textView = h('div.rx-dbg-text.mono');
  const log = h('ol.rx-dbg-log');
  const slider = h('input.rx-dbg-slider', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Step', oninput: e => { pause(); go(Number(e.target.value)); } });
  const playBtn = h('button.btn.primary.small', { type: 'button', onclick: () => (timer ? pause() : play()) }, '▶ Play');
  const counter = h('div.rx-dbg-count');

  function load() {
    pause();
    const g = get();
    src = g.pattern; text = g.text.length > 400 ? g.text.slice(0, 400) : g.text;
    parsed = parse(src, { flavor: g.flavor, flags: g.flags });
    if (parsed.error) { run = null; put(status, h('span.bad', parsed.error.message)); patView.innerHTML = patternHtml(src, parsed); textView.replaceChildren(); log.replaceChildren(); put(counter, ); return; }
    run = runTrace(parsed, text, { all: false, maxSteps, maxTrace: 6000 });
    slider.max = Math.max(0, run.trace.length - 1);
    const found = run.matches[0];
    put(counter, 
      h('div.rx-dbg-big', h('b', run.aborted ? `> ${maxSteps.toLocaleString()}` : run.steps.toLocaleString()), h('span', ' steps')),
      h('div.small', run.aborted
        ? h('span.bad', 'Stopped: catastrophic backtracking. The number of ways to split the text explodes with every extra character.')
        : found ? h('span.good', `Match at ${found.index}–${found.end}: "${text.slice(found.index, found.end)}"`) : h('span.muted', 'No match anywhere.')),
      g.text.length > 400 && h('div.small.muted', 'Only the first 400 characters are traced.'),
      run.truncatedTrace && h('div.small.muted', `The replay shows the first ${run.trace.length.toLocaleString()} steps.`));
    go(0);
  }

  function go(i) {
    if (!run) return;
    at = Math.max(0, Math.min(i, run.trace.length - 1));
    slider.value = at;
    paint();
  }
  function play() {
    if (!run?.trace.length) return;
    if (at >= run.trace.length - 1) at = -1;
    playBtn.textContent = '❚❚ Pause';
    const tick = () => { if (at < run.trace.length - 1) { go(at + 1); timer = setTimeout(tick, speed); } else pause(); };
    tick();
  }
  function pause() { clearTimeout(timer); timer = null; playBtn.textContent = '▶ Play'; }

  function paint() {
    const e = run.trace[at];
    if (!e) return;
    const active = e.at[1] > e.at[0] ? e.at : null;
    patView.innerHTML = patternHtml(src, parsed, active);
    patView.dataset.ev = e.ev;
    onActive?.(active);
    // The text as boxes: tried so far (from .. pos), the cursor, earlier matches.
    const boxes = [];
    for (let i = 0; i <= text.length; i++) {
      const cls = ['rx-c'];
      if (i >= e.from && i < e.pos) cls.push('tried');
      if (i === e.pos) cls.push('cur', 'ev-' + e.ev);
      if (i === e.from) cls.push('from');
      const ch = text[i];
      boxes.push(h(`span.${cls.join('.')}`, { title: `position ${i}` }, i === text.length ? '⊣' : ch === '\n' ? '↵' : ch === ' ' ? '·' : ch));
    }
    textView.replaceChildren(...boxes);
    textView.querySelector('.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const recent = run.trace.slice(Math.max(0, at - 7), at + 1);
    log.replaceChildren(...recent.map((x, k) => h(`li.ev-${x.ev}${k === recent.length - 1 ? '.now' : ''}`,
      h('span.rx-ev', EV_LABEL[x.ev]),
      x.at[1] > x.at[0] && h('code', src.slice(x.at[0], x.at[1]).slice(0, 24)),
      h('span', ` at ${x.pos}`), x.note && h('span.muted', ` · ${x.note}`))));
    put(status, h('b', `Event ${at + 1} of ${run.trace.length.toLocaleString()}`), h('span.muted', ` · step ${e.s.toLocaleString()} · attempt starting at position ${e.from}`));
  }

  const keys = e => {
    if (e.target.matches('textarea, input:not([type=range]), select')) return;
    if (e.key === 'ArrowRight') { pause(); go(at + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { pause(); go(at - 1); e.preventDefault(); }
  };
  const el = h('div.rx-dbg', { tabindex: 0, onkeydown: keys },
    h('div.rx-dbg-controls',
      h('button.btn.ghost.small', { type: 'button', onclick: load, title: 'Trace the current pattern and text again' }, '↻ Trace'),
      playBtn,
      h('button.btn.ghost.small', { type: 'button', title: 'Back one step (←)', 'aria-label': 'Back one step', onclick: () => { pause(); go(at - 1); } }, '◀'),
      h('button.btn.ghost.small', { type: 'button', title: 'Forward one step (→)', 'aria-label': 'Forward one step', onclick: () => { pause(); go(at + 1); } }, '▶'),
      h('button.btn.ghost.small', { type: 'button', title: 'Jump to the next backtrack', onclick: () => { pause(); const n = run?.trace.findIndex((x, k) => k > at && x.ev === 'back'); if (n > 0) go(n); } }, '⤼ next backtrack'),
      slider,
      h('select.rx-speed', { 'aria-label': 'Speed', onchange: e => { speed = Number(e.target.value); } },
        [[600, 'slow'], [120, 'normal'], [30, 'fast'], [5, 'very fast']].map(([v, l]) => h('option', { value: v, selected: v === speed }, l)))),
    counter, status,
    h('div.rx-dbg-grid',
      h('div', h('div.field-label', 'Pattern: the part being tried'), patView,
        h('div.field-label', 'Text: tried so far, and the cursor'), textView),
      h('div', h('div.field-label', 'What the engine just did'), log)),
    h('div.rx-dbg-legend.small.muted', h('span.ev-ok', 'match'), h('span.ev-fail', 'fail'), h('span.ev-back', 'backtrack'),
      ' · ← → step, or drag the bar. This replays a teaching model of a backtracking engine; step counts are comparable, not identical, to .NET\'s.'));
  return { el, load };
}

/** Steps a backtracking engine needs as the input grows: the picture of catastrophic backtracking. */
export function growthChart(rows) {
  // rows: [{ label, series: [{ n, steps, capped }] }]
  const max = Math.max(1, ...rows.flatMap(r => r.series.map(s => s.steps)));
  const logMax = Math.log10(max + 1);
  return h('div.rx-growth',
    rows.map((r, ri) => h('div.rx-growth-row',
      h('div.rx-growth-label', h('code', r.label)),
      h('div.rx-growth-bars', r.series.map(s => h(`div.rx-bar.s${ri}${s.capped ? '.capped' : ''}`, {
        title: `${s.n} characters: ${s.capped ? 'more than ' : ''}${s.steps.toLocaleString()} steps`,
        style: { height: `${Math.max(3, (Math.log10(s.steps + 1) / logMax) * 100)}%` },
      }, h('span.rx-bar-n', s.n)))),
      h('div.rx-growth-max.small', `${r.series.at(-1)?.capped ? '> ' : ''}${(r.series.at(-1)?.steps ?? 0).toLocaleString()} steps at ${r.series.at(-1)?.n} chars`))),
    h('div.small.muted', 'Bar height is on a log scale: each row up is 10 times more work. A straight climb means exponential time.'));
}

export function measureGrowth(pattern, flags, flavor, make, sizes, cap = 1_000_000) {
  const parsed = parse(pattern, { flavor, flags });
  if (parsed.error) return [];
  const series = [];
  let capped = false;
  for (const n of sizes) {
    if (capped) { series.push({ n, steps: cap, capped: true }); continue; }
    const r = runTrace(parsed, make(n), { maxSteps: cap, maxTrace: 0, firstOnly: true });
    capped = r.aborted;
    series.push({ n, steps: r.steps, capped: r.aborted });
  }
  return series;
}

// ---------------------------------------------------------------- the learn-card visual

/**
 * A small live regex lab for a learn card: { pattern, flags, text, replace?, debug? }.
 * The learner can edit the pattern and the text; .NET (the server) does the matching.
 */
export function regexCard(spec) {
  let flags = spec.flags || '';
  let timer = null;
  const text = Array.isArray(spec.text) ? spec.text.join('\n') : spec.text || '';
  const pat = hiliteBox({ value: spec.pattern || '', label: 'Pattern', onInput: () => schedule(), className: 'rx-pattern' });
  const body = hiliteBox({ value: text, rows: Math.min(8, text.split('\n').length + 1), label: 'Test text', onInput: () => schedule(), className: 'rx-text' });
  const rep = spec.replace != null ? hiliteBox({ value: spec.replace, label: 'Replacement', onInput: () => schedule(), className: 'rx-rep' }) : null;
  const status = h('div.rx-status.small', { 'aria-live': 'polite' });
  const result = h('pre.rx-replaced.mono', { hidden: true });
  const explainSlot = h('div');
  const dbg = spec.debug ? debuggerView(() => ({ pattern: pat.value, flags, flavor: 'dotnet', text: body.value })) : null;
  const flagBtns = h('div.rx-flags', [...'imsx'].map(f => h(`button.rx-flag${flags.includes(f) ? '.on' : ''}`, {
    type: 'button', title: { i: 'IgnoreCase', m: 'Multiline', s: 'Singleline', x: 'IgnorePatternWhitespace' }[f], 'aria-pressed': String(flags.includes(f)),
    onclick: e => { flags = flags.includes(f) ? flags.replace(f, '') : flags + f; e.currentTarget.classList.toggle('on'); e.currentTarget.setAttribute('aria-pressed', String(flags.includes(f))); schedule(); },
  }, f)));

  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 180); paintPattern(); }
  function paintPattern(active) { const p = parse(pat.value, { flavor: 'dotnet', flags }); pat.paint(patternHtml(pat.value, p, active)); return p; }
  async function refresh() {
    const parsed = paintPattern();
    explainSlot.replaceChildren(h('details.rx-card-explain', h('summary', 'Explain this pattern'), explainView(parsed, { onHover: r => paintPattern(r) })));
    if (!pat.value) { body.paint(esc(body.value)); status.textContent = 'Type a pattern.'; return; }
    let r;
    try { r = await api('regex', { pattern: pat.value, flags, input: body.value, replacement: rep ? rep.value : null }); }
    catch { status.textContent = 'Could not reach the dojo server.'; return; }
    if (r.error) { body.paint(esc(body.value)); put(status, h('span.bad', r.error)); result.hidden = true; return; }
    body.paint(textHtml(body.value, r.matches));
    put(status, h('b', `${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}`),
      r.matches.length > 0 && h('span.muted', ` · ${r.matches.slice(0, 6).map(m => JSON.stringify(m.value)).join(', ')}${r.matches.length > 6 ? ', …' : ''}`),
      r.timedOut && h('span.bad', ' · timed out: catastrophic backtracking'));
    if (rep) { result.hidden = false; result.textContent = r.replaced ?? ''; }
  }
  const el = h('div.rx-card',
    h('div.rx-card-head', h('b', 'Try it'), h('span.muted.small', ' · real .NET Regex · edit anything'), h('span.spacer'),
      h('a.mini', { href: '#/labs/regex', onclick: () => { try { sessionStorage.setItem('regexLab', JSON.stringify({ pattern: pat.value, flags, text: body.value, replacement: rep?.value })); } catch { /* private mode */ } } }, 'Open in the regex lab ↗')),
    h('div.rx-row', h('span.rx-slash', '/'), pat.el, h('span.rx-slash', '/'), flagBtns),
    body.el,
    rep && h('div.rx-row', h('span.rx-lbl.small', 'Replace with'), rep.el),
    status, result, explainSlot,
    dbg && h('details.rx-card-dbg', { ontoggle: e => { if (e.target.open) dbg.load(); } }, h('summary', 'Step through the engine'), dbg.el));
  setTimeout(() => { pat.autosize(); rep?.autosize(); refresh(); });
  return el;
}
