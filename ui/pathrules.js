// How the welcome answers (#/welcome) become a plan: an ordered path of tracks, a suggested dream per track
// and a pace. The rules follow docs/CURRICULUM.md 3.8 and every one of them is a small table below, so
// tuning the dojo's advice means editing data, not code. Track ids that do not exist are skipped.
//
//   profile = { version, goal, levels: { area: 0..3 }, minutesPerDay, interests: [theme], style, language,
//               environment, path: [trackId], dreams: { trackId: dreamId }, pacing, why: { trackId: reason }, createdAt }

/** Rule 1, "unsure" language: the first interest that names one decides; otherwise C#. */
export const LANGUAGE_FOR_INTEREST = { games: 'csharp', productivity: 'csharp', data: 'python', automation: 'python', web: 'typescript' };
export const DEFAULT_LANGUAGE = 'csharp';

/** Rule 1: never programmed -> fundamentals first. */
export const BEGINNER_TRACK = 'fundamentals';

/**
 * Rule 2: interest -> topics appended after the language track, in order, without duplicates.
 * A function gets the learner's language, for choices that depend on it.
 */
export const INTEREST_TRACKS = {
  games:        () => ['dsa', 'design'],
  data:         lang => (lang === 'python' ? ['sql', 'datascience'] : ['sql', 'efcore']),
  web:          lang => [...(lang === 'typescript' ? [] : ['typescript']), 'networking', 'auth'],
  automation:   lang => ['linux', 'editors', 'git', ...(lang === 'python' ? [] : ['python'])],
  security:     () => ['networking', 'pki', 'crypto', 'auth'],
  infra:        () => ['linux', 'editors', 'networking', 'docker', 'cicd', 'kubernetes'],
  productivity: lang => ['git', 'sql', ...(lang === 'csharp' ? ['efcore'] : [])],
};

/** Rule 3, upskill: topics of an area the learner already knows well (level >= 2) move to the end. */
export const AREA_TRACKS = {
  programming: ['fundamentals', 'csharp', 'python', 'typescript', 'dsa', 'design'],
  web: ['typescript', 'networking', 'auth'],
  data: ['sql', 'datascience', 'efcore'],
  devops: ['linux', 'editors', 'git', 'docker', 'cicd', 'kubernetes'],
  security: ['pki', 'crypto', 'auth'],
};

/** Rule 3: goal adjustments, applied in this order. */
export const GOAL_RULES = {
  career:    { after: { git: 'language' }, beforeEnd: ['docker'], gate: 'standard' },
  upskill:   { knownToEnd: true, gate: 'standard' },
  interview: { at: { dsa: 1, design: 2 }, gate: 'standard' },
  hobby:     { cap: 4, gate: 'relaxed' },
};

/** Rule 5: dream scoring. */
export const DREAM_SCORE = { perMatchingTag: 2, reusesChosenArtifact: 1, needsDockerOnWindowsOnly: -1 };

/** Rule 6: pacing. */
export const PACING = { xpPerMinute: 3, minutesPerLesson: 12, maxNewLessonsPerDay: 4 };

const languageOf = p => (p.language && p.language !== 'unsure'
  ? p.language
  : (p.interests || []).map(i => LANGUAGE_FOR_INTEREST[i]).find(Boolean) || DEFAULT_LANGUAGE);

export function pacingFor(profile) {
  const minutes = profile?.minutesPerDay ?? 20;
  return {
    dailyGoalXp: minutes * PACING.xpPerMinute,
    newLessonsPerDay: Math.min(PACING.maxNewLessonsPerDay, Math.max(1, Math.floor(minutes / PACING.minutesPerLesson))),
    gateStrictness: GOAL_RULES[profile?.goal]?.gate || 'standard',
  };
}

/**
 * The plan for a profile: { path, why, pacing }. `why[trackId]` is the rule that put it there, so the UI can say
 * "because you like automation".
 */
export function recommend(profile, tracks) {
  if (!profile) return { path: [], why: {}, pacing: pacingFor(null) };
  const exists = new Set(tracks.map(t => t.id));
  const lang = languageOf(profile);
  let path = [];
  const why = {};
  const add = (id, reason, at = path.length) => {
    if (!exists.has(id) || path.includes(id)) return;
    path.splice(Math.min(at, path.length), 0, id);
    why[id] = reason;
  };

  // 1. Language first; beginners start with fundamentals.
  add(lang, profile.language && profile.language !== 'unsure' ? 'your language' : 'a good first language for what you like');
  if ((profile.levels?.programming ?? 0) === 0) add(BEGINNER_TRACK, 'you are new to programming', 0);
  // 2. Interests, in the order they were picked.
  for (const i of profile.interests || []) for (const id of INTEREST_TRACKS[i]?.(lang) || []) add(id, `you like ${i}`);
  // 3. Goal adjustments.
  const g = GOAL_RULES[profile.goal] || {};
  for (const [id, anchor] of Object.entries(g.after || {})) {
    path = path.filter(x => x !== id);
    add(id, `useful in every ${profile.goal === 'career' ? 'job' : 'team'}`, path.indexOf(anchor === 'language' ? lang : anchor) + 1);
  }
  for (const id of g.beforeEnd || []) { path = path.filter(x => x !== id); add(id, 'employers expect it', Math.max(0, path.length - 1)); }
  for (const [id, at] of Object.entries(g.at || {})) { path = path.filter(x => x !== id); add(id, 'interviews ask about it', at); }
  if (g.knownToEnd) {
    const known = Object.entries(AREA_TRACKS).filter(([area]) => (profile.levels?.[area] ?? 0) >= 2).flatMap(([, ids]) => ids);
    path = [...path.filter(id => !known.includes(id)), ...path.filter(id => known.includes(id))];
  }
  if (g.cap) path = path.slice(0, g.cap);
  return { path, why, pacing: pacingFor(profile) };
}

/**
 * Rule 5: the dream of a track that best fits the profile (+2 per tag in interests, +1 when it reuses an artifact
 * already chosen, -1 when it needs Docker on a Windows-only machine). Ties go to the flagship (first). Null without
 * a profile, so callers fall back to the flagship.
 */
export function suggestDream(track, dreams, profile) {
  if (!dreams?.length || !profile) return null;
  const likes = new Set(profile.interests || []);
  const chosen = new Set(Object.values(profile.dreams || {}));
  let best = dreams[0].id, bestScore = -Infinity;
  for (const d of dreams) {
    let n = (d.tags || []).filter(t => likes.has(t)).length * DREAM_SCORE.perMatchingTag;
    if ((d.reuses || []).some(id => chosen.has(id))) n += DREAM_SCORE.reusesChosenArtifact;
    if ((d.needs || []).includes('docker') && profile.environment === 'windows') n += DREAM_SCORE.needsDockerOnWindowsOnly;
    if (n > bestScore) { best = d.id; bestScore = n; }
  }
  return best;
}

/** Dreams per track in the path, for the stored profile. */
export function suggestDreams(profile, tracks, path) {
  const out = {};
  for (const id of path) {
    const t = tracks.find(x => x.id === id);
    const dreams = Array.isArray(t?.dreams) ? t.dreams : [];
    if (dreams.length) out[id] = suggestDream(t, dreams, { ...profile, dreams: out });
  }
  return out;
}
