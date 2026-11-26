// Two step types that take the learner out of the quiz and into real tools (registered in steps.js):
//
//   terminal  a real shell in a throwaway container (server/TermSteps.cs). The lesson sets up a scenario, the
//             learner types real commands in the same in-page terminal the live labs use, and Check runs the
//             step's checks against the state they left behind. Leaving the step removes the container.
//   lab       links the lesson to a visual lab challenge (opened inline here) or to a live lab task (its own
//             page, with a way back to this step), and passes once that challenge or task is solved.
//
// Both follow the renderer contract of steps.js: { el, ready(), check(), reveal(), lock(on), focus?(), destroy?() }.
import { h, md, inline, api, ask } from './util.js';
import * as game from './game.js';
import { terminal } from './netlabs.js';
import { overTime, clock } from './pacing.js';

const promptEl = step => h('div.prompt', { html: md(step.prompt || '') });

/** Lab text is shell, not C#: fenced blocks render as plain text (as in netlabs.js). */
const shellMd = text => {
  let open = false;
  return md(String(text || '').split('\n').map(l => (/^\s*```/.test(l) ? ((open = !open) ? '```text' : '```') : l)).join('\n'));
};

const mb = bytes => (bytes ? `${Math.round(bytes / 1e6)} MB` : '');

/** Per-check results, in the same look as the code step's test rows. */
function checkRows(panel, tests) {
  const failed = tests.filter(t => !t.pass).length;
  panel.hidden = false;
  panel.replaceChildren(h('div.out-section',
    h(`div.out-title.${failed ? 'bad' : 'good'}`, failed ? `${tests.length - failed} of ${tests.length} checks pass` : tests.length === 1 ? 'The check passes' : `All ${tests.length} checks pass`),
    h('ul.ts-checks', tests.map(t => h(`li.test.${t.pass ? 'pass' : 'fail'}`,
      h('span.test-mark', { 'aria-hidden': 'true' }, t.pass ? '✓' : '✗'),
      h('div', h('div.test-name', h('span.sr-only', t.pass ? 'Passed: ' : 'Failed: '), t.name), !t.pass && t.detail && failDetail(t.detail)))))));
}

/** A failed check: the lesson's message (Markdown), then what the check command printed, if anything. */
function failDetail(detail) {
  const [msg, saw] = detail.split('\n\nWhat the check saw:\n');
  return h('div.ts-fail', h('div.ts-fail-msg', { html: inline(msg) }),
    saw && h('details.ts-saw', h('summary.muted.small', 'What the check saw'), h('pre.test-detail', saw)));
}

// ---------------------------------------------------------------- terminal

export function terminalStep(step, ctx) {
  const cold = !!step.cold;
  const where = { track: ctx.track, module: ctx.module, lesson: ctx.lesson, step: ctx.idx };
  const termUrl = `/api/termstep/term/${[ctx.track, ctx.module, ctx.lesson].map(encodeURIComponent).join('/')}/${ctx.idx}`;
  const notice = h('div.ts-notice', { role: 'status', 'aria-live': 'polite' });
  const termHost = h('div.ts-term-host');
  const panel = h('div.output.ts-results', { hidden: true, 'aria-live': 'polite' });
  const solutionBox = h('div.ts-solution', { hidden: true });
  const status = h('span.muted.small');
  let state = 'opening', busy = true, term = null, dead = false, retry = null;
  const started = Date.now();
  let passedMs = null;

  // A gentle timer for a cold step with a timeLimit (as on cold code steps): never fails, over costs a star.
  const timer = cold && step.timeLimit ? h('span.cold-timer', { role: 'timer', 'aria-live': 'off' }) : null;
  const tick = () => {
    if (!timer) return;
    const ms = passedMs ?? Date.now() - started;
    const over = overTime(ms, step.timeLimit);
    timer.textContent = over ? `${clock(ms)}: over ${clock(step.timeLimit * 1000)}, keep going` : `${clock(ms)} / ${clock(step.timeLimit * 1000)}`;
    timer.classList.toggle('over', over);
  };
  const interval = timer ? setInterval(tick, 1000) : null;
  tick();

  const setState = (s, isBusy = false) => { state = s; busy = isBusy; resetBtn.disabled = isBusy; ctx.onChange(); };

  function banner(kind, title, text, ...extra) {
    notice.replaceChildren(h(`div.nl-banner.${kind}`, h('b', title), text && h('p', text), ...extra));
  }

  async function open(action = 'open') {
    clearTimeout(retry);
    setState(state, true);
    if (state !== 'ready') banner('info', action === 'reset' ? 'Setting the scenario up again…' : 'Starting your machine…',
      'A fresh Linux container just for this step. The first time takes a few seconds.');
    else status.textContent = 'Setting the scenario up again…';
    let r;
    try { r = await api(`termstep/${action}`, where); }
    catch { r = { ok: false, state: 'failed', msg: 'Could not reach the dojo server. Is it still running?' }; }
    if (dead) return;
    status.textContent = '';
    if (r.ok) {
      notice.replaceChildren(h('p.ts-note.muted.small',
        h('span.ts-dot', { 'aria-hidden': 'true' }), 'Your own Debian machine for this step',
        r.imageBytes ? ` (shell image ${mb(r.imageBytes)})` : '', `: you are learner (sudo works), ${step.network ? 'with' : 'without'} network. `,
        'It is thrown away when you leave the step.'));
      setState('ready');
      attach(action === 'reset' || r.fresh);
      if (action === 'reset') { panel.hidden = true; term?.write('\r\n[the scenario was set up again from scratch]\r\n'); }
      return;
    }
    setState(r.state);
    const again = label => h('button.btn.primary.small', { type: 'button', onclick: () => open() }, label);
    if (r.state === 'docker') {
      banner('bad', 'Docker is not running', r.msg,
        h('p.muted.small', 'This step runs a real Linux shell in a container, so it needs Docker Desktop. Start it, wait until it says "Engine running", and this step connects by itself.'),
        again('Retry now'));
      retry = setTimeout(() => open(), 5000);
    } else if (r.state === 'building') {
      banner('warn', 'One-time setup: building the shell image', r.msg,
        r.build?.log?.length > 0 && h('pre.nl-log', { 'aria-label': 'Build log' }, r.build.log.join('\n')));
      retry = setTimeout(() => open(), 2500);
    } else {
      banner('bad', r.state === 'busy' ? 'Too many terminals open' : 'The scenario did not start', r.msg,
        r.build?.log?.length > 0 && h('pre.nl-log', r.build.log.join('\n')), again(r.state === 'failed' && r.build ? 'Try again' : 'Retry'));
    }
  }

  function attach(fresh) {
    if (term && !fresh) { if (!term.connected()) term.reconnect(); return; }
    term?.close();
    term = terminal('step', 'dojo', {
      url: termUrl, label: 'Terminal for this step',
      onKey: e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ctx.submit(); return true; }
        return e.key === 'Tab';   // let Tab move focus: no completion in a line terminal, and no keyboard trap
      },
    });
    termHost.replaceChildren(term.el);
    term.focus();
  }

  const resetBtn = h('button.btn.ghost', {
    type: 'button', title: 'Throw this machine away and set the scenario up again from the start',
    onclick: async () => { if (await ask('Throw away everything you did in this terminal and set the scenario up again from the start?', { ok: 'Reset scenario' })) open('reset'); },
  }, '↺ Reset scenario');

  // Leaving the page: ask the server to remove the container now (it would also go after a short grace period).
  const close = () => {
    try { fetch('/api/termstep/close', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(where) }); } catch { }
  };
  window.addEventListener('pagehide', close);
  const onKeyAnywhere = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.target.closest?.('.nl-term-in')) { e.preventDefault(); ctx.submit(); } };

  const coldBanner = cold ? h('div.cold-banner',
    h('div', h('b', ctx.mode === 'practice' ? 'Can you still do it?' : 'Cold rebuild: from memory'),
      h('div.muted.small', 'The same scenario as before, no hints and no solution to reveal. Type what you remember.')), timer) : null;

  const el = h('div.term-step', { onkeydown: onKeyAnywhere },
    coldBanner,
    h('div.code-head', step.title && h('h2', step.title), h('span.tag.web', '⌨ Real shell')),
    promptEl(step),
    notice,
    termHost,
    h('div.code-tools', resetBtn, status, h('span.spacer'), h('span.muted.small', 'Ctrl + Enter to check · ⛶ in the terminal: full screen')),
    panel,
    solutionBox);

  open();

  return {
    el,
    ready: () => !busy && state === 'ready',
    async check() {
      setState('ready', true);
      status.textContent = 'Running the checks in your machine…';
      try {
        const r = await api('termstep/check', where);
        if (dead) return { correct: false, noPenalty: true };
        status.textContent = '';
        if (!r.ok) {
          panel.hidden = false;
          panel.replaceChildren(h('div.diag.error', r.msg || 'The checks could not run.'));
          if (r.state === 'gone') { state = 'gone'; open(); }   // a fresh machine, so Check works again
          return { correct: false, noPenalty: true, detail: r.msg };
        }
        checkRows(panel, r.tests);
        const ms = Date.now() - started;
        const late = cold && overTime(ms, step.timeLimit);
        if (r.passed) {
          passedMs = ms; tick(); if (interval) clearInterval(interval);
          ctx.onPassed?.(null, { cold, ms, inTime: !late });
        }
        const failed = r.tests.filter(t => !t.pass).length;
        return { correct: r.passed, overTime: r.passed && late, detail: r.passed ? '' : `${failed} check${failed === 1 ? '' : 's'} failed. The details are below the terminal.` };
      } catch {
        status.textContent = '';
        return { correct: false, detail: 'Could not reach the dojo server. Is it still running?', noPenalty: true };
      } finally { if (!dead && state === 'ready') setState('ready'); }
    },
    reveal() {
      const lines = String(step.solution || '').split('\n').filter(l => l.trim());
      if (!lines.length) return;
      solutionBox.hidden = false;
      solutionBox.replaceChildren(h('div.out-title', 'What an expert would type'),
        h('ol.ts-sol', lines.map(line => h('li', h('code', line),
          /^\s*#/.test(line) ? null : h('button.btn.ghost.small', { type: 'button', title: 'Put this command in the terminal (you still press Enter)', onclick: () => term?.type(line) }, 'Type it')))),
        h('p.muted.small', 'Run them yourself and press Check: the step still checks your machine.'));
    },
    lock() { /* the terminal stays live after passing, to keep exploring */ },
    focus() { term?.focus(); },
    destroy() {
      dead = true;
      clearTimeout(retry);
      if (interval) clearInterval(interval);
      window.removeEventListener('pagehide', close);
      term?.close();
      document.body.classList.remove('term-max');
      close();
    },
  };
}

// ---------------------------------------------------------------- lab

/** Visual labs a step can open inline, and how. Progress lives in game.state.labs[id].solved. */
const VISUAL = {
  netbuild: { title: 'Network builder', icon: '🔌', load: () => import('./lab-netbuild.js').then(m => m.netBuildLab), sim: () => import('./netsim.js') },
  archbuild: { title: 'Architecture builder', icon: '🏗', load: () => import('./lab-archbuild.js').then(m => m.archBuildLab), sim: () => import('./archsim.js') },
  composebuild: { title: 'Compose builder', icon: '🐳', load: () => import('./lab-composebuild.js').then(m => m.composeBuildLab), sim: () => import('./composesim.js') },
  kubebuild: { title: 'Kubernetes builder', icon: '☸', load: () => import('./lab-kubebuild.js').then(m => m.kubeBuildLab), sim: () => import('./kubesim.js') },
  pipebuild: { title: 'Pipeline builder', icon: '⛓', load: () => import('./lab-pipebuild.js').then(m => m.pipeBuildLab), sim: () => import('./pipesim.js') },
  pki: { title: 'Certificate chain lab', icon: '🔐', load: () => import('./lab-pki.js').then(m => m.pkiLab) },
  // Real keystrokes on the Vim and nano emulator (vim-core.js); a challenge is a level id from vim-levels.js.
  vim: { title: 'Vim & nano trainer', icon: '⌨', load: () => import('./lab-vim.js').then(m => m.vimLab),
    sim: () => import('./vim-levels.js').then(m => ({ CHALLENGES: [...m.VIM_LEVELS, ...m.NANO_LEVELS] })) },
};

/** Remember this step, so the lab page can offer "Back to the lesson" (netlabs.js) and the lesson reopens here (app.js). */
function detourTo(ctx, lab) {
  const title = (document.querySelector('.play-meta .muted')?.textContent || '').split(' · ').pop() || 'the lesson';
  sessionStorage.setItem('detour', JSON.stringify({ back: location.hash, title, step: ctx.idx, lab }));
}

export function labStep(step, ctx) {
  return step.live ? liveLabStep(step, ctx) : visualLabStep(step, ctx);
}

function visualLabStep(step, ctx) {
  const lab = VISUAL[step.lab];
  const solved = () => !!game.state.labs?.[step.lab]?.solved?.[step.challenge];
  const statusEl = h('div.ls-status', { role: 'status', 'aria-live': 'polite' });
  const host = h('div.ls-host');
  let cleanup = null, was = solved(), mounted = false, challengeTitle = step.challenge;

  const paint = () => {
    const ok = solved();
    statusEl.className = `ls-status ${ok ? 'good' : ''}`;
    statusEl.replaceChildren(h('span.ls-mark', { 'aria-hidden': 'true' }, ok ? '✓' : '○'),
      ok ? h('span', h('b', `"${challengeTitle}" solved.`), ' Press Check to carry on.') : h('span', 'Solve the challenge ', h('b', `"${challengeTitle}"`), ' in the lab below. Its goals are checked live after every change.'));
  };
  lab?.sim?.().then(m => { challengeTitle = m.CHALLENGES.find(c => c.id === step.challenge)?.title || step.challenge; paint(); }, () => {});

  async function mount() {
    if (mounted || !lab) return;
    mounted = true;
    // Open the lab on this step's challenge (the lab keeps the learner's model for it).
    const labs = game.state.labs ||= {};
    const saved = labs[step.lab] ||= { solved: {}, stars: {}, challenge: step.challenge, model: null, modelFor: null, view: 'board', speed: 'normal' };
    saved.solved ||= {}; saved.stars ||= {};
    saved.challenge = step.challenge;
    host.replaceChildren(h('p.muted', `Opening the ${lab.title}…`));
    try {
      const make = await lab.load();
      host.replaceChildren();
      cleanup = make(host, xp => { statusEl.dataset.xp = xp; });
    } catch (e) { host.replaceChildren(h('div.diag.error', `The ${lab.title} could not open: ${e.message}`)); }
    openBtn.hidden = true;
  }

  const watch = setInterval(() => {
    const now = solved();
    if (now !== was) { was = now; paint(); ctx.onChange(); if (now) game.sound?.('right'); }
  }, 700);

  const openBtn = h('button.btn.primary', { type: 'button', onclick: mount }, solved() ? 'Open the lab again' : 'Open the lab here');
  const el = h('div.lab-step',
    h('div.code-head', step.title && h('h2', step.title), h('span.tag.web', `${lab?.icon || '🧪'} ${lab?.title || step.lab}`)),
    promptEl(step),
    statusEl,
    h('div.code-tools', openBtn,
      h('a.btn.ghost', { href: `#/labs/${step.lab}`, onclick: () => detourTo(ctx, step.lab), title: 'The same lab on its own page; your progress is shared' }, 'Open on the Labs page'),
      h('span.muted.small', 'Tip: the ⤢ button on the board gives it the whole screen.')),
    host);
  paint();
  if (!solved()) setTimeout(mount);

  return {
    el,
    ready: () => solved(),
    async check() {
      paint();
      return solved() ? { correct: true } : { correct: false, noPenalty: true, detail: 'The challenge is not solved yet: every goal in the lab needs a tick.' };
    },
    reveal() {},
    lock() {},
    destroy() { clearInterval(watch); try { cleanup?.(); } catch { } document.body.classList.remove('term-max'); },
  };
}

function liveLabStep(step, ctx) {
  const ids = Array.isArray(step.task) ? step.task : [step.task];
  const body = h('div.ls-live', h('p.muted', 'Asking the lab…'));
  const statusEl = h('div.ls-status', { role: 'status', 'aria-live': 'polite' });
  let info = null, dead = false, timer = null;
  const done = () => !!info && ids.every(id => info.tasks.find(t => t.id === id)?.done);
  const route = () => `#/labs/${(info?.module || '').startsWith('Linux missions') ? 'linux' : 'net'}/${step.live}`;

  async function load() {
    clearTimeout(timer);
    let next;
    try { next = await api(`netlabs/${encodeURIComponent(step.live)}`); }
    catch { if (!dead) body.replaceChildren(h('div.diag.error', 'Could not read the lab. Is the dojo server still running?')); return; }
    if (dead) return;
    const before = done();
    info = next;
    const tasks = ids.map(id => info.tasks.find(t => t.id === id)).filter(Boolean);
    const ok = done();
    statusEl.className = `ls-status ${ok ? 'good' : ''}`;
    statusEl.replaceChildren(h('span.ls-mark', { 'aria-hidden': 'true' }, ok ? '✓' : '○'),
      ok ? h('span', h('b', tasks.length > 1 ? 'Tasks done.' : 'Task done.'), ' Press Check to carry on.')
        : h('span', `${tasks.filter(t => t.done).length} of ${tasks.length} done. The lab marks a task done when you pass it there.`));
    body.replaceChildren(
      h('div.ls-lab-head', h('div.eyebrow', `Live lab ${info.num} · ${info.module || ''}`), h('h3', info.title), h('p.muted.small', info.summary),
        h('div.topic-meta', info.minutes && h('span', `about ${info.minutes} min for the whole lab`), h('span', info.running ? 'running' : 'not running'))),
      h('ol.ls-tasks', tasks.map(t => h(`li.ls-task${t.done ? '.done' : ''}`,
        h('div.ls-task-title', h('span.ls-mark', { 'aria-hidden': 'true' }, t.done ? '✓' : '○'), h('b', t.title), h('span.sr-only', t.done ? ' (done)' : ' (not done yet)')),
        h('div.ls-task-text', { html: shellMd(t.text) })))),
      h('div.code-tools',
        h('a.btn.primary', { href: route(), onclick: () => detourTo(ctx, step.live) }, ok ? 'Open the lab again' : 'Open the lab'),
        h('button.btn.ghost', { type: 'button', onclick: load }, 'I did it: check again'),
        h('span.muted.small', 'The lab needs Docker Desktop. A Back to the lesson button there brings you to this step.')));
    if (ok !== before) ctx.onChange();
    timer = setTimeout(load, 5000);
  }
  load();
  const onShow = () => { if (document.visibilityState === 'visible') load(); };
  document.addEventListener('visibilitychange', onShow);

  return {
    el: h('div.lab-step', h('div.code-head', step.title && h('h2', step.title), h('span.tag.web', '🖥 Live lab')), promptEl(step), statusEl, body),
    ready: () => done(),
    async check() { await load(); return done() ? { correct: true } : { correct: false, noPenalty: true, detail: 'The lab has not recorded the task as done yet.' }; },
    reveal() {},
    lock() {},
    destroy() { dead = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onShow); },
  };
}

export const EXTRA_STEPS = { terminal: terminalStep, lab: labStep };
export const EXTRA_LABELS = { terminal: 'Terminal', lab: 'Lab' };
