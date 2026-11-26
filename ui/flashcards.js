// Flashcards: spaced repetition over cards made from the lessons you finished (server/Flashcards.cs makes them,
// ui/srs.js schedules them). The Practice page shows the panel; #/cards is the review screen.
//   Keys on the review screen: Space shows the answer, 1 Again, 2 Hard, 3 Good, 4 Easy, T toggles "type it".
import { h, md, api, codeBlock } from './util.js';
import * as game from './game.js';
import * as srs from './srs.js';

const XP_CAP = 30;          // XP a day from flashcards: one per due card remembered

export const flash = () => (game.state.flash = srs.ensure(game.state.flash));

/** Scheduled cards due today (learning + review): the nav badge. New cards are not counted. */
export const dueCount = () => srs.dueCount(game.state.flash, Date.now());

let cache = { key: '', cards: [] };

/** Every unlocked card: the cards of the lessons you have finished, in lesson order. */
export async function loadCards() {
  const lessons = Object.keys(game.state.lessons).sort((a, b) => (game.state.lessons[a].completedAt || '').localeCompare(game.state.lessons[b].completedAt || '') || a.localeCompare(b));
  const key = lessons.join('|');
  if (cache.key !== key || !cache.cards.length) {
    const r = await api('cards', { lessons });
    cache = { key, cards: r.cards || [] };
  }
  return cache.cards;
}

const KIND_LABEL = { command: 'Command', reverse: 'Which command?', flag: 'Flag', term: 'Term', match: 'Pair', custom: 'Card' };

// ---------------------------------------------------------------- the Practice page panel

/** The flashcards panel on the Practice page: today's counts, the review button, stats and a 7-day chart. */
export function practicePanel() {
  const f = flash();
  const body = h('div.fc-panel-body', h('p.muted.small', 'Counting your cards…'));
  const panel = h('section.panel.fc-panel',
    h('div.fc-panel-head', h('div', h('h2', 'Flashcards'), h('p.muted.small',
      'Commands, flags, terms and pairs from the lessons you finished. Recall each one, then say how well you knew it: cards you know come back less often (SM-2 spaced repetition).'))),
    body);
  loadCards().then(cards => {
    const q = srs.buildQueue(cards, f, Date.now());
    const st = srs.stats(f, Date.now());
    const due = q.counts.learning + q.counts.review;
    const total = due + q.counts.fresh;
    const pct = st.retention == null ? '–' : `${Math.round(st.retention * 100)}%`;
    const limits = h('div.fc-limits',
      limitSelect('New cards a day', 'newPerDay', [0, 5, 10, 15, 20, 30, 50]),
      limitSelect('Reviews a day', 'reviewsPerDay', [50, 100, 200, 400, 9999]));
    body.replaceChildren(
      h('div.fc-row',
        h('div.fc-counts',
          count(q.counts.review, 'to review', 'review'), count(q.counts.learning, 'learning', 'learn'), count(q.counts.fresh, 'new today', 'new'),
          h('div.muted.small', `${cards.length.toLocaleString()} cards unlocked · ${Object.keys(f.cards).length.toLocaleString()} seen`)),
        cards.length
          ? h(`a.btn${total ? '.primary' : '.ghost'}.big`, { href: '#/cards' }, total ? `Review ${total} card${total === 1 ? '' : 's'}` : 'All done today')
          : h('a.btn.ghost.big', { href: '#/' }, 'Finish a lesson first')),
      h('div.fc-stats',
        stat(pct, 'retention, 30 days', st.retention == null ? 'Shows once you have reviewed a card a second time.' : `${st.reviewed30} reviews of cards you had seen before`),
        stat(`${st.streak}`, st.streak === 1 ? 'day streak' : 'day streak', 'Days in a row with at least one card reviewed.'),
        stat(`${st.states.mature}`, 'mature cards', 'Cards with an interval of 21 days or more.'),
        h('div.fc-forecast', h('div.fc-forecast-title.small.muted', 'Due over the next 7 days'), forecastChart(st.forecast))),
      limits);
  }).catch(() => body.replaceChildren(h('p.muted', 'Could not load your cards. Is the dojo server running?')));
  return panel;
}

const count = (n, label, kind) => h(`div.fc-count.${kind}`, h('b', n), h('span.small.muted', label));
const stat = (value, label, title) => h('div.fc-stat', { title }, h('b', value), h('span.small.muted', label));

function limitSelect(label, key, values) {
  const f = flash();
  return h('label.small.fc-limit', label, ' ', h('select', {
    onchange: e => { f.settings[key] = Number(e.target.value); game.save(); },
  }, values.map(v => h('option', { value: v, selected: f.settings[key] === v }, v >= 9999 ? 'No limit' : String(v)))));
}

/** A small bar chart: cards due on each of the next days. */
export function forecastChart(values) {
  const W = 260, H = 86, pad = 16, bw = (W - 8) / values.length;
  const max = Math.max(1, ...values);
  const days = values.map((_, i) => i === 0 ? 'Today' : new Date(Date.now() + i * 86_400_000).toLocaleDateString(undefined, { weekday: 'short' }));
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + pad}`);
  svg.setAttribute('class', 'fc-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Cards due: ${values.map((v, i) => `${days[i]} ${v}`).join(', ')}`);
  values.forEach((v, i) => {
    const bh = v ? Math.max(3, (v / max) * (H - 18)) : 0;
    const x = 4 + i * bw + 4, y = H - bh;
    const rect = document.createElementNS(NS, 'rect');
    Object.entries({ x, y, width: bw - 8, height: bh, rx: 3, class: i === 0 ? 'fc-bar today' : 'fc-bar' }).forEach(([k, val]) => rect.setAttribute(k, val));
    const title = document.createElementNS(NS, 'title');
    title.textContent = `${days[i]}: ${v} card${v === 1 ? '' : 's'}`;
    rect.append(title);
    const num = document.createElementNS(NS, 'text');
    Object.entries({ x: x + (bw - 8) / 2, y: y - 4, class: 'fc-bar-num', 'text-anchor': 'middle' }).forEach(([k, val]) => num.setAttribute(k, val));
    num.textContent = v ? v : '';
    const label = document.createElementNS(NS, 'text');
    Object.entries({ x: x + (bw - 8) / 2, y: H + 12, class: 'fc-bar-label', 'text-anchor': 'middle' }).forEach(([k, val]) => label.setAttribute(k, val));
    label.textContent = days[i];
    svg.append(rect, num, label);
  });
  return svg;
}

// ---------------------------------------------------------------- the review screen

/** #/cards: review today's queue. `page(active, ...content)` draws the shell. Returns a cleanup function. */
export function cardsView(page) {
  const f = flash();
  const holder = h('div.fc-review', h('p.muted', 'Loading your cards…'));
  page('practice',
    h('div.track-head', h('div', h('div.eyebrow', h('a', { href: '#/practice' }, 'Practice'), ' · Flashcards'), h('h2.track-title', 'Flashcards'))),
    holder);
  let onKey = null;
  const leave = () => { if (onKey) document.removeEventListener('keydown', onKey); };

  loadCards().then(cards => {
    const now = Date.now();
    const q = srs.buildQueue(cards, f, now);
    // Reviews first with new cards mixed in (one new after every three reviews), then what is still learning.
    const main = [];
    const reviews = [...q.review], fresh = [...q.fresh];
    while (reviews.length || fresh.length) {
      for (let i = 0; i < 3 && reviews.length; i++) main.push(reviews.shift());
      if (fresh.length) main.push(fresh.shift());
    }
    const pending = [...q.learning];            // learning cards, shown when their minute comes
    const done = { n: 0, again: 0, xp: 0 };
    let current = null, flipped = false, typed = null;

    const next = () => {
      const t = Date.now();
      const ready = pending.filter(c => (f.cards[c.id]?.due ?? 0) <= t).sort((a, b) => f.cards[a.id].due - f.cards[b.id].due)[0];
      if (ready) { pending.splice(pending.indexOf(ready), 1); return ready; }
      if (main.length) return main.shift();
      // Nothing else to do: learning cards due within 20 minutes may be shown early.
      const soon = pending.filter(c => srs.isDue(f.cards[c.id], t, { ahead: true })).sort((a, b) => f.cards[a.id].due - f.cards[b.id].due)[0];
      if (soon) { pending.splice(pending.indexOf(soon), 1); return soon; }
      return null;
    };

    const typeable = c => c.type === 'command';
    const typeMode = () => !!f.settings.typeIt;

    function show() {
      current = next();
      flipped = false; typed = null;
      if (!current) return finish();
      draw();
    }

    function draw() {
      const c = current;
      const sched = f.cards[c.id] || null;
      const left = main.length + pending.length + 1;
      const isNew = !sched;
      const typing = typeable(c) && typeMode();
      const input = typing && !flipped ? h('input.fc-type.mono', {
        type: 'text', spellcheck: false, autocomplete: 'off', placeholder: 'Type the command, then Enter',
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); check(input.value); } },
      }) : null;

      const answerEl = flipped ? h('div.fc-back',
        typed && h(`div.fc-typed.${typed.ok ? 'good' : 'bad'}`,
          h('div.fc-typed-head', typed.ok ? (typed.exact ? '✓ Exactly right' : '✓ Right (same command, different order or quoting)') : '✗ Not quite'),
          h('code.fc-typed-text', typed.text || '(nothing typed)'),
          !typed.ok && (typed.missing.length || typed.extra.length) && h('div.small.fc-typed-diff',
            typed.missing.length > 0 && h('span', 'Missing: ', typed.missing.map(t => h('code.miss', t))),
            typed.extra.length > 0 && h('span', ' Not in the answer: ', typed.extra.map(t => h('code.extra', t))))),
        h('div.fc-answer', { html: md(c.back) }),
        c.extra && h('details.fc-example', { open: c.kind === 'reverse' || c.kind === 'command' },
          h('summary.small.muted', 'Example'), h('div', { html: codeBlock(c.extra, c.lang || 'bash') })),
        gradeBar(sched, typed)) : null;

      holder.replaceChildren(
        h('div.fc-progress',
          h('span.small', `${left} left`),
          h('span.fc-pill.review', `${main.filter(x => f.cards[x.id]?.s === 'review').length + (sched?.s === 'review' ? 1 : 0)} review`),
          h('span.fc-pill.learn', `${pending.length + (sched && sched.s !== 'review' ? 1 : 0)} learning`),
          h('span.fc-pill.new', `${main.filter(x => !f.cards[x.id]).length + (isNew ? 1 : 0)} new`),
          h('span.spacer'),
          done.n > 0 && h('span.small.muted', `${done.n} done`)),
        h(`article.fc-card${flipped ? '.flipped' : ''}`, { 'aria-live': 'polite' },
          h('div.fc-meta',
            h(`span.fc-kind.${c.kind}`, isNew ? `New · ${KIND_LABEL[c.kind] || 'Card'}` : KIND_LABEL[c.kind] || 'Card'),
            h('a.small.muted.fc-source', { href: `#/lesson/${c.lesson}`, title: 'Open the lesson this card comes from' }, c.lessonTitle)),
          c.context && h('div.fc-context.small.muted', { html: md(c.context) }),
          h('div.fc-front', { html: md(c.front) }),
          input,
          !flipped && h('div.fc-actions',
            typing
              ? h('button.btn.primary', { type: 'button', onclick: () => check(input.value) }, 'Check (Enter)')
              : h('button.btn.primary.big', { type: 'button', onclick: flip }, 'Show answer', h('kbd', 'Space')),
            typeable(c) && h('label.small.fc-type-toggle', h('input', { type: 'checkbox', checked: typeMode(), onchange: e => { f.settings.typeIt = e.target.checked; game.save(); draw(); } }), ' Type it')),
          answerEl),
        h('p.muted.small.fc-keys', 'Space: show answer · 1 Again · 2 Hard · 3 Good · 4 Easy · T: type it (command cards)'));
      (input || holder.querySelector('.fc-grade.suggested') || holder.querySelector('.fc-actions .btn'))?.focus();
    }

    function flip() { if (!flipped) { flipped = true; draw(); } }

    function check(value) {
      const r = srs.compareCommand(value, current.back);
      typed = { ...r, text: value.trim() };
      flipped = true;
      game.sound(r.ok ? 'right' : 'wrong');
      draw();
    }

    function gradeBar(sched, typedResult) {
      const t = Date.now();
      // After typing, the result suggests a grade; you can still pick another.
      const suggested = typedResult ? (typedResult.ok ? 3 : 1) : null;
      const labels = [[1, 'Again', 'Forgot it'], [2, 'Hard', 'Got it, with effort'], [3, 'Good', 'Remembered'], [4, 'Easy', 'Instant']];
      return h('div.fc-grades', { role: 'group', 'aria-label': 'How well did you know it?' },
        labels.map(([g, name, help]) => h(`button.fc-grade.g${g}${suggested === g ? '.suggested' : ''}`, {
          type: 'button', title: help, onclick: () => rate(g),
        }, h('span.fc-grade-name', name), h('span.fc-grade-ivl', srs.preview(sched, g, t, current.id)), h('kbd', g))));
    }

    function rate(g) {
      if (!flipped) return;
      const c = current;
      const before = f.cards[c.id];
      const after = srs.answer(f, c.id, g, Date.now());
      done.n++;
      if (g === 1) done.again++;
      // Remembering a card that was due is real recall: a little XP, capped per day.
      if (before && g > 1 && (f.days[srs.dayKeyOf(Date.now())].xp || 0) < XP_CAP) {
        f.days[srs.dayKeyOf(Date.now())].xp = (f.days[srs.dayKeyOf(Date.now())].xp || 0) + 1;
        game.addXp(1, 'practice');
        done.xp++;
      }
      if (after.s !== 'review') pending.push(c);   // still learning: it comes back in minutes
      game.save();
      show();
    }

    function finish() {
      const soon = pending.map(c => f.cards[c.id]?.due).filter(Boolean).sort((a, b) => a - b)[0];
      const st = srs.stats(f, Date.now());
      game.save(true);
      holder.replaceChildren(h('div.fc-done.panel',
        h('h2', done.n ? 'Done for now' : 'Nothing to review'),
        h('p.muted', done.n
          ? `${done.n} card${done.n === 1 ? '' : 's'} reviewed${done.again ? `, ${done.again} to see again soon` : ''}${done.xp ? ` · +${done.xp} XP` : ''}.`
          : cards.length ? 'Every card is scheduled for later. Come back tomorrow.' : 'Finish a lesson and its cards appear here.'),
        soon && h('p.small', `A learning card comes back in ${Math.max(1, Math.round((soon - Date.now()) / 60000))} min. Open Flashcards again then.`),
        h('div.fc-forecast', h('div.small.muted', 'Due over the next 7 days'), forecastChart(st.forecast)),
        h('div.fc-actions', h('a.btn.primary', { href: '#/practice' }, 'Back to Practice'), soon && h('button.btn.ghost', { type: 'button', onclick: () => cardsView(page) }, 'Check again'))));
      game.checkAchievements();
    }

    onKey = e => {
      if (!current || e.ctrlKey || e.metaKey || e.altKey) return;
      const inField = e.target instanceof HTMLInputElement && e.target.type === 'text' || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (inField) return;
      if (e.key === ' ' && !flipped) { e.preventDefault(); flip(); }
      else if (/^[1-4]$/.test(e.key) && flipped) { e.preventDefault(); rate(Number(e.key)); }
      else if ((e.key === 't' || e.key === 'T') && typeable(current) && !flipped) { e.preventDefault(); f.settings.typeIt = !f.settings.typeIt; game.save(); draw(); }
    };
    document.addEventListener('keydown', onKey);
    show();
  }).catch(() => holder.replaceChildren(h('div.empty', h('h2', 'Could not load your cards'), h('p.muted', 'Is the dojo server running?'), h('a.btn.primary', { href: '#/practice' }, 'Back'))));
  return leave;
}
