// Search everything: a command palette opened with Ctrl+K / Cmd+K or the search button in the top bar.
// The server ranks topics, modules, lessons (down to the step), toolkit commands, labs, lab challenges, live labs and
// the glossary (GET /api/search, Server/Search.cs); the learner's own notes are matched here and merged in.
// Lessons the learner has not unlocked are listed with a lock and what opens them, and go to their place on the map.
//   installSearch(getTracks)   once at boot: the shortcut
//   searchButton()             the button for the top bar
//   openSearch(q?)             open the palette (optionally with a query)
import { h, api } from './util.js';
import * as game from './game.js';
import * as notes from './notes.js';

let tracksOf = () => [];
let palette = null;          // the open palette, if any
const RECENT_KEY = 'dojo-recent-searches';

const KIND = {
  note: { icon: '✎', label: 'Your notes' },
  glossary: { icon: 'Aa', label: 'Glossary' },
  command: { icon: '$_', label: "Senior's toolkit" },
  lesson: { icon: '▤', label: 'Lessons' },
  module: { icon: '▦', label: 'Modules' },
  topic: { icon: '◆', label: 'Topics' },
  lab: { icon: '⚗', label: 'Labs' },
  challenge: { icon: '★', label: 'Lab challenges' },
  livelab: { icon: '▶', label: 'Live labs and missions' },
};

export function installSearch(getTracks) {
  tracksOf = getTracks;
  // Capture phase, so the shortcut works inside editors and the lesson player too.
  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
    // The Vim trainer and live terminals have their own Ctrl keys.
    if (e.target.closest?.('.vm-lab, .nl-term, .nl-term-in, .xterm')) return;
    e.preventDefault();
    e.stopPropagation();
    palette ? palette.close() : openSearch();
  }, true);
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function searchButton() {
  return h('button.sp-open', { type: 'button', onclick: () => openSearch(), title: 'Search everything', 'aria-label': 'Search everything', 'aria-keyshortcuts': 'Control+K Meta+K' },
    h('span.sp-open-icon', { 'aria-hidden': 'true' }, '⌕'), h('span.sp-open-text', 'Search'), h('kbd.sp-kbd', isMac() ? '⌘K' : 'Ctrl K'));
}

// ---------------------------------------------------------------- locks and targets

/** Null when the lesson can be opened, else { reason, href } saying what unlocks it and where that is on the map. */
export function lockOf(key) {
  const [t, m, l] = (key || '').split('/');
  const track = tracksOf().find(x => x.id === t);
  const module = track?.modules.find(x => x.id === m);
  const index = module?.lessons.findIndex(x => x.id === l) ?? -1;
  if (!track || index < 0 || game.isUnlocked(track, module, index)) return null;
  const blocker = !game.isProject(module) && game.gateBlocker(track, module);
  const reason = blocker
    ? `Locked: prove “${blocker.title}” first (its mastery gate on the map)`
    : `Locked: finish “${module.lessons[index - 1]?.title}” first`;
  return { reason, href: `#/track/${t}/${blocker ? blocker.id : m}` };
}

/** Where a result goes. Challenges are opened by telling their lab which one to show. */
function go(item) {
  const lock = item.key && item.kind !== 'note' ? lockOf(item.key) : null;
  if (lock) { location.hash = lock.href; return; }
  if (item.lab && item.challenge) {
    const labs = game.state.labs ||= {};
    const saved = labs[item.lab] ||= { solved: {}, stars: {} };
    saved.challenge = item.challenge;
    game.save();
  }
  if (location.hash === item.href) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = item.href;
}

// ---------------------------------------------------------------- recent searches

function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(x => typeof x === 'string'); } catch { return []; } }
function remember(q) {
  q = q.trim();
  if (q.length < 2) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recent().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8))); } catch { }
}
function forget(q) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent().filter(x => x !== q))); } catch { } }

// ---------------------------------------------------------------- the palette

/** Text with <mark> around the given [start, length] ranges. */
function marked(text, ranges = []) {
  const out = [];
  let at = 0;
  for (const [s, len] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s < at || s >= text.length) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(h('mark', text.slice(s, s + len)));
    at = s + len;
  }
  out.push(text.slice(at));
  return out;
}

export function openSearch(initial = '') {
  if (palette) { palette.input.focus(); return; }
  const before = document.activeElement;
  const input = h('input.sp-input', {
    type: 'text', value: initial, placeholder: 'Search lessons, commands, labs, terms and your notes', autocomplete: 'off', spellcheck: false,
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'sp-list', 'aria-autocomplete': 'list', 'aria-label': 'Search everything',
  });
  const list = h('div.sp-list', { id: 'sp-list', role: 'listbox', 'aria-label': 'Results' });
  const status = h('div.sp-status', { role: 'status', 'aria-live': 'polite' });
  const dialog = h('div.sp-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search everything' },
    h('div.sp-head', h('span.sp-glass', { 'aria-hidden': 'true' }, '⌕'), input, h('kbd.sp-kbd', 'Esc')),
    list,
    h('div.sp-foot', status, h('span.spacer'),
      h('span.sp-keys', h('kbd', '↑'), h('kbd', '↓'), ' move ', h('kbd', 'Enter'), ' open ', h('kbd', 'Esc'), ' close')));
  const back = h('div.sp-back', { onmousedown: e => { if (e.target === back) close(); } }, dialog);
  document.body.append(back);
  document.body.classList.add('sp-lock');

  let options = [];             // [{ el, item }]
  let active = -1, seq = 0, timer = null, ctrl = null;

  function setActive(i, scroll = true) {
    if (!options.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
    active = (i + options.length) % options.length;
    options.forEach((o, j) => { o.el.classList.toggle('active', j === active); o.el.setAttribute('aria-selected', String(j === active)); });
    input.setAttribute('aria-activedescendant', options[active].el.id);
    if (scroll) options[active].el.scrollIntoView({ block: 'nearest' });
  }

  function choose(i, newTab) {
    const o = options[i];
    if (!o) return;
    if (o.run) { o.run(); return; }
    remember(input.value);
    if (newTab && !o.locked) { window.open(location.pathname + o.item.href, '_blank'); return; }
    close(false);
    go(o.item);
  }

  function option(item, extra = {}) {
    const id = `sp-opt-${options.length}`;
    const kind = KIND[item.kind] || { icon: '•' };
    const lock = item.key && item.kind !== 'note' ? lockOf(item.key) : null;
    const el = h(`div.sp-item${lock ? '.locked' : ''}`, { id, role: 'option', 'aria-selected': 'false', 'aria-disabled': lock ? 'true' : null },
      h(`span.sp-icon.k-${item.kind}`, { 'aria-hidden': 'true' }, kind.icon),
      h('div.sp-main',
        h('div.sp-title', item.kind === 'command' ? h('code', marked(item.title, item.titleHl)) : marked(item.title, item.titleHl),
          lock && h('span.sp-lock', { title: lock.reason }, '🔒 locked'),
          Number.isInteger(item.step) && item.kind === 'lesson' && !lock && h('span.sp-step', `step ${item.step + 1}`)),
        h('div.sp-sub', item.sub),
        item.snippet && item.snippet !== item.title && h('div.sp-snippet', marked(item.snippet, item.snippetHl)),
        lock && h('div.sp-why', lock.reason, '. Enter shows it on the map.')),
      extra.right);
    const index = options.length;
    el.addEventListener('mousemove', () => { if (active !== index) setActive(index, false); });
    el.addEventListener('click', e => choose(index, e.ctrlKey || e.metaKey));
    options.push({ el, item, locked: !!lock, ...extra });
    return el;
  }

  function group(label, total, els, id) {
    const head = h('div.sp-group-head', { id }, label, total > els.length && h('span.muted', ` · top ${els.length} of ${total}`));
    return h('div.sp-group', { role: 'group', 'aria-labelledby': id }, head, els);
  }

  function paintEmpty() {
    options = [];
    const rec = recent();
    const quick = [
      { kind: 'glossary', title: 'Glossary', sub: 'Every core term, in plain English, with the lessons that teach it', href: '#/glossary' },
      { kind: 'note', title: 'Your notes and highlights', sub: `${notes.all().length} saved · export to Markdown`, href: '#/notes' },
      { kind: 'lab', title: 'All labs', sub: 'Builders, trainers and live labs', href: '#/labs' },
    ];
    list.replaceChildren(
      rec.length > 0 && group('Recent searches', rec.length, rec.map(q => {
        const x = h('button.sp-x', { type: 'button', title: 'Remove from recent searches', 'aria-label': `Remove ${q} from recent searches`, tabindex: '-1',
          onclick: e => { e.stopPropagation(); forget(q); paintEmpty(); } }, '✕');
        const el = option({ kind: 'recent', title: q, sub: '' }, { right: x, run: () => { input.value = q; search(); } });
        el.classList.add('recent');
        el.querySelector('.sp-icon').textContent = '↺';
        el.querySelector('.sp-sub').remove();
        return el;
      }), 'sp-g-recent'),
      group('Go to', quick.length, quick.map(q => option(q)), 'sp-g-go'),
      h('p.sp-hint.muted.small', 'Try a command (', h('code', 'git rebase'), '), an error (', h('code', 'CrashLoopBackOff'), '), a concept (', h('code', 'idempotency'), ') or a word from your notes. Typos are fine.'));
    status.textContent = '';
    setActive(0);
  }

  async function search() {
    const q = input.value.trim();
    clearTimeout(timer);
    if (!q) { ctrl?.abort(); paintEmpty(); return; }
    const mine = ++seq;
    status.textContent = 'Searching…';
    ctrl?.abort();
    ctrl = new AbortController();
    let data;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&per=6`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (e) {
      if (e.name === 'AbortError' || mine !== seq) return;
      data = { groups: [], failed: true };
    }
    if (mine !== seq) return;
    options = [];
    const mineNotes = notes.search(q);
    const groups = [];
    if (mineNotes.length) groups.push({ kind: 'note', label: 'Your notes', total: mineNotes.length, items: mineNotes.slice(0, 5) });
    groups.push(...data.groups);
    const total = groups.reduce((n, g) => n + g.total, 0);
    if (!groups.length) {
      list.replaceChildren(h('div.sp-none', h('b', `Nothing found for “${q}”.`),
        h('p.muted.small', data.failed ? 'The dojo server did not answer. Is it still running?' : 'Try fewer or shorter words, or browse the glossary.'),
        !data.failed && h('a.btn.ghost.small', { href: '#/glossary', onclick: () => close(false) }, 'Open the glossary')));
      status.textContent = data.failed ? 'Search failed' : 'No results';
      setActive(-1);
      return;
    }
    list.replaceChildren(...groups.map((g, gi) => group(g.label || KIND[g.kind]?.label || g.kind, g.total, g.items.map(i => option(i)), `sp-g-${gi}`)));
    status.textContent = `${total} result${total === 1 ? '' : 's'}${data.ms != null ? ` · ${data.ms} ms` : ''}`;
    list.scrollTop = 0;
    setActive(0, false);
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 110); });
  dialog.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive(Math.min(options.length - 1, active + 5)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive(Math.max(0, active - 5)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (timer && input.value.trim()) { search().then(() => choose(active, e.ctrlKey || e.metaKey)); return; } choose(active, e.ctrlKey || e.metaKey); }
    else if (e.key === 'Tab') { e.preventDefault(); input.focus(); }   // focus stays in the dialog
    e.stopPropagation();                                                // never drive the page underneath
  });

  function close(restore = true) {
    clearTimeout(timer); ctrl?.abort();
    back.remove();
    document.body.classList.remove('sp-lock');
    palette = null;
    if (restore && before?.isConnected) before.focus?.();
  }

  palette = { input, close };
  input.focus();
  if (initial) { input.select(); search(); } else paintEmpty();
}
