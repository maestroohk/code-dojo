// Pacing: stop the rush, make it stick (docs/CURRICULUM.md 1.2, tracks/AUTHORING.md "Pacing: prove it, keep it").
// Pure functions over the progress state, so they can be tested without a browser (no imports on purpose).
//
//   module.json "gate": { "requires": ["boss" | lesson id | "track/module/lesson"], "minStars": 2,
//                         "cold": [lesson id | "lesson id#N"] }        also accepted: "boss": { "minStars": 2 }
//   state.pacing = {
//     modules: { "track/module": { provenAt, rusty, rustyAt } }    a gate passed (and whether a re-proof failed since)
//     cold:    { "track/module/lesson#idx": { at, ms, inTime } }  cold steps passed
//   }
//   state.review entries with kind: 'reproof' are cold steps that come back "Can you still do it?" (game.js).

export const RUSH_RATIO = 0.35;              // under 35% of a lesson's minutes ...
export const REPROOF_DAYS = [3, 10];         // a proven module's cold step comes back after 3 and 10 days

const lessonModules = track => (track?.modules || []).filter(m => m.kind !== 'project');
const keyOf = (track, module, lesson) => `${track.id}/${module.id}/${lesson.id}`;
const fullKey = (track, module, id) => (id.includes('/') ? id : `${track.id}/${module.id}/${id}`);

/** A module's gate in one shape: { requires: [...], minStars, cold: [...] }, or null when it has none. */
export function gateOf(module, strictness = 'standard') {
  const g = module?.gate;
  if (!g || typeof g !== 'object') return null;
  const requires = Array.isArray(g.requires) ? [...g.requires] : [];
  if (g.boss && !requires.includes('boss')) requires.push('boss');
  let minStars = Number(g.minStars ?? g.boss?.minStars ?? 1) || 1;
  if (strictness === 'relaxed') minStars = Math.min(minStars, 1);   // hobby learners: pass the boss, still prove the cold check
  return { requires, minStars: Math.max(1, Math.min(3, minStars)), cold: Array.isArray(g.cold) ? g.cold : [] };
}

/** Find a lesson anywhere in the given tracks by full key. */
function findLesson(tracks, key) {
  const [t, m, l] = key.split('/');
  const track = tracks.find(x => x.id === t);
  const module = track?.modules?.find(x => x.id === m);
  const lesson = module?.lessons?.find(x => x.id === l);
  return lesson ? { track, module, lesson } : null;
}

/**
 * What a module's gate asks for and how far the learner is:
 *   { gate, proven, needs: [{ kind: 'stars' | 'cold', key, title, href, done, have, want }] }
 * `tracks` lets a gate name lessons in other tracks; defaults to just this one.
 */
export function gateStatus(track, module, state, { tracks = [track], strictness } = {}) {
  const gate = gateOf(module, strictness ?? state?.profile?.pacing?.gateStrictness);
  if (!gate) return { gate: null, proven: true, needs: [] };
  const lessons = state?.lessons || {};
  const cold = state?.pacing?.cold || {};
  const needs = [];
  for (const r of gate.requires) {
    const targets = r === 'boss'
      ? (module.lessons || []).filter(l => l.kind === 'boss').map(l => keyOf(track, module, l))
      : [fullKey(track, module, r)];
    for (const key of targets) {
      const found = findLesson(tracks, key);
      const have = lessons[key]?.stars || 0;
      needs.push({ kind: 'stars', key, title: found?.lesson.title || key, href: `#/lesson/${key}`, boss: found?.lesson.kind === 'boss',
        have, want: gate.minStars, done: !!lessons[key] && have >= gate.minStars });
    }
  }
  for (const c of gate.cold) {
    const [id, n] = String(c).split('#');
    const key = fullKey(track, module, id);
    const found = findLesson(tracks, key);
    const steps = n ? [Number(n) - 1] : Array.isArray(found?.lesson.cold) && found.lesson.cold.length ? found.lesson.cold : null;
    // No cold step on the map (yet): finishing the lesson counts.
    const done = steps ? steps.every(i => !!cold[`${key}#${i}`]) : !!lessons[key];
    needs.push({ kind: 'cold', key, idx: steps?.[0], title: found?.lesson.title || key, href: `#/lesson/${key}`, done });
  }
  return { gate, proven: needs.every(x => x.done), needs };
}

/** The first earlier module (in map order) whose gate is not yet proven, or null: that gate locks this module. */
export function gateBlocker(track, module, state, opts) {
  const list = lessonModules(track);
  const at = list.findIndex(m => m.id === module.id);
  if (at <= 0) return null;
  for (const m of list.slice(0, at)) {
    if (m.gate && !gateStatus(track, m, state, opts).proven) return m;
  }
  return null;
}

/** The module right after `module` on the map (what its gate unlocks), or null. */
export function nextModule(track, module) {
  const list = lessonModules(track);
  const at = list.findIndex(m => m.id === module.id);
  return at >= 0 ? list[at + 1] || null : null;
}

/** The cold steps a module can re-ask: the gate's cold lessons first, then any lesson in it marked cold. [{ key, idx }] */
export function coldStepsOf(track, module) {
  const out = [];
  const add = (key, idx) => { if (idx != null && !out.some(x => x.key === key && x.idx === idx)) out.push({ key, idx }); };
  const gate = gateOf(module);
  for (const c of gate?.cold || []) {
    const [id, n] = String(c).split('#');
    const key = fullKey(track, module, id);
    const lesson = (module.lessons || []).find(l => keyOf(track, module, l) === key);
    if (n) add(key, Number(n) - 1); else for (const i of lesson?.cold || []) add(key, i);
  }
  for (const l of module.lessons || []) for (const i of l.cold || []) add(keyOf(track, module, l), i);
  return out;
}

export const isRusty = (state, track, module) => !!state?.pacing?.modules?.[`${track.id}/${module.id}`]?.rusty;
export const isProven = (state, track, module) => !!state?.pacing?.modules?.[`${track.id}/${module.id}`]?.provenAt;

function ensure(state) {
  state.pacing ||= {};
  state.pacing.modules ||= {};
  state.pacing.cold ||= {};
  state.review ||= [];
  return state.pacing;
}

/** Queue a cold step for Practice on `due` (no duplicates for the same day). */
export function queueReproof(state, { key, idx }, moduleKey, due) {
  ensure(state);
  if (state.review.some(r => r.kind === 'reproof' && r.key === key && r.idx === idx && r.due === due)) return false;
  state.review.push({ key, idx, box: 0, due, kind: 'reproof', module: moduleKey });
  return true;
}

/**
 * Notices gates that are newly proven: stamps provenAt and schedules the module's first cold step to come back
 * after 3 and 10 days. `dayAfter(n)` gives the day key n days from today. Returns the modules proven just now.
 */
export function syncGates(track, state, today, dayAfter, opts) {
  const p = ensure(state);
  const fresh = [];
  for (const m of lessonModules(track)) {
    if (!m.gate) continue;
    const mk = `${track.id}/${m.id}`;
    const rec = p.modules[mk] || {};
    if (rec.provenAt || !gateStatus(track, m, state, opts).proven) continue;
    p.modules[mk] = { ...rec, provenAt: today, rusty: false };
    const step = coldStepsOf(track, m)[0];
    if (step) for (const n of REPROOF_DAYS) queueReproof(state, step, mk, dayAfter(n));
    fresh.push(m);
  }
  return fresh;
}

/** A cold step passed (in a lesson or in Practice): remember it, so gates and re-proofs can see it. */
export function recordCold(state, key, idx, { at, ms, inTime = true } = {}) {
  const p = ensure(state);
  const prev = p.cold[`${key}#${idx}`];
  p.cold[`${key}#${idx}`] = { at, ms, inTime: inTime || !!prev?.inTime };
  // Rebuilding any cold step of a rusty module from memory makes it solid again.
  const rec = p.modules[key.split('/').slice(0, 2).join('/')];
  if (rec?.rusty) rec.rusty = false;
}

/**
 * A re-proof answered in Practice. Passed: its due entries go, the module is no longer rusty. Failed: the module is
 * rusty (amber on the map) and the step comes back tomorrow. Returns true when the entry was a re-proof.
 */
export function reproofResult(state, key, idx, passed, today, tomorrow) {
  const p = ensure(state);
  const due = state.review.filter(r => r.kind === 'reproof' && r.key === key && r.idx === idx && r.due <= today);
  if (!due.length) return false;
  const mk = due[0].module || key.split('/').slice(0, 2).join('/');
  const rec = p.modules[mk] ||= {};
  state.review = state.review.filter(r => !due.includes(r));
  if (passed) {
    rec.rusty = false;
    recordCold(state, key, idx, { at: today });
  } else {
    if (rec.provenAt) { rec.rusty = true; rec.rustyAt = today; }
    queueReproof(state, { key, idx }, mk, tomorrow);
  }
  return true;
}

/**
 * The rush detector: finished in well under the lesson's minutes while leaning on hints and answer reveals.
 * Never blocks anything; it only changes the summary and the quest credit.
 */
export function isRushed({ ms, minutes, hints = 0, reveals = 0, exercises = 0 }) {
  if (!minutes || !(ms >= 0)) return false;
  const assists = hints + reveals;
  return ms < RUSH_RATIO * minutes * 60_000 && assists >= Math.max(2, Math.ceil(exercises / 4));
}

/** Stars for a cold step: going over its timeLimit counts like a mistake (never a failure). */
export const overTime = (ms, timeLimit) => !!timeLimit && ms > timeLimit * 1000;

/** "1:05" from milliseconds. */
export const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Reorders a path: moves `id` by `delta` places (or to index `to`). Returns a new array. */
export function movePath(path, id, delta, to) {
  const list = [...path];
  const from = list.indexOf(id);
  if (from < 0) return list;
  const target = Math.max(0, Math.min(list.length - 1, to ?? from + delta));
  list.splice(from, 1);
  list.splice(target, 0, id);
  return list;
}
