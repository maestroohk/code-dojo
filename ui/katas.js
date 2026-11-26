// Code katas (#/katas, #/katas/<id>): short timed exercises in C#, Python, TypeScript and SQL, graded by the same
// runners as lessons (server/Katas.cs). A daily kata (the same for everyone on a given day), a timer that starts on
// your first keystroke, personal bests, a time-per-attempt chart with its trend, and retries in spaced intervals.
// Slowness never fails anything: the clock is for you.
//
//   state.katas = { attempts: { id: [{ at, day, ms, passed, hints, revealed }] }, retry: { id: { box, due } }, lang }
import { h, md, api, codeBlock, ask } from './util.js';
import * as game from './game.js';
import { createEditor } from './editor.js';
import { renderRunOutput } from './steps.js';
import { clock } from './pacing.js';

export const RETRY_DAYS = [3, 7, 21, 60];   // after a solve, the kata comes back after 3, then 7, 21 and 60 days
const LANG = { csharp: 'C#', python: 'Python', typescript: 'TypeScript', sql: 'SQL' };
const XP = { easy: 15, medium: 25, hard: 40 };

const ks = () => {
  const s = game.state.katas ||= {};
  s.attempts ||= {}; s.retry ||= {};
  return s;
};

let list = null;
const loadList = async () => (list ||= await api('katas'));

function fnv(s) {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  return x >>> 0;
}

/** Today's kata: the same for a given day and set of katas (optionally within one language). */
export function dailyKata(katas, day = game.dayKey(), lang = 'all') {
  const pool = (lang === 'all' ? katas : katas.filter(k => k.language === lang)).slice().sort((a, b) => a.id.localeCompare(b.id));
  return pool.length ? pool[fnv(`kata:${day}`) % pool.length] : null;
}

export const best = id => {
  const done = (ks().attempts[id] || []).filter(a => a.passed && !a.revealed);
  return done.length ? Math.min(...done.map(a => a.ms)) : null;
};

/** Katas whose spaced retry is due today. */
export const dueRetries = () => Object.entries(ks().retry).filter(([, r]) => r.due <= game.dayKey()).map(([id]) => id);

// ---------------------------------------------------------------- the list page

export async function katasView(page, id) {
  if (id) return kataView(page, id);
  const s = ks();
  let katas;
  try { katas = await loadList(); }
  catch { page('practice', h('div.empty', h('h2', 'Could not load the katas'), h('p.muted', 'Is the dojo server running?'))); return; }
  const lang = s.lang || 'all';
  const daily = dailyKata(katas, game.dayKey(), lang);
  const dailyDone = daily && (s.attempts[daily.id] || []).some(a => a.day === game.dayKey() && a.passed);
  const retries = dueRetries().map(rid => katas.find(k => k.id === rid)).filter(Boolean);
  const shown = lang === 'all' ? katas : katas.filter(k => k.language === lang);
  const solved = katas.filter(k => best(k.id) != null).length;

  const row = k => {
    const att = s.attempts[k.id] || [];
    const pb = best(k.id);
    const r = s.retry[k.id];
    return h('a.kata-row', { href: `#/katas/${k.id}` },
      h(`span.kata-lang.${k.language}`, LANG[k.language] || k.language),
      h('span.kata-title', h('b', k.title), h('span.muted.small', k.summary)),
      h(`span.kata-diff.${k.difficulty}`, k.difficulty),
      h('span.small.muted', `${k.minutes} min`),
      h('span.small.kata-pb', pb != null ? `PB ${clock(pb)}` : att.length ? `${att.length} tr${att.length === 1 ? 'y' : 'ies'}` : ''),
      h('span.small.muted', r ? (r.due <= game.dayKey() ? 'retry due' : `retry ${r.due.slice(5)}`) : ''));
  };

  page('practice',
    h('section.hero.kata-hero',
      h('div',
        h('div.eyebrow', h('a', { href: '#/practice' }, 'Practice'), ' · Katas'),
        h('h1', 'Daily kata'),
        h('p.muted', 'A short, realistic exercise against hidden tests. The clock starts on your first keystroke and only tracks your own progress: there is no time limit and no failing for being slow. Solved katas come back after 3, 7, 21 and 60 days.')),
      daily && h('div.kata-daily',
        h('div.small.muted', new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })),
        h('b.kata-daily-title', daily.title),
        h('div.small', h(`span.kata-lang.${daily.language}`, LANG[daily.language]), ' ', h(`span.kata-diff.${daily.difficulty}`, daily.difficulty), ` · about ${daily.minutes} min`, best(daily.id) != null ? ` · PB ${clock(best(daily.id))}` : ''),
        h(`a.btn${dailyDone ? '.ghost' : '.primary'}.big`, { href: `#/katas/${daily.id}` }, dailyDone ? 'Solved today · go again' : 'Start'))),
    h('div.cards',
      h('div.card', h('b.card-num', `${solved} / ${katas.length}`), h('span.muted', 'katas solved')),
      h('div.card', h('b.card-num', retries.length), h('span.muted', 'retries due')),
      h('div.card', h('b.card-num', Object.values(s.attempts).reduce((n, a) => n + a.filter(x => x.passed).length, 0)), h('span.muted', 'solves in total')),
      h('div.card', h('b.card-num', kataStreak()), h('span.muted', 'day kata streak'))),
    retries.length > 0 && h('section.panel', h('h2', 'Due for a retry'), h('p.muted.small', 'You solved these before. Doing them again from a blank page is what makes them stick.'), h('div.kata-list', retries.map(row))),
    h('section.panel',
      h('div.kata-filter', h('h2', 'All katas'), h('span.spacer'),
        ['all', 'csharp', 'python', 'typescript', 'sql'].map(l => h(`button.tab.small${lang === l ? '.active' : ''}`, {
          type: 'button', onclick: () => { s.lang = l; game.save(); katasView(page); },
        }, l === 'all' ? 'All' : LANG[l]))),
      lang !== 'all' && h('p.muted.small', `The daily kata now comes from ${LANG[lang]} only.`),
      h('div.kata-list', shown.map(row))));
}

/** The katas panel on the Practice page: today's kata and the retries that are due. */
export function practicePanel() {
  const body = h('div.kata-panel-body', h('p.muted.small', 'Loading the katas…'));
  loadList().then(katas => {
    const s = ks();
    const daily = dailyKata(katas, game.dayKey(), s.lang || 'all');
    const retries = dueRetries().length;
    const done = daily && (s.attempts[daily.id] || []).some(a => a.day === game.dayKey() && a.passed);
    body.replaceChildren(h('div.fc-row',
      daily ? h('div',
        h('div.small.muted', done ? 'Today\'s kata · solved' : 'Today\'s kata'),
        h('b', daily.title), h('div.small.muted', `${LANG[daily.language]} · ${daily.difficulty} · about ${daily.minutes} min${best(daily.id) != null ? ` · PB ${clock(best(daily.id))}` : ''}`),
        retries > 0 && h('div.small', `${retries} kata retr${retries === 1 ? 'y' : 'ies'} due`)) : h('p.muted', 'No katas found.'),
      h('div.kata-panel-actions',
        daily && h(`a.btn${done ? '.ghost' : '.primary'}`, { href: `#/katas/${daily.id}` }, done ? 'Again' : 'Start the kata'),
        h('a.btn.ghost', { href: '#/katas' }, `All ${katas.length} katas`))));
  }).catch(() => body.replaceChildren(h('p.muted', 'Could not load the katas.')));
  return h('section.panel.kata-panel',
    h('h2', 'Katas'),
    h('p.muted.small', '5 to 15 minute exercises in C#, Python, TypeScript and SQL against hidden tests, timed from your first keystroke. Personal bests and a time-per-attempt chart; solved katas come back in spaced intervals.'),
    body);
}

/** Days in a row (ending today or yesterday) with a solved kata. */
function kataStreak() {
  const days = new Set(Object.values(ks().attempts).flat().filter(a => a.passed).map(a => a.day));
  let d = new Date(), n = 0;
  if (!days.has(game.dayKey(d))) d = game.addDays(-1, d);
  while (days.has(game.dayKey(d))) { n++; d = game.addDays(-1, d); }
  return n;
}

// ---------------------------------------------------------------- one kata

async function kataView(page, id) {
  let kata;
  try { kata = await api(`katas/${encodeURIComponent(id)}`); }
  catch { page('practice', h('div.empty', h('h2', 'No such kata'), h('a.btn.primary', { href: '#/katas' }, 'All katas'))); return; }
  if (location.hash !== `#/katas/${id}`) return;
  document.documentElement.dataset.codeLang = kata.language;
  const s = ks();
  const draftKey = `kata:${id}`;
  const starter = kata.starter || '';
  let started = null, stopped = null, hints = 0, revealed = false, busy = false, interval = null;

  const timer = h('span.kata-timer', { role: 'timer' }, '0:00');
  const timerNote = h('span.small.muted', 'starts when you type');
  const tick = () => { timer.textContent = clock(started ? (stopped ?? Date.now()) - started : 0); };
  const start = () => {
    if (started) return;
    started = Date.now();
    timerNote.textContent = '';
    interval = setInterval(tick, 500);
  };

  const panel = h('div.output', { hidden: true });
  const status = h('span.muted.small');
  const after = h('div.kata-after');
  const editor = createEditor({
    value: game.state.drafts[draftKey] ?? starter,
    language: kata.language,
    minLines: Math.max(12, starter.split('\n').length + 4),
    onChange: v => { start(); game.state.drafts[draftKey] = v; game.save(); },
    onRun: () => check(),
    popout: { title: kata.title, runLabel: 'Run checks', side: () => [promptEl, tools, panel] },
  });

  const hintBox = h('div.kata-hints');
  const hintBtn = (kata.hints || []).length ? h('button.btn.ghost', { type: 'button', onclick: () => {
    if (hints >= kata.hints.length) return;
    hintBox.append(h('div.callout', { html: md(`**Hint ${hints + 1}.** ${kata.hints[hints]}`) }));
    hints++;
    if (hints >= kata.hints.length) hintBtn.disabled = true;
  } }, '💡 Hint') : null;

  const checkBtn = h('button.btn.primary', { type: 'button', onclick: () => check() }, 'Run checks');
  const dataBtn = kata.language === 'sql' && h('button.btn.ghost', { type: 'button', onclick: async () => {
    try { renderRunOutput(panel, await api('run', { track: 'sql', language: 'sql', code: '', setup: kata.setup }), { lang: 'sql' }); } catch { }
  } }, '▦ Show the data');
  const resetBtn = h('button.btn.ghost', { type: 'button', onclick: async () => {
    if (editor.value !== starter && !(await ask('Start over from the starter code? The timer keeps running.', { ok: 'Reset' }))) return;
    editor.value = starter; delete game.state.drafts[draftKey]; game.save();
  } }, '↺ Reset');
  const revealBtn = h('button.btn.ghost', { type: 'button', onclick: async () => {
    if (!revealed && !(await ask('Show the reference solution? This try will not count for a personal best, and the kata comes back tomorrow.', { ok: 'Show it' }))) return;
    await showSolution(true);
  } }, 'Show a solution');

  const tools = h('div.code-tools', checkBtn, dataBtn, hintBtn, resetBtn, revealBtn, status, h('span.spacer'), h('span.muted.small', 'Ctrl + Enter: run checks'));
  const promptEl = h('div.prompt', { html: md(kata.prompt) });

  async function check() {
    if (busy) return;
    start();
    busy = true; checkBtn.disabled = true; status.textContent = 'Running the hidden tests…';
    try {
      const r = await api(`katas/${encodeURIComponent(id)}/check`, { code: editor.value });
      editor.mark(r.diagnostics);
      renderRunOutput(panel, r, { code: editor.value, task: kata.prompt, lang: kata.language });
      if (r.passed && !stopped) solved();
    } catch {
      panel.hidden = false;
      panel.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?'));
    }
    busy = false; checkBtn.disabled = false; status.textContent = '';
  }

  function record(passed) {
    const ms = (stopped ?? Date.now()) - (started ?? Date.now());
    const list = s.attempts[id] ||= [];
    list.push({ at: Date.now(), day: game.dayKey(), ms, passed, hints, revealed });
    if (list.length > 60) list.splice(0, list.length - 60);
    // Spaced retries: a clean solve moves the kata one box further out; a revealed one comes back tomorrow.
    // Solving it again the same day does not push it further out: spacing needs days in between.
    const r = s.retry[id] || { box: -1 };
    if (passed && !revealed) {
      if (r.solvedOn !== game.dayKey()) {
        const box = Math.min(RETRY_DAYS.length - 1, r.box + 1);
        s.retry[id] = { box, due: game.dayKey(game.addDays(RETRY_DAYS[box])), solvedOn: game.dayKey() };
      }
    } else s.retry[id] = { box: -1, due: game.dayKey(game.addDays(1)) };
    return ms;
  }

  function solved() {
    stopped = Date.now();
    clearInterval(interval); tick();
    const prevBest = best(id);
    const ms = record(true);
    const isBest = !revealed && (prevBest == null || ms < prevBest);
    const first = (s.attempts[id] || []).filter(a => a.passed).length === 1;
    let xp = 0;
    if (!revealed) {
      xp = Math.round((XP[kata.difficulty] || 20) * (first ? 1 : 0.4) * Math.max(0.5, 1 - 0.15 * hints));
      game.addXp(xp, 'practice');
      game.state.stats.codePassed++;
    }
    delete game.state.drafts[draftKey];
    game.save(true);
    game.sound('done');
    const r = s.retry[id];
    document.querySelector('.kata-past')?.remove();   // the result below has the updated chart
    after.replaceChildren(h('section.panel.kata-result',
      h('div.kata-result-head',
        h('div', h('h2', revealed ? 'Passed, with the solution shown' : isBest ? (prevBest == null ? 'Solved: first time on the board' : 'Solved: a new personal best') : 'Solved'),
          h('p.muted', revealed ? 'This try does not count for your best time. Write it again from memory tomorrow.'
            : `${clock(ms)}${prevBest != null ? ` · best ${clock(Math.min(ms, prevBest))}` : ''}${hints ? ` · ${hints} hint${hints === 1 ? '' : 's'}` : ''}${xp ? ` · +${xp} XP` : ''}. It comes back on ${r.due}.`)),
        h('div.kata-result-actions', h('button.btn.ghost', { type: 'button', onclick: () => showSolution(false) }, 'Compare with the reference'), h('a.btn.primary', { href: '#/katas' }, 'More katas'))),
      historyChart(s.attempts[id] || [])));
  }

  async function showSolution(giveUp) {
    try {
      const { solution } = await api(`katas/${encodeURIComponent(id)}/solution`);
      if (giveUp && !stopped) {
        revealed = true;
        s.retry[id] = { box: -1, due: game.dayKey(game.addDays(1)) };   // learn from it today, rebuild it tomorrow
        game.save();
      }
      const box = h('details.kata-solution', { open: true }, h('summary', 'Reference solution'), h('div', { html: codeBlock(solution, kata.language) }),
        h('p.muted.small', giveUp && !stopped ? 'Read it, close it, then write your own version: the checks still count as a solve, just not for a best time.' : 'One clean way to do it. Yours may differ and still be right.'));
      after.querySelector('.kata-solution')?.remove();
      after.prepend(box);
    } catch { }
  }

  page('practice',
    h('div.track-head',
      h('div', h('div.eyebrow', h('a', { href: '#/katas' }, 'Katas'), ` · ${LANG[kata.language]} · ${kata.difficulty} · about ${kata.minutes} min`),
        h('h2.track-title', kata.title)),
      h('div.kata-clock', timer, timerNote, best(id) != null && h('span.small.muted', `PB ${clock(best(id))}`))),
    h('div.code-step', promptEl, hintBox, editor.el, tools, panel),
    after,
    (s.attempts[id] || []).some(a => a.passed) && h('section.panel.kata-past', h('h2', 'Your history'), historyChart(s.attempts[id])));
  // The timer stops when you leave the page.
  window.addEventListener('hashchange', () => clearInterval(interval), { once: true });
}

/** Time per solved attempt (oldest first), with the least-squares trend: falling means you are getting faster. */
export function historyChart(attempts) {
  const pts = attempts.filter(a => a.passed);
  if (pts.length < 1) return h('p.muted.small', 'Solve it to start your history.');
  const W = 520, H = 160, L = 44, B = 24, T = 12, R = 12;
  const max = Math.max(...pts.map(p => p.ms)) * 1.15 || 1;
  const x = i => L + (pts.length === 1 ? (W - L - R) / 2 : (i / (pts.length - 1)) * (W - L - R));
  const y = ms => T + (1 - ms / max) * (H - T - B);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'kata-chart', role: 'img', 'aria-label': `Time per solve: ${pts.map(p => clock(p.ms)).join(', ')}` });
  for (const f of [0, 0.5, 1]) {
    const ms = max * f;
    svg.append(el('line', { x1: L, x2: W - R, y1: y(ms), y2: y(ms), class: 'kata-grid' }), el('text', { x: L - 6, y: y(ms) + 4, 'text-anchor': 'end', class: 'kata-axis' }, clock(ms)));
  }
  if (pts.length >= 2) {
    const n = pts.length, mx = (n - 1) / 2, my = pts.reduce((a, p) => a + p.ms, 0) / n;
    let num = 0, den = 0;
    pts.forEach((p, i) => { num += (i - mx) * (p.ms - my); den += (i - mx) ** 2; });
    const slope = den ? num / den : 0;
    const at = i => Math.max(0, my + slope * (i - mx));
    svg.append(el('line', { x1: x(0), y1: y(at(0)), x2: x(n - 1), y2: y(at(n - 1)), class: `kata-trend${slope <= 0 ? ' better' : ''}` }));
    svg.append(el('polyline', { points: pts.map((p, i) => `${x(i)},${y(p.ms)}`).join(' '), class: 'kata-line' }));
  }
  pts.forEach((p, i) => {
    const dot = el('circle', { cx: x(i), cy: y(p.ms), r: 4, class: `kata-dot${p.hints ? ' hinted' : ''}${p.revealed ? ' revealed' : ''}` });
    dot.append(el('title', {}, `${p.day}: ${clock(p.ms)}${p.hints ? `, ${p.hints} hint(s)` : ''}${p.revealed ? ', solution shown' : ''}`));
    svg.append(dot, el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'kata-axis' }, p.day.slice(5)));
  });
  const trendNote = pts.length >= 2
    ? (pts[pts.length - 1].ms <= pts[0].ms ? `From ${clock(pts[0].ms)} to ${clock(pts[pts.length - 1].ms)}: getting faster.` : `Latest ${clock(pts[pts.length - 1].ms)}, first ${clock(pts[0].ms)}. Speed comes with repetition.`)
    : 'One solve so far. The trend line appears after the second.';
  return h('div.kata-history', svg, h('p.small.muted', trendNote, ' Hollow dots: hints used.'));
}
