// Learning paths: role routes across topics (content/paths/*.json, served by /api/paths, checked by `dojo validate`).
//
//   #/paths          every path, with its route and how far you are
//   #/paths/<id>     the progress map: stations (stages) on a line, milestones between them, every module, lab and
//                    live lab of each stage with its progress, "next up" and the hours left (from lesson minutes)
//   homePanel()      the active path on the home page
//
//   state.learningPath = { active: pathId, chosen: { pathId: date } }   (merged newest-wins between machines)
import { h, api } from './util.js';
import * as game from './game.js';

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

/** Visual labs that keep solved challenges in state.labs (same list as Paths.Labs on the server). */
export const LAB_INFO = {
  pki: 'Certificate chain lab', subnet: 'Subnetting trainer', netbuild: 'Network builder', archbuild: 'Architecture builder',
  composebuild: 'Compose builder', kubebuild: 'Kubernetes builder', pipebuild: 'Pipeline builder',
  'msgbuild-rabbit': 'Messaging builder: RabbitMQ', 'msgbuild-kafka': 'Messaging builder: Kafka', vim: 'Vim & nano trainer', regex: 'Regex lab',
};
const LAB_MINUTES_PER_CHALLENGE = 8;
const DEFAULT_LESSON_MINUTES = 10;

/** Challenges solved in a visual lab: solved {id: date}, a solved count (subnet), or stars per challenge (regex). */
export function labSolved(id) {
  const l = game.state.labs?.[id];
  if (!l) return 0;
  if (typeof l.solved === 'number') return l.solved;
  if (l.solved && typeof l.solved === 'object' && Object.keys(l.solved).length) return Object.keys(l.solved).length;
  if (l.stars && typeof l.stars === 'object') return Object.values(l.stars).filter(n => n > 0).length;
  return 0;
}

let data = null;
/** /api/paths, read fresh each time a paths page opens (live-lab task counts change). */
export async function loadPaths() {
  data = await api('paths').catch(() => ({ paths: [], netlabs: [] }));
  return data;
}
export const cachedPaths = () => data;

const findModule = (tracks, key) => {
  const [t, m] = key.split('/');
  const track = tracks.find(x => x.id === t);
  const module = track?.modules.find(x => x.id === m);
  return module ? { track, module } : null;
};
const lessonMinutes = l => Number(l.minutes) || DEFAULT_LESSON_MINUTES;

/**
 * One item of a stage, measured: { kind, title, sub, done, total, complete, started, minutesLeft, minutes, href, key }.
 * Units are lessons for a module, challenges for a lab, tasks for a live lab.
 */
export function itemInfo(item, tracks, netlabs = []) {
  if (typeof item === 'string') {
    const found = findModule(tracks, item);
    if (!found) return { kind: 'missing', title: item, sub: 'not found', done: 0, total: 0, complete: false, started: false, minutesLeft: 0, minutes: 0, href: '#/' };
    const { track, module } = found;
    const lessons = module.lessons.map((l, i) => ({ l, i, key: game.lessonKey(track, module, l) }));
    const left = lessons.filter(x => !game.isDone(x.key));
    const next = left.find(x => game.isUnlocked(track, module, x.i)) || left[0];
    const done = lessons.length - left.length;
    return {
      kind: game.isProject(module) ? 'project' : 'module', key: item, track, module,
      title: module.title, sub: track.title, done, total: lessons.length,
      complete: lessons.length > 0 && left.length === 0, started: done > 0,
      minutesLeft: left.reduce((n, x) => n + lessonMinutes(x.l), 0), minutes: lessons.reduce((n, x) => n + lessonMinutes(x.l), 0),
      href: next ? `#/lesson/${next.key}` : `#/track/${track.id}`, next,
    };
  }
  if (item?.lab) {
    const goal = Math.max(1, Number(item.goal) || 3);
    const solved = labSolved(item.lab);
    const done = Math.min(goal, solved);
    return {
      kind: 'lab', key: `lab:${item.lab}`, title: LAB_INFO[item.lab] || item.lab, sub: `Lab · solve ${goal} challenge${goal === 1 ? '' : 's'}`,
      done, total: goal, complete: solved >= goal, started: solved > 0, solved,
      minutesLeft: (goal - done) * LAB_MINUTES_PER_CHALLENGE, minutes: goal * LAB_MINUTES_PER_CHALLENGE,
      href: `#/labs/${item.lab.replace(/-(rabbit|kafka)$/, '')}`,
    };
  }
  if (item?.netlab) {
    const nl = netlabs.find(x => x.id === item.netlab);
    const total = nl?.total || 0, done = nl?.done || 0, minutes = nl?.minutes || 20;
    return {
      kind: 'netlab', key: `netlab:${item.netlab}`, title: nl?.title || item.netlab, sub: nl?.kind === 'linux' ? 'Linux mission · live' : 'Live network lab',
      done, total, complete: total > 0 && done >= total, started: done > 0,
      minutesLeft: total ? Math.round(minutes * (1 - done / total)) : minutes, minutes,
      href: `#/labs/${nl?.kind === 'linux' ? 'linux' : 'net'}/${item.netlab}`,
    };
  }
  return { kind: 'missing', title: JSON.stringify(item), sub: '', done: 0, total: 0, complete: false, started: false, minutesLeft: 0, minutes: 0, href: '#/' };
}

/** A whole path, measured: stages with status (done / active / open / locked), totals, the next item and hours left. */
export function pathProgress(path, tracks, netlabs = []) {
  let prevComplete = true;
  let current = null;
  const stages = (path.stages || []).map((st, i) => {
    const items = (st.items || []).map(it => itemInfo(it, tracks, netlabs));
    const done = items.reduce((n, x) => n + x.done, 0), total = items.reduce((n, x) => n + x.total, 0);
    const complete = items.length > 0 && items.every(x => x.complete);
    const started = items.some(x => x.started);
    const status = complete ? 'done' : started ? 'active' : prevComplete ? 'open' : 'locked';
    const stage = { ...st, index: i, items, done, total, complete, started, status, frac: total ? done / total : 0,
      minutesLeft: items.reduce((n, x) => n + x.minutesLeft, 0), minutes: items.reduce((n, x) => n + x.minutes, 0) };
    if (!complete && !current) current = stage;
    prevComplete = complete;
    return stage;
  });
  const done = stages.reduce((n, x) => n + x.done, 0), total = stages.reduce((n, x) => n + x.total, 0);
  const nextItem = current?.items.find(x => !x.complete && x.kind !== 'missing') || null;
  const modules = new Set(stages.flatMap(st => st.items.filter(x => x.kind === 'module' || x.kind === 'project').map(x => x.key)));
  return {
    stages, done, total, frac: total ? done / total : 0, current, nextItem,
    complete: stages.length > 0 && stages.every(x => x.complete),
    minutesLeft: stages.reduce((n, x) => n + x.minutesLeft, 0), minutes: stages.reduce((n, x) => n + x.minutes, 0),
    moduleCount: modules.size, stagesDone: stages.filter(x => x.complete).length,
  };
}

/** "Git · Foundations" for a module (titles like "Foundations" repeat across topics), the title otherwise. */
export const nextLabel = x => (x.kind === 'module' || x.kind === 'project' ? `${x.track.title} · ${x.title}` : x.title);

export const hours = min => (min <= 0 ? '0 h' : min < 60 ? `${Math.max(5, Math.round(min / 5) * 5)} min` : `${Math.round(min / 60)} h`);

export const activePathId = () => game.state.learningPath?.active || null;
export function setActive(id) {
  const lp = (game.state.learningPath = { ...(game.state.learningPath || {}) });
  lp.active = id;
  lp.chosen = { ...(lp.chosen || {}) };
  if (id) lp.chosen[id] ||= game.dayKey();
  game.save(true);
}

// ---------------------------------------------------------------- the route, drawn

/**
 * The route as a transit line: one station per stage, the line between stations filled as far as you are, milestones
 * as small diamonds after the stations that have one. `compact` draws it short for cards and the home page.
 */
export function routeStrip(prog, { compact = false, height } = {}) {
  const n = prog.stages.length;
  const gap = compact ? 64 : 120, pad = compact ? 16 : 62, H = height || (compact ? 34 : 78), y = compact ? 17 : 26;
  const W = pad * 2 + gap * Math.max(1, n - 1);
  const svg = s('svg', { class: `pm-strip${compact ? ' compact' : ''}`, viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Route: ${prog.stagesDone} of ${n} stages done` });
  const x = i => pad + gap * i;
  svg.append(s('line', { x1: x(0), y1: y, x2: x(n - 1), y2: y, class: 'pm-track' }));
  // Filled line: through the leading run of done stations, then toward the next one as far as that stage is done.
  const cur = prog.current;
  let k = 0;
  while (k < n && prog.stages[k].complete) k++;
  const fillTo = k >= n ? x(n - 1) : k === 0 ? x(0) : x(k - 1) + gap * prog.stages[k].frac;
  if (fillTo > x(0)) svg.append(s('line', { x1: x(0), y1: y, x2: fillTo, y2: y, class: 'pm-fill' }));
  prog.stages.forEach((st, i) => {
    const r = compact ? 6 : 10;
    const g = s('g', { class: `pm-node ${st.status}${cur && cur.index === i ? ' current' : ''}` });
    g.append(s('title', {}, `${i + 1}. ${st.title} · ${Math.round(st.frac * 100)}%`));
    g.append(s('circle', { cx: x(i), cy: y, r, class: 'pm-dot' }));
    if (st.status === 'active' && st.frac > 0) {
      // Progress arc around the station.
      const a = Math.min(0.999, st.frac) * 2 * Math.PI, R = r + (compact ? 3 : 4);
      const x1 = x(i), y1 = y - R, x2 = x(i) + R * Math.sin(a), y2 = y - R * Math.cos(a);
      g.append(s('path', { d: `M ${x1} ${y1} A ${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`, class: 'pm-arc' }));
    }
    if (st.complete && !compact) g.append(s('path', { d: `M ${x(i) - 4} ${y} l 3 3 l 5 -6`, class: 'pm-check' }));
    if (!compact) {
      g.append(s('text', { x: x(i), y: y + 28, class: 'pm-num' }, `${i + 1}`));
      const label = st.title.length > 18 ? st.title.slice(0, 17) + '…' : st.title;
      g.append(s('text', { x: x(i), y: y + 44, class: 'pm-label' }, label));
    }
    svg.append(g);
    if (st.milestone && i < n - 1 && !compact) {
      const mx = x(i) + gap / 2;
      const reached = st.complete;
      const m = s('g', { class: `pm-ms${reached ? ' reached' : ''}` }, s('title', {}, `Milestone: ${st.milestone}`));
      m.append(s('rect', { x: mx - 4, y: y - 4, width: 8, height: 8, transform: `rotate(45 ${mx} ${y})` }));
      svg.append(m);
    }
  });
  return svg;
}

// ---------------------------------------------------------------- pages

const KIND_LABEL = { module: 'Module', project: 'Project', lab: 'Lab', netlab: 'Live lab', missing: 'Missing' };

function bar(frac) {
  return h('div.bar', h('div.bar-fill', { style: { width: `${Math.round(frac * 100)}%` } }));
}

function pathCard(path, prog) {
  const active = activePathId() === path.id;
  return h(`a.pm-card${active ? '.active' : ''}`, { href: `#/paths/${path.id}` },
    h('div.pm-card-head',
      h('div.pm-mono', path.icon || path.title.slice(0, 2).toUpperCase()),
      h('div.grow',
        h('div.eyebrow', active ? 'Your active path' : 'Learning path'),
        h('h3', path.title))),
    h('p.muted.small', path.summary),
    routeStrip(prog, { compact: true }),
    h('div.topic-meta',
      h('span', `${prog.stages.length} stages`), h('span', `${prog.moduleCount} modules`),
      h('span', prog.complete ? 'complete' : `${Math.round(prog.frac * 100)}% · about ${hours(prog.minutesLeft)} left`)),
    bar(prog.frac));
}

export async function pathsView(page, tracks, id) {
  page('paths', h('div.pm-loading.muted', 'Loading learning paths…'));
  const { paths, netlabs } = await loadPaths();
  if (!location.hash.startsWith('#/paths')) return;
  if (id) {
    const path = paths.find(p => p.id === id);
    if (!path) return page('paths', h('div.empty', h('h2', 'No such path'), h('a.btn.primary', { href: '#/paths' }, 'All learning paths')));
    return detail(page, tracks, path, netlabs);
  }
  const measured = paths.map(p => ({ path: p, prog: pathProgress(p, tracks, netlabs) }));
  page('paths',
    h('section.hero', h('div',
      h('div.eyebrow', 'Learning paths'),
      h('h1', 'Routes to a role'),
      h('p.muted', 'Each path strings modules, projects and labs from several topics into the order a team would want you to learn them, with a reason for every stage and milestones you can name in an interview. Pick one to follow; the home page then shows where you are.'))),
    measured.length
      ? h('div.pm-grid', measured.map(({ path, prog }) => pathCard(path, prog)))
      : h('div.empty', h('p.muted', 'No paths found. Add one under content/paths/.')));
}

function itemRow(x) {
  const pct = x.total ? x.done / x.total : 0;
  const state = x.complete ? 'done' : x.started ? 'active' : 'todo';
  const unit = x.kind === 'lab' ? 'challenges' : x.kind === 'netlab' ? 'tasks' : x.kind === 'project' ? 'stages' : 'lessons';
  return h(`a.pm-item.${state}${x.kind === 'missing' ? '.missing' : ''}`, { href: x.href },
    h('span.pm-item-mark', { 'aria-hidden': 'true' }, x.complete ? '✓' : ''),
    h('span.pm-item-kind', KIND_LABEL[x.kind]),
    h('span.pm-item-text', h('span.pm-item-title', x.title), h('span.pm-item-sub', x.sub)),
    h('span.pm-item-bar', bar(pct)),
    h('span.pm-item-count', x.total ? `${x.done}/${x.total} ${unit}` : x.kind === 'netlab' ? 'needs Docker' : ''),
    h('span.pm-item-time', x.complete ? 'done' : `${hours(x.minutesLeft)} left`));
}

function detail(page, tracks, path, netlabs) {
  const prog = pathProgress(path, tracks, netlabs);
  const active = activePathId() === path.id;
  const next = prog.nextItem;
  const stageEls = prog.stages.map(st => {
    const isCurrent = prog.current?.index === st.index;
    return [
      h(`section.pm-stage.${st.status}${isCurrent ? '.current' : ''}`, { id: `stage-${st.id}` },
        h('div.pm-rail', h('span.pm-station', { 'aria-hidden': 'true' }, st.complete ? '✓' : st.index + 1)),
        h('div.pm-body',
          h('div.pm-stage-head',
            h('div.grow',
              h('div.eyebrow', `Stage ${st.index + 1} · ${({ done: 'done', active: 'in progress', open: 'open', locked: 'after the stages before it' })[st.status]}`),
              h('h3', st.title)),
            h('div.pm-stage-num', h('b', `${Math.round(st.frac * 100)}%`), h('span.muted.small', st.complete ? 'complete' : `${hours(st.minutesLeft)} left`))),
          h('p.pm-why', st.why),
          h('div.pm-items', st.items.map(itemRow)))),
      st.milestone && h(`div.pm-milestone${st.complete ? '.reached' : ''}`,
        h('div.pm-rail', h('span.pm-diamond', { 'aria-hidden': 'true' })),
        h('div.pm-body', h('span.eyebrow', st.complete ? 'Milestone reached' : 'Milestone'), h('span.pm-ms-text', st.milestone))),
    ];
  });
  page('paths',
    h('a.back-link', { href: '#/paths' }, '← All learning paths'),
    h('section.pm-hero',
      h('div.pm-hero-text',
        h('div.eyebrow', `Learning path · ${path.role || 'Role'}`),
        h('h1', path.title),
        h('p.muted', path.summary),
        path.outcome && h('p.pm-outcome', h('b', 'At the end: '), path.outcome)),
      h('div.pm-hero-side',
        h('div.pm-big', `${Math.round(prog.frac * 100)}%`),
        h('div.muted.small', prog.complete ? 'Path complete' : `${prog.stagesDone} of ${prog.stages.length} stages · about ${hours(prog.minutesLeft)} left`),
        h('div.muted.small', `${prog.moduleCount} modules · about ${hours(prog.minutes)} in all`),
        h('div.pm-actions',
          next && h('a.btn.primary', { href: next.href }, `Next up: ${nextLabel(next)}`),
          active ? h('span.pm-badge', 'Your active path')
            : h('button.btn.ghost', { type: 'button', onclick: () => { setActive(path.id); detail(page, tracks, path, netlabs); } }, 'Make this my path'),
          h('a.btn.ghost', { href: `#/certificate/path/${path.id}` }, prog.complete ? 'Certificate' : 'Progress record')))),
    h('section.panel.pm-map-panel',
      h('div.pm-map-head', h('h2', 'Route'), h('span.muted.small', 'Stations are stages; diamonds are milestones. Stages open in order, and you can always look ahead.')),
      h('div.pm-strip-wrap', routeStrip(prog))),
    h('div.pm-stages', stageEls),
    active && h('p.muted.small.pm-foot', h('button.btn.ghost.small', { type: 'button', onclick: () => { setActive(null); detail(page, tracks, path, netlabs); } }, 'Stop following this path')));
  if (prog.current) setTimeout(() => document.getElementById(`stage-${prog.current.id}`)?.classList.add('pm-focus'), 0);
}

/** The active path on the home page: where you are, next up, hours left. Fills in once /api/paths answers. */
export function homePanel(tracks) {
  const host = h('section.panel.pm-home', h('div.muted.small', 'Loading your learning path…'));
  loadPaths().then(({ paths, netlabs }) => {
    const id = activePathId();
    const path = paths.find(p => p.id === id);
    if (!path) {
      if (!paths.length) { host.remove(); return; }
      host.replaceChildren(
        h('div.pm-home-row',
          h('div.grow',
            h('div.eyebrow', 'Learning paths'),
            h('h3', 'Follow a route to a role'),
            h('p.muted.small', paths.map(p => p.title).join(' · '))),
          h('a.btn.ghost', { href: '#/paths' }, 'Choose a path')));
      return;
    }
    const prog = pathProgress(path, tracks, netlabs);
    const next = prog.nextItem;
    host.replaceChildren(
      h('div.pm-home-row',
        h('div.grow',
          h('div.eyebrow', 'Your learning path'),
          h('h3', h('a', { href: `#/paths/${path.id}` }, path.title)),
          h('p.muted.small', prog.complete ? 'Every stage done. Your certificate is ready.'
            : `Stage ${prog.current.index + 1} of ${prog.stages.length}: ${prog.current.title} · ${Math.round(prog.frac * 100)}% of the path · about ${hours(prog.minutesLeft)} left`)),
        prog.complete
          ? h('a.btn.primary', { href: `#/certificate/path/${path.id}` }, 'View certificate')
          : next && h('a.btn.primary', { href: next.href }, `Next up: ${nextLabel(next)}`)),
      h('a.pm-home-strip', { href: `#/paths/${path.id}`, 'aria-label': 'Open the route' }, routeStrip(prog, { compact: true })));
  });
  return host;
}
