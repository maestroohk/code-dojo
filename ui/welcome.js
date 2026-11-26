// The welcome questionnaire (#/welcome): seven quick questions on first launch, or from Profile > Retake
// (docs/CURRICULUM.md 3.8). Answers become state.profile; pathrules.js turns them into "Your path" on the
// home page, a suggested dream per track, a daily goal and a pace. Learners who already have progress only
// ever see an optional banner ("Tailor the dojo to you"); nothing here blocks anyone.
import { h } from './util.js';
import * as game from './game.js';
import { recommend, suggestDreams, pacingFor } from './pathrules.js';
import { movePath } from './pacing.js';

const AREAS = [
  ['programming', 'Programming', '⌨'],
  ['web', 'Web', '🌐'],
  ['data', 'Data', '🗄'],
  ['devops', 'DevOps / Linux', '🐳'],
  ['security', 'Security', '🔒'],
];
const LEVELS = ['Never', 'A little (tutorials)', 'I use it at work', 'Confident'];

/** The questions, in order. `one` picks a single option, `many` up to `max`, `levels` rates each area. */
const QUESTIONS = [
  { id: 'goal', kind: 'one', title: 'What brings you here?', sub: 'Pick the one that matters most right now.', options: [
    ['career', '💼', 'Get a first developer job, or switch career'], ['upskill', '📈', 'Get better at my current job'],
    ['hobby', '🛠', 'Build things for myself'], ['interview', '🎯', 'Pass an interview or certification'] ] },
  { id: 'levels', kind: 'levels', title: 'How much have you done already?', sub: 'Be honest: it only decides where you start.' },
  { id: 'minutesPerDay', kind: 'one', title: 'How much time a day?', sub: 'Small and steady beats big and rare.', options: [
    [10, '☕', '10 minutes'], [20, '⏱', '20 minutes'], [45, '📘', '45 minutes'], [60, '🔥', 'An hour or more'] ] },
  { id: 'interests', kind: 'many', max: 3, title: 'Which of these excite you?', sub: 'Pick up to three. They choose the dream projects you build.', options: [
    ['games', '🎮', 'Games'], ['data', '📊', 'Data and charts'], ['web', '🕸', 'Websites and apps'], ['automation', '🤖', 'Automating chores'],
    ['security', '🔐', 'Security and privacy'], ['infra', '🏗', 'Servers and infrastructure'], ['productivity', '🗂', 'Money and productivity tools'] ] },
  { id: 'style', kind: 'one', title: 'How do you learn best?', sub: 'We will lean that way.', options: [
    ['visual', '👀', 'Seeing it move'], ['hands-on', '🧪', 'Trying things'], ['reading', '📖', 'Reading it properly first'] ] },
  { id: 'language', kind: 'one', title: 'Which language do you use, or want?', sub: 'Your path starts there.', options: [
    ['csharp', 'C#', 'C#'], ['python', '🐍', 'Python'], ['typescript', 'TS', 'JavaScript / TypeScript'], ['unsure', '🤷', 'No idea yet'] ] },
  { id: 'environment', kind: 'one', title: 'Where will you run things?', sub: 'Some projects need Docker; we will plan around it.', options: [
    ['windows', '🪟', 'Windows only'], ['windows-docker', '🐳', 'Windows + Docker Desktop'], ['wsl', '🐧', 'WSL or Linux too'] ] },
];

const blank = () => ({ goal: null, levels: {}, minutesPerDay: 20, interests: [], style: null, language: null, environment: null });

/** Save the answers with the plan they lead to, and set the daily goal from the time per day. */
export function saveProfile(answers, tracks) {
  const plan = recommend(answers, tracks);
  game.state.profile = {
    version: 1, ...answers,
    path: plan.path, why: plan.why,
    dreams: suggestDreams(answers, tracks, plan.path),
    pacing: plan.pacing,
    createdAt: game.state.profile?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  game.state.settings.dailyGoal = plan.pacing.dailyGoalXp;
  game.save(true);
  game.putProfile();                        // .state/profile.json (GET/PUT /api/profile)
}

/** The learner reordered "Your path": keep their order in the profile (and its file). */
function savePath(path) {
  game.state.profile = { ...game.state.profile, path, pathEdited: true, updatedAt: new Date().toISOString() };
  game.save();
  game.putProfile();
}

/** Fresh install with no progress and no profile: the welcome questions come first. */
export function shouldWelcome() {
  if (game.state.profile || game.state.welcomeSkipped) return false;
  return (game.state.xp || 0) === 0 && Object.keys(game.state.lessons || {}).length === 0;
}

export function welcomeView(page, tracks) {
  const { path, why, dreams, pacing, version, createdAt, updatedAt, ...saved } = game.state.profile || {};
  const answers = { ...blank(), ...saved };
  let at = 0;
  const body = h('div.wl-body');
  const dots = h('div.wl-dots');
  const answered = q => q.kind === 'many' || q.kind === 'levels' || answers[q.id] != null;

  function draw() {
    dots.replaceChildren(...[...QUESTIONS, null].map((_, i) => h(`span.wl-dot${i === at ? '.on' : i < at ? '.done' : ''}`)));
    if (at >= QUESTIONS.length) return drawResult();
    const q = QUESTIONS[at];
    let field;
    if (q.kind === 'levels') {
      field = h('div.wl-levels', AREAS.map(([id, label, icon]) => h('div.wl-level-row',
        h('span.wl-level-name', h('span.wl-icon', icon), label),
        h('div.wl-seg', { role: 'radiogroup', 'aria-label': label }, LEVELS.map((l, n) =>
          h(`button.wl-seg-btn${(answers.levels[id] ?? 0) === n ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String((answers.levels[id] ?? 0) === n),
            onclick: () => { answers.levels = { ...answers.levels, [id]: n }; draw(); } }, l))))));
    } else {
      field = h('div.wl-options', { role: q.kind === 'one' ? 'radiogroup' : 'group' }, q.options.map(([value, icon, label]) => {
        const on = q.kind === 'many' ? answers[q.id].includes(value) : answers[q.id] === value;
        const full = q.kind === 'many' && !on && answers[q.id].length >= (q.max || 99);
        return h(`button.wl-option${on ? '.on' : ''}`, { type: 'button', disabled: full, role: q.kind === 'one' ? 'radio' : 'checkbox', 'aria-checked': String(on), onclick: () => {
          if (q.kind === 'many') answers[q.id] = on ? answers[q.id].filter(v => v !== value) : [...answers[q.id], value];
          else { answers[q.id] = value; at++; }
          draw();
        } }, h('span.wl-option-icon', icon), h('span', label));
      }));
    }
    body.replaceChildren(
      h('div.eyebrow', `Question ${at + 1} of ${QUESTIONS.length}`),
      h('h1.wl-title', q.title), h('p.muted', q.sub), field,
      h('div.wl-nav',
        h('button.btn.ghost', { type: 'button', hidden: at === 0, onclick: () => { at--; draw(); } }, '← Back'),
        h('span.spacer'),
        h('button.btn.primary.big', { type: 'button', disabled: !answered(q), onclick: () => { at++; draw(); } }, at === QUESTIONS.length - 1 ? 'See my path' : 'Next')));
  }

  function drawResult() {
    const plan = recommend(answers, tracks);
    const suggested = suggestDreams(answers, tracks, plan.path);
    const pace = pacingFor(answers);
    body.replaceChildren(
      h('div.eyebrow', 'Your path'),
      h('h1.wl-title', 'Here is where we would start'),
      h('p.muted', `About ${answers.minutesPerDay} minutes a day: up to ${pace.newLessonsPerDay} new lesson${pace.newLessonsPerDay === 1 ? '' : 's'} a day, and a daily goal of ${pace.dailyGoalXp} XP. Change any of it later in Profile.`),
      h('ol.wl-path', plan.path.map((id, i) => {
        const t = tracks.find(x => x.id === id);
        const dream = (t.dreams || []).find(d => d.id === suggested[id]);
        return h(`li.wl-path-step${i === 0 ? '.first' : ''}`, h('span.wl-path-icon', t.icon || t.title.slice(0, 2)),
          h('div.grow', h('b', t.title), h('div.muted.small', `Because ${plan.why[id] || 'it fits'}.`, dream ? ` You would build ${dream.title}.` : '')));
      })),
      h('div.wl-nav',
        h('button.btn.ghost', { type: 'button', onclick: () => { at--; draw(); } }, '← Back'),
        h('span.spacer'),
        h('button.btn.primary.big', { type: 'button', onclick: () => { saveProfile(answers, tracks); location.hash = '#/'; } }, 'Start my path')));
  }

  page('home', h('section.wl',
    h('div.wl-head', dots,
      h('button.btn.ghost.small', { type: 'button', onclick: () => { game.state.welcomeSkipped = true; game.save(true); location.hash = '#/'; } }, 'Skip for now')),
    body));
  draw();
}

/** Home page: the recommended path with the next step highlighted, or an optional banner to make one. */
export function pathPanel(tracks, { nextLesson, trackProgress, editing: editingStart = false }) {
  const profile = game.state.profile;
  if (!profile) {
    if (game.state.tailorDismissed) return null;
    return h('section.wl-banner',
      h('div', h('div.eyebrow', 'New'), h('h2', 'Tailor the dojo to you'),
        h('p.muted', 'Seven quick questions, under two minutes. You get a path through the topics, dream projects that fit you and a daily goal that suits your time.')),
      h('div.wl-banner-actions',
        h('a.btn.primary', { href: '#/welcome' }, 'Tailor it'),
        h('button.btn.ghost', { type: 'button', onclick: e => { game.state.tailorDismissed = true; game.save(); e.currentTarget.closest('.wl-banner').remove(); } }, 'Not now')));
  }
  const path = Array.isArray(profile.path) ? profile.path : recommend(profile, tracks).path;
  const steps = path.map(id => tracks.find(t => t.id === id)).filter(Boolean);
  if (!steps.length) return null;
  const current = steps.find(t => nextLesson(t)) || null;
  let editing = false;
  const ids = steps.map(t => t.id);
  const redraw = focusId => {
    const fresh = pathPanel(tracks, { nextLesson, trackProgress, editing: true });
    section.replaceWith(fresh);
    // Keep keyboard focus on the moved topic's arrow (the other arrow when that one is now disabled).
    const [id, dir] = focusId || [];
    const btns = id ? [`${id}-${dir}`, `${id}-${dir === 'up' ? 'down' : 'up'}`].map(k => fresh.querySelector(`[data-move="${k}"]`)) : [];
    btns.find(b => b && !b.disabled)?.focus();
  };
  const move = (id, delta, to) => { savePath(movePath(ids, id, delta, to)); redraw([id, delta > 0 ? 'down' : 'up']); };
  let dragId = null;
  const section = h('section.wl-yourpath',
    h('div.wl-yourpath-head', h('div', h('div.eyebrow', 'Your path'), h('h2', current ? `Next: ${nextLesson(current).lesson.title}` : 'Path complete')),
      h('div.wl-yourpath-actions',
        h('button.btn.ghost.small', { type: 'button', 'aria-pressed': 'false', onclick: e => {
          editing = !editing;
          section.classList.toggle('editing', editing);
          e.currentTarget.setAttribute('aria-pressed', String(editing));
          e.currentTarget.textContent = editing ? 'Done' : 'Reorder';
        } }, 'Reorder'),
        h('a.btn.ghost.small', { href: '#/welcome' }, 'Retake'))),
    h('p.muted.small.wl-reorder-tip', 'Drag a topic, or use its arrows, to put your path in the order you want. It is saved to your profile.'),
    h('ol.wl-path.row', steps.map((t, i) => {
      const prog = trackProgress(t);
      const done = prog.total > 0 && prog.done === prog.total;
      const now = t === current;
      const next = now && nextLesson(t);
      return h(`li.wl-path-step${now ? '.now' : ''}${done ? '.done' : ''}`, {
        title: profile.why?.[t.id] ? `Because ${profile.why[t.id]}` : '',
        dataset: { id: t.id },
        ondragstart: e => { if (!section.classList.contains('editing')) return e.preventDefault(); dragId = t.id; e.dataTransfer.effectAllowed = 'move'; },
        ondragover: e => { if (dragId && dragId !== t.id) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
        ondragleave: e => e.currentTarget.classList.remove('drop'),
        ondrop: e => { e.preventDefault(); if (dragId && dragId !== t.id) move(dragId, 0, ids.indexOf(t.id)); dragId = null; },
        ondragend: () => { dragId = null; },
      },
        h('a.wl-path-link', { href: now && next ? `#/lesson/${next.key}` : `#/track/${t.id}`, onclick: () => sessionStorage.setItem('track', t.id) },
          h('span.wl-path-icon', done ? '✓' : t.icon || t.title.slice(0, 2)),
          h('div.grow', h('b', t.title), h('div.muted.small', now && next ? `Continue: ${next.lesson.title}` : `${prog.done}/${prog.total} lessons`)),
          h('div.bar', h('div.bar-fill', { style: { width: `${(prog.done / Math.max(1, prog.total)) * 100}%` } }))),
        h('div.wl-move',
          h('button.icon-btn.small', { type: 'button', 'data-move': `${t.id}-up`, disabled: i === 0, 'aria-label': `Move ${t.title} earlier`, onclick: () => move(t.id, -1) }, '↑'),
          h('button.icon-btn.small', { type: 'button', 'data-move': `${t.id}-down`, disabled: i === steps.length - 1, 'aria-label': `Move ${t.title} later`, onclick: () => move(t.id, +1) }, '↓')));
    })));
  // Steps are draggable only while reordering, so a normal click on the card still opens the topic.
  const setDraggable = () => section.querySelectorAll('li.wl-path-step').forEach(li => { li.draggable = section.classList.contains('editing'); });
  new MutationObserver(setDraggable).observe(section, { attributes: true, attributeFilter: ['class'] });
  if (editingStart) { editing = true; section.classList.add('editing'); const b = section.querySelector('[aria-pressed]'); b.setAttribute('aria-pressed', 'true'); b.textContent = 'Done'; }
  setDraggable();
  return section;
}
