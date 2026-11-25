// Habits: streak freezes, streak milestones, comebacks and the weekly league against yourself.
// Pure game rules on game.state (no DOM), so they can be tested in Node with a fake state.
//
//   Streak freezes  One is earned on every 7th day of a streak (you can hold 2). When you come back
//                   after missing days, freezes cover the gap automatically, but only if they can
//                   cover all of it: a streak that is already lost does not eat your freezes.
//   Milestones      3, 7, 14, 30, 60 and 100 days, celebrated once per streak.
//   League          This week's XP (Monday to Sunday) against your best week and last week.
import * as game from './game.js';

export const MILESTONES = [3, 7, 14, 30, 60, 100];
export const MAX_FREEZES = 2;
const FREEZE_EVERY = 7;

const { dayKey, addDays } = game;
const parse = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

/** The most recent active day strictly before `beforeKey`, or null. */
export function lastActiveBefore(beforeKey) {
  const s = game.state;
  const keys = [...Object.keys(s.days).filter(k => s.days[k] > 0), ...Object.keys(s.habit.frozen || {})];
  return keys.filter(k => k < beforeKey).sort().pop() || null;
}

/** The first day of the current streak (today or yesterday counts as current), or null. */
export function streakStart(now = new Date()) {
  let d = new Date(now);
  if (!game.activeOn(dayKey(d))) d = addDays(-1, d);
  if (!game.activeOn(dayKey(d))) return null;
  while (game.activeOn(dayKey(addDays(-1, d)))) d = addDays(-1, d);
  return dayKey(d);
}

/**
 * Daily bookkeeping. Call on boot and after XP is earned. Returns events for the UI to celebrate:
 *   { type: 'freeze-used', days: [...] } { type: 'freeze-earned', freezes } { type: 'milestone', days }
 *   { type: 'comeback', gap }
 * `silent` (used when migrating an old save) records milestones without celebrating them.
 */
export function checkStreak(now = new Date(), { silent = false } = {}) {
  const s = game.state, hb = s.habit;
  const today = dayKey(now);
  const out = [];

  // 1. Cover missed days (before today) with freezes, if they can bridge the whole gap.
  const last = lastActiveBefore(today);
  if (last) {
    const missed = daysBetween(last, today) - 1;
    if (missed > 0 && missed <= hb.freezes) {
      const covered = [];
      for (let i = 1; i <= missed; i++) { const k = dayKey(addDays(i, parse(last))); hb.frozen[k] = true; covered.push(k); }
      hb.freezes -= missed;
      hb.usedFreezes = (hb.usedFreezes || 0) + missed;
      out.push({ type: 'freeze-used', days: covered });
    }
  }

  const active = s.days[today] > 0;
  const n = game.streak();
  hb.best = Math.max(hb.best || 0, n);
  if (!active) return out;

  // 2. A comeback: active today after a week or more away (checked once a day).
  if (hb.comebackDay !== today) {
    hb.comebackDay = today;
    if (last && daysBetween(last, today) >= 8) {
      s.stats.comebacks = (s.stats.comebacks || 0) + 1;
      out.push({ type: 'comeback', gap: daysBetween(last, today) - 1 });
    }
  }

  // 3. Every 7th day of a streak earns a freeze (once per calendar day).
  if (n > 0 && n % FREEZE_EVERY === 0 && !hb.freezeDays[today]) {
    hb.freezeDays[today] = true;
    if (hb.freezes < MAX_FREEZES) { hb.freezes++; out.push({ type: 'freeze-earned', freezes: hb.freezes }); }
  }

  // 4. Milestones, once per streak run.
  const run = streakStart(now);
  for (const m of MILESTONES) {
    const id = `${run}:${m}`;
    if (n >= m && !hb.celebrated.includes(id)) {
      hb.celebrated.push(id);
      if (!silent) out.push({ type: 'milestone', days: m });   // a migrated save records them quietly
    }
  }
  hb.celebrated = hb.celebrated.slice(-30);
  return out;
}

export const nextMilestone = (n = game.streak()) => MILESTONES.find(m => m > n) || null;

/**
 * The last `weeks` weeks of days, Monday first, for a calendar:
 *   [{ key, xp, state: 'goal' | 'active' | 'frozen' | 'missed' | 'future', today }]
 */
export function calendar(weeks = 4, now = new Date()) {
  const s = game.state;
  const start = addDays(-7 * (weeks - 1), weekStart(now));
  const today = dayKey(now);
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const key = dayKey(addDays(i, start));
    const xp = s.days[key] || 0;
    const st = key > today ? 'future' : xp >= s.settings.dailyGoal ? 'goal' : xp > 0 ? 'active' : s.habit.frozen[key] ? 'frozen' : 'missed';
    return { key, xp, state: st, today: key === today };
  });
}

// ---------------------------------------------------------------- weekly league (vs yourself)

/** Monday 00:00 of the week containing `d`. */
export function weekStart(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(-((x.getDay() + 6) % 7), x);
}
export const weekKey = (d = new Date()) => dayKey(weekStart(d));

/** XP per week, keyed by the week's Monday. */
export function weeklyXp() {
  const out = {};
  for (const [k, xp] of Object.entries(game.state.days)) {
    const w = weekKey(parse(k));
    out[w] = (out[w] || 0) + xp;
  }
  return out;
}

export const TIERS = [
  { id: 'bronze', name: 'Bronze', icon: '🥉', at: 0, text: 'Earn any XP this week' },
  { id: 'silver', name: 'Silver', icon: '🥈', at: 0.5, text: 'Half of your record week' },
  { id: 'gold', name: 'Gold', icon: '🥇', at: 0.8, text: '80% of your record week' },
  { id: 'platinum', name: 'Platinum', icon: '💠', at: 1, text: 'Match your record week' },
  { id: 'diamond', name: 'Diamond', icon: '💎', at: 1.25, text: 'Beat your record by 25%' },
];
/** Before you have a record, you race this many XP. */
export const FIRST_TARGET = 200;

/** The tier a week's XP reaches against a record. */
export function tierFor(xp, record) {
  if (xp <= 0) return null;
  const ref = Math.max(record, FIRST_TARGET);
  return [...TIERS].reverse().find(t => xp >= Math.ceil(t.at * ref)) || TIERS[0];
}

/** This week against your past: { xp, last, best, tier, next: { tier, need } | null, weekDay, history } */
export function league(now = new Date()) {
  const per = weeklyXp();
  const thisWeek = weekKey(now), lastWeek = weekKey(addDays(-7, weekStart(now)));
  const past = Object.entries(per).filter(([w]) => w < thisWeek);
  const best = past.reduce((m, [, xp]) => Math.max(m, xp), 0);
  const xp = per[thisWeek] || 0;
  const tier = tierFor(xp, best);
  const ref = Math.max(best, FIRST_TARGET);
  const idx = tier ? TIERS.indexOf(tier) : -1;
  const nextTier = TIERS[idx + 1] || null;
  const next = nextTier ? { tier: nextTier, need: Math.max(1, Math.ceil(nextTier.at * ref) - xp) } : null;
  // The last 8 weeks, oldest first, each with the tier it reached against the record before it.
  const history = Array.from({ length: 8 }, (_, i) => {
    const w = weekKey(addDays(-7 * (7 - i), weekStart(now)));
    const before = Object.entries(per).filter(([k]) => k < w).reduce((m, [, v]) => Math.max(m, v), 0);
    return { week: w, xp: per[w] || 0, tier: tierFor(per[w] || 0, before), current: w === thisWeek };
  });
  return { xp, last: per[lastWeek] || 0, best, tier, next, record: xp > best && best > 0, weekDay: (now.getDay() + 6) % 7, history, week: thisWeek };
}

/**
 * The first visit of a new week: a recap of the week that ended (or null if nothing to recap).
 * Marks the week as seen, so it shows once.
 */
export function weeklyRecap(now = new Date()) {
  const lg = game.state.league;
  const thisWeek = weekKey(now);
  if (lg.seenWeek === thisWeek) return null;
  const prev = lg.seenWeek;
  lg.seenWeek = thisWeek;
  if (!prev) return null;                                     // a fresh or migrated save: start counting now
  const per = weeklyXp();
  const ended = weekKey(addDays(-7, weekStart(now)));
  const xp = per[ended] || 0;
  if (!xp) return null;
  const before = Object.entries(per).filter(([k]) => k < ended).reduce((m, [, v]) => Math.max(m, v), 0);
  const tier = tierFor(xp, before);
  const order = TIERS.map(t => t.id);
  if (!lg.bestTier || order.indexOf(tier.id) > order.indexOf(lg.bestTier)) lg.bestTier = tier.id;
  return { week: ended, xp, tier, record: xp > before, before };
}

/** A full Monday-to-Sunday week where every day reached the daily goal. */
export function hadPerfectWeek(now = new Date()) {
  const s = game.state, goal = s.settings.dailyGoal;
  const weeks = new Set(Object.keys(s.days).filter(k => s.days[k] >= goal).map(k => weekKey(parse(k))));
  for (const w of weeks) {
    const start = parse(w);
    if (Array.from({ length: 7 }, (_, i) => dayKey(addDays(i, start))).every(k => (s.days[k] || 0) >= goal)) return true;
  }
  return false;
}
