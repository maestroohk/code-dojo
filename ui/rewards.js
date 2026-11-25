// Rewards: titles you can wear in the header, accent themes, and the extra achievements.
// Pure rules on game.state (no DOM).
import * as game from './game.js';
import * as habits from './habits.js';
import { levelOf, mastery } from './mastery.js';

const PRACTITIONER = 2, EXPERT = 3, MASTER = 4;
const solvedIn = lab => {
  const s = game.state.labs[lab]?.solved;
  return typeof s === 'number' ? s : s ? Object.keys(s).length : 0;
};
const lessonsIn = id => Object.keys(game.state.lessons).filter(k => k.startsWith(id + '/')).length;
const topicsStarted = tracks => tracks.filter(t => lessonsIn(t.id) > 0).length;
/** Every lesson of a module whose id matches `re`, in a track, is finished. */
const moduleDone = (tracks, trackId, re) => {
  const t = tracks.find(x => x.id === trackId);
  return !!t && game.lessonModules(t).some(m => re.test(m.id) && m.lessons.every(l => game.isDone(game.lessonKey(t, m, l))));
};

// ---------------------------------------------------------------- titles
// `test(tracks)` unlocks the title; `need` says how. Topic titles need Practitioner mastery
// (or a lab feat that shows the same skill).

const topic = (id, track, title, extra, extraText) => ({
  id, title, need: `Reach Practitioner in ${track}${extraText ? `, or ${extraText}` : ''}`,
  test: tracks => levelOf(tracks, id.split(':')[1]) >= PRACTITIONER || (extra ? extra(tracks) : false),
});

export const TITLES = [
  { id: 'initiate', title: 'Dojo Initiate', need: 'Always yours', test: () => true },
  topic('t:networking', 'Networking & HTTP', 'Packet Whisperer', () => solvedIn('subnet') >= 50, 'answer 50 subnetting questions'),
  topic('t:csharp', 'C#', 'LINQ Sorcerer', tracks => moduleDone(tracks, 'csharp', /linq/i), 'finish the LINQ module'),
  topic('t:linux', 'Linux & the shell', 'Shell Ninja'),
  topic('t:pki', 'Certificates & PKI', 'Cert Wrangler', () => solvedIn('pki') >= 4, 'solve 4 certificate lab challenges'),
  topic('t:editors', 'Terminal editors', 'Vim Escape Artist', () => solvedIn('vim') >= 10, 'solve 10 Vim challenges'),
  topic('t:python', 'Python', 'Pythonista'),
  topic('t:typescript', 'JavaScript & TypeScript', 'Type Tamer'),
  topic('t:dsa', 'Data structures & algorithms', 'Big-O Hunter'),
  topic('t:design', 'Code design', 'Pattern Smith'),
  topic('t:auth', 'Authentication & JWT', 'Token Keeper'),
  topic('t:crypto', 'Cryptography', 'Cipher Smith'),
  topic('t:git', 'Git', 'Branch Surgeon'),
  topic('t:docker', 'Docker', 'Container Captain'),
  topic('t:kubernetes', 'Kubernetes', 'Pod Shepherd'),
  topic('t:cicd', 'CI/CD', 'Pipeline Plumber'),
  topic('t:integration', 'Integration', 'Gateway Keeper'),
  topic('t:fundamentals', 'Programming fundamentals', 'First Principles'),
  topic('t:datascience', 'Data science', 'Data Wrangler'),
  topic('t:sql', 'SQL & databases', 'Query Whisperer'),
  { id: 'streak', title: 'Streak Keeper', need: 'Keep a 7-day streak', test: () => (game.state.habit.best || 0) >= 7 },
  { id: 'bosses', title: 'Boss Hunter', need: 'Beat 5 bosses', test: () => game.state.stats.bosses >= 5 },
  { id: 'polyglot', title: 'Polyglot', need: 'Finish lessons in 5 different topics', test: tracks => topicsStarted(tracks) >= 5 },
  { id: 'quester', title: 'Quest Runner', need: 'Open 10 quest chests', test: () => (game.state.stats.chests || 0) >= 10 },
  { id: 'duelist', title: 'Duelist', need: 'Win the daily challenge 7 days in a row', test: () => (game.state.challenge.best || 0) >= 7 },
  { id: 'owl', title: 'Night Owl', need: 'Finish 5 lessons after 11 pm', test: () => (game.state.stats.nightOwl || 0) >= 5 },
  { id: 'lark', title: 'Early Bird', need: 'Finish 5 lessons before 8 am', test: () => (game.state.stats.earlyBird || 0) >= 5 },
  { id: 'diamond', title: 'Diamond Mind', need: 'Reach Diamond in the weekly league', test: () => game.state.league.bestTier === 'diamond' },
  { id: 'grandmaster', title: 'Grandmaster', need: 'Reach Master in any topic', test: tracks => tracks.some(t => mastery(t).levelIndex >= MASTER) },
];

/** New topics get a title too ("<Topic> Adept") until someone names a better one above. */
export function registerTrackTitles(tracks) {
  for (const t of tracks) {
    if (TITLES.some(x => x.id === `t:${t.id}`)) continue;
    const at = TITLES.findIndex(x => x.id === 'streak');
    TITLES.splice(at, 0, topic(`t:${t.id}`, t.title, `${t.title} Adept`));
  }
}

/** Titles unlocked just now (recorded in state.rewards.titles). */
export function checkTitles(tracks) {
  const r = game.state.rewards, fresh = [];
  for (const t of TITLES) {
    if (r.titles[t.id]) continue;
    let ok = false;
    try { ok = t.test(tracks); } catch { /* never break the app over a title */ }
    if (ok) { r.titles[t.id] = game.dayKey(); if (t.id !== 'initiate') fresh.push(t); }
  }
  return fresh;
}

/** The title being worn, or null. */
export const worn = () => TITLES.find(t => t.id === game.state.rewards.title && game.state.rewards.titles[t.id]) || null;

// ---------------------------------------------------------------- accent themes
// Each sets the accent tokens in styles.css (html[data-accent=...]). No purple, on purpose.

export const THEMES = [
  { id: 'copper', name: 'Copper', swatch: '#d9773f', need: 'The dojo default', test: () => true },
  { id: 'teal', name: 'Teal', swatch: '#2a9d8f', need: 'Reach level 5', test: () => game.levelInfo().level >= 5 },
  { id: 'amber', name: 'Amber', swatch: '#c98a1e', need: 'Keep a 7-day streak', test: () => (game.state.habit.best || 0) >= 7 },
  { id: 'slate', name: 'Slate', swatch: '#6f8aa6', need: 'Reach Practitioner in any topic', test: tracks => tracks.some(t => mastery(t).levelIndex >= PRACTITIONER) },
];
export const themeUnlocked = (id, tracks) => !!THEMES.find(t => t.id === id)?.test(tracks);

// ---------------------------------------------------------------- achievements
// Registered with game.registerAchievements once the tracks are known.

export function extraAchievements(tracks) {
  const perTopic = tracks.map(t => ({
    id: `first-${t.id}`, icon: t.icon && t.icon.length <= 2 ? t.icon : '📗', title: `First steps: ${t.title}`,
    text: `Finish your first ${t.title} lesson.`, test: () => lessonsIn(t.id) >= 1,
  }));
  const n = () => Object.keys(game.state.lessons).length;
  return [
    ...perTopic,
    { id: 'lessons-50', icon: '📖', title: 'Scholar', text: 'Finish 50 lessons.', test: () => n() >= 50 },
    { id: 'lessons-100', icon: '🎓', title: 'Centurion', text: 'Finish 100 lessons.', test: () => n() >= 100 },
    { id: 'lessons-250', icon: '🏛️', title: 'Living library', text: 'Finish 250 lessons.', test: () => n() >= 250 },
    { id: 'topics-3', icon: '🧭', title: 'Explorer', text: 'Finish lessons in 3 different topics.', test: () => topicsStarted(tracks) >= 3 },
    { id: 'topics-10', icon: '🗺️', title: 'Renaissance', text: 'Finish lessons in 10 different topics.', test: () => topicsStarted(tracks) >= 10 },
    { id: 'module-bosses', icon: '⚔️', title: 'Clean sweep', text: 'Beat every boss in a module.', test: () => tracks.some(t => game.lessonModules(t).some(m => {
      const bosses = m.lessons.filter(l => l.kind === 'boss');
      return bosses.length > 0 && bosses.every(l => game.isDone(game.lessonKey(t, m, l)));
    })) },
    { id: 'bosses-10', icon: '🐉', title: 'Dragon slayer', text: 'Beat 10 bosses.', test: s => s.stats.bosses >= 10 },
    { id: 'practitioner', icon: '🥋', title: 'Practitioner', text: 'Reach Practitioner mastery in a topic.', test: () => tracks.some(t => mastery(t).levelIndex >= PRACTITIONER) },
    { id: 'expert', icon: '🧠', title: 'Expert', text: 'Reach Expert mastery in a topic.', test: () => tracks.some(t => mastery(t).levelIndex >= EXPERT) },
    { id: 'master', icon: '🏯', title: 'Master', text: 'Reach Master mastery in a topic.', test: () => tracks.some(t => mastery(t).levelIndex >= MASTER) },
    { id: 'streak-14', icon: '🌄', title: 'Two weeks strong', text: 'Keep a 14-day streak.', test: () => game.streak() >= 14 },
    { id: 'streak-60', icon: '🌋', title: 'Iron will', text: 'Keep a 60-day streak.', test: () => game.streak() >= 60 },
    { id: 'streak-100', icon: '💯', title: 'Triple digits', text: 'Keep a 100-day streak.', test: () => game.streak() >= 100 },
    { id: 'freeze-used', icon: '🧊', title: 'Saved by the ice', text: 'A streak freeze protected your streak.', test: s => (s.habit.usedFreezes || 0) >= 1 },
    { id: 'perfect-week', icon: '🗓️', title: 'Perfect week', text: 'Reach your daily goal every day from Monday to Sunday.', test: () => habits.hadPerfectWeek() },
    { id: 'night-owl', icon: '🦉', title: 'Night owl', text: 'Finish a lesson after 11 pm.', test: s => (s.stats.nightOwl || 0) >= 1 },
    { id: 'early-bird', icon: '🐦', title: 'Early bird', text: 'Finish a lesson before 8 am.', test: s => (s.stats.earlyBird || 0) >= 1 },
    { id: 'comeback', icon: '🔄', title: 'Comeback', text: 'Come back and learn after a week or more away.', test: s => (s.stats.comebacks || 0) >= 1 },
    { id: 'chest-1', icon: '🎁', title: 'Treasure', text: 'Finish all three daily quests and open the chest.', test: s => (s.stats.chests || 0) >= 1 },
    { id: 'chest-7', icon: '🗝️', title: 'Treasure hunter', text: 'Open 7 quest chests.', test: s => (s.stats.chests || 0) >= 7 },
    { id: 'chest-30', icon: '👑', title: 'Hoard', text: 'Open 30 quest chests.', test: s => (s.stats.chests || 0) >= 30 },
    { id: 'challenge-1', icon: '⚔️', title: 'Challenger', text: 'Win a daily challenge.', test: s => (s.challenge.wins || 0) >= 1 },
    { id: 'challenge-7', icon: '🛡️', title: 'Week of duels', text: 'Win the daily challenge 7 days in a row.', test: s => (s.challenge.best || 0) >= 7 },
    { id: 'league-gold', icon: '🥇', title: 'Gold week', text: 'Finish a week in the Gold tier or higher.', test: s => ['gold', 'platinum', 'diamond'].includes(s.league.bestTier) },
    { id: 'league-diamond', icon: '💎', title: 'Diamond week', text: 'Finish a week in the Diamond tier.', test: s => s.league.bestTier === 'diamond' },
    { id: 'record-week', icon: '📈', title: 'Personal best', text: 'Beat your best week of XP.', test: () => habits.league().record },
    { id: 'xp-10000', icon: '🌌', title: 'Five digits', text: 'Earn 10,000 XP.', test: s => s.xp >= 10000 },
    { id: 'lab-pki', icon: '🔐', title: 'Chain of trust', text: 'Solve every challenge in the certificate chain lab.', test: () => solvedIn('pki') >= 8 },
    { id: 'lab-subnet', icon: '🧮', title: 'Subnet savant', text: 'Answer 100 subnetting questions right.', test: () => solvedIn('subnet') >= 100 },
    { id: 'lab-vim-1', icon: '🚪', title: 'I can quit Vim', text: 'Solve your first Vim challenge.', test: () => solvedIn('vim') >= 1 },
    { id: 'lab-vim-all', icon: '🧙', title: 'Vim wizard', text: 'Solve 30 Vim and nano challenges.', test: () => solvedIn('vim') >= 30 },
    { id: 'labs-3', icon: '🧪', title: 'Mad scientist', text: 'Solve something in 3 different labs.', test: () => ['pki', 'subnet', 'vim'].filter(l => solvedIn(l) > 0).length >= 3 },
  ];
}
