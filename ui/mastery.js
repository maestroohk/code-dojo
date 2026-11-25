// Topic mastery: how well you know a track, from lessons finished, stars and first-try accuracy.
// Pure rules on game.state (no DOM).
//
//   score (0-100) = 60 x lessons done / lessons
//                 + 25 x stars / max stars
//                 + 15 x first-try accuracy, weighted by how many answers we have seen (full at 20)
//
// Levels: Novice 0, Apprentice 10, Practitioner 35, Expert 65, Master 90.
import * as game from './game.js';

export const LEVELS = [
  { name: 'Novice', at: 0 },
  { name: 'Apprentice', at: 10 },
  { name: 'Practitioner', at: 35 },
  { name: 'Expert', at: 65 },
  { name: 'Master', at: 90 },
];
const CONFIDENT_AT = 20;   // answers before accuracy counts fully

/** Record one answer for a track's accuracy. */
export function recordAnswer(trackId, firstTry) {
  if (!trackId) return;
  const a = game.state.accuracy[trackId] ||= { right: 0, total: 0 };
  a.total++;
  if (firstTry) a.right++;
}

/** { score, level, levelIndex, next: { name, at } | null, done, total, stars, maxStars, accuracy, hint } */
export function mastery(track) {
  const p = game.trackProgress(track);
  const acc = game.state.accuracy[track.id] || { right: 0, total: 0 };
  const accuracy = acc.total ? acc.right / acc.total : 0;
  const weight = Math.min(1, acc.total / CONFIDENT_AT);
  const total = Math.max(1, p.total);
  const score = p.done === 0 ? 0 : Math.min(100, Math.round(
    60 * (p.done / total) + 25 * (p.stars / Math.max(1, p.maxStars)) + 15 * accuracy * weight));
  let levelIndex = 0;
  LEVELS.forEach((l, i) => { if (score >= l.at) levelIndex = i; });
  const next = LEVELS[levelIndex + 1] || null;
  return { score, level: LEVELS[levelIndex].name, levelIndex, next, accuracy, answers: acc.total, ...p, hint: hint(score, next, p, total) };
}

/** A friendly "next milestone" line: roughly how many more lessons get you there. */
function hint(score, next, p, total) {
  if (!next) return 'Mastered. Replay bosses and keep your accuracy sharp.';
  // A typical new lesson is worth 60/total for finishing plus ~2.5 stars' worth.
  const perLesson = 60 / total + 25 * (2.5 / 3) / total;
  const left = p.total - p.done;
  const lessons = Math.ceil((next.at - score) / perLesson);
  if (left > 0 && lessons <= left) return `About ${lessons} more lesson${lessons === 1 ? '' : 's'} to ${next.name}`;
  return `Raise your stars and practice accuracy to reach ${next.name}`;
}

/** Mastery for every track, best first. */
export const all = tracks => tracks.map(t => ({ track: t, ...mastery(t) })).sort((a, b) => b.score - a.score);

/** The level index for a track id (0 if unknown), used by titles and achievements. */
export function levelOf(tracks, id) {
  const t = tracks.find(x => x.id === id);
  return t ? mastery(t).levelIndex : 0;
}
