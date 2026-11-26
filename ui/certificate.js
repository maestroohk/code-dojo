// Completion certificates and progress records.
//
//   #/certificate/topic/<trackId>   one topic: modules mastered with stars, gates proven, cold rebuilds, builds,
//                                   projects, labs, hours, first and last dates, boss highlights; or what is left
//   #/certificate/path/<pathId>     one learning path, stage by stage, with its milestones
//   certificatesPanel(tracks)       the list on the Profile page
//
// Every page carries a SHA-256 of its evidence: the exact JSON the "Download evidence" button saves (keys sorted, no
// whitespace), so `sha256sum` or `Get-FileHash` on that file reproduces the printed hash. Printable: the browser's
// Print / Save as PDF uses the print styles at the end of styles.css.
import { h } from './util.js';
import * as game from './game.js';
import * as builds from './builds.js';
import { mastery } from './mastery.js';
import { loadPaths, pathProgress, labSolved, LAB_INFO, hours } from './paths.js';

/** Labs that belong to a topic, for its certificate (visual labs keep solved challenges; live labs keep tasks). */
const TOPIC_LABS = {
  pki: { labs: ['pki'] }, networking: { labs: ['subnet', 'netbuild'], netlabs: /^(0[1-9]|10)-/ },
  docker: { labs: ['composebuild'] }, kubernetes: { labs: ['kubebuild'] }, cicd: { labs: ['pipebuild'] },
  messaging: { labs: ['msgbuild-rabbit', 'msgbuild-kafka'], netlabs: /^(24|25)-/ }, integration: { labs: ['archbuild'], netlabs: /^23-/ },
  linux: { labs: ['vim'], netlabs: /^(1[1-9]|2[0-2])-/ }, editors: { labs: ['vim'] }, regex: { labs: ['regex'] },
};

/** JSON with object keys sorted and no whitespace: the same value always gives the same bytes. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const fmtDate = d => (d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '–');
/** "10 Nov – 26 Nov 2026": short enough for a stat tile. */
const span = (a, b) => {
  const d = x => new Date(x.length === 10 ? x + 'T12:00:00' : x);
  const short = x => d(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return a === b ? fmtDate(a) : `${short(a)} – ${short(b)} ${d(b).getFullYear()}`;
};
const starText =(n, max = 3) => '★'.repeat(n) + '☆'.repeat(Math.max(0, max - n));
const minDate = list => list.filter(Boolean).sort()[0] || null;
const maxDate = list => list.filter(Boolean).sort().pop() || null;

// ---------------------------------------------------------------- measuring a set of modules

/** Everything a certificate says about some modules of some tracks, measured from game.state. */
function measureModules(entries) {
  const s = game.state;
  const rows = [];
  const bosses = [];
  const cold = [];
  let minutesDone = 0, minutesLeft = 0;
  const dates = [];
  for (const { track, module } of entries) {
    const mk = `${track.id}/${module.id}`;
    const lessons = module.lessons.map(l => ({ l, key: game.lessonKey(track, module, l), rec: s.lessons[game.lessonKey(track, module, l)] }));
    const done = lessons.filter(x => x.rec);
    const stars = done.reduce((n, x) => n + (x.rec.stars || 0), 0);
    for (const x of lessons) {
      const m = Number(x.l.minutes) || 10;
      if (x.rec) { minutesDone += m; dates.push(x.rec.completedAt); } else minutesLeft += m;
      if (x.rec && x.l.kind === 'boss') bosses.push({ track, module, lesson: x.l, rec: x.rec, key: x.key });
    }
    const gate = s.pacing?.modules?.[mk];
    const coldHere = Object.entries(s.pacing?.cold || {}).filter(([k]) => k.startsWith(mk + '/'))
      .map(([k, v]) => ({ key: k, at: v.at, inTime: v.inTime, ms: v.ms, lesson: module.lessons.find(l => k.startsWith(`${mk}/${l.id}#`)) }));
    cold.push(...coldHere.map(c => ({ ...c, track, module })));
    const complete = lessons.length > 0 && done.length === lessons.length;
    const mastered = complete && done.every(x => (x.rec.stars || 0) >= 2) && (!module.gate || !!gate?.provenAt) && !gate?.rusty;
    const next = lessons.find(x => !x.rec);
    rows.push({
      track, module, key: mk, project: game.isProject(module), total: lessons.length, done: done.length, stars, maxStars: lessons.length * 3,
      complete, mastered, provenAt: gate?.provenAt || null, rusty: !!gate?.rusty, hasGate: !!module.gate, cold: coldHere.length,
      first: minDate(done.map(x => x.rec.completedAt)), last: maxDate(done.map(x => x.rec.completedAt)),
      minutesLeft: lessons.filter(x => !x.rec).reduce((n, x) => n + (Number(x.l.minutes) || 10), 0),
      next: next && { key: next.key, title: next.l.title },
    });
  }
  bosses.sort((a, b) => (b.rec.stars || 0) - (a.rec.stars || 0) || (b.rec.bestXp || 0) - (a.rec.bestXp || 0) || (a.rec.completedAt < b.rec.completedAt ? -1 : 1));
  return { rows, bosses, cold, minutesDone, minutesLeft, first: minDate(dates), last: maxDate(dates) };
}

/** "Your builds" of some tracks: artifacts with at least one piece, or all of them when `all`. */
function measureBuilds(tracks) {
  const out = [];
  for (const t of tracks)
    for (const a of builds.activeArtifacts(t)) {
      const p = builds.progress(t, a);
      if (p.m === 0) continue;
      const pieces = Object.values(game.state.builds?.[a.id]?.pieces || {});
      out.push({ track: t, artifact: a, n: p.n, m: p.m, files: [...new Set(pieces.map(x => x.file))].sort(), coldPieces: pieces.filter(x => x.cold).length });
    }
  return out;
}

// ---------------------------------------------------------------- the page

function sheet(...kids) { return h('article.cert-sheet', kids); }

function statGrid(items) {
  return h('div.cert-stats', items.filter(Boolean).map(([value, label]) => h('div.cert-stat', h('b', value), h('span', label))));
}

function moduleTable(rows) {
  return h('table.cert-table',
    h('thead', h('tr', h('th', 'Module'), h('th', 'Lessons'), h('th', 'Stars'), h('th', 'Gate'), h('th', 'Completed'))),
    h('tbody', rows.map(r => h(`tr${r.complete ? '' : '.open'}`,
      h('td', h('div.cert-mod', r.module.title), h('div.cert-sub', `${r.track.title}${r.project ? ' · project' : ''}${r.mastered ? ' · mastered' : r.complete ? ' · complete' : ''}`)),
      h('td', `${r.done}/${r.total}`),
      h('td', h('span.cert-stars', { title: `${r.stars} of ${r.maxStars} stars` }, r.total ? starText(Math.round(r.stars / Math.max(1, r.done || 1)), 3) : ''), h('span.cert-sub', ` ${r.stars}/${r.maxStars}`)),
      h('td', !r.hasGate ? h('span.cert-sub', 'none') : r.provenAt ? [r.rusty ? 'proven, needs a re-proof' : 'proven', h('div.cert-sub', fmtDate(r.provenAt))] : h('span.cert-sub', 'not yet')),
      h('td', r.last ? fmtDate(r.last) : h('span.cert-sub', 'in progress'))))));
}

function leftList(rows) {
  const open = rows.filter(r => !r.complete);
  if (!open.length) return null;
  return h('section.cert-section.cert-left',
    h('h3', 'Still to do'),
    h('ul.cert-list', open.map(r => h('li',
      h('b', r.module.title), ` (${r.track.title}): ${r.total - r.done} lesson${r.total - r.done === 1 ? '' : 's'}, about ${hours(r.minutesLeft)}`,
      r.next && [' · next: ', h('a.no-print-link', { href: `#/lesson/${r.next.key}` }, r.next.title)]))));
}

function evidenceBlock(evidence, name) {
  const text = canonical(evidence);
  const hashEl = h('code.cert-hash', 'computing…');
  const file = `code-dojo-evidence-${name}.json`;
  sha256(text).then(hex => { hashEl.textContent = hex.match(/.{1,8}/g).join(' '); hashEl.dataset.full = hex; })
    .catch(() => { hashEl.textContent = 'unavailable (this browser has no Web Crypto here)'; });
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: file });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return h('section.cert-verify',
    h('div.cert-verify-head', h('span.eyebrow', 'Record hash · SHA-256'), hashEl),
    h('p.cert-sub', `The hash of the evidence behind this page: every lesson with its stars and date, gates, cold rebuilds, build pieces and labs, as canonical JSON. Download it and run sha256sum ${file} (or Get-FileHash in PowerShell) to get the same value; change one star and it no longer matches.`),
    h('button.btn.ghost.small.no-print', { type: 'button', onclick: download }, 'Download evidence (JSON)'));
}

function toolbar(back, backLabel) {
  const name = h('input.cert-name-input', { type: 'text', value: game.state.settings.certName || '', placeholder: 'Your name, as it should appear', 'aria-label': 'Name on the certificate', maxLength: 80 });
  name.addEventListener('input', () => {
    game.state.settings.certName = name.value.trim();
    game.save();
    for (const el of document.querySelectorAll('.cert-name')) el.textContent = name.value.trim() || 'Name not set';
  });
  return h('div.cert-toolbar.no-print',
    h('a.back-link', { href: back }, `← ${backLabel}`),
    h('div.spacer'),
    h('label.cert-name-label', h('span.muted.small', 'Name on the certificate'), name),
    h('button.btn.primary', { type: 'button', onclick: () => window.print() }, 'Print or save as PDF'));
}

function header({ complete, kind, title, subtitle, issued }) {
  return h('header.cert-head',
    h('div.cert-brand', h('span.cert-mark', '{ }'), h('span', 'code-dojo')),
    h('div.cert-kind', complete ? `Certificate of completion · ${kind}` : `Progress record · ${kind}`),
    h('h1.cert-title', title),
    h('p.cert-lede', complete ? 'This certifies that' : 'Progress of'),
    h('div.cert-name', game.state.settings.certName || 'Name not set'),
    h('p.cert-lede', subtitle),
    h('div.cert-issued', `${complete ? 'Completed' : 'As of'} ${fmtDate(issued)}`));
}

function bossSection(bosses) {
  if (!bosses.length) return null;
  return h('section.cert-section',
    h('h3', 'Boss fights'),
    h('div.cert-bosses', bosses.slice(0, 4).map(b => h('div.cert-boss',
      h('div.cert-boss-top', h('b', b.lesson.title), h('span.cert-stars', starText(b.rec.stars || 0))),
      h('div.cert-sub', `${b.module.title} · ${b.track.title} · ${fmtDate(b.rec.completedAt)}${b.rec.runs > 1 ? ` · ${b.rec.runs} runs` : ''}`),
      b.lesson.summary && h('p.cert-boss-text', b.lesson.summary)))),
    bosses.length > 4 && h('p.cert-sub', `and ${bosses.length - 4} more boss fight${bosses.length - 4 === 1 ? '' : 's'} won.`));
}

function buildSection(list) {
  if (!list.length) return null;
  return h('section.cert-section',
    h('h3', 'What was built'),
    h('ul.cert-list', list.map(b => h('li',
      h('b', b.artifact.title), ` (${b.track.title}): ${b.n} of ${b.m} pieces written and passing`,
      b.coldPieces > 0 && `, ${b.coldPieces} rebuilt from memory`,
      b.files.length > 0 && h('div.cert-files', b.files.slice(0, 12).join(' · ') + (b.files.length > 12 ? ` · +${b.files.length - 12} more` : ''))))));
}

function coldSection(cold) {
  if (!cold.length) return null;
  const sorted = [...cold].sort((a, b) => (a.at < b.at ? -1 : 1));
  return h('section.cert-section',
    h('h3', 'Proven from memory'),
    h('p.cert-sub', 'Cold rebuilds: written without the starter code, hints or the solution.'),
    h('ul.cert-list.cols', sorted.map(c => h('li', h('b', c.lesson?.title || c.key), h('span.cert-sub', ` · ${c.module.title} · ${fmtDate(c.at)}${c.inTime ? '' : ' · over time'}`)))));
}

function labSection(labs) {
  if (!labs.length) return null;
  return h('section.cert-section',
    h('h3', 'Labs'),
    h('ul.cert-list', labs.map(l => h('li', h('b', l.title), ` · ${l.text}`))));
}

const evidenceLessons = rows => rows.flatMap(r => r.module.lessons.map(l => {
  const key = game.lessonKey(r.track, r.module, l);
  const rec = game.state.lessons[key];
  return rec ? [key, rec.stars || 0, rec.completedAt || null] : null;
}).filter(Boolean)).sort((a, b) => (a[0] < b[0] ? -1 : 1));

// ---------------------------------------------------------------- topic

function topicPage(page, tracks, track, netlabs) {
  const entries = track.modules.map(module => ({ track, module }));
  const m = measureModules(entries);
  const lessonRows = m.rows.filter(r => !r.project), projectRows = m.rows.filter(r => r.project);
  const complete = lessonRows.length > 0 && lessonRows.every(r => r.complete);
  const mast = mastery(track);
  const builtList = measureBuilds([track]);
  const tl = TOPIC_LABS[track.id] || {};
  const labs = [
    ...(tl.labs || []).map(id => ({ id, title: LAB_INFO[id] || id, solved: labSolved(id) })).filter(l => l.solved > 0)
      .map(l => ({ ...l, text: `${l.solved} challenge${l.solved === 1 ? '' : 's'} solved`, complete: true })),
    ...(tl.netlabs ? netlabs.filter(n => tl.netlabs.test(n.id) && n.done > 0) : [])
      .map(n => ({ id: n.id, title: n.title, text: `${n.done} of ${n.total} live tasks`, complete: n.done >= n.total, done: n.done, total: n.total })),
  ];
  const lessonsDone = lessonRows.reduce((n, r) => n + r.done, 0), lessonsTotal = lessonRows.reduce((n, r) => n + r.total, 0);
  const stars = lessonRows.reduce((n, r) => n + r.stars, 0), maxStars = lessonRows.reduce((n, r) => n + r.maxStars, 0);
  const evidence = {
    format: 'code-dojo-evidence', version: 1, kind: 'topic', id: track.id, title: track.title, name: game.state.settings.certName || null,
    complete, lessons: evidenceLessons(m.rows),
    gates: m.rows.filter(r => r.provenAt).map(r => [r.key, r.provenAt, r.rusty]),
    cold: m.cold.map(c => [c.key, c.at || null, !!c.inTime]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    builds: builtList.map(b => [b.artifact.id, b.n, b.m]),
    labs: labs.map(l => [l.id, l.solved ?? l.done, l.total ?? null]),
  };
  page('profile',
    toolbar('#/profile', 'Profile'),
    sheet(
      header({ complete, kind: 'Topic', title: track.title,
        subtitle: complete
          ? `completed every lesson of ${track.title} in code-dojo${mast.level ? `, at ${mast.level} level` : ''}: graded exercises run against real tests, module gates and cold rebuilds proven from memory.`
          : `${lessonsDone} of ${lessonsTotal} lessons of ${track.title} finished so far.`,
        issued: complete ? m.last : game.dayKey() }),
      statGrid([
        [`${lessonRows.filter(r => r.complete).length}/${lessonRows.length}`, 'modules complete'],
        [`${lessonRows.filter(r => r.mastered).length}`, 'mastered (2+ stars, gate proven)'],
        [`${stars}/${maxStars}`, 'stars'],
        [`${m.cold.length}`, 'cold rebuilds'],
        [`${projectRows.filter(r => r.complete).length}/${projectRows.length}`, 'projects shipped'],
        [hours(m.minutesDone), 'study time (lesson estimates)'],
        [m.first ? span(m.first, m.last) : "–", "first and last lesson"],
        [`${mast.score}`, `mastery score · ${mast.level}`],
      ]),
      h('section.cert-section', h('h3', 'Modules'), moduleTable(lessonRows)),
      projectRows.length > 0 && h('section.cert-section', h('h3', 'Projects'), moduleTable(projectRows)),
      buildSection(builtList),
      coldSection(m.cold),
      labSection(labs),
      bossSection(m.bosses),
      !complete && leftList(lessonRows),
      evidenceBlock(evidence, `topic-${track.id}`)));
}

// ---------------------------------------------------------------- path

function pathPage(page, tracks, path, netlabs) {
  const prog = pathProgress(path, tracks, netlabs);
  const moduleItems = prog.stages.flatMap(st => st.items.filter(x => x.kind === 'module' || x.kind === 'project'));
  const seen = new Set();
  const entries = moduleItems.filter(x => !seen.has(x.key) && seen.add(x.key)).map(x => ({ track: x.track, module: x.module }));
  const m = measureModules(entries);
  const touched = [...new Set(entries.map(e => e.track))];
  const builtList = measureBuilds(touched).filter(b => b.n > 0);
  const labItems = prog.stages.flatMap(st => st.items.filter(x => x.kind === 'lab' || x.kind === 'netlab'));
  const labs = labItems.filter(x => x.started).map(x => ({ id: x.key, title: x.title, done: x.done, total: x.total, complete: x.complete,
    text: `${x.done} of ${x.total} ${x.kind === 'lab' ? 'challenges' : 'live tasks'}${x.complete ? ', passed' : ''}` }));
  const labMinutes = labItems.reduce((n, x) => n + (x.minutes - x.minutesLeft), 0);
  const evidence = {
    format: 'code-dojo-evidence', version: 1, kind: 'path', id: path.id, title: path.title, name: game.state.settings.certName || null,
    complete: prog.complete,
    stages: prog.stages.map(st => [st.id, st.done, st.total, st.complete]),
    lessons: evidenceLessons(m.rows),
    gates: m.rows.filter(r => r.provenAt).map(r => [r.key, r.provenAt, r.rusty]),
    cold: m.cold.map(c => [c.key, c.at || null, !!c.inTime]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    builds: builtList.map(b => [b.artifact.id, b.n, b.m]),
    labs: labItems.map(x => [x.key, x.done, x.total]),
  };
  const stageBlock = h('section.cert-section',
    h('h3', 'Stages and milestones'),
    h('ol.cert-stages', prog.stages.map(st => h(`li${st.complete ? '.done' : ''}`,
      h('div.cert-stage-top', h('b', st.title), h('span.cert-sub', st.complete ? 'complete' : `${Math.round(st.frac * 100)}%`)),
      st.milestone && h('div.cert-sub', `${st.complete ? 'Milestone reached' : 'Milestone'}: ${st.milestone}`)))));
  const leftStages = prog.stages.filter(st => !st.complete);
  page('paths',
    toolbar(`#/paths/${path.id}`, path.title),
    sheet(
      header({ complete: prog.complete, kind: 'Learning path', title: path.title,
        subtitle: prog.complete
          ? `completed the ${path.title} path in code-dojo: ${prog.stages.length} stages across ${touched.length} topics. ${path.outcome || ''}`
          : `${prog.stagesDone} of ${prog.stages.length} stages of the ${path.title} path, ${Math.round(prog.frac * 100)}% overall.`,
        issued: prog.complete ? maxDate([m.last]) : game.dayKey() }),
      statGrid([
        [`${prog.stagesDone}/${prog.stages.length}`, 'stages complete'],
        [`${prog.stages.filter(st => st.complete && st.milestone).length}`, 'milestones reached'],
        [`${m.rows.filter(r => r.complete).length}/${m.rows.length}`, 'modules and projects'],
        [`${m.rows.filter(r => r.mastered).length}`, 'mastered'],
        [`${m.cold.length}`, 'cold rebuilds'],
        [`${labs.filter(l => l.complete).length}/${labItems.length}`, 'labs passed'],
        [hours(m.minutesDone + labMinutes), 'study time (estimates)'],
        [m.first ? span(m.first, m.last) : "–", "first and last lesson"],
      ]),
      stageBlock,
      h('section.cert-section', h('h3', 'Modules'), moduleTable(m.rows)),
      buildSection(builtList),
      coldSection(m.cold),
      labSection(labs),
      bossSection(m.bosses),
      leftStages.length > 0 && h('section.cert-section.cert-left',
        h('h3', 'Still to do'),
        h('ul.cert-list', leftStages.map(st => h('li', h('b', `${st.index + 1}. ${st.title}`), `: about ${hours(st.minutesLeft)}`,
          h('div.cert-sub', st.items.filter(x => !x.complete).map(x => `${x.title} (${x.done}/${x.total})`).join(' · ')))))),
      evidenceBlock(evidence, `path-${path.id}`)));
}

export async function certificateView(page, tracks, kind, id) {
  page('profile', h('div.muted', 'Preparing the record…'));
  const { paths, netlabs } = await loadPaths();
  if (!location.hash.startsWith('#/certificate')) return;
  if (kind === 'topic') {
    const track = tracks.find(t => t.id === id);
    if (track) return topicPage(page, tracks, track, netlabs);
  }
  if (kind === 'path') {
    const path = paths.find(p => p.id === id);
    if (path) return pathPage(page, tracks, path, netlabs);
  }
  page('profile', h('div.empty', h('h2', 'Nothing to certify here'), h('a.btn.primary', { href: '#/profile' }, 'Back to your profile')));
}

/** Profile: every topic you started and every path, with a link to its certificate or progress record. */
export function certificatesPanel(tracks) {
  const started = tracks.filter(t => game.flatLessons(t).some(x => game.isDone(x.key)))
    .map(t => ({ t, p: game.trackProgress(t) }))
    .sort((a, b) => b.p.done / Math.max(1, b.p.total) - a.p.done / Math.max(1, a.p.total));
  const pathsHost = h('div.cert-links');
  loadPaths().then(({ paths, netlabs }) => {
    pathsHost.replaceChildren(...paths.map(p => {
      const prog = pathProgress(p, tracks, netlabs);
      if (prog.done === 0) return null;
      return h('a.cert-link', { href: `#/certificate/path/${p.id}` },
        h('span.cert-link-kind', prog.complete ? 'Certificate' : 'Record'), h('span', p.title), h('span.muted.small', `${Math.round(prog.frac * 100)}%`));
    }).filter(Boolean));
  });
  return h('section.panel',
    h('h2', 'Certificates and progress records'),
    h('p.muted', 'A printable page per topic and per learning path: what you built, modules and stars, cold rebuilds, labs and boss fights, with a hash of the evidence. Finished ones are certificates; the rest show what is left.'),
    started.length
      ? h('div.cert-links', started.map(({ t, p }) => h('a.cert-link', { href: `#/certificate/topic/${t.id}` },
        h('span.cert-link-kind', p.done === p.total ? 'Certificate' : 'Record'), h('span', t.title), h('span.muted.small', `${p.done}/${p.total} lessons`))))
      : h('p.muted.small', 'Finish a lesson and its topic shows up here.'),
    pathsHost);
}

