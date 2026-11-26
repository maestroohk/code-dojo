// The glossary (#/glossary, #/glossary/<slug>): the hand-written core terms (content/glossary.json) plus the terms
// lessons define themselves ("**Term** is ..."), each with the lessons that teach it. Built by the server (GET
// /api/glossary, Server/Search.cs). Locked lessons are shown with a lock and link to their place on the map.
import { h, api, inline, loader } from './util.js';
import { lockOf } from './search.js';

let cache = null;

export async function glossaryView(page, tracks, slug) {
  const slow = setTimeout(() => page('glossary', loader('Glossary')), 150);
  let data;
  try { data = cache && Date.now() - cache.at < 30_000 ? cache.data : await api('glossary'); }
  catch { clearTimeout(slow); return page('glossary', h('div.empty', h('h2', 'The glossary did not load'), h('p.muted', 'Is the dojo server still running?'))); }
  clearTimeout(slow);
  cache = { at: Date.now(), data };
  const terms = data.terms;
  const topicTitle = id => tracks.find(t => t.id === id)?.title || id;
  const topics = [...new Set(terms.map(t => t.topic).filter(Boolean))].sort((a, b) => topicTitle(a).localeCompare(topicTitle(b)));

  const filter = h('input.gl-filter', { type: 'search', placeholder: `Filter ${terms.length} terms`, 'aria-label': 'Filter the glossary' });
  const topicSel = h('select.gl-topic', { 'aria-label': 'Topic' }, h('option', { value: '' }, 'All topics'), topics.map(t => h('option', { value: t }, topicTitle(t))));
  const sourceSel = h('select.gl-topic', { 'aria-label': 'Source' }, h('option', { value: '' }, 'Core and lesson terms'), h('option', { value: 'curated' }, 'Core terms only'), h('option', { value: 'lesson' }, 'Defined in lessons'));
  const letters = h('nav.gl-letters', { 'aria-label': 'Jump to letter' });
  const list = h('div.gl-list');
  const count = h('span.muted.small', { role: 'status', 'aria-live': 'polite' });

  const letterOf = t => { const c = t.term.replace(/^[^\p{L}\p{N}]+/u, '')[0]?.toUpperCase() || '#'; return /[A-Z]/.test(c) ? c : '#'; };

  function lessonLink(l) {
    const lock = lockOf(l.key);
    const label = l.title + (l.step != null ? ` · step ${l.step + 1}` : '');
    const topic = l.track && topicTitle(l.track);
    return lock
      ? h('a.gl-lesson.locked', { href: lock.href, title: lock.reason }, h('span', { 'aria-hidden': 'true' }, '🔒 '), label, topic && h('span.muted', ` · ${topic}`))
      : h('a.gl-lesson', { href: `#/lesson/${l.key}${l.step != null ? `/${l.step + 1}` : ''}` }, label, topic && h('span.muted', ` · ${topic}`));
  }

  function card(t) {
    return h(`article.gl-term${t.slug === slug ? '.target' : ''}`, { id: `g-${t.slug}`, tabindex: '-1' },
      h('div.gl-term-head',
        h('h3', h('a.gl-anchor', { href: `#/glossary/${t.slug}`, title: 'Link to this term' }, t.term)),
        t.topic && h('span.tag.gl-tag', topicTitle(t.topic)),
        t.source === 'lesson' && h('span.gl-src.muted.small', { title: 'Taken from the lesson that defines it' }, 'from a lesson')),
      h('p.gl-def', { html: inline(t.def) }),
      t.aliases?.length > 0 && h('p.muted.small.gl-aka', 'Also: ', t.aliases.join(', ')),
      h('div.gl-lessons', t.lessons.length
        ? [h('span.muted.small', 'Taught in '), t.lessons.map(lessonLink)]
        : h('span.muted.small', 'Not taught in a lesson yet.')));
  }

  function paint() {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = terms.filter(t => (!topicSel.value || t.topic === topicSel.value) && (!sourceSel.value || t.source === sourceSel.value)
      && words.every(w => `${t.term} ${t.aliases?.join(' ') || ''} ${t.def}`.toLowerCase().includes(w)))
      // Names first when filtering: a term whose name matches beats one that only mentions it.
      .sort((a, b) => (words.length ? (words.every(w => b.term.toLowerCase().includes(w)) - words.every(w => a.term.toLowerCase().includes(w))) : 0) || a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
    count.textContent = `${shown.length} of ${terms.length} terms`;
    const byLetter = new Map();
    for (const t of shown) { const L = words.length ? '' : letterOf(t); if (!byLetter.has(L)) byLetter.set(L, []); byLetter.get(L).push(t); }
    letters.replaceChildren(...'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(L => byLetter.has(L)
      ? h('a.gl-letter', { href: `#/glossary`, onclick: e => { e.preventDefault(); document.getElementById(`gl-L-${L}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, L)
      : h('span.gl-letter.off', { 'aria-hidden': 'true' }, L)));
    letters.hidden = words.length > 0;
    list.replaceChildren(...(shown.length ? [...byLetter].map(([L, ts]) => h('section.gl-section', L && h('h2.gl-letter-head', { id: `gl-L-${L}` }, L), ts.map(card)))
      : [h('p.muted.gl-none', `No term matches “${filter.value}”. `, h('button.mini', { type: 'button', onclick: () => { filter.value = ''; topicSel.value = ''; sourceSel.value = ''; paint(); } }, 'Clear filters'))]));
  }

  filter.addEventListener('input', paint);
  topicSel.addEventListener('change', paint);
  sourceSel.addEventListener('change', paint);
  page('glossary',
    h('section.hero', h('div',
      h('div.eyebrow', 'Glossary'),
      h('h1', 'The words people use at work'),
      h('p.muted', `${data.curated} core terms written for the dojo and ${data.fromLessons} more defined in the lessons, each in plain English with the lessons that teach it. Ctrl+K finds them too.`))),
    h('div.gl-bar', filter, topicSel, sourceSel, count),
    letters, list);
  paint();
  if (slug) {
    const el = document.getElementById(`g-${slug}`);
    if (el) { setTimeout(() => { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); }, 30); }
  }
}
