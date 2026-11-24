// Views and the lesson player. Routes: #/  #/lesson/t/m/l  #/practice  #/playground  #/profile
import { h, md, inline, api, shuffle, ask } from './util.js';
import * as game from './game.js';
import { renderStep, renderRunOutput, DRAG_TYPES, TYPE_LABEL } from './steps.js';
import { createEditor } from './editor.js';

const app = document.getElementById('app');
let tracks = [];
let leave = null;              // cleanup for the current view

// ---------------------------------------------------------------- shell

function toast(node, kind = '') {
  const host = document.getElementById('toasts');
  const el = h(`div.toast.${kind || 'info'}`, node);
  host.append(el);
  setTimeout(() => el.classList.add('out'), 3600);
  setTimeout(() => el.remove(), 4100);
}

function announce(fresh) {
  for (const a of fresh) toast([h('span.toast-icon', a.icon), h('div', h('strong', 'Achievement unlocked'), h('div', a.title))], 'gold');
}

function confetti() {
  const canvas = h('canvas.confetti');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const W = canvas.width = innerWidth, H = canvas.height = innerHeight;
  const colors = ['#7c5cff', '#22c98a', '#ffb020', '#ff5d73', '#36b3ff'];
  const bits = Array.from({ length: 110 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 200, y: H * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 3,
    s: 4 + Math.random() * 6, r: Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.32; b.x += b.vx; b.y += b.vy; b.r += 0.2; b.vx *= 0.99;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6); ctx.restore();
    }
    if (++frame < 150) requestAnimationFrame(tick); else canvas.remove();
  })();
}

function header(active) {
  const lv = game.levelInfo();
  const goal = game.state.settings.dailyGoal;
  const today = game.todayXp();
  const days = game.streak();
  const link = (hash, label, id) => h(`a.nav-link${active === id ? '.active' : ''}`, { href: hash }, label);
  const due = game.dueReviews().length;
  return h('header.top',
    h('a.brand', { href: '#/' }, h('span.brand-mark', '{ }'), h('span', 'code-dojo')),
    h('nav.nav',
      link('#/', 'Learn', 'home'),
      h(`a.nav-link${active === 'practice' ? '.active' : ''}`, { href: '#/practice' }, 'Practice', due > 0 && h('span.badge', due)),
      link('#/playground', 'Playground', 'playground'),
      link('#/profile', 'Profile', 'profile')),
    h('div.stats',
      h(`div.stat.streak${days > 0 && game.state.days[game.dayKey()] ? '.lit' : ''}`, { title: `${days}-day streak` }, h('span', '🔥'), h('b', days)),
      h('div.stat.goal', { title: `Daily goal: ${today} of ${goal} XP` },
        h('div.ring', { style: { '--p': Math.min(1, today / goal) } }), h('b', `${today}`), h('span.muted', `/ ${goal} XP`)),
      h('a.stat.level', { href: '#/profile', title: `${lv.rank}: ${lv.into} of ${lv.need} XP to the next level` },
        h('span.level-num', lv.level),
        h('div.level-meta', h('span.level-rank', lv.rank), h('div.bar', h('div.bar-fill', { style: { width: `${(lv.into / lv.need) * 100}%` } }))))));
}

function page(active, ...content) {
  app.replaceChildren(header(active), h('main.page', content));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- home / map

function stars(n, max = 3) {
  return h('span.stars', Array.from({ length: max }, (_, i) => h(`span.star${i < n ? '.on' : ''}`, '★')));
}

function home() {
  if (!tracks.length) return page('home', h('div.empty', h('h2', 'No tracks found'), h('p', 'Add a folder under tracks/ and refresh.')));
  const wanted = sessionStorage.getItem('track');
  const track = tracks.find(t => t.id === wanted) || tracks[0];
  const prog = game.trackProgress(track);
  const next = game.nextLesson(track);
  const first = prog.done === 0;

  const hero = next
    ? h('section.hero',
      h('div',
        h('div.eyebrow', first ? 'Start here' : 'Continue'),
        h('h1', next.lesson.title),
        h('p.muted', `${next.module.title} · ${next.lesson.kind === 'boss' ? 'Boss challenge' : `about ${next.lesson.minutes || 10} min`}`),
        h('p', next.lesson.summary || '')),
      h('a.btn.primary.big', { href: `#/lesson/${next.key}` }, first ? 'Start learning' : 'Continue'))
    : h('section.hero', h('div', h('div.eyebrow', 'Track complete'), h('h1', `You finished ${track.title} 🏆`),
      h('p.muted', 'Replay lessons for three stars, or keep sharp in Practice.')), h('a.btn.primary.big', { href: '#/practice' }, 'Practice'));

  const modules = track.modules.map((m, mi) => {
    const done = m.lessons.filter(l => game.isDone(game.lessonKey(track, m, l))).length;
    return h('section.module',
      h('div.module-head',
        h('div.module-num', String(mi + 1).padStart(2, '0')),
        h('div.module-text', h('h2', m.title), h('p.muted', m.summary || '')),
        h('div.module-prog', h('span', `${done} / ${m.lessons.length}`), h('div.bar', h('div.bar-fill', { style: { width: `${(done / Math.max(1, m.lessons.length)) * 100}%` } })))),
      h('div.lessons', m.lessons.map((l, li) => {
        const key = game.lessonKey(track, m, l);
        const rec = game.state.lessons[key];
        const open = game.isUnlocked(track, m, li);
        const boss = l.kind === 'boss';
        const cls = `${rec ? '.done' : ''}${open ? '' : '.locked'}${boss ? '.boss' : ''}${next?.key === key ? '.next' : ''}`;
        const inner = [
          h('div.lesson-node', rec ? '✓' : open ? (boss ? '👑' : li + 1) : '🔒'),
          h('div.lesson-text', h('div.lesson-title', l.title), h('div.lesson-sub', boss ? 'Boss challenge' : `${l.exercises} exercises`)),
          rec ? stars(rec.stars) : h('span.stars.ghost', '★★★'),
        ];
        return open
          ? h(`a.lesson${cls}`, { href: `#/lesson/${key}`, title: l.summary || '' }, inner)
          : h(`div.lesson${cls}`, { title: 'Finish the previous lesson to unlock this one' }, inner);
      })));
  });

  page('home',
    tracks.length > 1 && h('div.track-tabs', tracks.map(t => h(`button.tab${t.id === track.id ? '.active' : ''}`, {
      onclick: () => { sessionStorage.setItem('track', t.id); home(); },
    }, t.title))),
    hero,
    h('div.track-head',
      h('div', h('h2.track-title', `${track.title} track`), h('p.muted', track.tagline || '')),
      h('div.track-nums',
        h('div', h('b', `${prog.done}/${prog.total}`), h('span.muted', 'lessons')),
        h('div', h('b', `${prog.stars}/${prog.maxStars}`), h('span.muted', 'stars')),
        h('div', h('b', game.state.xp.toLocaleString()), h('span.muted', 'total XP')))),
    modules);
}

// ---------------------------------------------------------------- lesson player

/**
 * Plays a list of steps. Used for lessons and for practice sessions.
 *   items: [{ step, lessonKey, idx, track, module, lesson }]
 */
function play({ title, items, mode, meta, onFinish }) {
  const total = items.length;
  let pos = 0, combo = 0, bestCombo = 0, earned = 0, mistakes = 0, firstTry = 0, answered = 0;
  let current = null, phase = 'answer', attempts = 0, hints = 0, revealed = false;
  const replay = mode === 'lesson' && game.isDone(meta.key);
  const boss = meta?.lesson?.kind === 'boss';

  const progress = h('div.play-bar', h('div.play-fill'));
  const comboEl = h('div.combo');
  const xpEl = h('div.play-xp', '0 XP');
  const stage = h('div.stage');
  const feedback = h('div.feedback', { hidden: true });
  const hintBox = h('div.hints');
  const hintBtn = h('button.btn.ghost', { type: 'button', onclick: showHint }, '💡 Hint');
  const skipBtn = h('button.btn.ghost', { type: 'button', onclick: reveal, hidden: true }, 'Show answer');
  const mainBtn = h('button.btn.primary.big', { type: 'button', onclick: submit }, 'Check');
  const typeTag = h('span.tag');

  app.replaceChildren(
    h('div.player',
      h('header.play-top',
        h('button.icon-btn', { type: 'button', title: 'Leave', 'aria-label': 'Leave', onclick: quit }, '✕'),
        progress, comboEl, xpEl),
      h('main.play-main', h('div.play-meta', typeTag, h('span.muted.small', title)), stage, hintBox),
      h('footer.play-foot', feedback, h('div.foot-row', h('div.foot-left', hintBtn, skipBtn), mainBtn))));
  window.scrollTo(0, 0);

  const onKey = e => {
    if (e.key !== 'Enter' || e.target.matches('textarea, button, a, input')) return;
    e.preventDefault();
    submit();
  };
  document.addEventListener('keydown', onKey);
  leave = () => { document.removeEventListener('keydown', onKey); current?.view.destroy?.(); };

  async function quit() {
    if (answered > 0 && pos < total &&
        !(await ask('Leave this session? The XP you earned so far is kept, but it will not count as finished.', { ok: 'Leave', cancel: 'Keep going' }))) return;
    // Practice lives at #/practice and lessons at #/lesson/..., so always go via the router.
    const target = mode === 'practice' ? '#/practice' : '#/';
    if (location.hash === target) route(); else location.hash = target;
  }

  function refresh() {
    if (!current) return;
    const step = current.item.step;
    if (phase === 'answer') {
      mainBtn.textContent = step.type === 'learn' ? 'Continue' : step.type === 'code' ? 'Run checks' : 'Check';
      mainBtn.disabled = !current.view.ready();
    }
    const left = (step.hints?.length || 0) - hints;
    hintBtn.hidden = phase !== 'answer' || !step.hints?.length;
    hintBtn.disabled = left <= 0;
    hintBtn.textContent = left > 0 ? `💡 Hint (${left})` : '💡 No more hints';
    skipBtn.hidden = !(phase === 'answer' && attempts >= 2 && step.type !== 'learn');
    skipBtn.textContent = step.type === 'code' ? 'Show solution' : 'Show answer';
  }

  function show() {
    current?.view.destroy?.();
    const item = items[pos];
    phase = 'answer'; attempts = 0; hints = 0; revealed = false;
    feedback.hidden = true; feedback.className = 'feedback';
    hintBox.replaceChildren();
    const view = renderStep(item.step, {
      onChange: refresh, submit, bonus,
      track: item.track, module: item.module, lesson: item.lesson, idx: item.idx,
      draftKey: `${item.lessonKey}#${item.idx}`,
    });
    current = { item, view };
    typeTag.textContent = TYPE_LABEL[item.step.type] || item.step.type;
    typeTag.className = `tag type-${item.step.type}`;
    stage.replaceChildren(view.el);
    stage.classList.remove('enter'); void stage.offsetWidth; stage.classList.add('enter');
    progress.firstChild.style.width = `${(pos / total) * 100}%`;
    refresh();
    window.scrollTo(0, 0);
    if (item.step.type !== 'code') view.focus?.();
  }

  /** Extra XP outside the answer flow, e.g. for typing out a code sample. */
  function bonus(xp, kind) {
    if (replay || mode === 'practice') xp = 1;
    earned += xp;
    if (kind === 'typed') game.state.stats.typed = (game.state.stats.typed || 0) + 1;
    const { leveledUp, level } = game.addXp(xp);
    if (leveledUp) { game.sound('level'); toast([h('span.toast-icon', '⬆️'), h('div', h('strong', `Level ${level.level}`), h('div', level.rank))], 'gold'); }
    xpEl.textContent = `${earned} XP`;
    xpEl.classList.remove('bump'); void xpEl.offsetWidth; xpEl.classList.add('bump');
    game.save();
    announce(game.checkAchievements(tracks));
    return xp;
  }

  function showHint() {
    const step = current.item.step;
    if (hints >= (step.hints?.length || 0)) return;
    hintBox.append(h('div.hint', h('span.hint-n', `Hint ${hints + 1}`), h('div', { html: md(step.hints[hints]) })));
    hints++;
    game.state.stats.hints++;
    refresh();
    hintBox.lastChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setFeedback(kind, titleText, bodyHtml) {
    feedback.hidden = false;
    feedback.className = `feedback ${kind}`;
    feedback.replaceChildren(h('div.fb-title', titleText), bodyHtml && h('div.fb-body', { html: bodyHtml }));
  }

  function award(correctNow) {
    const { item } = current;
    const step = item.step;
    answered++;
    let xp = 0;
    if (correctNow && !revealed) {
      if (attempts === 1 && hints === 0) { combo++; firstTry++; } else combo = 0;
      bestCombo = Math.max(bestCombo, combo);
      xp = mode === 'practice' ? 6 : game.stepXp(step, { attempts, hints, revealed, combo, replay, boss });
      // Typing an answer is harder than dragging it, so it pays a little more.
      if (current.typed) { xp += replay || mode === 'practice' ? 1 : 4; game.state.stats.typed = (game.state.stats.typed || 0) + 1; }
      game.state.stats.correct++;
      if (step.type === 'code') { game.state.stats.codePassed++; if (step.mode === 'fix') game.state.stats.fixes++; }
      if (DRAG_TYPES.has(step.type)) game.state.stats.drags++;
      game.state.stats.bestCombo = Math.max(game.state.stats.bestCombo, bestCombo);
    }
    if (mode === 'practice') game.reviewed(item.lessonKey, item.idx, correctNow && !revealed && attempts === 1);
    else if (step.type !== 'code' && (attempts > 1 || revealed)) game.missed(item.lessonKey, item.idx);

    if (xp) {
      earned += xp;
      const { leveledUp, level } = game.addXp(xp);
      if (leveledUp) { game.sound('level'); toast([h('span.toast-icon', '⬆️'), h('div', h('strong', `Level ${level.level}`), h('div', level.rank))], 'gold'); }
    }
    xpEl.textContent = `${earned} XP`;
    xpEl.classList.remove('bump'); void xpEl.offsetWidth; xpEl.classList.add('bump');
    comboEl.textContent = combo >= 3 ? `🔥 ${combo} in a row` : '';
    game.save();
    announce(game.checkAchievements(tracks));
    return xp;
  }

  async function submit() {
    if (!current || mainBtn.disabled) return;
    const { item, view } = current;
    const step = item.step;

    if (phase === 'done') return advance();
    if (step.type === 'learn') return advance();

    mainBtn.disabled = true;
    const result = await view.check();
    if (current.view !== view) return;                       // the learner left while checks were running
    if (!result.noPenalty) attempts++;
    current.typed = !!result.typed;

    if (result.correct) {
      phase = 'done';
      view.lock(true);
      const xp = award(true);
      game.sound('right');
      const praise = attempts === 1 ? shuffle(['Correct!', 'Nice.', 'Exactly right.', 'Spot on.', 'You got it.'])[0] : 'Got there!';
      setFeedback('good', `${praise}  +${xp} XP`, step.explain ? md(step.explain) : '');
      mainBtn.textContent = pos === total - 1 ? 'Finish' : 'Continue';
      mainBtn.disabled = false;
      mainBtn.focus({ preventScroll: true });
    } else {
      if (!result.noPenalty) {
        if (attempts === 1 || (step.type === 'code' && attempts === 4)) mistakes++;
        combo = 0; comboEl.textContent = '';
        game.state.stats.wrong++;
        game.sound('wrong');
      }
      setFeedback('bad', step.type === 'code' ? 'Not passing yet' : 'Not quite', result.detail ? inline(result.detail) : 'Have another look and try again.');
      view.lock(false);
      refresh();
      mainBtn.disabled = false;
      mainBtn.textContent = step.type === 'code' ? 'Run checks' : 'Check again';
    }
    refresh();
  }

  function reveal() {
    const { view, item } = current;
    revealed = true;
    phase = 'done';
    view.retry?.();
    view.reveal();
    view.lock(true);
    award(false);
    setFeedback('info', 'Here is the answer', item.step.explain ? md(item.step.explain) : 'Study it, then carry on. It will come back in Practice.');
    mainBtn.textContent = pos === total - 1 ? 'Finish' : 'Continue';
    mainBtn.disabled = false;
    refresh();
  }

  function advance() {
    pos++;
    if (pos < total) return show();
    progress.firstChild.style.width = '100%';
    current.view.destroy?.();
    current = null;
    onFinish({ earned, mistakes, firstTry, bestCombo, exercises: items.filter(i => i.step.type !== 'learn').length, replay, boss });
  }

  show();
}

async function lessonView(trackId, moduleId, lessonId) {
  const track = tracks.find(t => t.id === trackId);
  const module = track?.modules.find(m => m.id === moduleId);
  const index = module?.lessons.findIndex(l => l.id === lessonId) ?? -1;
  if (index < 0) return notFound();
  if (!game.isUnlocked(track, module, index)) { location.hash = '#/'; return; }

  const meta = module.lessons[index];
  const key = game.lessonKey(track, module, meta);
  let lesson;
  try { lesson = await api(`lesson/${key}`); } catch { return notFound(); }

  const items = lesson.steps.map((step, idx) => ({ step, lessonKey: key, idx, track: trackId, module: moduleId, lesson: lessonId }));
  play({
    title: `${module.title} · ${lesson.title}`, items, mode: 'lesson', meta: { key, lesson: meta },
    onFinish(r) {
      const starCount = game.starsFor(r.mistakes);
      const bonus = Math.round((r.boss ? 50 : 20) * (r.replay ? 0.3 : 1)) + (starCount === 3 && !r.replay ? 15 : 0);
      const before = game.state.lessons[key];
      game.state.lessons[key] = {
        stars: Math.max(before?.stars || 0, starCount),
        bestXp: Math.max(before?.bestXp || 0, r.earned + bonus),
        runs: (before?.runs || 0) + 1,
        completedAt: before?.completedAt || game.dayKey(),
      };
      if (r.mistakes === 0 && r.exercises > 0) game.state.stats.perfect++;
      if (r.boss && !before) game.state.stats.bosses++;
      const { leveledUp, level } = game.addXp(bonus);
      game.save(true);
      const fresh = game.checkAchievements(tracks);
      game.save(true);
      summary({ r, starCount, bonus, fresh, leveledUp, level, track, key, heading: r.boss ? 'Boss defeated!' : 'Lesson complete!', lessonTitle: lesson.title });
    },
  });
}

function summary({ r, starCount, bonus, fresh, leveledUp, level, track, key, heading, lessonTitle, practice }) {
  leave?.(); leave = null;
  game.sound('done');
  confetti();
  const all = track ? game.flatLessons(track) : [];
  const at = all.findIndex(x => x.key === key);
  const next = at >= 0 ? all[at + 1] : null;
  const accuracy = r.exercises ? Math.round((r.firstTry / r.exercises) * 100) : 100;

  app.replaceChildren(h('div.summary',
    h('div.summary-card',
      h('div.summary-icon', practice ? '🔁' : r.boss ? '👑' : '🎉'),
      h('h1', heading),
      lessonTitle && h('p.muted', lessonTitle),
      !practice && h('div.big-stars', stars(starCount)),
      h('div.summary-stats',
        h('div', h('b', `+${r.earned + bonus}`), h('span.muted', 'XP earned')),
        h('div', h('b', `${accuracy}%`), h('span.muted', 'first try')),
        h('div', h('b', r.bestCombo), h('span.muted', 'best combo'))),
      bonus > 0 && h('p.muted.small', `Includes a ${bonus} XP completion bonus${r.replay ? ' (replays earn less)' : ''}.`),
      leveledUp && h('div.level-up', `⬆️ Level ${level.level}: ${level.rank}`),
      fresh.length > 0 && h('div.summary-badges', fresh.map(a => h('div.badge-row', h('span.badge-icon', a.icon), h('div', h('strong', a.title), h('div.muted.small', a.text))))),
      h('div.summary-actions',
        h('a.btn.ghost', { href: '#/' }, 'Back to the map'),
        practice ? h('a.btn.primary.big', { href: '#/practice', onclick: () => setTimeout(route) }, 'Practice again')
          : next ? h('a.btn.primary.big', { href: `#/lesson/${next.key}` }, next.lesson.kind === 'boss' ? 'Face the boss' : 'Next lesson')
            : h('a.btn.primary.big', { href: '#/' }, 'Done')))));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- practice

async function practiceView() {
  const due = game.dueReviews();
  const doneKeys = Object.keys(game.state.lessons);
  const start = async () => {
    const SIZE = 8;
    const picks = shuffle(due).slice(0, SIZE).map(r => ({ key: r.key, idx: r.idx }));
    const cache = new Map();
    const lessonOf = async key => {
      if (!cache.has(key)) cache.set(key, await api(`lesson/${key}`).catch(() => null));
      return cache.get(key);
    };
    // Top up with random quick questions from finished lessons.
    for (const key of shuffle(doneKeys)) {
      if (picks.length >= SIZE) break;
      const lesson = await lessonOf(key);
      if (!lesson) continue;
      const candidates = shuffle(lesson.steps.map((s, idx) => ({ s, idx })).filter(x => !['learn', 'code'].includes(x.s.type)));
      for (const c of candidates.slice(0, 2)) {
        if (picks.length < SIZE && !picks.some(p => p.key === key && p.idx === c.idx)) picks.push({ key, idx: c.idx });
      }
    }
    const items = [];
    for (const p of shuffle(picks)) {
      const lesson = await lessonOf(p.key);
      const step = lesson?.steps[p.idx];
      if (!step || step.type === 'learn') { game.state.review = game.state.review.filter(r => !(r.key === p.key && r.idx === p.idx)); continue; }
      const [track, module, id] = p.key.split('/');
      items.push({ step, lessonKey: p.key, idx: p.idx, track, module, lesson: id });
    }
    if (!items.length) return;
    play({
      title: 'Practice', items, mode: 'practice', meta: {},
      onFinish(r) {
        game.state.stats.practice++;
        game.save(true);
        const fresh = game.checkAchievements(tracks);
        game.save(true);
        summary({ r, starCount: 0, bonus: 0, fresh, heading: 'Practice complete', practice: true });
      },
    });
  };

  page('practice',
    h('section.hero',
      h('div',
        h('div.eyebrow', 'Practice'),
        h('h1', due.length ? `${due.length} question${due.length === 1 ? '' : 's'} to review` : 'Keep it fresh'),
        h('p.muted', 'Questions you got wrong come back here after 1, 3, 7 and 14 days. Answer one right each time and it is mastered. Sessions are topped up with quick questions from lessons you have finished.')),
      doneKeys.length || due.length
        ? h('button.btn.primary.big', { type: 'button', onclick: start }, 'Start a session')
        : h('a.btn.primary.big', { href: '#/' }, 'Finish a lesson first')),
    h('div.cards',
      h('div.card', h('b.card-num', game.state.review.length), h('span.muted', 'questions in review')),
      h('div.card', h('b.card-num', due.length), h('span.muted', 'due today')),
      h('div.card', h('b.card-num', game.state.stats.reviewed), h('span.muted', 'mastered')),
      h('div.card', h('b.card-num', game.state.stats.practice), h('span.muted', 'sessions done'))));
}

// ---------------------------------------------------------------- playground

function playground() {
  const KEY = 'playground';
  const sample = [
    '// A scratchpad. Anything you write here runs as a real C# program.',
    'var languages = new List<string> { "C#", "F#", "Visual Basic" };',
    '',
    'foreach (var name in languages.OrderBy(n => n.Length))',
    '{',
    '    Console.WriteLine($"{name} has {name.Length} characters");',
    '}',
  ].join('\n');
  const panel = h('div.output', { hidden: true });
  const status = h('span.muted.small');
  const stdin = h('textarea.answer.mono', { rows: 3, spellcheck: false, placeholder: 'Lines for Console.ReadLine(), if your program reads input' });
  let busy = false;

  const run = async () => {
    if (busy) return;
    busy = true; runBtn.disabled = true; status.textContent = 'Compiling and running…';
    try {
      const r = await api('run', { track: tracks[0]?.id || 'csharp', code: editor.value, stdin: stdin.value });
      editor.mark(r.diagnostics);
      renderRunOutput(panel, r);
    } catch {
      panel.hidden = false;
      panel.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?'));
    }
    busy = false; runBtn.disabled = false; status.textContent = '';
  };
  const editor = createEditor({
    value: game.state.drafts[KEY] ?? sample,
    onChange: v => { game.state.drafts[KEY] = v; game.save(); },
    onRun: run, minLines: 14,
  });
  const runBtn = h('button.btn.primary', { type: 'button', onclick: run }, '▶ Run');

  page('playground',
    h('div.track-head', h('div', h('h2.track-title', 'Playground'), h('p.muted', 'Try an idea, break something on purpose, see what happens. Nothing here is graded.'))),
    h('div.playground',
      editor.el,
      h('div.code-tools', runBtn,
        h('button.btn.ghost', { type: 'button', onclick: async () => { if (await ask('Clear the playground?', { ok: 'Clear' })) { editor.value = ''; delete game.state.drafts[KEY]; game.save(); } } }, 'Clear'),
        status, h('span.spacer'), h('span.muted.small', 'Ctrl + Enter to run')),
      h('details.stdin', h('summary', 'Program input'), stdin),
      panel));
}

// ---------------------------------------------------------------- profile

function profile() {
  const s = game.state;
  const lv = game.levelInfo();
  const answered = s.stats.correct + s.stats.wrong;

  // Last 12 weeks of activity, oldest first, aligned so each column is a week.
  const cells = [];
  const end = new Date();
  const startDay = game.addDays(-(7 * 12 - 1) - end.getDay() + 6, end);
  for (let d = new Date(startDay); d <= end; d = game.addDays(1, d)) {
    const xp = s.days[game.dayKey(d)] || 0;
    const heat = xp === 0 ? 0 : xp < s.settings.dailyGoal / 2 ? 1 : xp < s.settings.dailyGoal ? 2 : 3;
    cells.push(h(`span.heat.h${heat}`, { title: `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${xp} XP` }));
  }

  const setting = (label, help, control) => h('label.setting', h('div', h('div', label), h('div.muted.small', help)), control);
  const toggle = (key) => h('input', {
    type: 'checkbox', checked: s.settings[key],
    onchange: e => { s.settings[key] = e.target.checked; game.save(true); },
  });

  page('profile',
    h('section.hero.profile-hero',
      h('div.level-big', lv.level),
      h('div.grow',
        h('div.eyebrow', `Level ${lv.level}`),
        h('h1', lv.rank),
        h('div.bar.thick', h('div.bar-fill', { style: { width: `${(lv.into / lv.need) * 100}%` } })),
        h('p.muted.small', `${lv.into} / ${lv.need} XP to level ${lv.level + 1}`))),
    h('div.cards',
      h('div.card', h('b.card-num', s.xp.toLocaleString()), h('span.muted', 'total XP')),
      h('div.card', h('b.card-num', `${game.streak()} 🔥`), h('span.muted', 'day streak')),
      h('div.card', h('b.card-num', Object.keys(s.lessons).length), h('span.muted', 'lessons finished')),
      h('div.card', h('b.card-num', s.stats.codePassed), h('span.muted', 'code exercises passed')),
      h('div.card', h('b.card-num', answered ? `${Math.round((s.stats.correct / answered) * 100)}%` : '–'), h('span.muted', 'answers correct')),
      h('div.card', h('b.card-num', s.stats.bestCombo), h('span.muted', 'best combo'))),
    h('section.panel', h('h2', 'Activity'), h('div.heatmap', cells), h('p.muted.small', 'Brighter squares are days you reached more of your daily goal.')),
    h('section.panel',
      h('h2', `Achievements  ${Object.keys(s.achievements).length} / ${game.ACHIEVEMENTS.length}`),
      h('div.badges', game.ACHIEVEMENTS.map(a => h(`div.badge-card${s.achievements[a.id] ? '.earned' : ''}`,
        h('div.badge-icon', a.icon), h('div', h('strong', a.title), h('div.muted.small', a.text)))))),
    h('section.panel',
      h('h2', 'Settings'),
      setting('Daily goal', 'XP to aim for each day.', h('select', {
        onchange: e => { s.settings.dailyGoal = Number(e.target.value); game.save(true); profile(); },
      }, [[30, 'Casual · 30 XP'], [60, 'Regular · 60 XP'], [120, 'Serious · 120 XP'], [200, 'Intense · 200 XP']]
        .map(([v, label]) => h('option', { value: v, selected: s.settings.dailyGoal === v }, label)))),
      setting('Type instead of drag', 'Fill-the-gap and ordering puzzles open in typing mode: you write the code yourself for a little extra XP. You can still switch on each puzzle.', toggle('typing')),
      setting('Free roam', 'Unlock every lesson. By default the first lesson of each module is open and the rest unlock in order.', toggle('freeRoam')),
      setting('Sound effects', 'Short tones for right and wrong answers.', toggle('sound')),
      setting('Reset progress', 'Erase XP, stars, streak and drafts on this machine.', h('button.btn.danger', {
        type: 'button',
        onclick: async () => { if (await ask('Erase all progress? This cannot be undone.', { ok: 'Erase everything', danger: true })) { await game.reset(); profile(); } },
      }, 'Reset'))));
}

function notFound() {
  page('', h('div.empty', h('h2', 'Nothing here'), h('a.btn.primary', { href: '#/' }, 'Back to the map')));
}

// ---------------------------------------------------------------- router

function route() {
  leave?.(); leave = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case undefined: return home();
    case 'lesson': return lessonView(parts[1], parts[2], parts[3]);
    case 'practice': return practiceView();
    case 'playground': return playground();
    case 'profile': return profile();
    default: return notFound();
  }
}

async function boot() {
  try {
    [tracks] = await Promise.all([api('tracks'), game.load()]);
  } catch (e) {
    app.replaceChildren(h('div.empty', h('h2', 'Cannot reach the dojo server'), h('p.muted', 'Start it with dojo.cmd and refresh this page.')));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

boot();
