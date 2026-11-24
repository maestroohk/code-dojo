// Progress and game rules: XP, levels, daily streak, stars, achievements, spaced review.
// State lives in .state/progress.json on this machine (via the local server).
import { api } from './util.js';

const DEFAULTS = () => ({
  v: 1,
  xp: 0,
  lessons: {},        // "track/module/lesson" -> { stars, bestXp, runs, completedAt }
  days: {},           // "2026-11-24" -> XP earned that day
  achievements: {},   // id -> date earned
  review: [],         // [{ key, idx, box, due }]  steps answered wrong, resurfaced in Practice
  drafts: {},         // "track/module/lesson#idx" -> code the learner left in the editor
  stats: { correct: 0, wrong: 0, codePassed: 0, perfect: 0, hints: 0, drags: 0, fixes: 0, bestCombo: 0, practice: 0, reviewed: 0, bosses: 0 },
  settings: { freeRoam: false, dailyGoal: 60, sound: true },
});

export let state = DEFAULTS();
let saveTimer = null;

export async function load() {
  const saved = await api('progress').catch(() => ({}));
  const base = DEFAULTS();
  state = { ...base, ...saved, stats: { ...base.stats, ...saved.stats }, settings: { ...base.settings, ...saved.settings } };
}

export function save(now) {
  clearTimeout(saveTimer);
  const put = () => api('progress', state, 'PUT').catch(e => console.error('Could not save progress', e));
  if (now) return put();
  saveTimer = setTimeout(put, 400);
}

export function reset() { state = DEFAULTS(); return save(true); }

// ---------------------------------------------------------------- dates and streak

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (n, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + n); return d; };

/** Consecutive active days ending today (or yesterday, so the streak survives until midnight). */
export function streak() {
  let d = new Date();
  if (!state.days[dayKey(d)]) d = addDays(-1, d);
  let n = 0;
  while (state.days[dayKey(d)] > 0) { n++; d = addDays(-1, d); }
  return n;
}
export const todayXp = () => state.days[dayKey()] || 0;

// ---------------------------------------------------------------- levels

const RANKS = [[1, 'Newcomer'], [3, 'Apprentice'], [6, 'Junior Developer'], [10, 'Developer'],
  [15, 'Senior Developer'], [20, 'Tech Lead'], [26, 'Architect'], [33, 'Distinguished Engineer']];

/** Level n -> n+1 costs 100 + 40*(n-1) XP, so early levels come quickly. */
export function levelInfo(xp = state.xp) {
  let level = 1, need = 100, left = xp;
  while (left >= need) { left -= need; level++; need = 100 + 40 * (level - 1); }
  const rank = RANKS.filter(([min]) => level >= min).pop()[1];
  return { level, into: left, need, rank };
}

// ---------------------------------------------------------------- XP rules

const BASE_XP = { mcq: 10, predict: 12, order: 14, blanks: 14, match: 14, sort: 14, code: 30 };

/** XP for solving a step, given how it went. */
export function stepXp(step, { attempts, hints, revealed, combo, replay, boss }) {
  if (revealed) return 0;
  let xp = BASE_XP[step.type] || 10;
  if (step.type === 'code' && boss) xp = 45;
  const ladder = step.type === 'code' ? [1, 0.9, 0.8, 0.7, 0.6, 0.5] : [1, 0.6, 0.35, 0.2];
  xp *= ladder[Math.min(attempts - 1, ladder.length - 1)];
  xp *= Math.max(0.4, 1 - 0.2 * hints);
  if (combo >= 3) xp += Math.min(combo - 2, 5) * 2;
  if (replay) xp *= 0.3;
  return Math.max(1, Math.round(xp));
}

export function addXp(n) {
  const before = levelInfo().level;
  state.xp += n;
  state.days[dayKey()] = todayXp() + n;
  return { leveledUp: levelInfo().level > before, level: levelInfo() };
}

export const starsFor = mistakes => (mistakes === 0 ? 3 : mistakes <= 2 ? 2 : 1);

// ---------------------------------------------------------------- map and unlocking

export const lessonKey = (track, module, lesson) => `${track.id}/${module.id}/${lesson.id}`;
export const isDone = key => !!state.lessons[key];

/** The first lesson of every module is open, so you can start at your level. After that, in order. */
export function isUnlocked(track, module, index) {
  if (state.settings.freeRoam || index === 0) return true;
  return isDone(lessonKey(track, module, module.lessons[index - 1]));
}

export function flatLessons(track) {
  return track.modules.flatMap(m => m.lessons.map((l, i) => ({ track, module: m, lesson: l, index: i, key: lessonKey(track, m, l) })));
}

export function nextLesson(track) {
  const all = flatLessons(track);
  // Carry on from the furthest point reached, not from the first gap.
  let last = -1;
  all.forEach((x, i) => { if (isDone(x.key)) last = i; });
  return all.slice(last + 1).find(x => !isDone(x.key)) || all.find(x => !isDone(x.key)) || null;
}

export function trackProgress(track) {
  const all = flatLessons(track);
  const done = all.filter(x => isDone(x.key)).length;
  const stars = all.reduce((n, x) => n + (state.lessons[x.key]?.stars || 0), 0);
  return { done, total: all.length, stars, maxStars: all.length * 3 };
}

// ---------------------------------------------------------------- review (Leitner boxes)

const INTERVALS = [1, 3, 7, 14];

export function missed(key, idx) {
  const item = state.review.find(r => r.key === key && r.idx === idx);
  if (item) { item.box = 0; item.due = dayKey(); }
  else state.review.push({ key, idx, box: 0, due: dayKey() });
}

export function reviewed(key, idx, correct) {
  const item = state.review.find(r => r.key === key && r.idx === idx);
  if (!item) return;
  if (!correct) { item.box = 0; item.due = dayKey(); return; }
  item.box++;
  if (item.box >= INTERVALS.length) { state.review = state.review.filter(r => r !== item); state.stats.reviewed++; }
  else item.due = dayKey(addDays(INTERVALS[item.box]));
}

export const dueReviews = () => state.review.filter(r => r.due <= dayKey());

// ---------------------------------------------------------------- achievements

export const ACHIEVEMENTS = [
  { id: 'first-lesson', icon: '🌱', title: 'First steps', text: 'Finish your first lesson.', test: s => Object.keys(s.lessons).length >= 1 },
  { id: 'ten-lessons', icon: '📚', title: 'Bookworm', text: 'Finish 10 lessons.', test: s => Object.keys(s.lessons).length >= 10 },
  { id: 'perfect', icon: '⭐', title: 'Flawless', text: 'Finish a lesson with no mistakes.', test: s => s.stats.perfect >= 1 },
  { id: 'perfect-5', icon: '🌟', title: 'Perfectionist', text: 'Finish 5 lessons with no mistakes.', test: s => s.stats.perfect >= 5 },
  { id: 'first-code', icon: '⌨️', title: 'It compiles!', text: 'Pass your first coding exercise.', test: s => s.stats.codePassed >= 1 },
  { id: 'code-25', icon: '🛠️', title: 'Builder', text: 'Pass 25 coding exercises.', test: s => s.stats.codePassed >= 25 },
  { id: 'code-100', icon: '🏗️', title: 'Engineer', text: 'Pass 100 coding exercises.', test: s => s.stats.codePassed >= 100 },
  { id: 'bug-squasher', icon: '🐞', title: 'Bug squasher', text: 'Repair 5 broken programs.', test: s => s.stats.fixes >= 5 },
  { id: 'drag-20', icon: '🧩', title: 'Puzzle solver', text: 'Solve 20 drag-and-drop puzzles.', test: s => s.stats.drags >= 20 },
  { id: 'combo-8', icon: '🔥', title: 'On fire', text: 'Get 8 answers right in a row, first try.', test: s => s.stats.bestCombo >= 8 },
  { id: 'streak-3', icon: '📆', title: 'Habit forming', text: 'Keep a 3-day streak.', test: () => streak() >= 3 },
  { id: 'streak-7', icon: '🗓️', title: 'Full week', text: 'Keep a 7-day streak.', test: () => streak() >= 7 },
  { id: 'streak-30', icon: '🏔️', title: 'Unstoppable', text: 'Keep a 30-day streak.', test: () => streak() >= 30 },
  { id: 'goal', icon: '🎯', title: 'Daily goal', text: 'Reach your daily XP goal.', test: s => todayXp() >= s.settings.dailyGoal },
  { id: 'boss', icon: '👑', title: 'Boss slayer', text: 'Beat a module boss.', test: s => s.stats.bosses >= 1 },
  { id: 'boss-all', icon: '🏆', title: 'Track champion', text: 'Beat every boss in a track.', test: (s, tracks) => tracks.some(t => {
    const bosses = flatLessons(t).filter(x => x.lesson.kind === 'boss');
    return bosses.length > 0 && bosses.every(x => s.lessons[x.key]);
  }) },
  { id: 'reviewer', icon: '🔁', title: 'Second chances', text: 'Master 5 questions you first got wrong.', test: s => s.stats.reviewed >= 5 },
  { id: 'xp-1000', icon: '💎', title: 'Four digits', text: 'Earn 1,000 XP.', test: s => s.xp >= 1000 },
  { id: 'xp-5000', icon: '🚀', title: 'Liftoff', text: 'Earn 5,000 XP.', test: s => s.xp >= 5000 },
];

/** Returns achievements earned just now. */
export function checkAchievements(tracks) {
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (state.achievements[a.id]) continue;
    let ok = false;
    try { ok = a.test(state, tracks || []); } catch { /* an achievement must never break a lesson */ }
    if (ok) { state.achievements[a.id] = dayKey(); fresh.push(a); }
  }
  return fresh;
}

// ---------------------------------------------------------------- sound

let audio = null;
export function sound(kind) {
  if (!state.settings.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = { right: [660, 880], wrong: [220, 180], level: [523, 659, 784, 1047], done: [523, 784, 1047] }[kind] || [440];
    notes.forEach((freq, i) => {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = kind === 'wrong' ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      const t = audio.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch { /* no audio device: stay silent */ }
}
