// "Your builds": every topic quietly assembles a real artifact (a tool, a service, a script kit) from the
// learner's own passing code. A track declares its artifacts in track.json; a code step marks the piece it
// adds with "build" (format: tracks/AUTHORING.md, "Building a real artifact"). /api/tracks lists every
// lesson's build markers, so progress is counted without loading lessons.
//
//   state.builds[artifactId] = {
//     pieces:   { pieceKey: { file, mode, code, at, lessonKey, stepIdx, title } }   latest passing version only
//     done:     { "track/module/lesson#idx": date }                               which markers were passed
//     revealed: date                                                              the dream reveal was shown
//   }
// pieceKey is the file for "replace" pieces (a later lesson replaces the earlier version: pieces grow) and
// "file#lessonKey#idx" for "append" pieces.
//
// Dreams: a track may declare "dreams" (4-5 builds to choose from) instead of one fixed "artifacts" entry.
// The choice lives in state.dreams[trackId]; until the learner picks, the profile's suggestion (pathrules.js)
// or the first dream is the default. Every dream keeps its own pieces: switching never deletes code, and
// pieces whose file also exists in the new dream's skeleton carry over.
import { h, md, inline, api } from './util.js';
import * as game from './game.js';
import { suggestDream } from './pathrules.js';

// ---------------------------------------------------------------- data

/** Fixed artifacts and dreams as one list; a dream's own fields are laid over its "artifact". Same as Builds.Artifacts. */
export function artifactsOf(track) {
  const fixed = (Array.isArray(track?.artifacts) ? track.artifacts : []).filter(a => a && a.id);
  const dreams = (Array.isArray(track?.dreams) ? track.dreams : []).filter(d => d && d.id)
    .map(d => { const { artifact, ...rest } = d; return { ...(artifact || {}), ...rest, dream: true }; });
  return [...fixed, ...dreams];
}
export const dreamsOf = track => artifactsOf(track).filter(a => a.dream);

/** The dream this learner builds in a track: their choice, else the profile's suggestion, else the first. */
export function chosenDream(track) {
  const list = dreamsOf(track);
  if (!list.length) return null;
  const picked = game.state.dreams?.[track.id];
  const suggested = game.state.profile?.dreams?.[track.id] || suggestDream(track, list, game.state.profile);
  return list.find(d => d.id === picked) || list.find(d => d.id === suggested) || list[0];
}
export const hasChosen = track => !!dreamsOf(track).find(d => d.id === game.state.dreams?.[track.id]);

/** What a track is building right now: its fixed artifacts plus the chosen dream. */
export function activeArtifacts(track) {
  const dream = chosenDream(track);
  return artifactsOf(track).filter(a => !a.dream || a.id === dream?.id);
}

/** The id to send as ?dream= so the server serves (and grades) that dream's variants. */
export const dreamParam = track => chosenDream(track)?.id || '';

/** A marker "artifact" meaning the learner's chosen dream: none, "@dream" or "dream". Same as Builds.ChosenDream. */
const meansDream = target => !target || target === '@dream' || target === 'dream';

/** {{key}} -> the dream's lexicon value; unknown keys stay. Same as Content.Lex. */
export const lex = (text, lexicon) => String(text ?? '').replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (m, k) => (typeof lexicon?.[k] === 'string' ? lexicon[k] : m));

/** Does marker b build artifact a, and with which file, title and stub? Same rule as Builds.MarkerFile. */
function markerFor(b, a) {
  if (!(b.artifact === a.id || (a.dream && meansDream(b.artifact)))) return null;
  const v = b.variants?.[a.id] || {};
  return { file: lex(v.file || b.file, a.lexicon), title: lex(v.title || b.title, a.lexicon), mode: v.mode || b.mode || 'replace', stub: v.stub ?? b.stub };
}

/** Every build marker of one artifact in a track, in teaching order (lesson map, then projects). */
export function markers(track, artifactId) {
  const a = artifactsOf(track).find(x => x.id === artifactId);
  const out = [];
  if (!a) return out;
  for (const m of track.modules || []) {
    m.lessons.forEach((l, li) => {
      for (const b of l.builds || []) {
        const hit = markerFor(b, a);
        if (!hit) continue;
        const key = game.lessonKey(track, m, l);
        out.push({ ...b, ...hit, key, id: `${key}#${b.step}`, lesson: l, module: m, li });
      }
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.step - b.step));
}

/**
 * Pick a dream. Pieces already earned under other dreams of this track carry over when the new dream's
 * skeleton (its template or its pieces) has the same file; nothing is ever removed from the old dream.
 */
export function chooseDream(track, dreamId) {
  const target = dreamsOf(track).find(d => d.id === dreamId);
  if (!target) return;
  (game.state.dreams ||= {})[track.id] = dreamId;
  const files = new Set([...Object.keys(target.template || {}), ...markers(track, dreamId).map(m => m.file)]);
  const into = entry(dreamId);
  for (const other of dreamsOf(track)) {
    if (other.id === dreamId) continue;
    const from = game.state.builds?.[other.id];
    if (!from) continue;
    for (const [k, p] of Object.entries(from.pieces || {})) {
      if (!files.has(p.file) || into.pieces[k]) continue;
      into.pieces[k] = { ...p, from: other.id };
      const id = `${p.lessonKey}#${p.stepIdx}`;
      if (from.done?.[id]) into.done[id] ||= from.done[id];
    }
  }
  entry(dreamId).revealed ||= game.dayKey();
  game.save();
}

function entry(id) {
  const all = (game.state.builds ||= {});
  const b = (all[id] ||= {});
  b.pieces ||= {};
  b.done ||= {};
  return b;
}
const peek = id => game.state.builds?.[id] || { pieces: {}, done: {} };

export function progress(track, artifact) {
  const list = markers(track, artifact.id);
  const done = peek(artifact.id).done || {};
  const marked = list.map(m => ({ ...m, done: !!done[m.id] }));
  return { list: marked, n: marked.filter(m => m.done).length, m: marked.length };
}

const textOf = v => (Array.isArray(v) ? v.join('\n') + '\n' : typeof v === 'string' ? v : '');
const withNewline = s => (s.length === 0 || s.endsWith('\n') ? s : s + '\n');

/** The learner's code wrapped by the step's transform; an indented {{CODE}} indents every line. Same as Builds.Transform. */
export function transform(t, code) {
  const tpl = textOf(t);
  if (!tpl) return code;
  const body = String(code).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return tpl.replace(/(^[ \t]*)?\{\{CODE\}\}/gm, (_, indent = '') =>
    indent + body.split('\n').map((l, i) => (i === 0 || !l ? l : indent + l)).join('\n'));
}

/** Template files, then pieces in teaching order. Mirrors Builds.Assemble on the server. */
export function assemble(artifact, stubs = []) {
  const files = new Map();
  for (const [path, v] of Object.entries(artifact.template || {})) files.set(path, { text: textOf(v), source: 'template' });
  for (const m of stubs) if (m.stub != null && !files.has(m.file)) files.set(m.file, { text: lex(textOf(m.stub), artifact.lexicon), source: 'stub' });
  const pieces = Object.values(peek(artifact.id).pieces || {})
    .sort((a, b) => (a.lessonKey < b.lessonKey ? -1 : a.lessonKey > b.lessonKey ? 1 : a.stepIdx - b.stepIdx));
  for (const p of pieces) {
    const before = files.get(p.file);
    const code = withNewline(p.code || '');
    files.set(p.file, { text: p.mode === 'append' && before ? withNewline(before.text) + code : code, source: 'yours', piece: p });
  }
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const payload = artifact => ({
  pieces: Object.values(peek(artifact.id).pieces || {}).map(p => ({ file: p.file, mode: p.mode, code: p.code, lesson: p.lessonKey, step: p.stepIdx })),
});

/**
 * Called when a code step passes. Saves the (transformed) code as the newest version of its piece.
 * Returns { track, artifact, n, m, fresh } for the toast, or null when the step builds nothing.
 */
export function record(tracks, item, code) {
  const b = item?.step?.build;
  if (!b?.file) return null;
  const track = tracks.find(t => t.id === item.track);
  // No artifact (or "dream"): the piece belongs to whichever dream the learner is building.
  const artifact = meansDream(b.artifact)
    ? chosenDream(track)
    : artifactsOf(track).find(a => a.id === b.artifact);
  if (!artifact) return null;
  const mode = b.mode === 'append' ? 'append' : 'replace';
  const e = entry(artifact.id);
  const id = `${item.lessonKey}#${item.idx}`;
  const fresh = !e.done[id];
  const pieceKey = mode === 'append' ? `${b.file}#${id}` : b.file;
  const existing = e.pieces[pieceKey];
  // A replace piece keeps the version from the furthest lesson; replaying an earlier lesson does not shrink it.
  if (!(mode === 'replace' && existing && existing.lessonKey > item.lessonKey)) {
    e.pieces[pieceKey] = { file: b.file, mode, code: transform(b.transform, code), at: new Date().toISOString(), lessonKey: item.lessonKey, stepIdx: item.idx, title: b.title || item.step.title || b.file };
  }
  e.done[id] ||= game.dayKey();
  (e.fresh ||= []).push(id);        // lit with an animation the next time the blueprint is drawn
  const p = progress(track, artifact);
  return { track, artifact, n: p.n, m: p.m, fresh, title: b.title || item.step.title || b.file, unlocks: b.unlocks };
}

/** The toast body for a new piece. */
export function pieceToast(r) {
  return [h('span.toast-icon', r.artifact.icon || '◆'),
    h('div', h('strong', r.fresh ? `+ piece added to ${r.artifact.title}` : `${r.artifact.title}: piece updated`),
      r.unlocks && h('div.small', r.unlocks),
      h('div.small', `${r.title} · ${r.n}/${r.m} pieces · `, h('a', { href: '#/builds' }, 'See your build')))];
}

// ---------------------------------------------------------------- the blueprint: pieces that light up

/** One tile per piece; earned tiles glow, the ones just earned light up with an animation. */
export function blueprintGrid(track, artifact, { compact = false } = {}) {
  const p = progress(track, artifact);
  const e = game.state.builds?.[artifact.id];
  const fresh = new Set(e?.fresh || []);
  if (e?.fresh?.length) { e.fresh = []; game.save(); }
  return h(`div.bd-grid${compact ? '.compact' : ''}`, { role: 'list', 'aria-label': `${artifact.title}: ${p.n} of ${p.m} pieces built` },
    p.list.map((m, i) => {
      const cls = `${m.done ? '.lit' : ''}${fresh.has(m.id) ? '.just' : ''}`;
      return h(`div.bd-tile${cls}`, { role: 'listitem', title: `${m.title} (${m.file}): ${m.done ? 'built' : `built in "${m.lesson.title}"`}`, style: { '--i': i } },
        h('span.bd-tile-mark', m.done ? '✓' : String(i + 1)),
        !compact && h('span.bd-tile-text', h('span.bd-tile-title', m.title), h('span.bd-tile-file', m.file)));
    }));
}

function meter(p) {
  return h('div.bd-meter', h('div.bar', h('div.bar-fill', { style: { width: `${(p.n / Math.max(1, p.m)) * 100}%` } })), h('span.muted.small', `${p.n}/${p.m} pieces`));
}

// ---------------------------------------------------------------- the dream reveal

function previewOf(track, artifact) {
  const pv = artifact.preview || {};
  return [
    pv.image && h('img.bd-preview-img', { src: `/api/track-asset/${encodeURIComponent(track.id)}/${String(pv.image).split('/').map(encodeURIComponent).join('/')}`, alt: `${artifact.title}, finished` }),
    pv.demo && h('div.bd-demo', { html: md(textOf(pv.demo)) }),
    Array.isArray(pv.frames) && terminal(pv.frames),
  ];
}

/** A terminal preview that types each frame's command, then prints its output: { cmd, out: [lines] }. */
function terminal(frames) {
  const body = h('pre.code.plain.bd-term');
  const box = h('div.bd-demo', body);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  (async () => {
    const wait = ms => new Promise(r => setTimeout(r, reduce ? 0 : ms));
    await wait(400);                                   // let the page place it first
    for (const f of frames) {
      if (!box.isConnected) return;                    // the page moved on
      const line = document.createTextNode('$ ');
      body.append(line);
      for (const ch of String(f.cmd)) { line.textContent += ch; await wait(28); }
      body.append('\n');
      await wait(250);
      for (const out of [].concat(f.out ?? [])) { body.append(String(out) + '\n'); await wait(60); }
      body.append('\n');
      await wait(500);
    }
  })();
  return box;
}

/** The big pitch: what you are going to build in this track. */
function dreamFull(track, artifact, { cta } = {}) {
  const p = progress(track, artifact);
  return h('section.bd-dream',
    h('div.bd-dream-text',
      h('div.eyebrow', `Your dream build · ${track.title}`),
      h('h1.bd-dream-title', h('span.bd-icon', artifact.icon || '◆'), artifact.title),
      artifact.pitch && h('p.bd-pitch', { html: inline(artifact.pitch) }),
      artifact.features?.length > 0 && h('ul.bd-features', artifact.features.map(f => h('li', { html: inline(f) }))),
      h('p.muted.small', p.m
        ? `It is assembled from ${p.m} piece${p.m === 1 ? '' : 's'} of your own passing code. Each one lights up below when you pass the lesson that builds it; then open the whole thing as a real project.`
        : 'Its pieces are on the way.'),
      cta),
    h('div.bd-dream-side', previewOf(track, artifact), p.m > 0 && blueprintGrid(track, artifact)));
}

/** The compact header once the reveal has been seen: title, progress and the glowing pieces. */
function dreamCompact(track, artifact, refresh) {
  const p = progress(track, artifact);
  const more = h('div.bd-compact-more', { hidden: true });
  const toggle = (btn, what) => {
    const open = more.hidden || more.dataset.what !== what;
    more.hidden = !open;
    more.dataset.what = what;
    more.replaceChildren(open ? (what === 'pick' ? dreamPicker(track, { onPick: () => refresh?.() }) : dreamFull(track, artifact)) : '');
  };
  return h('section.bd-compact',
    h('div.bd-compact-row',
      h('span.bd-icon', artifact.icon || '◆'),
      h('div.grow', h('div.eyebrow', "You're building"), h('div.bd-compact-title', artifact.title, h('span.muted', ` · ${p.n}/${p.m} pieces`))),
      p.m > 0 && blueprintGrid(track, artifact, { compact: true }),
      h('button.btn.ghost.small', { type: 'button', onclick: e => toggle(e.currentTarget, 'dream') }, 'The dream'),
      artifact.dream && dreamsOf(track).length > 1 && h('button.btn.ghost.small', { type: 'button', onclick: e => toggle(e.currentTarget, 'pick') }, 'Change dream'),
      h('a.btn.ghost.small', { href: '#/builds' }, 'Open')),
    more);
}

/**
 * Choose what to build: one card per dream (the profile's suggestion marked), and the full pitch of the one
 * selected. onPick(dream) runs after the choice is saved.
 */
export function dreamPicker(track, { onPick, label = 'Build this one' } = {}) {
  const list = dreamsOf(track);
  const suggested = suggestDream(track, list, game.state.profile);
  let selected = chosenDream(track)?.id || list[0]?.id;
  const detail = h('div.bd-pick-detail');
  const cards = h('div.bd-pick-cards', { role: 'radiogroup', 'aria-label': 'Pick your dream' });
  const draw = () => {
    cards.replaceChildren(...list.map(d => {
      const earned = Object.keys(game.state.builds?.[d.id]?.done || {}).length;
      return h(`button.bd-pick${d.id === selected ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(d.id === selected), onclick: () => { selected = d.id; draw(); } },
        h('span.bd-pick-icon', d.icon || '◆'),
        h('span.bd-pick-title', d.title),
        d.id === suggested && h('span.bd-pick-tag', 'Suggested for you'),
        d.id === game.state.dreams?.[track.id] && h('span.bd-pick-tag.mine', 'Your pick'),
        earned > 0 && h('span.muted.small', `${earned} piece${earned === 1 ? '' : 's'} built`),
        (d.tags || []).length > 0 && h('span.bd-pick-tags.small.muted', d.tags.join(' · ')));
    }));
    const d = list.find(x => x.id === selected);
    detail.replaceChildren(d ? dreamFull(track, d, {
      cta: h('button.btn.primary.big', { type: 'button', onclick: () => { chooseDream(track, d.id); onPick?.(d); } },
        d.id === game.state.dreams?.[track.id] ? 'Keep building this' : label),
    }) : '');
  };
  draw();
  return h('section.bd-picker',
    h('div.eyebrow', `Pick your dream · ${track.title}`),
    h('h2', 'What do you want to have built at the end of this?'),
    h('p.muted', 'Every lesson adds a real piece to the one you pick. You can change your mind later; pieces you earned stay yours.'),
    cards, detail);
}

/** For the track page: the full reveal (or the dream choice) the first time, the compact header after. */
export function trackPanel(track, { refresh } = {}) {
  const list = activeArtifacts(track);
  if (!list.length) return null;
  return list.map(a => {
    if (a.dream && !hasChosen(track)) return dreamPicker(track, { onPick: () => refresh?.() });
    if (game.state.builds?.[a.id]?.revealed) return dreamCompact(track, a, refresh);
    entry(a.id).revealed = game.dayKey();
    game.save();
    return dreamFull(track, a, { cta: h('a.btn.ghost', { href: '#/builds' }, 'See it on Your builds') });
  });
}

/** True when the first lesson of a track with an artifact opens and the learner has not seen (or picked) the dream yet. */
export function needsReveal(track, key) {
  const list = activeArtifacts(track);
  if (!list.length || game.flatLessons(track)[0]?.key !== key) return false;
  return list.some(a => (a.dream ? !hasChosen(track) : !game.state.builds?.[a.id]?.revealed));
}

/** A full-screen reveal before the first lesson starts: the dream choice, or the fixed artifact's pitch. */
export function revealScreen(app, track, start) {
  if (dreamsOf(track).length && !hasChosen(track)) {
    app.replaceChildren(h('div.bd-reveal', dreamPicker(track, { onPick: start, label: "Let's build it" }),
      h('div.bd-reveal-go', h('button.btn.ghost', { type: 'button', onclick: start }, 'Decide later'))));
    window.scrollTo(0, 0);
    return;
  }
  const list = activeArtifacts(track).filter(a => !a.dream && !game.state.builds?.[a.id]?.revealed);
  for (const a of list) entry(a.id).revealed = game.dayKey();
  game.save();
  const go = h('button.btn.primary.big', { type: 'button', onclick: start }, "Let's build it");
  app.replaceChildren(h('div.bd-reveal',
    list.map(a => dreamFull(track, a)),
    h('div.bd-reveal-go', go, h('span.muted.small', 'This first lesson starts the groundwork.'))));
  window.scrollTo(0, 0);
  go.focus();
}

/** For the lesson summary: "You're building: X (n/m pieces)" with the pieces this lesson lit. */
export function summaryPanel(track, key) {
  const list = activeArtifacts(track).filter(a => markers(track, a.id).length);
  if (!list.length) return null;
  return list.map(a => {
    const p = progress(track, a);
    const here = p.list.some(m => m.key === key);
    return h(`div.bd-summary${here ? '.here' : ''}`,
      h('div.bd-summary-row',
        h('span.bd-icon', a.icon || '◆'),
        h('span', "You're building: ", h('a', { href: '#/builds' }, h('b', a.title)), h('span.muted', ` (${p.n}/${p.m} pieces)`))),
      blueprintGrid(track, a));
  });
}

// ---------------------------------------------------------------- the Builds page

async function download(track, artifact, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/builds/${encodeURIComponent(track.id)}/${encodeURIComponent(artifact.id)}/zip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(artifact)),
    });
    if (!res.ok) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: `${artifact.id}.zip` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { alert('Could not build the zip. Is the dojo server still running?'); }
  btn.disabled = false;
}

async function openSpace(track, artifact, btn, out) {
  btn.disabled = true;
  out.replaceChildren(h('span.muted.small', 'Writing your files…'));
  try {
    const r = await api(`builds/${encodeURIComponent(track.id)}/${encodeURIComponent(artifact.id)}/space`, payload(artifact));
    if (r.error) { out.replaceChildren(h('div.callout.warn', r.error)); return; }
    out.replaceChildren(h('div.bd-export',
      h('div', h('b', `Space "${r.space}" is ready. `),
        h('span.muted', `${r.written.length} written, ${r.unchanged.length} unchanged${r.kept.length ? `, ${r.kept.length} kept as you edited them` : ''}.`)),
      r.kept.length > 0 && h('div.small.muted', 'You changed these in the space, so they were left alone. The new version is next to each as ', h('code', '.dojo-new'), ': ',
        r.kept.map((k, i) => [i ? ', ' : '', h('code', k)])),
      h('a.btn.primary', { href: `#/spaces/${encodeURIComponent(r.space)}` }, `Open ${r.space}`)));
  } catch { out.replaceChildren(h('div.callout.warn', 'Could not reach the dojo server.')); }
  finally { btn.disabled = false; }
}

function fileTree(artifact, markersList) {
  const files = assemble(artifact, markersList);
  const waiting = new Set(markersList.filter(m => !files.get(m.file) || files.get(m.file).source !== 'yours').map(m => m.file));
  for (const m of markersList) if (!files.has(m.file)) files.set(m.file, { text: '', source: 'missing' });
  const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const view = h('pre.code.plain.bd-file-view');
  const label = h('div.bd-file-name.mono.small');
  const show = (path, f, btn) => {
    label.textContent = path;
    view.textContent = f.source === 'missing' ? '(not built yet)' : f.text;
    btn?.parentElement?.querySelectorAll('.bd-file').forEach(b => b.classList.toggle('active', b === btn));
  };
  const list = h('div.bd-files', sorted.map(([path, f]) => {
    const depth = path.split('/').length - 1;
    const state = f.source === 'yours' ? 'yours' : waiting.has(path) ? 'waiting' : 'template';
    const btn = h(`button.bd-file.${state}`, { type: 'button', style: { paddingLeft: `${10 + depth * 14}px` }, onclick: () => show(path, f, btn) },
      h('span.mono', path.split('/').pop()),
      h('span.bd-file-tag', state === 'yours' ? 'your code' : state === 'waiting' ? 'stub' : 'template'));
    return btn;
  }));
  const first = sorted.find(([, f]) => f.source === 'yours') || sorted[0];
  if (first) queueMicrotask(() => show(first[0], first[1], [...list.children][sorted.indexOf(first)]));
  return h('div.bd-tree', list, h('div.bd-file-pane', label, view));
}

function artifactCard(track, artifact) {
  const p = progress(track, artifact);
  const out = h('div.bd-out');
  const spaceBtn = h('button.btn.primary', { type: 'button', onclick: () => openSpace(track, artifact, spaceBtn, out) }, 'Open as a Code space');
  const zipBtn = h('button.btn.ghost', { type: 'button', onclick: () => download(track, artifact, zipBtn) }, 'Download as .zip');
  return h('section.bd-card',
    h('div.bd-card-head',
      h('span.bd-icon.big', artifact.icon || '◆'),
      h('div.grow',
        h('div.eyebrow', `${track.title} · ${artifact.kind || 'project'}${artifact.dream && artifact.id !== chosenDream(track)?.id ? ' · an earlier dream, kept' : ''}`),
        h('h2', artifact.title),
        h('p.muted', { html: inline(artifact.pitch || artifact.summary || '') })),
      meter(p)),
    p.m > 0 && blueprintGrid(track, artifact),
    h('div.bd-cols',
      h('div.bd-pieces',
        h('h3', 'Pieces'),
        p.list.length ? h('ol.bd-piece-list', p.list.map(m => {
          const open = game.isUnlocked(track, m.module, m.li);
          return h(`li${m.done ? '.done' : ''}`,
            h('span.bd-piece-mark', m.done ? '✓' : '○'),
            h('div',
              h('div', h('b', m.title), ' ', h('span.mono.small.muted', m.file), m.mode === 'append' && h('span.muted.small', ' (adds to the file)')),
              h('div.small.muted', m.done ? 'Built in ' : 'Built in ',
                open ? h('a', { href: `#/lesson/${m.key}` }, m.lesson.title) : h('span', `${m.lesson.title} (locked)`),
                ` · ${m.module.title}`)));
        })) : h('p.muted', 'No lesson builds a piece of this yet.')),
      h('div.bd-files-col', h('h3', 'What you have so far'), fileTree(artifact, p.list))),
    artifact.run && h('div.bd-run', h('span.muted.small', 'Run it: '), h('code', artifact.run)),
    h('div.bd-actions', spaceBtn, zipBtn, h('span.muted.small', p.n < p.m ? 'Unbuilt pieces stay as stubs, so it runs at every stage.' : 'Every piece is yours.')),
    out);
}

export function buildsView(page, tracks) {
  const all = [...tracks].sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .flatMap(t => artifactsOf(t)
      .filter(a => !a.dream || a.id === chosenDream(t)?.id || Object.keys(game.state.builds?.[a.id]?.pieces || {}).length)
      .map(a => ({ track: t, artifact: a })));
  page('builds',
    h('section.hero', h('div',
      h('div.eyebrow', 'Your builds'),
      h('h1', 'Real things, made of your code'),
      h('p.muted', 'Every topic quietly assembles a usable artifact from the code you pass: a tool, a service, a script kit. Watch the pieces light up, then open it as a project and run it for real.'))),
    all.length
      ? all.map(({ track, artifact }) => artifactCard(track, artifact))
      : h('div.empty', h('p.muted', 'No topic declares a build yet.')));
}
