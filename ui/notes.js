// Notes and highlights, per lesson step.
//
// Stored with the learner's progress (game.state.notes, saved to .state/progress.json by game.save()). Older saves have
// no "notes" field and get an empty list; nothing else in the state changes shape.
//   { id, kind: 'note' | 'highlight', key: 'track/module/lesson', step: 0-based index, text?: the highlighted passage,
//     body: markdown, lessonTitle, stepTitle, created, updated }
// One 'note' per step (the side editor); any number of 'highlight's (a passage selected on a learn card, with an
// optional note of its own).
//
//   playerNotes(tracks)   the "Notes" button and side editor for the lesson player (app.js wires it into play())
//   notesView(page, tracks)   the #/notes page: everything, grouped by topic and lesson, searchable, export / import
//   search(q)             client-side matches for the Ctrl+K palette (search.js)
import { h, md, ask } from './util.js';
import * as game from './game.js';

// ---------------------------------------------------------------- the store

export const all = () => (Array.isArray(game.state.notes) ? game.state.notes : (game.state.notes = []));
const now = () => new Date().toISOString();
const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const forLesson = key => all().filter(n => n.key === key);
export const forStep = (key, step) => all().filter(n => n.key === key && n.step === step);
export const noteFor = (key, step) => all().find(n => n.kind === 'note' && n.key === key && n.step === step);

/** Lesson and step titles, so a note still reads well if the lesson is renamed or moved. */
function titles(tracks, key, step, stepObj) {
  const [t, m, l] = key.split('/');
  const lesson = tracks?.find(x => x.id === t)?.modules.find(x => x.id === m)?.lessons.find(x => x.id === l);
  return { lessonTitle: lesson?.title || l || key, stepTitle: stepObj?.title || '' };
}

/** Writes (or, when empty, removes) the step's note. */
export function setNote(key, step, body, meta = {}) {
  const list = all();
  const at = list.findIndex(n => n.kind === 'note' && n.key === key && n.step === step);
  if (!body.trim()) { if (at >= 0) list.splice(at, 1); }
  else if (at >= 0) Object.assign(list[at], { body, updated: now() }, meta);
  else list.push({ id: newId(), kind: 'note', key, step, body, created: now(), updated: now(), ...meta });
  game.save();
}

export function addHighlight(key, step, text, meta = {}) {
  const item = { id: newId(), kind: 'highlight', key, step, text: text.slice(0, 2000), body: '', created: now(), updated: now(), ...meta };
  all().push(item);
  game.save();
  return item;
}

export function update(id, fields) {
  const n = all().find(x => x.id === id);
  if (n) { Object.assign(n, fields, { updated: now() }); game.save(); }
}

export function remove(id) {
  const list = all();
  const at = list.findIndex(x => x.id === id);
  if (at >= 0) { list.splice(at, 1); game.save(); }
}

const stepHash = n => `#/lesson/${n.key}/${n.step + 1}`;

/** Client-side matches for the search palette: every query word must appear in the note, passage or titles. */
export function search(q) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const n of all()) {
    const hay = `${n.text || ''} ${n.body || ''} ${n.lessonTitle || ''} ${n.stepTitle || ''}`.toLowerCase();
    if (!words.every(w => hay.includes(w))) continue;
    const text = (n.kind === 'highlight' ? `“${n.text}”${n.body ? ` ${n.body}` : ''}` : n.body).replace(/\s+/g, ' ');
    const first = Math.max(0, Math.min(...words.map(w => text.toLowerCase().indexOf(w)).filter(i => i >= 0), text.length));
    const start = text.length > 170 && first > 40 ? first - 40 : 0;
    const snippet = (start > 0 ? '…' : '') + text.slice(start, start + 170) + (start + 170 < text.length ? '…' : '');
    const score = words.reduce((s, w) => s + ((n.lessonTitle || '').toLowerCase().includes(w) ? 3 : 0) + (text.toLowerCase().includes(w) ? 2 : 0), 0);
    out.push({
      kind: 'note', title: n.kind === 'highlight' ? `Highlight · ${n.lessonTitle}` : `Note · ${n.lessonTitle}`,
      sub: `Step ${n.step + 1}${n.stepTitle ? ` · ${n.stepTitle}` : ''}`, snippet, snippetHl: ranges(snippet, words), titleHl: [],
      href: stepHash(n), key: n.key, score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** [start, length] of each occurrence of the words in text (for <mark>). */
export function ranges(text, words) {
  const lower = text.toLowerCase();
  const list = [];
  for (const w of words) for (let i = lower.indexOf(w); i >= 0 && list.length < 40; i = lower.indexOf(w, i + w.length)) list.push([i, w.length]);
  list.sort((a, b) => a[0] - b[0]);
  return list.filter((r, i) => i === 0 || r[0] >= list[i - 1][0] + list[i - 1][1]);
}

// ---------------------------------------------------------------- the player: button, side editor, highlights

/**
 * The lesson player's notes. `button` goes in the step header; call setStep() on every step and destroy() on leave.
 * setStep({ key, idx, step, el }): `el` is the rendered step, whose learn card text can be highlighted.
 */
export function playerNotes(tracks) {
  let cur = null;                 // { key, idx, step, el }
  let open = false, saveTimer = null;
  const count = h('span.nt-count', { hidden: true });
  const button = h('button.btn.ghost.small.nt-btn', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'nt-drawer', title: 'Your notes and highlights for this step' },
    h('span', { 'aria-hidden': 'true' }, '✎'), ' Notes', count);
  const status = h('span.muted.small.nt-status', { role: 'status', 'aria-live': 'polite' });
  const stepLabel = h('div.muted.small.nt-step');
  const editor = h('textarea.nt-editor', { id: 'nt-editor', rows: 9, spellcheck: true, placeholder: 'Write in your own words: what it is, why it matters, where you would use it. Markdown works: **bold**, `code`, - lists.' });
  const preview = h('div.prose.nt-preview', { hidden: true });
  const previewBtn = h('button.mini', { type: 'button', 'aria-pressed': 'false' }, 'Preview');
  const hlList = h('div.nt-hls');
  const closeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Close notes', title: 'Close (Esc)' }, '✕');
  const drawer = h('aside.nt-drawer', { id: 'nt-drawer', 'aria-label': 'Notes for this step', hidden: true },
    h('div.nt-head', h('div.grow', h('h2', 'Notes'), stepLabel), closeBtn),
    h('label.field-label', { for: 'nt-editor' }, 'Your note on this step'),
    editor, preview,
    h('div.nt-tools', previewBtn, status, h('span.spacer'), h('a.mini', { href: '#/notes' }, 'All notes')),
    hlList,
    h('p.muted.small.nt-tip', 'Tip: select text on a learn card and press Highlight to keep the passage here.'));
  const pop = h('button.nt-pop', { type: 'button', hidden: true, title: 'Save the selected passage as a highlight' }, h('span', { 'aria-hidden': 'true' }, '▍'), ' Highlight');
  document.body.append(drawer, pop);

  const meta = () => titles(tracks, cur.key, cur.idx, cur.step);
  function paintCount() {
    const n = cur ? forStep(cur.key, cur.idx).length : 0;
    count.hidden = n === 0;
    count.textContent = n;
    button.classList.toggle('has', n > 0);
  }
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer); saveTimer = null;
    if (cur) { setNote(cur.key, cur.idx, editor.value, meta()); status.textContent = 'Saved'; paintCount(); }
  }
  editor.addEventListener('input', () => {
    status.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = 1; flush(); }, 500);
  });
  editor.addEventListener('blur', flush);
  // Typing in the note must not drive the player (Enter = Check, Alt+← = Back).
  drawer.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    e.stopPropagation();
  });
  previewBtn.addEventListener('click', () => {
    const on = preview.hidden;
    preview.hidden = !on; editor.hidden = on;
    previewBtn.setAttribute('aria-pressed', String(on));
    previewBtn.textContent = on ? 'Edit' : 'Preview';
    if (on) preview.innerHTML = editor.value.trim() ? md(editor.value) : '<p class="muted">Nothing written yet.</p>';
  });
  closeBtn.addEventListener('click', () => close(true));
  button.addEventListener('click', () => (open ? close(true) : show()));

  function paintHighlights() {
    const hls = cur ? forStep(cur.key, cur.idx).filter(n => n.kind === 'highlight') : [];
    hlList.replaceChildren(...[hls.length ? h('div.field-label', `Highlights on this step (${hls.length})`) : null,
      ...hls.map(n => {
        const body = h('textarea.nt-hl-note', { rows: 2, value: n.body || '', placeholder: 'Add a note to this passage (optional)', 'aria-label': 'Note on this highlight' });
        let t = null;
        body.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { update(n.id, { body: body.value }); status.textContent = 'Saved'; }, 500); });
        return h('div.nt-hl', { dataset: { id: n.id } },
          h('blockquote.nt-quote', n.text),
          body,
          h('div.nt-hl-tools', h('button.mini', { type: 'button', onclick: () => { remove(n.id); paintHighlights(); paintMarks(); paintCount(); } }, 'Remove')));
      })].filter(Boolean));
  }

  /** Wraps each saved passage on the visible card in <mark> (first occurrence; passages may span elements). */
  function paintMarks() {
    if (!cur?.el) return;
    cur.el.querySelectorAll('mark.nt-mark').forEach(m => m.replaceWith(...m.childNodes));
    cur.el.normalize();
    for (const n of forStep(cur.key, cur.idx).filter(x => x.kind === 'highlight')) markText(cur.el, n.text, n.id);
  }

  function show(focusId) {
    if (!cur) return;
    open = true;
    drawer.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.body.classList.add('nt-open');
    const target = focusId && hlList.querySelector(`[data-id="${focusId}"] textarea`);
    (target || (editor.hidden ? previewBtn : editor)).focus();
  }
  function close(refocus) {
    flush();
    if (!open) return;
    open = false;
    drawer.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nt-open');
    if (refocus) button.focus();
  }

  // ---- highlighting a selection on a learn card
  const learnRoot = () => cur?.el?.classList.contains('learn') ? cur.el : cur?.el?.querySelector?.('.learn');
  function selectedPassage() {
    const sel = getSelection();
    const root = learnRoot();
    if (!sel || sel.isCollapsed || !root || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer) || drawer.contains(range.commonAncestorContainer)) return null;
    if (range.commonAncestorContainer.parentElement?.closest?.('textarea, input, .cm, .editor, .drill')) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    return text.length >= 3 ? { text, rect: range.getBoundingClientRect() } : null;
  }
  const onSelect = () => setTimeout(() => {
    const p = selectedPassage();
    if (!p) { pop.hidden = true; return; }
    pop.hidden = false;
    const w = pop.offsetWidth || 110;
    pop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, p.rect.left + p.rect.width / 2 - w / 2)))}px`;
    pop.style.top = `${Math.round(Math.max(8, p.rect.top - 42))}px`;
  });
  pop.addEventListener('mousedown', e => e.preventDefault());   // keep the selection
  pop.addEventListener('click', () => {
    const p = selectedPassage();
    pop.hidden = true;
    if (!p || !cur) return;
    const item = addHighlight(cur.key, cur.idx, p.text, meta());
    getSelection().removeAllRanges();
    paintHighlights(); paintMarks(); paintCount();
    show(item.id);
  });
  const onDocDown = e => { if (e.target !== pop && !pop.contains(e.target)) pop.hidden = true; };
  const onMarkClick = e => { const m = e.target.closest?.('mark.nt-mark'); if (m && cur?.el?.contains(m)) show(m.dataset.id); };
  document.addEventListener('mouseup', onSelect);
  document.addEventListener('keyup', onSelect);
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('click', onMarkClick);
  const onScroll = () => { pop.hidden = true; };
  addEventListener('scroll', onScroll, { passive: true });

  return {
    button,
    setStep(next) {
      flush();
      cur = next;
      pop.hidden = true;
      const n = noteFor(cur.key, cur.idx);
      editor.value = n?.body || '';
      if (!preview.hidden) previewBtn.click();
      status.textContent = n ? `Saved ${new Date(n.updated).toLocaleString()}` : '';
      const m = meta();
      stepLabel.textContent = `${m.lessonTitle} · step ${cur.idx + 1}${m.stepTitle ? `: ${m.stepTitle}` : ''}`;
      paintCount(); paintHighlights(); paintMarks();
    },
    destroy() {
      flush();
      document.body.classList.remove('nt-open');
      document.removeEventListener('mouseup', onSelect);
      document.removeEventListener('keyup', onSelect);
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('click', onMarkClick);
      removeEventListener('scroll', onScroll);
      drawer.remove(); pop.remove();
    },
  };
}

/** Wraps the first occurrence of `text` (whitespace-insensitive) under `root` in mark.nt-mark, across text nodes. */
function markText(root, text, id) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('textarea, button, .sample-bar, .sample-slot, mark.nt-mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  let flat = '';
  const map = [];                 // flat index -> [node, offset]
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n);
    for (let i = 0; i < n.data.length; i++) {
      const c = /\s/.test(n.data[i]) ? ' ' : n.data[i];
      if (c === ' ' && flat.endsWith(' ')) continue;
      flat += c; map.push([n, i]);
    }
  }
  const want = text.replace(/\s+/g, ' ').trim();
  const at = flat.indexOf(want);
  if (at < 0 || !want) return;
  const [sNode, sOff] = map[at];
  const [eNode, eOff] = map[at + want.length - 1];
  // Wrap each text node's slice separately (a passage may cross <strong>, <code> and paragraphs).
  const inRange = [];
  let on = false;
  for (const n of nodes) {
    if (n === sNode) on = true;
    if (on) inRange.push(n);
    if (n === eNode) break;
  }
  for (const n of inRange) {
    const from = n === sNode ? sOff : 0;
    const to = n === eNode ? eOff + 1 : n.data.length;
    if (to <= from || !n.data.slice(from, to).trim()) continue;
    const r = document.createRange();
    r.setStart(n, from); r.setEnd(n, to);
    const mark = h('mark.nt-mark', { title: 'Your highlight (click to open your notes)', dataset: { id } });
    r.surroundContents(mark);
  }
}

// ---------------------------------------------------------------- export and import

const MARK = /^<!-- dojo:(\{.*\}) -->$/;

/** All notes as one Markdown file, grouped by topic and lesson; each item carries a comment so Import can read it back. */
export function toMarkdown(tracks) {
  const lines = ['# code-dojo notes', '', `Exported ${new Date().toLocaleString()} · ${all().length} item${all().length === 1 ? '' : 's'}.`, ''];
  for (const topic of grouped(tracks, all())) {
    lines.push(`## ${topic.title}`, '');
    for (const lesson of topic.lessons) {
      lines.push(`### ${lesson.title}`, '');
      for (const n of lesson.items) {
        const { id, kind, key, step, lessonTitle, stepTitle, created, updated } = n;
        lines.push(`#### Step ${step + 1}${stepTitle ? `: ${stepTitle}` : ''}${kind === 'highlight' ? ' (highlight)' : ''}`);
        lines.push(`<!-- dojo:${JSON.stringify({ id, kind, key, step, lessonTitle, stepTitle, created, updated })} -->`);
        if (kind === 'highlight') lines.push(...String(n.text).split('\n').map(l => `> ${l}`), '');
        if (n.body?.trim()) lines.push(n.body.trim(), '');
        else if (kind !== 'highlight') lines.push('');
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Reads an exported Markdown file (or a JSON array of notes). Returns the items found. */
export function parseImport(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return arr.filter(n => n && typeof n.key === 'string' && Number.isInteger(n.step) && (n.kind === 'note' || n.kind === 'highlight'));
  }
  const items = [];
  let cur = null, buf = [];
  const finish = () => {
    if (!cur) return;
    let i = 0;
    const quote = [];
    if (cur.kind === 'highlight') { while (i < buf.length && /^>\s?/.test(buf[i])) quote.push(buf[i++].replace(/^>\s?/, '')); }
    const body = buf.slice(i).join('\n').trim();
    items.push({ ...cur, text: cur.kind === 'highlight' ? quote.join('\n') : undefined, body });
    cur = null; buf = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = MARK.exec(line.trim());
    if (m) {
      finish();
      try { const meta = JSON.parse(m[1]); if (typeof meta.key === 'string' && Number.isInteger(meta.step)) cur = meta; } catch { }
      continue;
    }
    if (/^#{1,4}\s/.test(line)) { finish(); continue; }
    if (cur) buf.push(line);
  }
  finish();
  return items.filter(n => n.kind === 'highlight' ? n.text : n.kind === 'note' && n.body);
}

/** Merges imported items: same id keeps the newer copy; a step note for a step that has one is appended to it. */
export function mergeImport(items) {
  const list = all();
  let added = 0, updated = 0;
  for (const raw of items) {
    const n = { ...raw, id: raw.id || newId(), created: raw.created || now(), updated: raw.updated || now() };
    const same = list.find(x => x.id === n.id);
    if (same) { if ((n.updated || '') > (same.updated || '')) { Object.assign(same, n); updated++; } continue; }
    if (n.kind === 'note') {
      const existing = list.find(x => x.kind === 'note' && x.key === n.key && x.step === n.step);
      if (existing) { if (!existing.body.includes(n.body)) { existing.body = `${existing.body.trim()}\n\n${n.body}`; existing.updated = now(); updated++; } continue; }
    }
    if (n.kind === 'highlight' && list.some(x => x.kind === 'highlight' && x.key === n.key && x.step === n.step && x.text === n.text)) continue;
    list.push(n); added++;
  }
  game.save(true);
  return { added, updated };
}

// ---------------------------------------------------------------- the #/notes page

/** Topics (in map order) -> lessons -> items (by step, notes before highlights). */
function grouped(tracks, items) {
  const order = new Map();
  (tracks || []).forEach((t, ti) => t.modules.forEach((m, mi) => m.lessons.forEach((l, li) => order.set(`${t.id}/${m.id}/${l.id}`, [ti, mi, li]))));
  const byTopic = new Map();
  for (const n of items) {
    const tid = n.key.split('/')[0];
    const track = tracks?.find(t => t.id === tid);
    if (!byTopic.has(tid)) byTopic.set(tid, { id: tid, title: track?.title || tid, idx: tracks?.indexOf(track) ?? 99, lessons: new Map() });
    const topic = byTopic.get(tid);
    if (!topic.lessons.has(n.key)) topic.lessons.set(n.key, { key: n.key, title: n.lessonTitle || n.key, items: [] });
    topic.lessons.get(n.key).items.push(n);
  }
  const pos = k => order.get(k) || [99, 99, 99];
  return [...byTopic.values()].sort((a, b) => a.idx - b.idx || a.title.localeCompare(b.title)).map(t => ({
    ...t,
    lessons: [...t.lessons.values()].sort((a, b) => { const x = pos(a.key), y = pos(b.key); return x[1] - y[1] || x[2] - y[2] || a.title.localeCompare(b.title); })
      .map(l => ({ ...l, items: l.items.sort((a, b) => a.step - b.step || (a.kind === b.kind ? (a.created || '').localeCompare(b.created || '') : a.kind === 'note' ? -1 : 1)) })),
  }));
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function notesView(page, tracks, { isOpen } = {}) {
  const filter = h('input.nt-filter', { type: 'search', placeholder: 'Filter notes and highlights', 'aria-label': 'Filter notes and highlights' });
  const list = h('div.nt-page-list');
  const msg = h('p.muted.small.nt-msg', { role: 'status', 'aria-live': 'polite' });
  const file = h('input', { type: 'file', accept: '.md,.markdown,.txt,.json', hidden: true, 'aria-hidden': 'true' });
  const exportBtn = h('button.btn.ghost', { type: 'button', onclick: () => {
    if (!all().length) { msg.textContent = 'Nothing to export yet.'; return; }
    download(`code-dojo-notes-${game.dayKey()}.md`, toMarkdown(tracks));
    msg.textContent = `Exported ${all().length} item${all().length === 1 ? '' : 's'} to a Markdown file.`;
  } }, '⇩ Export to Markdown');
  const importBtn = h('button.btn.ghost', { type: 'button', onclick: () => file.click() }, '⇧ Import');
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const items = parseImport(await f.text());
      if (!items.length) { msg.textContent = `${f.name} has no code-dojo notes in it (import reads files made by Export).`; return; }
      const r = mergeImport(items);
      msg.textContent = `Imported ${f.name}: ${r.added} added, ${r.updated} updated${items.length - r.added - r.updated > 0 ? `, ${items.length - r.added - r.updated} already here` : ''}.`;
      paint();
    } catch (e) { msg.textContent = `Could not read ${f.name}: ${e.message}`; }
  });

  function itemView(n) {
    const locked = isOpen && !isOpen(n.key);
    const body = h('div.prose.nt-body', { html: n.body?.trim() ? md(n.body) : '' });
    const edit = h('button.mini', { type: 'button' }, 'Edit');
    const del = h('button.mini', { type: 'button' }, 'Delete');
    const el = h(`article.nt-item.${n.kind}`,
      h('div.nt-item-head',
        h('span.tag', n.kind === 'highlight' ? 'Highlight' : 'Note'),
        locked ? h('span.muted.small', `Step ${n.step + 1}${n.stepTitle ? ` · ${n.stepTitle}` : ''} · 🔒 locked`)
          : h('a.small', { href: stepHash(n) }, `Step ${n.step + 1}${n.stepTitle ? ` · ${n.stepTitle}` : ''}`),
        h('span.spacer'),
        h('span.muted.small', { title: `Created ${new Date(n.created).toLocaleString()}` }, new Date(n.updated || n.created).toLocaleDateString()),
        edit, del),
      n.kind === 'highlight' && h('blockquote.nt-quote', n.text),
      body);
    edit.addEventListener('click', () => {
      const ta = h('textarea.nt-editor', { rows: Math.max(3, (n.body || '').split('\n').length + 1), value: n.body || '', 'aria-label': 'Edit note' });
      const done = h('button.btn.primary.small', { type: 'button' }, 'Save');
      const cancel = h('button.btn.ghost.small', { type: 'button' }, 'Cancel');
      const box = h('div.nt-inline-edit', ta, h('div.nt-tools', done, cancel));
      body.replaceWith(box); edit.hidden = true; ta.focus();
      const finish = save => {
        if (save) { if (n.kind === 'note') setNote(n.key, n.step, ta.value, {}); else update(n.id, { body: ta.value }); }
        paint();
      };
      done.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      ta.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); } });
    });
    del.addEventListener('click', async () => {
      if (!(await ask(n.kind === 'highlight' ? 'Delete this highlight and its note?' : 'Delete this note?', { ok: 'Delete', danger: true }))) return;
      remove(n.id); paint();
    });
    return el;
  }

  function paint() {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const items = all().filter(n => {
      if (!words.length) return true;
      const hay = `${n.text || ''} ${n.body || ''} ${n.lessonTitle || ''} ${n.stepTitle || ''}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
    const topics = grouped(tracks, items);
    const notesN = all().filter(n => n.kind === 'note').length, hlN = all().length - notesN;
    counts.textContent = `${notesN} note${notesN === 1 ? '' : 's'} · ${hlN} highlight${hlN === 1 ? '' : 's'} · ${new Set(all().map(n => n.key)).size} lesson${new Set(all().map(n => n.key)).size === 1 ? '' : 's'}`;
    if (!all().length) {
      list.replaceChildren(h('div.empty.nt-empty',
        h('h2', 'No notes yet'),
        h('p.muted', 'In any lesson, press ✎ Notes beside the step title to write a note, or select text on a learn card and press Highlight.'),
        h('a.btn.primary', { href: '#/' }, 'Go to the topics')));
      return;
    }
    if (!topics.length) { list.replaceChildren(h('p.muted.nt-none', `Nothing matches “${filter.value}”.`)); return; }
    list.replaceChildren(...topics.map(t => h('section.nt-topic',
      h('h2.section-title', t.title),
      t.lessons.map(l => h('div.nt-lesson',
        h('div.nt-lesson-head', h('h3', l.title), isOpen && !isOpen(l.key) ? h('span.muted.small', '🔒 locked') : h('a.mini', { href: `#/lesson/${l.key}` }, 'Open lesson')),
        l.items.map(itemView))))));
  }

  const counts = h('span.muted.small');
  filter.addEventListener('input', paint);
  page('notes',
    h('section.hero', h('div',
      h('div.eyebrow', 'Your notes'),
      h('h1', 'Notes and highlights'),
      h('p.muted', 'Everything you wrote and highlighted in lessons, grouped by topic and lesson. Each one links back to its step. Notes are saved with your progress on this machine; export them to keep a copy.'))),
    h('div.nt-bar', filter, counts, h('span.spacer'), exportBtn, importBtn, file),
    msg, list);
  paint();
}
