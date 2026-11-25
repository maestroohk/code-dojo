// The habit layer's views and wiring: the Today panel, "One more?", mastery rings, rewards in the
// profile, celebrations (level-up, streak milestones, quests, chests) and small bits of juice.
// The rules live in habits.js, quests.js, mastery.js and rewards.js; this file only shows them and
// feeds them the game events (game.emit) from lessons, practice and labs.
//
// app.js calls: init(tracks) once after loading, afterPage() after every page render, and the view
// builders (todayPanel, oneMore, topicChip, trackMastery, profilePanels, headerTitle).
import { h, api, shuffle } from './util.js';
import * as game from './game.js';
import * as habits from './habits.js';
import * as quests from './quests.js';
import * as mastery from './mastery.js';
import * as rewards from './rewards.js';

let tracks = [];
let sessionStart = null;           // quest progress when the current lesson/practice began
const queue = [];                  // modals waiting until the learner is out of the player
let shownToday = null;             // the header's "today XP" as last shown, so it can tick up

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const inPlayer = () => !!document.querySelector('.player');

// ---------------------------------------------------------------- toasts and modals

export function toast(node, kind = 'info', ms = 3600) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h(`div.toast.${kind}`, node);
  host.append(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 500);
}
const toastLine = (icon, title, text, kind = 'gold', ms) =>
  toast([h('span.toast-icon', icon), h('div', h('strong', title), text && h('div', text))], kind, ms);

/** A celebration card over the page. Resolves when closed. */
function celebrateModal({ big, icon, eyebrow, title, text, extra, sound = 'milestone' }) {
  return new Promise(resolve => {
    const close = () => { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(); };
    const onKey = e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
    const ok = h('button.btn.primary.big', { type: 'button', onclick: close }, 'Keep going');
    const back = h('div.modal-back', { onclick: e => { if (e.target === back) close(); } },
      h('div.modal.celebrate', { role: 'dialog', 'aria-modal': 'true' },
        h('div.cel-burst', { 'aria-hidden': 'true' }, Array.from({ length: 12 }, (_, i) => h('span', { style: { '--i': i } }))),
        big != null ? h('div.cel-big', big) : h('div.cel-icon', icon),
        eyebrow && h('div.eyebrow', eyebrow),
        h('h2', title),
        text && h('p.muted', text),
        extra,
        h('div.modal-actions.center', ok)));
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    game.sound(sound);
    ok.focus();
  });
}

/** Show a modal now, or after the lesson if one is running. */
function celebrate(modal) {
  queue.push(modal);
  if (!inPlayer()) flush();
}
let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  while (queue.length && !inPlayer()) await celebrateModal(queue.shift());
  flushing = false;
}

/** Counts a number up inside an element. Respects reduced motion. */
export function tick(el, from, to, ms = 800) {
  if (!el) return;
  const fmt = v => (el.dataset.prefix || '') + Math.round(v).toLocaleString() + (el.dataset.suffix || '');
  if (reducedMotion() || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  let ticks = 0;
  const step = now => {
    const k = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (k * 6 > ticks && ticks < 6) { ticks++; game.sound('tick'); }
    if (k < 1) requestAnimationFrame(step);
    else { el.classList.remove('tick-bump'); void el.offsetWidth; el.classList.add('tick-bump'); }
  };
  requestAnimationFrame(step);
}
/** Ticks every [data-tick] number under a root from 0 (or data-from) to its value. */
export function tickAll(root = document) {
  root.querySelectorAll('[data-tick]').forEach(el => {
    const to = Number(el.dataset.tick), from = Number(el.dataset.from || 0);
    delete el.dataset.tick;
    tick(el, from, to);
  });
}

/** A mastery/progress ring. p is 0..1. The fill animates in after the ring is on the page. */
export function ring(p, label, size = 44) {
  const el = h('div.mring', { style: { '--size': `${size}px`, '--mp': 0 } }, h('span.mring-label', label));
  requestAnimationFrame(() => requestAnimationFrame(() => el.style.setProperty('--mp', Math.max(0, Math.min(1, p)))));
  return el;
}

// ---------------------------------------------------------------- setup, migration, events

export function applyTheme() {
  const theme = game.state.rewards.theme || 'copper';
  if (theme === 'copper') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = theme;
  try { localStorage.setItem('dojo-accent', theme); } catch { }
}

/**
 * Upgrades a save from before the habit layer (v1) without taking anything away: XP, lessons and
 * days stay as they are; freezes you would have earned on your current streak are granted;
 * milestones, titles and achievements you already qualify for are recorded quietly, with one note.
 */
function migrate() {
  const s = game.state;
  if ((s.v || 1) >= 2) return;
  const n = game.streak();
  habits.checkStreak(new Date(), { silent: true });
  s.habit.freezes = Math.max(s.habit.freezes || 0, Math.min(habits.MAX_FREEZES, Math.floor(n / 7)));
  s.habit.best = Math.max(s.habit.best || 0, n);
  s.league.seenWeek ||= habits.weekKey();
  s.rewards.levelSeen = Math.max(s.rewards.levelSeen || 0, game.levelInfo().level);
  rewards.checkTitles(tracks);
  checkThemes(true);
  const before = Object.keys(s.achievements).length;
  game.checkAchievements(tracks);
  const got = Object.keys(s.achievements).length - before;
  s.v = 2;
  game.save(true);
  if (got > 0) setTimeout(() => toastLine('🏅', `${got} achievement${got === 1 ? '' : 's'} recorded from your history`, 'See them all in your Profile.', 'gold', 6000), 1200);
}

function checkThemes(silent) {
  const r = game.state.rewards;
  r.themes ||= {};
  for (const t of rewards.THEMES) {
    if (r.themes[t.id] || !t.test(tracks)) continue;
    r.themes[t.id] = game.dayKey();
    if (!silent && t.id !== 'copper') toastLine('🎨', `New accent unlocked: ${t.name}`, 'Try it on in your Profile.', 'gold', 5000);
  }
}

/** After anything that can unlock things: titles, themes, quests done. */
function checkUnlocks() {
  for (const t of rewards.checkTitles(tracks)) toastLine('🏷️', `New title: ${t.title}`, 'Wear it from your Profile.', 'gold', 5000);
  checkThemes(false);
}

function questsDone(fresh) {
  for (const q of fresh) {
    game.sound('quest');
    toastLine(q.icon, 'Quest complete', q.title, 'gold');
  }
  if (fresh.length && quests.allDone() && !game.state.quests.chest.opened) setTimeout(() => toastLine('🎁', 'All three quests done!', 'Your chest is waiting on the home page.', 'gold', 5000), 600);
}

function streakEvents(events) {
  for (const e of events) {
    if (e.type === 'freeze-used') toastLine('🧊', 'Streak saved', `A streak freeze covered ${e.days.length === 1 ? 'the day you missed' : `the ${e.days.length} days you missed`}.`, 'info', 6000);
    if (e.type === 'freeze-earned') { game.sound('freeze'); toastLine('❄️', 'Streak freeze earned', `You hold ${e.freezes} of ${habits.MAX_FREEZES}. It protects your streak if you miss a day.`, 'gold', 5000); }
    if (e.type === 'comeback') toastLine('👋', 'Welcome back!', `${e.gap} days away. Fresh start, same skills.`, 'gold', 5000);
    if (e.type === 'milestone') celebrate({
      big: e.days, eyebrow: 'Streak milestone', title: `${e.days}-day streak!`,
      text: habits.nextMilestone(e.days) ? `Next milestone: ${habits.nextMilestone(e.days)} days.` : 'The highest milestone. Legendary.',
      extra: h('p.small', `Every 7th day earns a streak freeze (you hold ${game.state.habit.freezes}).`),
    });
  }
}

function onEvent(type, d) {
  const s = game.state;
  if (type === 'session') { sessionStart = quests.snapshot(); return; }
  if (type === 'answer') mastery.recordAnswer(d.track, d.correct && d.firstTry);
  if (type === 'lesson') {
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 4) s.stats.nightOwl = (s.stats.nightOwl || 0) + 1;
    if (hour >= 4 && hour < 8) s.stats.earlyBird = (s.stats.earlyBird || 0) + 1;
  }
  questsDone(quests.track(type, d));
  if (type === 'xp') {
    streakEvents(habits.checkStreak());
    const lv = game.levelInfo();
    if (lv.level > (s.rewards.levelSeen || 0)) {
      s.rewards.levelSeen = lv.level;
      const unlocks = rewards.THEMES.filter(t => t.id === 'teal' && lv.level === 5).map(t => `${t.name} accent unlocked`);
      celebrate({ big: lv.level, eyebrow: 'Level up', title: lv.rank, sound: 'level',
        text: `${lv.need} XP to level ${lv.level + 1}.`, extra: unlocks.length > 0 && h('p.cel-unlock', unlocks.join(' · ')) });
    }
  }
  if (type === 'xp' || type === 'lesson' || type === 'challenge') checkUnlocks();
  game.save();
}

export function init(allTracks) {
  tracks = allTracks;
  game.registerAchievements(rewards.extraAchievements(tracks));
  rewards.registerTrackTitles(tracks);
  migrate();
  if (!game.state.rewards.levelSeen) game.state.rewards.levelSeen = game.levelInfo().level;
  streakEvents(habits.checkStreak());
  quests.today();
  const recap = habits.weeklyRecap();
  if (recap) setTimeout(() => toastLine(recap.tier.icon, `Last week: ${recap.tier.name}`,
    `${recap.xp.toLocaleString()} XP${recap.record ? ', a new personal best!' : recap.before ? ` (your best is ${recap.before.toLocaleString()})` : ''}. A new week starts now.`, 'gold', 8000), 900);
  applyTheme();
  game.on(onEvent);
  game.save();
  shownToday = game.todayXp();
}

/** After every page render: tick counters up and show anything that waited for the lesson to end. */
export function afterPage() {
  const goal = document.querySelector('.stat.goal b');
  const now = game.todayXp();
  if (goal && shownToday != null && now > shownToday) tick(goal, shownToday, now, 700);
  shownToday = now;
  tickAll();
  flush();
}

// ---------------------------------------------------------------- shared helpers

const currentTrack = () => tracks.find(t => t.id === sessionStorage.getItem('track')) || tracks[0];
/** Where to go to "pick up where you left off": { href, title, sub } or null. */
export function resumeTarget() {
  const t = currentTrack();
  const next = t && game.nextLesson(t);
  return next ? { href: `#/lesson/${next.key}`, title: next.lesson.title, sub: `${t.title} · ${next.module.title}`, track: t } : null;
}
const goHref = go => go === 'quick' ? '#/quick' : go === 'labs' ? '#/labs' : go === 'challenge' ? '#/challenge' : go === 'home' ? '#/' : resumeTarget()?.href || '#/';

/** Where a quest's progress stands: "3 / 10" or "40 / 50 XP". */
const fmtHave = q => `${q.have} / ${q.target}${q.unit ? ' ' + q.unit : ''}`;

// ---------------------------------------------------------------- header

/** The title worn in the header, or the level rank. */
export function headerTitle(rank) {
  const t = rewards.worn();
  return t ? t.title : rank;
}
export const freezes = () => game.state.habit.freezes || 0;

// ---------------------------------------------------------------- the Today panel (home)

export function todayPanel({ refresh } = {}) {
  const resume = resumeTarget();
  quests.track('view', {});            // quietly settle quests that read the state (XP, daily goal)
  const list = quests.list();
  const doneCount = list.filter(q => q.complete).length;
  const chest = game.state.quests.chest;

  // -- quests and the chest
  const chestBtn = h(`button.chest${quests.allDone() && !chest.opened ? '.ready' : ''}${chest.opened ? '.opened' : ''}`, {
    type: 'button', disabled: !quests.allDone() || chest.opened,
    title: chest.opened ? 'Opened today. New quests tomorrow.' : quests.allDone() ? 'Open it!' : 'Finish all three quests to open',
    onclick: e => openChest(e.currentTarget, refresh),
  }, h('span.chest-icon', chest.opened ? '📭' : '🎁'),
    h('span.chest-text', chest.opened ? `Opened · +${chest.xp} XP` : quests.allDone() ? 'Open your chest' : `Chest · ${doneCount}/3 quests`));

  const questCard = h('div.tcard.quests',
    h('div.tcard-head', h('h3', 'Daily quests'), h('span.muted.small', `${doneCount} / 3 · new quests at midnight`)),
    list.map(q => h(`a.quest${q.complete ? '.complete' : ''}`, { href: goHref(q.go), title: q.complete ? 'Done!' : 'Go do it' },
      h('span.quest-icon', q.complete ? '✓' : q.icon),
      h('div.quest-body',
        h('div.quest-title', q.title),
        h('div.bar', h('div.bar-fill', { style: { width: `${(q.have / q.target) * 100}%` } }))),
      h('span.quest-n.small', q.complete ? 'Done' : fmtHave(q)))),
    chestBtn);

  // -- daily challenge
  const c = quests.challengeToday();
  const cStreak = quests.challengeStreak();
  const challengeCard = h('div.tcard.challenge',
    h('div.tcard-head', h('h3', 'Daily challenge'), h('span.tag', '2× XP')),
    h('p.muted.small', 'One hard exercise from your topics, new every day.'),
    h('div.tc-line', h('span.big-num', cStreak), h('span.muted.small', `day challenge streak${game.state.challenge.best > 1 ? ` · best ${game.state.challenge.best}` : ''}`)),
    c.done
      ? h('div.tc-done', c.solved ? '✓ Won today. Back tomorrow for the next one.' : 'Answer shown today. A fresh one tomorrow.')
      : h('a.btn.primary', { href: '#/challenge' }, '⚔️ Take the challenge'));

  // -- weekly league
  const lg = habits.league();
  const maxBar = Math.max(lg.xp, lg.last, lg.best, 1);
  const barRow = (label, xp, cls) => h('div.lg-row', h('span.small.muted', label),
    h('div.lg-track', h(`div.lg-fill${cls}`, { style: { width: `${(xp / maxBar) * 100}%` } })), h('span.small', xp.toLocaleString()));
  const leagueCard = h('div.tcard.league',
    h('div.tcard-head', h('h3', 'Weekly league'), h('span.muted.small', `${7 - lg.weekDay} day${7 - lg.weekDay === 1 ? '' : 's'} left`)),
    h('div.tc-line', h('span.tier-icon', lg.tier ? lg.tier.icon : '·'),
      h('div', h('b', lg.tier ? lg.tier.name : 'Unranked'), h('div.muted.small', lg.tier ? 'vs. your own record' : 'Earn XP to enter this week'))),
    barRow('This week', lg.xp, '.now'), barRow('Last week', lg.last, ''), barRow('Your best', lg.best, '.best'),
    lg.next && h('p.small.tc-next', `${lg.next.need.toLocaleString()} XP to ${lg.next.tier.icon} ${lg.next.tier.name}`));

  // -- streak with freezes and the calendar
  const n = game.streak();
  const next = habits.nextMilestone(n);
  const fz = freezes();
  const cal = habits.calendar(4);
  const streakCard = h('div.tcard.streakcard',
    h('div.tcard-head', h('h3', 'Streak'),
      h('span.freezes', { title: `Streak freezes: ${fz} of ${habits.MAX_FREEZES}. Earn one every 7 days of streak; one is used automatically if you miss a day.` },
        Array.from({ length: habits.MAX_FREEZES }, (_, i) => h(`span.fz${i < fz ? '.on' : ''}`, '❄')))),
    h('div.tc-line', h('span.big-num', n), h('span.muted.small', `day${n === 1 ? '' : 's'}${game.state.habit.best > n ? ` · best ${game.state.habit.best}` : ''}`)),
    h('div.cal', ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => h('span.cal-h', d)),
      cal.map(d => h(`span.cal-d.${d.state}${d.today ? '.today' : ''}`, {
        title: `${d.key}: ${d.state === 'frozen' ? 'covered by a streak freeze' : `${d.xp} XP`}`,
      }, d.state === 'frozen' ? '❄' : ''))),
    h('p.small.tc-next', next ? `${next - n} day${next - n === 1 ? '' : 's'} to the ${next}-day milestone` : 'Past every milestone. Legendary.'));

  return h('section.today',
    h('div.today-head',
      h('div', h('div.eyebrow', 'Today'), h('h2', greeting())),
      h('div.today-actions',
        resume && h('a.btn.primary.big', { href: resume.href, onclick: () => sessionStorage.setItem('track', resume.track.id), title: resume.sub },
          '▶ Pick up where you left off'),
        h('a.btn.ghost.big', { href: '#/quick', title: 'Five due reviews or quick questions from lessons you finished' }, '⚡ Quick 5-minute session'))),
    resume && h('p.muted.small.today-resume', `Next up: ${resume.title} · ${resume.sub}`),
    h('div.today-grid', questCard, challengeCard, leagueCard, streakCard));
}

function greeting() {
  const left = game.state.settings.dailyGoal - game.todayXp();
  if (left <= 0) return 'Daily goal reached. Anything more is a bonus.';
  if (game.todayXp() === 0) return game.streak() > 0 ? `Keep your ${game.streak()}-day streak alive` : 'Start a streak today';
  return `${left} XP to your daily goal`;
}

async function openChest(btn, refresh) {
  const got = quests.openChest();
  if (!got) return;
  game.save(true);
  btn.disabled = true;
  btn.classList.remove('ready');
  btn.classList.add('opening');
  game.sound('chest');
  const num = h('b', { dataset: { prefix: '+', suffix: ' XP' } }, '+0 XP');
  btn.replaceChildren(h('span.chest-icon', '✨'), h('span.chest-text', got.lucky ? 'Lucky chest! ' : '', num, got.freeze ? ' + a streak freeze ❄' : ''));
  tick(num, 0, got.xp, 900);
  game.checkAchievements(tracks);
  setTimeout(() => refresh?.(), reducedMotion() ? 600 : 1800);
}

// ---------------------------------------------------------------- "One more?" after a lesson

/**
 * The pull to continue: the best next thing to do, with what this session moved on your quests.
 *   { track, key, practice, challenge }   (track/key of the lesson just finished, if any)
 */
export function oneMore({ track, key, practice } = {}) {
  const list = quests.list();
  const before = sessionStart || {};
  sessionStart = null;
  const picks = [];
  const add = (score, icon, title, sub, href) => picks.push({ score, icon, title, sub, href });

  const flat = track ? game.flatLessons(track) : [];
  const at = flat.findIndex(x => x.key === key);
  const nextInTrack = at >= 0 ? flat.slice(at + 1).find(x => !game.isDone(x.key) && game.isUnlocked(track, x.module, x.index)) : null;
  const resume = nextInTrack ? { href: `#/lesson/${nextInTrack.key}`, title: nextInTrack.lesson.title, sub: `${track.title} · ${nextInTrack.module.title}` } : resumeTarget();
  const nearQuest = list.filter(q => !q.complete && q.have > 0).sort((a, b) => b.have / b.target - a.have / a.target)[0];

  if (quests.allDone() && !game.state.quests.chest.opened) add(100, '🎁', 'Open your quest chest', 'All three quests are done', '#/');
  if (nearQuest) add(40 + 50 * (nearQuest.have / nearQuest.target),   // a nearly done quest wins; a barely started one does not nearQuest.icon, `Finish the quest: ${nearQuest.title}`,
    `${nearQuest.target - nearQuest.have}${nearQuest.unit ? ' ' + nearQuest.unit : ''} to go`, goHref(nearQuest.go));
  if (resume) add(practice ? 45 : 55, nextInTrack?.lesson.kind === 'boss' ? '👑' : '📘', nextInTrack ? `Next: ${resume.title}` : `Continue: ${resume.title}`, resume.sub, resume.href);
  const due = game.dueReviews().length;
  if (due > 0 && !practice) add(48, '🔁', `Clear ${Math.min(due, 5)} due review${due === 1 ? '' : 's'}`, 'A quick 5-minute session', '#/quick');
  if (!quests.challengeToday().done) add(50, '⚔️', 'Take the daily challenge', 'One hard exercise, double XP', '#/challenge');

  // The summary is on screen by the time these run: count its numbers up, then show any level-up.
  requestAnimationFrame(() => tickAll());
  setTimeout(flush, reducedMotion() ? 300 : 1400);

  const goalLeft = game.state.settings.dailyGoal - game.todayXp();
  const top = picks.sort((a, b) => b.score - a.score).filter((p, i, all) => all.findIndex(x => x.href === p.href) === i).slice(0, 3);

  return h('div.one-more',
    h('div.om-head', h('h3', 'One more?'),
      h('span.muted.small', goalLeft > 0 ? `${goalLeft} XP to your daily goal` : `Daily goal done · ${game.streak()}-day streak 🔥`)),
    h('div.om-picks', top.map((p, i) => h(`a.om-pick${i === 0 ? '.best' : ''}`, { href: p.href },
      h('span.om-icon', p.icon), h('div.om-text', h('div.om-title', p.title), h('div.muted.small', p.sub)),
      i === 0 && h('span.tag', 'Recommended')))),
    h('div.om-quests', list.map(q => {
      const was = Math.min(q.target, before[q.id] ?? q.have);
      const delta = q.have - was;
      const fill = h('div.bar-fill', { style: { width: `${(was / q.target) * 100}%` } });
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${(q.have / q.target) * 100}%`; }));
      return h(`div.omq${q.complete ? '.complete' : ''}`,
        h('span.omq-icon', q.complete ? '✓' : q.icon),
        h('div.omq-body', h('div.small', q.title), h('div.bar', fill)),
        h('span.small.omq-n', delta > 0 && h('b.delta', `+${delta}${q.unit ? ' ' + q.unit : ''}`), ` ${q.complete ? 'Done' : fmtHave(q)}`));
    })));
}

// ---------------------------------------------------------------- mastery views

/** A small ring and level name for a topic card. */
export function topicChip(track) {
  const m = mastery.mastery(track);
  return h(`div.mastery-chip.lv${m.levelIndex}`, { title: `${m.level} · ${m.score}% mastery. ${m.hint}` },
    ring(m.score / 100, '', 18), h('span', m.level), m.score > 0 && h('span.muted', `${m.score}%`));
}

/** The mastery panel on a track page: ring, the five levels, and the next milestone. */
export function trackMastery(track) {
  const m = mastery.mastery(track);
  return h('section.mastery-panel',
    ring(m.score / 100, `${m.score}%`, 76),
    h('div.grow',
      h('div.eyebrow', 'Topic mastery'),
      h('h3', m.level),
      h('div.mlevels', mastery.LEVELS.map((l, i) => h(`span.mlevel${i <= m.levelIndex ? '.on' : ''}${i === m.levelIndex ? '.current' : ''}`, { title: `${l.name} at ${l.at}%` }, l.name))),
      h('p.small.muted.mhint', `${m.hint}.`.replace(/\.\.$/, '.'))),
    h('div.mstats',
      h('div', h('b', `${m.done}/${m.total}`), h('span.muted.small', 'lessons')),
      h('div', h('b', `${m.stars}/${m.maxStars}`), h('span.muted.small', 'stars')),
      h('div', h('b', m.answers ? `${Math.round(m.accuracy * 100)}%` : '–'), h('span.muted.small', 'first-try'))));
}

// ---------------------------------------------------------------- profile

export function profilePanels(rerender) {
  const s = game.state, r = s.rewards;
  const lg = habits.league();
  const maxWeek = Math.max(1, ...lg.history.map(w => w.xp));
  const ranked = mastery.all(tracks);

  return [
    h('div.cards',
      h('div.card', h('b.card-num', `${s.habit.best || game.streak()}`), h('span.muted', 'best streak')),
      h('div.card', h('b.card-num', `${freezes()} ❄`), h('span.muted', `streak freezes (max ${habits.MAX_FREEZES})`)),
      h('div.card', h('b.card-num', s.stats.chests || 0), h('span.muted', 'quest chests opened')),
      h('div.card', h('b.card-num', `${quests.challengeStreak()} ⚔️`), h('span.muted', `challenge streak · best ${s.challenge.best || 0}`))),

    h('section.panel',
      h('h2', 'Weekly league'),
      h('p.muted.small', `You race your own record: ${habits.TIERS.map(t => `${t.icon} ${t.name} (${t.text.toLowerCase()})`).join(', ')}.`),
      h('div.lg-history', lg.history.map(w => h(`div.lg-week${w.current ? '.current' : ''}`, { title: `Week of ${w.week}: ${w.xp} XP${w.tier ? ` · ${w.tier.name}` : ''}` },
        h('span.small', w.tier ? w.tier.icon : ''),
        h('div.lg-col', h('div.lg-colfill', { style: { height: `${(w.xp / maxWeek) * 100}%` } })),
        h('span.muted.small', w.current ? 'now' : w.week.slice(5))))),
      h('p.small.muted', `Best week: ${lg.best.toLocaleString()} XP · this week: ${lg.xp.toLocaleString()} XP${lg.next ? ` · ${lg.next.need} XP to ${lg.next.tier.name}` : ''}`)),

    h('section.panel',
      h('h2', 'Topic mastery'),
      h('div.mastery-list', ranked.map(m => h('a.mastery-row', { href: `#/track/${m.track.id}` },
        ring(m.score / 100, `${m.score}`, 40),
        h('div.grow', h('div', h('strong', m.track.title), ' ', h('span.muted.small', m.level)), h('div.muted.small', m.hint)))))),

    h('section.panel',
      h('h2', 'Title'),
      h('p.muted.small', 'Wear a title in the header instead of your rank. Titles unlock with topic mastery, labs and habits.'),
      h('div.title-grid',
        h(`button.title-chip${!r.title ? '.worn' : ''}`, { type: 'button', onclick: () => { r.title = null; game.save(true); rerender(); } },
          h('strong', 'Your rank'), h('span.muted.small', game.levelInfo().rank)),
        rewards.TITLES.map(t => {
          const have = !!r.titles[t.id];
          return h(`button.title-chip${have ? '' : '.locked'}${r.title === t.id && have ? '.worn' : ''}`, {
            type: 'button', disabled: !have, title: have ? `Unlocked ${r.titles[t.id]}` : t.need,
            onclick: () => { r.title = t.id; game.save(true); rerender(); },
          }, h('strong', have ? t.title : `🔒 ${t.title}`), h('span.muted.small', t.need));
        }))),

    h('section.panel',
      h('h2', 'Accent'),
      h('div.theme-row', rewards.THEMES.map(t => {
        const have = t.test(tracks);
        return h(`button.theme-chip${(r.theme || 'copper') === t.id ? '.worn' : ''}${have ? '' : '.locked'}`, {
          type: 'button', disabled: !have, title: have ? t.name : t.need,
          onclick: () => { r.theme = t.id; applyTheme(); game.save(true); rerender(); },
        }, h('span.swatch', { style: { background: t.swatch } }), h('div', h('strong', t.name), h('div.muted.small', have ? 'Unlocked' : t.need)));
      }))),
  ];
}

// ---------------------------------------------------------------- sessions: quick 5 and the daily challenge

const lessonCache = new Map();
const lessonOf = key => {
  if (!lessonCache.has(key)) lessonCache.set(key, api(`lesson/${key}`).catch(() => null));
  return lessonCache.get(key);
};
const itemFor = (key, idx, step) => { const [track, module, lesson] = key.split('/'); return { step, lessonKey: key, idx, track, module, lesson }; };

/** Up to `size` quick items: due reviews first, then short questions from finished lessons. */
export async function quickItems(size = 5) {
  const picks = shuffle(game.dueReviews()).slice(0, size).map(r => ({ key: r.key, idx: r.idx }));
  for (const key of shuffle(Object.keys(game.state.lessons))) {
    if (picks.length >= size) break;
    const lesson = await lessonOf(key);
    const quick = shuffle((lesson?.steps || []).map((s, idx) => ({ s, idx })).filter(x => ['mcq', 'predict', 'match', 'order', 'blanks', 'sort'].includes(x.s.type)));
    const c = quick.find(x => !picks.some(p => p.key === key && p.idx === x.idx));
    if (c) picks.push({ key, idx: c.idx });
  }
  const items = [];
  for (const p of picks) {
    const step = (await lessonOf(p.key))?.steps[p.idx];
    if (step && step.type !== 'learn') items.push(itemFor(p.key, p.idx, step));
  }
  return items;
}

/** Today's challenge as a one-item session: { item, lessonTitle, trackTitle } or null. */
export async function loadChallenge() {
  const c = quests.challengeToday();
  for (let attempt = 0; attempt < 6; attempt++) {
    const key = c.key && attempt === 0 ? c.key : quests.challengeLesson(tracks, attempt + (c.key ? 1 : 0));
    if (!key) return null;
    const lesson = await lessonOf(key);
    if (!lesson) continue;
    const idx = c.key === key && c.idx != null ? c.idx : quests.hardestStep(lesson.steps, `${c.day}:${key}`);
    if (idx == null || !lesson.steps[idx]) continue;
    c.key = key; c.idx = idx;
    game.save();
    const t = tracks.find(x => x.id === key.split('/')[0]);
    return { item: itemFor(key, idx, lesson.steps[idx]), lessonTitle: lesson.title, trackTitle: t?.title || '' };
  }
  return null;
}

/** Records the result of the challenge and announces it. Returns the challenge record. */
export function finishChallenge(solved, xp) {
  const c = quests.finishChallenge(solved);
  game.emit('challenge', { solved, xp });
  if (solved) toastLine('⚔️', 'Daily challenge won', `${quests.challengeStreak()}-day challenge streak`, 'gold', 4500);
  game.save(true);
  return c;
}
export const challengeDone = () => quests.challengeToday().done;
