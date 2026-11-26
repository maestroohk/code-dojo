// Spaced repetition for flashcards: an SM-2 scheduler (Anki's variant) with Again / Hard / Good / Easy, daily
// limits, review stats, and the "type it" comparison for command cards. Pure functions, no imports, so they are
// tested in plain Node (tests/CodeDojo.Tests/srs.test.mjs).
//
//   card schedule  { s: 'learn' | 'review' | 'relearn', step, due (ms), ivl (days), ease, reps, lapses, last (ms) }
//                  a card with no schedule is new
//   state.flash = { cards: { id: schedule }, log: [{ t, id, g, s }], days: { 'YYYY-MM-DD': { new, reviews } },
//                   settings: { newPerDay, reviewsPerDay }, suspended: { id: true } }
//
// Grades: 1 Again (forgot), 2 Hard, 3 Good, 4 Easy.
//   New and learning cards walk the learning steps (1 min, 10 min); Good on the last step graduates to 1 day, Easy
//   graduates straight to 4 days.
//   Review cards: Hard x1.2 (ease -0.15), Good x ease (plus half of any overdue days), Easy x ease x1.3 (ease +0.15).
//   Again on a review card is a lapse: ease -0.20, the interval shrinks to 20% (at least 1 day), and the card is
//   relearned (10 min) first. Ease never drops under 1.3. Intervals of 3+ days get a small deterministic fuzz
//   (about ±5%), so cards learned together do not all come back on the same day.

export const CONFIG = {
  learnSteps: [1, 10],      // minutes
  relearnSteps: [10],       // minutes
  graduating: 1,            // days
  easyInterval: 4,          // days
  startEase: 2.5,
  minEase: 1.3,
  hard: 1.2,
  easyBonus: 1.3,
  lapse: 0.2,
  maxInterval: 3650,
  learnAheadMin: 20,        // a learning card due within 20 minutes may be shown now when nothing else is due
};

export const DEFAULT_LIMITS = { newPerDay: 15, reviewsPerDay: 200 };

const MIN = 60_000, DAY = 86_400_000;

/** Local midnight of the day holding `ms`. */
export const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKeyOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDaysMs = (ms, n) => { const d = new Date(dayStart(ms)); d.setDate(d.getDate() + n); return d.getTime(); };
/** Whole local days from a to b. */
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY);

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** A fixed nudge of about ±5% (at least ±1 day from 3 days up), the same for the same card and repetition. */
export function fuzz(ivl, id = '', reps = 0) {
  if (ivl < 3) return ivl;
  const span = Math.max(1, Math.round(ivl * 0.05));
  const r = (hash(`${id}#${reps}`) % (2 * span + 1)) - span;
  return Math.max(2, ivl + r);
}

const clampEase = e => Math.max(CONFIG.minEase, Math.round(e * 100) / 100);
const clampIvl = n => Math.max(1, Math.min(CONFIG.maxInterval, Math.round(n)));

/**
 * The card's next schedule after grade `g` (1-4) at time `now` (ms). `card` is the current schedule, or null for a
 * new card. Returns a new object; the input is not changed.
 */
export function grade(card, g, now, id = '') {
  g = Math.max(1, Math.min(4, Math.round(g)));
  const c = card ? { ...card } : { s: 'learn', step: 0, ivl: 0, ease: CONFIG.startEase, reps: 0, lapses: 0 };
  c.reps = (c.reps || 0) + 1;
  c.last = now;
  const toReview = ivl => { c.s = 'review'; c.step = 0; c.ivl = clampIvl(ivl); c.due = addDaysMs(now, c.ivl); };

  if (c.s === 'learn' || c.s === 'relearn') {
    const steps = c.s === 'learn' ? CONFIG.learnSteps : CONFIG.relearnSteps;
    const graduate = c.s === 'learn' ? CONFIG.graduating : Math.max(1, c.ivl || 1);
    if (g === 1) { c.step = 0; c.due = now + steps[0] * MIN; }
    else if (g === 2) {
      const wait = c.step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[Math.min(c.step, steps.length - 1)];
      c.due = now + wait * MIN;
    }
    else if (g === 3) {
      c.step = (c.step || 0) + 1;
      if (c.step >= steps.length) toReview(graduate);
      else c.due = now + steps[c.step] * MIN;
    }
    else toReview(c.s === 'learn' ? CONFIG.easyInterval : graduate + 1);
    return c;
  }

  // A review card. Overdue days count for something: remembering after a long gap is stronger evidence.
  const ivl = Math.max(1, c.ivl || 1);
  const late = Math.max(0, daysBetween(c.due ?? now, now));
  if (g === 1) {
    c.lapses = (c.lapses || 0) + 1;
    c.ease = clampEase(c.ease - 0.2);
    c.s = 'relearn'; c.step = 0;
    c.ivl = clampIvl(ivl * CONFIG.lapse);
    c.due = now + CONFIG.relearnSteps[0] * MIN;
    return c;
  }
  const hard = Math.max(ivl + 1, ivl * CONFIG.hard);
  const good = Math.max(hard + 1, (ivl + late / 2) * c.ease);
  const easy = Math.max(good + 1, (ivl + late) * c.ease * CONFIG.easyBonus);
  if (g === 2) c.ease = clampEase(c.ease - 0.15);
  if (g === 4) c.ease = clampEase(c.ease + 0.15);
  toReview(fuzz(clampIvl(g === 2 ? hard : g === 3 ? good : easy), id, c.reps));
  return c;
}

/** "<1m", "10m", "1d", "3w", "4mo": how long until a card graded `g` now comes back (for the buttons). */
export function preview(card, g, now, id = '') {
  const next = grade(card, g, now, id);
  const ms = next.due - now;
  if (next.s !== 'review') return ms < MIN ? '<1m' : ms < 60 * MIN ? `${Math.round(ms / MIN)}m` : `${Math.round(ms / (60 * MIN))}h`;
  const d = next.ivl;
  return d < 21 ? `${d}d` : d < 60 ? `${Math.round(d / 7)}w` : d < 365 ? `${Math.round(d / 30)}mo` : `${(d / 365).toFixed(1)}y`;
}

/** Is this scheduled card due at `now`? Reviews are due all day; learning cards at their minute. */
export function isDue(card, now, { ahead = false } = {}) {
  if (!card) return false;
  if (card.s === 'review') return card.due <= addDaysMs(now, 1) - 1;
  return card.due <= now + (ahead ? CONFIG.learnAheadMin * MIN : 0);
}

export function ensure(flash) {
  const f = flash || {};
  f.cards ||= {}; f.log ||= []; f.days ||= {}; f.suspended ||= {};
  f.settings = { ...DEFAULT_LIMITS, ...(f.settings || {}) };
  return f;
}

/**
 * Today's queue from the unlocked cards (in lesson order): due learning cards, due reviews (most overdue first),
 * then new cards, within the daily limits. Returns { learning, review, fresh, counts: { learning, review, fresh } }.
 */
export function buildQueue(cards, flash, now) {
  const f = ensure(flash);
  const today = f.days[dayKeyOf(now)] || { new: 0, reviews: 0 };
  const learning = [], review = [], fresh = [];
  for (const c of cards) {
    if (f.suspended[c.id]) continue;
    const s = f.cards[c.id];
    if (!s) { fresh.push(c); continue; }
    if (s.s === 'review') { if (isDue(s, now)) review.push(c); }
    else if (isDue(s, now, { ahead: true }) || dayStart(s.due) <= dayStart(now)) learning.push(c);
  }
  review.sort((a, b) => f.cards[a.id].due - f.cards[b.id].due);
  learning.sort((a, b) => f.cards[a.id].due - f.cards[b.id].due);
  const reviewLeft = Math.max(0, f.settings.reviewsPerDay - today.reviews);
  const newLeft = Math.max(0, f.settings.newPerDay - today.new);
  const r = review.slice(0, reviewLeft), n = fresh.slice(0, newLeft);
  return { learning, review: r, fresh: n, counts: { learning: learning.length, review: r.length, fresh: n.length, newTotal: fresh.length } };
}

/** How many scheduled cards are due today (learning + review), ignoring new cards and limits: for the nav badge. */
export function dueCount(flash, now) {
  const f = ensure(flash);
  const end = addDaysMs(now, 1) - 1;
  let n = 0;
  for (const [id, s] of Object.entries(f.cards)) if (!f.suspended[id] && s.due <= end) n++;
  return Math.min(n, f.settings.reviewsPerDay + 50);
}

/** Records a grade in the flash state (schedule, log, today's counters). Returns the new schedule. */
export function answer(flash, id, g, now) {
  const f = ensure(flash);
  const before = f.cards[id] || null;
  const next = grade(before, g, now, id);
  f.cards[id] = next;
  const day = f.days[dayKeyOf(now)] ||= { new: 0, reviews: 0 };
  if (!before) day.new++;
  else if (before.s === 'review') day.reviews++;
  f.log.push({ t: now, id, g, s: before ? before.s : 'new' });
  if (f.log.length > 4000) f.log.splice(0, f.log.length - 4000);
  return next;
}

/**
 * Review stats: retention (share of review-card answers that were not "Again", last 30 days), the streak of days
 * with at least one card reviewed, and how many cards come due on each of the next `days` days (day 0 includes
 * anything overdue).
 */
export function stats(flash, now, days = 7) {
  const f = ensure(flash);
  const since = now - 30 * DAY;
  const reviews = f.log.filter(e => e.t >= since && e.s === 'review');
  const retention = reviews.length ? reviews.filter(e => e.g > 1).length / reviews.length : null;
  const active = new Set(f.log.map(e => dayKeyOf(e.t)));
  let streak = 0;
  let d = now;
  if (!active.has(dayKeyOf(d))) d = addDaysMs(d, -1);
  while (active.has(dayKeyOf(d))) { streak++; d = addDaysMs(d, -1); }
  const forecast = Array.from({ length: days }, () => 0);
  for (const [id, s] of Object.entries(f.cards)) {
    if (f.suspended[id]) continue;
    const at = Math.max(0, daysBetween(now, s.due));
    if (at < days) forecast[at]++;
  }
  const states = { learning: 0, young: 0, mature: 0 };
  for (const s of Object.values(f.cards)) {
    if (s.s !== 'review') states.learning++;
    else if (s.ivl >= 21) states.mature++;
    else states.young++;
  }
  const todayKey = dayKeyOf(now);
  return { retention, reviewed30: reviews.length, streak, forecast, states, today: f.days[todayKey] || { new: 0, reviews: 0 },
    answeredToday: f.log.filter(e => dayKeyOf(e.t) === todayKey).length };
}

// ---------------------------------------------------------------- "type it": comparing a typed command

/** Shell-like tokens: quotes group words (and are dropped), | && || ; are tokens of their own. */
export function tokenize(cmd) {
  const out = [];
  let cur = '', quote = null, had = false;
  const s = String(cmd ?? '').trim();
  const push = () => { if (cur.length || had) out.push(cur); cur = ''; had = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; had = true; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') { push(); out.push(two); i++; continue; }
    if (ch === '|' || ch === ';') { push(); out.push(ch); continue; }
    cur += ch;
  }
  push();
  return out;
}

// Programs whose arguments mean something different in another order: compared exactly.
const ORDERED = new Set(['find', 'ffmpeg', 'sed', 'awk', 'xargs', 'ssh', 'iptables', 'nft', 'jq', 'printf', 'echo', 'test', '[']);
const SEPARATORS = new Set(['|', '&&', '||', ';']);
const isPlaceholder = t => /^<[^<>]+>$/.test(t);
const isFlag = t => /^-/.test(t) && t !== '-' && t !== '--';

const tokenMatches = (want, got) => want === got || (isPlaceholder(want) && got != null && got.length > 0);

function sameTokens(want, got) {
  return want.length === got.length && want.every((w, i) => tokenMatches(w, got[i]));
}

/**
 * Splits one command (no separators) into its head, its flag units, other positional words (in order) and what follows
 * `--`. `arity` is how many words after a flag belong to it (the rest are positional): we cannot know a flag's arity,
 * so the comparison tries 0, 1 and "all until the next flag".
 */
function units(tokens, arity = Infinity) {
  const head = [], pos = [];
  let i = 0;
  while (i < tokens.length && !isFlag(tokens[i]) && tokens[i] !== '--') head.push(tokens[i++]);
  const groups = [];
  let tail = [];
  let taken = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { tail = tokens.slice(i); break; }
    if (isFlag(t)) {
      taken = 0;
      // -nw is -n -w: expand clusters of single-letter flags (not --long ones, not -1 style numbers).
      if (/^-[A-Za-z]{2,5}$/.test(t)) for (const ch of [...t.slice(1)].sort()) groups.push([`-${ch}`]);
      else {
        // --name=value is --name value
        const eq = t.indexOf('=');
        if (t.startsWith('--') && eq > 2) { groups.push([t.slice(0, eq), t.slice(eq + 1)]); taken = arity; }
        else groups.push([t]);
      }
    } else if (groups.length && taken < arity) { groups[groups.length - 1].push(t); taken++; }
    else pos.push(t);
  }
  return { head, groups, pos, tail };
}

function sameUnits(a, b) {
  if (!sameTokens(a.head, b.head) || !sameTokens(a.tail, b.tail) || !sameTokens(a.pos, b.pos) || a.groups.length !== b.groups.length) return false;
  // Every flag unit of the expected command is matched by a different typed unit.
  const left = [...b.groups];
  for (const g of a.groups) {
    const at = left.findIndex(x => sameTokens(g, x));
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

function sameSegment(want, got) {
  if (sameTokens(want, got)) return true;
  if (!want.length || !got.length || ORDERED.has(want[0])) return false;
  return [Infinity, 1, 0].some(n => sameUnits(units(want, n), units(got, n)));
}

/** Splits tokens at | && || ;  */
function segments(tokens) {
  const segs = [[]], seps = [];
  for (const t of tokens) if (SEPARATORS.has(t)) { seps.push(t); segs.push([]); } else segs[segs.length - 1].push(t);
  return { segs, seps };
}

/**
 * Compares a typed command with the expected one, token by token. Quotes do not matter, flags may come in any order
 * where that is safe (not for find, sed, awk, jq, ...), clustered short flags (-nw) equal separate ones (-n -w),
 * --name=value equals --name value, and a <placeholder> in the expected command accepts any one word.
 * Returns { ok, exact, missing: [tokens expected but not typed], extra: [tokens typed but not expected] }.
 */
export function compareCommand(typed, expected) {
  const want = tokenize(String(expected ?? '').replace(/^`|`$/g, ''));
  const got = tokenize(typed);
  const exact = sameTokens(want, got);
  let ok = exact;
  if (!ok) {
    const a = segments(want), b = segments(got);
    ok = a.segs.length === b.segs.length && a.seps.every((s, i) => s === b.seps[i]) && a.segs.every((s, i) => sameSegment(s, b.segs[i]));
  }
  const missing = [], extra = [...got];
  for (const w of want) {
    const at = extra.findIndex(g => tokenMatches(w, g));
    if (at >= 0) extra.splice(at, 1); else missing.push(w);
  }
  return { ok, exact, missing: ok ? [] : missing, extra: ok ? [] : extra };
}
