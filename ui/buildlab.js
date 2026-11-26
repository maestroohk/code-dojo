// The shared page for the "build it from bricks" labs that simulate a config file: the Compose builder,
// the Kubernetes builder and the Pipeline builder. It owns what they have in common: challenge chips,
// the brief, goals with stars and XP, saved progress, the lego board (blocks.js), run buttons with an
// animated, explained log, and a live YAML panel (editable when the lab can read YAML back).
//
// A lab passes cfg:
//   lab                      key in game.state.labs (saved progress)
//   sim                      { CHALLENGES, judge(model, challenge) -> { ok, goals: [{ label, ok, why }], cost, stars } }
//   board(api)               createBoard options (kinds, wires, ports, body, canConnect, connect, palette, inspector, ...)
//   form(api)                the Form view
//   actions(challenge)       [{ id, label, title }] run buttons
//   run(model, id, ch)       -> { ok, verdict, steps: [{ who, tone, text, at? }], tokens?, wires?: { id: state }, marks?: { blockId: 'ok'|'bad' }, panel?: Node }
//   yaml                     { title, text(model), apply?(model, text) -> model | 'error text', note? }
//   costLabel, tie(challenge) optional extras
// api = { model, changed(), persist(), say(text), select(sel), board }
import { h, md } from './util.js';
import * as game from './game.js';
import { createBoard } from './blocks.js';
import * as Y from './miniyaml.js';

/** replaceChildren that skips false/null (from `cond && node`). */
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
export const starText = n => '★'.repeat(n) + '☆'.repeat(3 - n);

/** Inspector controls bound to obj[key]. Every edit calls changed(). */
export function controls(changed, say) {
  const field = (label, control, help) => h('label.pk-field', h('span', label), control, help && h('span.muted.small', help));
  const text = (o, key, placeholder = '', valid) => h('input', { value: o[key] ?? '', placeholder, spellcheck: false, onchange: e => {
    const v = e.target.value.trim();
    const bad = valid?.(v);
    if (typeof bad === 'string') { say(bad); e.target.value = o[key] ?? ''; return; }
    o[key] = v; changed();
  } });
  const num = (o, key, { min = 0, max = 1e9, step = 1 } = {}) => h('input', { type: 'number', value: o[key], min, max, step,
    onchange: e => { o[key] = Math.max(min, Math.min(max, Number(e.target.value) || 0)); changed(); } });
  const check = (o, key, label) => h('label.ab-check', h('input', { type: 'checkbox', checked: !!o[key], onchange: e => { o[key] = e.target.checked; changed(); } }), ' ', label);
  const select = (o, key, options) => h('select', { onchange: e => { o[key] = e.target.value; changed(); } },
    options.map(([v, l]) => h('option', { value: v, selected: String(o[key] ?? '') === v }, l)));
  const lines = (o, key, placeholder = '', rows = 3) => h('textarea.yb-lines', { rows, placeholder, spellcheck: false, value: (o[key] || []).join('\n'),
    onchange: e => { o[key] = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); changed(); } });
  return { field, text, num, check, select, lines };
}

export function builderLab(container, onXp, cfg) {
  const C = cfg.sim.CHALLENGES;
  const saved = game.state.labs[cfg.lab] ||= { solved: {}, stars: {}, challenge: C[1].id, model: null, modelFor: null, view: 'board' };
  saved.stars ||= {}; saved.solved ||= {};
  let challenge = C.find(c => c.id === saved.challenge) || C[1];
  let model = saved.model && saved.modelFor === challenge.id ? saved.model : challenge.setup();
  let last = null;            // the last run result
  let runSeq = 0;
  let editing = false, draft = '', yamlErr = '';

  const persist = () => { saved.model = model; saved.modelFor = challenge.id; saved.challenge = challenge.id; game.save(); };
  function changed() {
    persist();
    runSeq++;
    last = null;
    board.render();
    paintResult();
    paintYaml();
    evaluate();
  }
  const api = {
    get model() { return model; },
    changed, persist,
    say: t => board.say(t),
    select: s => board.select(s),
    get board() { return board; },
  };

  // ------------------------------------------------------------ the board
  const b = cfg.board(api);
  const board = createBoard({
    portSide: 'right', arrows: true,
    ...b,
    blocks: () => model.blocks,
    onMove: () => persist(),
    blockClass: x => [b.blockClass?.(x), { bad: 'bad', ok: 'yb-good', skip: 'yb-skip' }[last?.marks?.[x.id]]].filter(Boolean).join(' '),
    wireState: w => last?.wires?.[w.id] || b.wireState?.(w) || '',
    form: () => cfg.form(api),
    view: saved.view,
    onView: v => { saved.view = v; persist(); },
  });

  // ------------------------------------------------------------ running
  const runbarEl = h('div.yb-runbar');
  const verdictEl = h('div.yb-verdict');
  const logEl = h('ol.nb-log.yb-log');
  const panelEl = h('div.yb-panel');
  const resultEl = h('div.yb-result', verdictEl, logEl);

  function paintRunbar() {
    fill(runbarEl, cfg.actions(challenge).map((a, i) => h(`button.btn.${i === 0 ? 'primary' : 'ghost'}`, { type: 'button', title: a.title || '', onclick: () => doRun(a.id) }, a.label)));
  }

  function paintResult() {
    if (!last) {
      fill(verdictEl, h('p.muted.small', 'Press a run button to simulate it. Every step is explained here.'));
      logEl.replaceChildren(); panelEl.replaceChildren();
      resultEl.classList.remove('has');
      return;
    }
    resultEl.classList.add('has');
    fill(verdictEl, h(last.ok ? 'div.nb-ok' : 'div.nb-bad', h(`span.pk-status.${last.ok ? 'ok' : 'bad'}`, last.ok ? 'OK' : 'Problem'), ' ', last.verdict));
    fill(logEl, (last.steps || []).map(s => h(`li.nb-ev.${s.tone || 'info'}`,
      h('span.nb-who', { title: s.who || '' }, s.at != null ? `${s.at}` : (s.who || '')),
      h('span', s.at != null && s.who ? h('b', s.who + ' ') : '', ...(Array.isArray(s.text) ? s.text : [s.text])))));
    fill(panelEl, last.panel || null);
  }

  async function doRun(id) {
    const my = ++runSeq;
    board.stop();
    last = cfg.run(model, id, challenge);
    board.render();
    paintResult();
    game.sound?.(last.ok ? 'right' : 'wrong');
    const tokens = (last.tokens || []).slice(0, 14);
    await Promise.all(tokens.map((t, i) => new Promise(res => setTimeout(() => {
      if (my !== runSeq || !t.hops?.length) return res();
      board.animate(t.hops, { cls: t.cls || 'req', label: t.label || '', endCls: t.endCls, ms: t.ms || 380, linger: 350 }).then(res);
    }, i * 170))));
  }

  // ------------------------------------------------------------ YAML
  const yamlEl = h('div.yb-yaml');
  function paintYaml() {
    const text = cfg.yaml.text(model);
    const head = (...btns) => h('div.yb-yaml-head', h('b', cfg.yaml.title), h('span.yb-yaml-btns', btns));
    if (editing) {
      const ta = h('textarea.yb-yaml-edit', { rows: Math.min(40, Math.max(14, draft.split('\n').length + 2)), spellcheck: false, value: draft, oninput: e => { draft = e.target.value; } });
      fill(yamlEl,
        head(
          h('button.btn.primary.small', { type: 'button', onclick: () => {
            const r = cfg.yaml.apply(model, draft);
            if (typeof r === 'string') { yamlErr = r; paintYaml(); return; }
            editing = false; yamlErr = ''; model = r; board.select(null); changed(); requestAnimationFrame(() => board.fit());
          } }, 'Apply'),
          h('button.btn.ghost.small', { type: 'button', onclick: () => { editing = false; yamlErr = ''; paintYaml(); } }, 'Cancel')),
        yamlErr && h('div.nb-bad.small.yb-yaml-err', yamlErr),
        ta,
        h('p.muted.small', 'Apply rebuilds the board from this file. Blocks keep their place when their names stay the same.'));
      return;
    }
    fill(yamlEl,
      head(
        h('button.btn.ghost.small', { type: 'button', title: 'Copy to the clipboard', onclick: () => navigator.clipboard?.writeText(text).then(() => board.say('Copied.'), () => board.say('Copy failed: select the text instead.')) }, 'Copy'),
        cfg.yaml.apply && h('button.btn.ghost.small', { type: 'button', title: 'Edit the file by hand; Apply puts it back on the board', onclick: () => { editing = true; draft = text; yamlErr = ''; paintYaml(); } }, 'Edit')),
      h('pre.yb-code', { html: Y.highlight(text) }),
      cfg.yaml.note && h('p.muted.small', cfg.yaml.note));
  }

  // ------------------------------------------------------------ goals, stars, XP
  const goalsEl = h('div.nb-goals');
  function evaluate() {
    if (!challenge.xp) { fill(goalsEl, h('span.muted.small', 'Sandbox: no goals. Pick a challenge above to earn XP.')); return; }
    const j = cfg.sim.judge(model, challenge);
    const best = saved.stars[challenge.id] || 0;
    fill(goalsEl,
      h('div.nb-goal-head',
        h('b', j.ok ? '✓ All goals met' : 'Goals'),
        h('span.muted.small', `Par ${challenge.par} (${challenge.costLabel || cfg.costLabel || 'blocks + wires'}). You: ${j.cost}.`),
        h('span.nb-stars', { title: 'Best so far' }, starText(Math.max(best, j.stars)))),
      h('ul.nb-goal-list', j.goals.map(g => h(`li.${g.ok ? 'ok' : 'bad'}`,
        h('span', h('span.nb-mark', g.ok ? '✓' : '✕'), ' ', g.label),
        !g.ok && g.why && h('div.muted.small', g.why)))),
      h('p.muted.small', 'Goals are checked live after every change. The run buttons show you why.'));
    if (j.ok && j.stars > best) {
      const earned = Math.round(challenge.xp * j.stars / 3) - Math.round(challenge.xp * best / 3);
      saved.stars[challenge.id] = j.stars;
      saved.solved[challenge.id] ||= game.dayKey();
      if (earned > 0) game.addXp(earned);
      game.sound?.('done');
      game.save(true);
      if (earned > 0) onXp?.(earned, `${challenge.title} ${starText(j.stars)}`);
      paintChips();
    }
  }

  // ------------------------------------------------------------ layout
  const chipsEl = h('div.pk-challenges');
  const counter = h('div.muted.small');
  function paintChips() {
    chipsEl.replaceChildren(...C.map(c => h(`button.pk-ch${c.id === challenge.id ? '.active' : ''}${saved.solved[c.id] ? '.solved' : ''}`, { type: 'button', onclick: () => pick(c) },
      c.title, c.xp ? h('span.nb-chip-stars', saved.stars[c.id] ? ' ' + starText(saved.stars[c.id]) : ` +${c.xp}`) : '')));
    counter.textContent = `${C.filter(c => c.xp && saved.solved[c.id]).length} / ${C.filter(c => c.xp).length} solved`;
  }
  const briefEl = h('div.pk-brief');
  function paintBrief() {
    fill(briefEl, h('div', h('div', { html: md(challenge.brief) }), cfg.tie?.(challenge)),
      h('button.btn.ghost.small', { type: 'button', title: 'Start this challenge again from its original setup', onclick: () => { model = challenge.setup(); editing = false; board.select(null); changed(); requestAnimationFrame(() => board.fit()); } }, 'Reset'));
  }
  function pick(c) {
    challenge = c;
    model = c.setup();
    editing = false;
    paintChips(); paintBrief(); paintRunbar();
    board.select(null);
    changed();
    requestAnimationFrame(() => board.fit());
  }

  container.replaceChildren(
    h('div.pk-top', chipsEl, counter),
    briefEl,
    goalsEl,
    runbarEl,
    h('div.nb-main.yb-main',
      h('div.nb-left', board.el, h('div.yb-under', resultEl, panelEl)),
      h('div.nb-right', board.inspectorEl, yamlEl)));
  paintChips(); paintBrief(); paintRunbar();
  board.render();
  paintResult(); paintYaml();
  evaluate();
  requestAnimationFrame(() => board.fit());
  return () => { runSeq++; board.stop(); };
}
