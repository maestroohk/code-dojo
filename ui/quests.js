// Daily quests and the daily challenge. Pure rules on game.state (no DOM).
//
// Quests: every day three quests are drawn from POOL (one easy, one medium, one hard), seeded by
// the date, so the day's quests stay the same however often you reload. Progress comes from the
// game events (see game.emit). Finishing all three fills a chest with a seeded, variable bonus.
//
// Daily challenge: one hard exercise a day, taken from a lesson you finished (or, before you have
// finished any, an open lesson), worth double XP, with its own streak.
import * as game from './game.js';

// ---------------------------------------------------------------- seeded randomness

/** A 32-bit hash of a string (FNV-1a). */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** A repeatable random number generator (mulberry32) for a seed string. */
export function seeded(seed) {
  let a = hash(seed);
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the pool
// Each quest: tier (1 easy, 2 medium, 3 hard), a target, and either `on(type, data)` returning how
// much progress an event makes (or `{ max: n }` for "best of" quests), or `value()` for quests that
// read the state directly. `ok(ctx)` says whether it makes sense for this learner today; `go` is
// where to go to work on it.

const done = () => Object.keys(game.state.lessons).length;

export const POOL = [
  { id: 'lesson-1', tier: 1, icon: '📘', target: 1, title: 'Finish a lesson', go: 'resume',
    on: (t, d) => t === 'lesson' ? 1 : 0 },
  { id: 'correct-10', tier: 1, icon: '✅', target: 10, title: 'Answer 10 questions right', go: 'resume',
    on: (t, d) => t === 'answer' && d.correct ? 1 : 0 },
  { id: 'combo-3', tier: 1, icon: '🔥', target: 3, title: 'Get a 3-answer combo', go: 'resume',
    on: (t, d) => t === 'answer' ? { max: d.combo } : 0 },
  { id: 'practice-5', tier: 1, icon: '🔁', target: 5, title: 'Answer 5 practice questions', go: 'quick', ok: () => done() > 0,
    on: (t, d) => t === 'answer' && d.mode === 'practice' ? 1 : 0 },
  { id: 'xp-50', tier: 1, icon: '✨', target: 50, title: 'Earn 50 XP', go: 'resume', unit: 'XP',
    value: () => game.todayXp() },

  { id: 'lessons-2', tier: 2, icon: '📚', target: 2, title: 'Finish 2 lessons', go: 'resume',
    on: t => t === 'lesson' ? 1 : 0 },
  { id: 'combo-5', tier: 2, icon: '🔥', target: 5, title: 'Get a 5-answer combo', go: 'resume',
    on: (t, d) => t === 'answer' ? { max: d.combo } : 0 },
  { id: 'practice-10', tier: 2, icon: '🔁', target: 10, title: 'Do 10 practice reviews', go: 'quick', ok: () => done() > 0,
    on: (t, d) => t === 'answer' && d.mode === 'practice' ? 1 : 0 },
  { id: 'lab', tier: 2, icon: '🧪', target: 1, title: 'Earn XP in a lab', go: 'labs',
    on: (t, d) => t === 'xp' && d.source === 'lab' ? 1 : 0 },
  { id: 'goal', tier: 2, icon: '🎯', target: 1, title: 'Reach your daily goal', go: 'resume',
    value: () => (game.todayXp() >= game.state.settings.dailyGoal ? 1 : 0) },
  { id: 'code-2', tier: 2, icon: '⌨️', target: 2, title: 'Pass 2 coding exercises', go: 'resume',
    on: (t, d) => t === 'answer' && d.correct && d.type === 'code' ? 1 : 0 },
  { id: 'typed-3', tier: 2, icon: '🎹', target: 3, title: 'Type out 3 answers instead of dragging', go: 'resume',
    on: (t, d) => t === 'answer' && d.correct && d.typed ? 1 : 0 },
  { id: 'challenge', tier: 2, icon: '⚔️', target: 1, title: 'Beat the daily challenge', go: 'challenge',
    on: (t, d) => t === 'challenge' && d.solved ? 1 : 0 },

  { id: 'perfect', tier: 3, icon: '⭐', target: 1, title: 'Finish a lesson with no mistakes', go: 'resume',
    on: (t, d) => t === 'lesson' && d.mistakes === 0 && d.exercises > 0 ? 1 : 0 },
  { id: 'boss-3', tier: 3, icon: '👑', target: 1, title: 'Earn 3 stars in a boss', go: 'resume',
    on: (t, d) => t === 'lesson' && d.boss && d.stars === 3 ? 1 : 0 },
  { id: 'new-topic', tier: 3, icon: '🧭', target: 1, title: "Learn something from a topic you haven't opened", go: 'home',
    on: (t, d) => t === 'lesson' && d.firstInTrack ? 1 : 0 },
  { id: 'stars-6', tier: 3, icon: '🌟', target: 6, title: 'Earn 6 stars', go: 'resume',
    on: (t, d) => t === 'lesson' ? d.stars : 0 },
  { id: 'combo-8', tier: 3, icon: '💥', target: 8, title: 'Get an 8-answer combo', go: 'resume',
    on: (t, d) => t === 'answer' ? { max: d.combo } : 0 },
  { id: 'xp-150', tier: 3, icon: '🚀', target: 150, title: 'Earn 150 XP', go: 'resume', unit: 'XP',
    value: () => game.todayXp() },
];

export const CHEST_MIN = 30, CHEST_MAX = 80;

/** The three quests for a day: one per tier, seeded by the date. */
export function pickQuests(day, ctx = {}) {
  const rand = seeded('quests:' + day);
  return [1, 2, 3].map(tier => {
    const options = POOL.filter(q => q.tier === tier && (!q.ok || q.ok(ctx)));
    return options[Math.floor(rand() * options.length)].id;
  });
}

/** Today's quest record, created on first use each day. */
export function today(day = game.dayKey()) {
  const s = game.state;
  if (!s.quests || s.quests.day !== day) {
    const rand = seeded('chest:' + day);
    const xp = CHEST_MIN + Math.round(rand() * (CHEST_MAX - CHEST_MIN));
    const lucky = rand() < 0.15;                                   // now and then a chest is a big one
    s.quests = { day, ids: pickQuests(day), progress: {}, done: {}, chest: { xp: lucky ? xp * 2 : xp, lucky, opened: false } };
  }
  return s.quests;
}

const byId = id => POOL.find(q => q.id === id);

/** The day's quests with their progress: [{ ...quest, have, complete }] */
export function list() {
  const q = today();
  return q.ids.map(byId).filter(Boolean).map(def => {
    const have = Math.min(def.target, def.value ? def.value() : q.progress[def.id] || 0);
    return { ...def, have, complete: have >= def.target };
  });
}

/** Feed a game event to today's quests. Returns the quests completed by it. */
export function track(type, data) {
  const q = today();
  const fresh = [];
  // The rush detector (pacing.js): a lesson rushed through with hints and reveals earns no quest progress.
  const rushed = type === 'lesson' && !!data?.rushed;
  for (const def of q.ids.map(byId).filter(Boolean)) {
    if (!def.value && def.on && !rushed) {
      const step = def.on(type, data || {});
      if (step && typeof step === 'object') q.progress[def.id] = Math.max(q.progress[def.id] || 0, step.max || 0);
      else if (step > 0) q.progress[def.id] = (q.progress[def.id] || 0) + step;
    }
    const have = def.value ? def.value() : q.progress[def.id] || 0;
    if (have >= def.target && !q.done[def.id]) { q.done[def.id] = true; fresh.push(def); }
  }
  return fresh;
}

/** A snapshot of progress, to show what a session moved: { id: have } */
export const snapshot = () => Object.fromEntries(list().map(x => [x.id, x.have]));

export const allDone = () => list().every(x => x.complete);

/** Opens the chest once all three quests are done. Returns { xp, lucky, freeze } or null. */
export function openChest() {
  const q = today();
  if (!allDone() || q.chest.opened) return null;
  q.chest.opened = true;
  const s = game.state;
  s.stats.chests = (s.stats.chests || 0) + 1;
  // Every 5th chest also holds a streak freeze, if you have room for one.
  let freeze = false;
  if (s.stats.chests % 5 === 0 && s.habit.freezes < 2) { s.habit.freezes++; freeze = true; }
  game.addXp(q.chest.xp, 'chest');
  return { xp: q.chest.xp, lucky: q.chest.lucky, freeze };
}

// ---------------------------------------------------------------- daily challenge

/** The day key before a day key. */
const dayBefore = key => { const [y, m, d] = key.split('-').map(Number); return game.dayKey(new Date(y, m - 1, d - 1)); };

const HARD = { code: 5, order: 4, blanks: 4, match: 3, sort: 3, predict: 2, mcq: 1 };

/**
 * Candidate lessons for today's challenge: finished lessons first; before any are finished, the open
 * first lessons of every module. Returns lesson keys in a stable order.
 */
export function challengeCandidates(tracks) {
  const finished = Object.keys(game.state.lessons).filter(k => tracks.some(t => k.startsWith(t.id + '/'))).sort();
  if (finished.length) return finished;
  return tracks.flatMap(t => game.flatLessons(t).filter(x => game.isUnlocked(t, x.module, x.index)).map(x => x.key)).sort();
}

/** Picks the step of a lesson to use as the challenge: the hardest kind, seeded among equals. */
export function hardestStep(steps, seed) {
  const scored = steps.map((s, idx) => ({ idx, score: HARD[s.type] || 0 })).filter(x => x.score > 0);
  if (!scored.length) return null;
  const top = Math.max(...scored.map(x => x.score));
  const best = scored.filter(x => x.score === top);
  return best[Math.floor(seeded(seed)() * best.length)].idx;
}

/** Today's challenge record; `key`/`idx` are filled in by the caller once the lesson is fetched. */
export function challengeToday(day = game.dayKey()) {
  const c = game.state.challenge;
  if (c.day !== day) Object.assign(c, { day, key: null, idx: null, done: false, solved: false });
  return c;
}

/** The lesson key for today's challenge (seeded by date, fixed once chosen). `attempt` skips bad picks. */
export function challengeLesson(tracks, attempt = 0, day = game.dayKey()) {
  const c = challengeToday(day);
  if (c.key && attempt === 0) return c.key;
  const list = challengeCandidates(tracks);
  if (!list.length) return null;
  return list[(hash('challenge:' + day) + attempt * 7919) % list.length];
}

/** Records a finished challenge. Returns the challenge record. */
export function finishChallenge(solved, day = game.dayKey()) {
  const c = challengeToday(day);
  if (c.done) return c;
  c.done = true; c.solved = solved;
  if (solved) {
    const yesterday = dayBefore(day);
    c.streak = c.last === yesterday ? c.streak + 1 : 1;
    c.last = day;
    c.best = Math.max(c.best || 0, c.streak);
    c.wins = (c.wins || 0) + 1;
  }
  return c;
}

/** The challenge streak as it stands today (0 if you missed yesterday's and have not done today's). */
export function challengeStreak(day = game.dayKey()) {
  const c = game.state.challenge;
  if (!c.last) return 0;
  const yesterday = dayBefore(day);
  return c.last === day || c.last === yesterday ? c.streak : 0;
}
