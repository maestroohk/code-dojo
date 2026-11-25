// Architecture builder: wire a client through an API gateway and integration routes to backend services,
// queues, caches and databases; tune auth, scopes, rate limits, timeouts, retries and dead-lettering;
// break things with failure switches; send one request or a burst and watch every token travel and come
// back with its status code (200/202/204/400/401/403/429/502/504), explained. A metrics panel shows what
// a dashboard would show, including the trap where a 204 from the dead-letter path counts as success.
// The simulation itself lives in archsim.js (DOM-free, tested in Node).
import { h, md } from './util.js';
import * as game from './game.js';
import { createBoard } from './blocks.js';
import * as A from './archsim.js';

const LAB = 'archbuild';
const COLORS = { client: '#3d6f8a', gateway: '#b8572a', route: '#8a6a2f', cache: '#2f7a72', queue: '#5f5590', service: '#4f7a3a', db: '#6b5b4b' };
const KINDS = Object.fromEntries(Object.entries(A.KINDS).map(([k, v]) => [k, { ...v, color: COLORS[k], width: 210 }]));
const OPS = ['GET /products', 'GET /orders', 'POST /orders', 'GET /search', 'GET /prices'];
const COST_LABEL = { retries: 'retries used', timeouts: 'route timeout in 100 ms steps' };
/** replaceChildren that skips false/null (from `cond && node`). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const starText = n => '★'.repeat(n) + '☆'.repeat(3 - n);
const tone = code => (code >= 200 && code < 300 ? (code === 204 ? 'warn' : 'ok') : code === 429 || code === 401 || code === 403 || code === 400 ? 'warn' : 'bad');

export function archBuildLab(container, onXp) {
  const saved = game.state.labs[LAB] ||= { solved: {}, stars: {}, challenge: 'hello', model: null, modelFor: null, view: 'board' };
  saved.stars ||= {};
  let challenge = A.CHALLENGES.find(c => c.id === saved.challenge) || A.CHALLENGES[1];
  let model = saved.model && saved.modelFor === challenge.id ? saved.model : challenge.setup();
  let last = null;              // the last run the learner sent: { run, label }
  let wireStates = new Map();
  let sendRun = 0;

  const blk = id => A.byId(model, id);
  const persist = () => { saved.model = model; saved.modelFor = challenge.id; saved.challenge = challenge.id; game.save(); };

  function changed() {
    persist();
    sendRun++;
    wireStates = new Map();
    board.render();
    paintChaos();
    evaluate();
  }

  const wireKind = w => {
    const f = blk(w.from), t = blk(w.to);
    if (t?.kind === 'db') return 'query';
    if (t?.kind === 'queue') return 'publish';
    if (f?.kind === 'queue') return 'consume';
    return 'http';
  };

  // ------------------------------------------------------------ the board

  const board = createBoard({
    kinds: KINDS,
    portSide: 'right',
    arrows: true,
    wireKinds: { http: { label: 'HTTP' }, query: { label: 'query' }, publish: { label: 'publish' }, consume: { label: 'consume' } },
    blocks: () => model.blocks,
    wires: () => model.wires.map(w => ({ id: w.id, kind: wireKind(w), from: { block: w.from, port: 'out' }, to: { block: w.to } })),
    ports: b => (A.TARGETS[b.kind].length ? [{ id: 'out', label: '', on: model.wires.some(w => w.from === b.id), title: `Drag onto ${A.TARGETS[b.kind].map(k => A.KINDS[k].label).join(', ')}` }] : []),
    body: blockBody,
    canConnect: (from, port, to) => A.canWire(model, from, to),
    connect: (from, port, to) => {
      if (!A.connect(model, from.id, to.id)) return `A ${A.KINDS[from.kind].label} cannot call a ${A.KINDS[to.kind].label}.`;
      changed();
      return false;
    },
    onDropEmpty: from => {
      const n = model.wires.length;
      model.wires = model.wires.filter(w => w.from !== from.id);
      if (n !== model.wires.length) changed();
      return false;
    },
    palette: Object.keys(A.KINDS).map(kind => ({ kind, add: at => addBlock(kind, at) })),
    howto: 'Drag a block to move it. Drag its ▶ port onto the next block to wire a call; drop it on empty board to unwire. Click to configure; Delete removes. Wheel zooms.',
    inspector,
    onDelete: sel => {
      if (sel.type === 'wire') model.wires = model.wires.filter(w => w.id !== sel.id);
      else { model.blocks = model.blocks.filter(b => b.id !== sel.id); model.wires = model.wires.filter(w => w.from !== sel.id && w.to !== sel.id); }
      changed();
    },
    onMove: () => persist(),
    blockClass: b => [(b.down) && 'bad'].filter(Boolean).join(' '),
    wireState: w => wireStates.get(w.id) || '',
    wireLabel: w => ({ query: 'query', publish: 'publish', consume: 'consume' }[w.kind] || ''),   // board wire: kind already resolved
    form: formView,
    view: saved.view,
    onView: v => { saved.view = v; persist(); },
  });

  function addBlock(kind, at) {
    if (kind === 'client' && model.blocks.some(b => b.kind === 'client')) return 'One client is enough: change its request in the inspector.';
    let i = 1;
    while (model.blocks.some(b => b.id === kind + i)) i++;
    const names = { client: 'Web app', gateway: 'API gateway', route: 'Route', cache: 'Cache', queue: 'Queue', service: 'Service', db: 'Database' };
    const b = A.block(kind, kind + i, `${names[kind]}${i > 1 || kind === 'service' || kind === 'route' ? ' ' + i : ''}`, at.x, at.y);
    model.blocks.push(b);
    changed();
    return b;
  }

  function blockBody(b) {
    const line = t => h('div.ab-line', t);
    const tags = [];
    let lines = [];
    if (b.kind === 'client') lines = [h('code.ab-op', b.op), line(`token: ${b.token}`), line(`burst: ${b.burst}`)];
    if (b.kind === 'gateway') {
      lines = [line(b.auth ? `auth on${b.scope ? ` · needs ${b.scope}` : ''}` : 'auth off'), line(b.rateLimit ? `limit ${b.rateLimit}/s` : 'no rate limit'), line(`timeout ${b.timeout} ms`)];
    }
    if (b.kind === 'route') {
      lines = [line(`timeout ${b.timeout} ms · retries ${b.retries}`), line(b.transform ? 'transform v1 → v2' : 'no transform'), line(b.deadLetter ? `dead-letter on · replies ${b.dlqReply}` : 'dead-letter off')];
      const dlq = last?.run?.metrics?.dlq;
      if (b.deadLetter && dlq) tags.push(h('span.bk-tag.warn', `DLQ ${dlq}`));
    }
    if (b.kind === 'cache') lines = [line(`hit rate ${b.hitRate}% (GET only)`)];
    if (b.kind === 'queue') lines = [line('accepts now, delivers later')];
    if (b.kind === 'service') {
      lines = [line(`~${b.latency} ms${b.capacity ? ` · ${b.capacity}/s max` : ''}`), line(`expects ${b.expects}`)];
      if (b.failRate) tags.push(h('span.bk-tag.warn', `flaky ${b.failRate}%`));
    }
    if (b.kind === 'db') lines = [line(`~${b.latency} ms`)];
    if (b.down) tags.push(h('span.bk-tag.bad', 'DOWN'));
    return [h('div.bk-name', b.name), lines, tags.length > 0 && h('div.bk-tags', tags)];
  }

  // ------------------------------------------------------------ inspector

  const field = (label, control, help) => h('label.pk-field', h('span', label), control, help && h('span.muted.small', help));
  const num = (b, key, opts = {}) => h('input', { type: 'number', value: b[key], min: opts.min ?? 0, max: opts.max, step: opts.step || 1,
    onchange: e => { b[key] = Math.max(opts.min ?? 0, Math.min(opts.max ?? 1e9, Number(e.target.value) || 0)); changed(); } });
  const check = (b, key, label) => h('label.ab-check', h('input', { type: 'checkbox', checked: !!b[key], onchange: e => { b[key] = e.target.checked; changed(); } }), ' ', label);
  const text = (b, key, placeholder = '') => h('input', { value: b[key] ?? '', placeholder, onchange: e => { b[key] = e.target.value.trim(); changed(); } });
  const select = (b, key, options) => h('select', { onchange: e => { b[key] = e.target.value; changed(); } },
    options.map(([v, l]) => h('option', { value: v, selected: String(b[key]) === v }, l)));

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click a block or a wire to configure it.');
    if (sel.type === 'wire') {
      const w = model.wires.find(x => x.id === sel.id);
      if (!w) return null;
      return h('div.pk-inspect',
        h('div.pk-inspect-head', h('b', 'Wire'), h('button.btn.ghost.small', { type: 'button', onclick: () => { model.wires = model.wires.filter(x => x !== w); changed(); } }, 'Remove')),
        h('p', `${blk(w.from)?.name} → ${blk(w.to)?.name} (${wireKind(w)})`));
    }
    const b = blk(sel.id);
    if (!b) return null;
    const k = KINDS[b.kind];
    const parts = [
      h('div.pk-inspect-head', h('b', `${k.icon} ${k.label}`),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { model.blocks = model.blocks.filter(x => x !== b); model.wires = model.wires.filter(w => w.from !== b.id && w.to !== b.id); changed(); } }, 'Delete')),
      field('Name', text(b, 'name')),
    ];
    if (b.kind === 'client') parts.push(
      field('Request', select(b, 'op', OPS.map(o => [o, o]))),
      h('div.pk-two', field('Token', select(b, 'token', [['valid', 'valid'], ['none', 'none'], ['expired', 'expired']])), field('Burst size', num(b, 'burst', { min: 1, max: 200 }))),
      field('Token scopes', text(b, 'scopes', 'orders:read orders:write'), 'What this caller is allowed to do, space separated.'));
    if (b.kind === 'gateway') parts.push(
      check(b, 'auth', 'Require a valid bearer token (else 401)'),
      field('Required scope', text(b, 'scope', 'e.g. orders:write'), 'Checked when auth is on. A valid token without it gets 403.'),
      h('div.pk-two', field('Rate limit / s', num(b, 'rateLimit', { max: 10000 }), '0 = off. Excess gets 429.'), field('Total timeout ms', num(b, 'timeout', { min: 0, step: 100 }), 'After this: 504.')));
    if (b.kind === 'route') parts.push(
      check(b, 'transform', 'Transform the payload v1 → v2'),
      h('div.pk-two', field('Timeout per attempt ms', num(b, 'timeout', { step: 50 }), '0 = wait forever'), field('Retries', num(b, 'retries', { max: 10 }), 'Extra attempts after a 5xx or timeout.')),
      field('Backoff between attempts ms', num(b, 'backoff', { step: 10 })),
      check(b, 'deadLetter', 'Dead-letter messages that still fail'),
      field('When dead-lettered, reply', h('select', { disabled: !b.deadLetter, onchange: e => { b.dlqReply = e.target.value; changed(); } },
        [['204', '204 No Content (looks like success)'], ['202', '202 Accepted (not done yet)'], ['502', '502 Bad Gateway (honest failure)']].map(([v, l]) => h('option', { value: v, selected: b.dlqReply === v }, l)))));
    if (b.kind === 'cache') parts.push(field('Hit rate %', num(b, 'hitRate', { max: 100 }), 'Share of reads answered from the cache. Writes pass through.'));
    if (b.kind === 'queue') parts.push(h('p.muted.small', 'Stores each message and answers 202 Accepted at once. Wire its ▶ to a consumer service: it pulls messages one at a time, at its own pace, so a burst never overloads it. Without a consumer, messages pile up and are never processed.'));
    if (b.kind === 'service') parts.push(
      h('div.pk-two', field('Latency ms', num(b, 'latency', { step: 10 })), field('Failure rate %', num(b, 'failRate', { max: 100 }))),
      h('div.pk-two', field('Capacity / s', num(b, 'capacity', { max: 10000 }), '0 = unlimited. Beyond it: 503.'), field('Expects payload', select(b, 'expects', [['v1', 'v1'], ['v2', 'v2']]))),
      check(b, 'down', 'Down (connection refused)'),
      h('p.muted.small', 'Wire its ▶ to a database, cache, queue or another service to make it call them on every request.'));
    if (b.kind === 'db') parts.push(field('Latency ms', num(b, 'latency', { step: 5 })), check(b, 'down', 'Down'));
    return h('div.pk-inspect', parts);
  }

  // ------------------------------------------------------------ form view

  function formView() {
    let a = '', z = '';
    return h('div.ab-form',
      h('table.nb-ftable', h('tr', h('th', 'Block'), h('th', 'Settings'), h('th', 'Calls')),
        model.blocks.map(b => h('tr', { onclick: e => { if (!e.target.closest('input,button,select')) board.select({ type: 'block', id: b.id }); } },
          h('td', h('b', `${KINDS[b.kind].icon} ${b.name}`), h('div.muted.small', KINDS[b.kind].label)),
          h('td.small', blockBody(b).slice(1)),
          h('td.small', A.outs(model, b).map(t => t.name).join(', ') || h('span.muted', '—'))))),
      h('div.eyebrow', 'Wires'),
      h('ul.nb-cables', model.wires.map(w => h('li', `${blk(w.from)?.name} → ${blk(w.to)?.name} `,
        h('button.btn.ghost.small', { type: 'button', onclick: () => { model.wires = model.wires.filter(x => x !== w); changed(); } }, 'Remove')))),
      h('div.nb-cable-add',
        h('select', { onchange: e => { a = e.target.value; } }, h('option', { value: '' }, 'from…'), model.blocks.filter(b => A.TARGETS[b.kind].length).map(b => h('option', { value: b.id }, b.name))),
        h('span', '→'),
        h('select', { onchange: e => { z = e.target.value; } }, h('option', { value: '' }, 'to…'), model.blocks.map(b => h('option', { value: b.id }, b.name))),
        h('button.btn.primary.small', { type: 'button', onclick: () => { if (!A.connect(model, a, z)) board.say('That wire is not allowed (see which blocks may call which).'); else changed(); } }, 'Wire')),
      h('p.muted.small', 'Click a row to edit that block in the inspector.'));
  }

  // ------------------------------------------------------------ chaos, sending, metrics

  const chaosEl = h('div.ab-chaos');
  function paintChaos() {
    const targets = model.blocks.filter(b => b.kind === 'service' || b.kind === 'db');
    fill(chaosEl, h('div.eyebrow', 'Failure injection'),
      targets.length ? targets.map(b => h('div.ab-chaos-row',
        h('span.ab-chaos-name', `${KINDS[b.kind].icon} ${b.name}`),
        h('label.ab-check', h('input', { type: 'checkbox', checked: !!b.down, onchange: e => { b.down = e.target.checked; changed(); } }), ' down'),
        b.kind === 'service' && h('label.ab-check', 'fail ', h('input.ab-pct', { type: 'number', min: 0, max: 100, value: b.failRate, onchange: e => { b.failRate = Math.max(0, Math.min(100, Number(e.target.value) || 0)); changed(); } }), '%'),
        h('label.ab-check', 'slow ', h('input.ab-pct', { type: 'number', min: 0, step: 50, value: b.latency, onchange: e => { b.latency = Math.max(0, Number(e.target.value) || 0); changed(); } }), 'ms')))
        : h('p.muted.small', 'Add a backend service to break it.'));
  }

  const sendEl = h('div.ab-send');
  const metricsEl = h('div.ab-metrics');
  const outcomesEl = h('div.ab-outcomes');
  function paintSend() {
    const client = model.blocks.find(b => b.kind === 'client');
    fill(sendEl, 
      h('button.btn.primary', { type: 'button', onclick: () => send({ count: 1 }, 'one request') }, '▶ Send 1 request'),
      h('button.btn.ghost', { type: 'button', onclick: () => send({ count: client?.burst || 20 }, `a burst of ${client?.burst || 20}`) }, `⇶ Send a burst (${client?.burst || 20})`),
      challenge.xp > 0 && h('button.btn.ghost', { type: 'button', title: 'The exact scenario the challenge is judged on, with its fixed random seed', onclick: () => send(challenge.scenario, 'the challenge scenario', challenge.seed ?? 7) }, '◎ Run the challenge scenario'));
  }

  async function send(scenario, label, seed = (Date.now() % 100000) + 1) {
    const my = ++sendRun;
    const r = A.run(model, scenario, seed);
    board.stop();
    if (r.error) { fill(outcomesEl, h('div.nb-bad', r.error)); return; }
    last = { run: r, label };
    // Wire colours: a wire is green when most requests that crossed it came back fine.
    const tally = new Map();
    for (const res of r.results) for (const t of res.trace) if (t.type === 'back') {
      const w = model.wires.find(x => (x.from === t.to && x.to === t.from));
      if (!w) continue;
      const c = tally.get(w.id) || { ok: 0, bad: 0 };
      t.code < 400 ? c.ok++ : c.bad++;
      tally.set(w.id, c);
    }
    wireStates = new Map([...tally].map(([id, c]) => [id, c.bad > c.ok ? 'bad' : 'ok']));
    board.render();
    paintMetrics(r);
    paintOutcomes(r);
    const shown = r.results.slice(0, 16);
    const ms = shown.length > 1 ? 260 : 420;
    await Promise.all(shown.map((res, i) => new Promise(resolve => setTimeout(() => {
      if (my !== sendRun) return resolve();
      const hops = res.trace.map(t => ({ from: t.from, to: t.to, cls: t.type === 'hop' ? 'req' : tone(t.code) }));
      board.animate(hops, { ms, label: String(res.code || '…'), endCls: tone(res.code), linger: 300 }).then(resolve);
    }, i * 110))));
    if (my === sendRun) game.sound?.(r.metrics.failed === 0 && !r.metrics.hidden ? 'right' : 'wrong');
  }

  function paintMetrics(r) {
    const m = r.metrics;
    const tile = (label, value, cls = '') => h(`div.ab-tile${cls ? '.' + cls : ''}`, h('div.ab-tile-v', String(value)), h('div.ab-tile-l', label));
    const trap = m.failed === 0 && m.dlq > 0;
    fill(metricsEl, 
      h('div.eyebrow', `Dashboard · ${last.label}`),
      h('div.ab-tiles',
        tile('requests', m.total), tile('successes (2xx)', m.ok, 'ok'), tile('failures', m.failed, m.failed ? 'bad' : ''),
        tile('p50', m.p50 + ' ms'), tile('p95', m.p95 + ' ms')),
      h('div.ab-codes', Object.entries(m.byCode).sort().map(([c, n]) => h(`span.ab-code.${tone(Number(c))}`, `${c === '0' ? '—' : c} ${A.CODE_TEXT[c] || ''} × ${n}`))),
      h('div.eyebrow', 'Behind the scenes'),
      h('div.ab-tiles.small',
        tile('service attempts', m.attempts), tile('backend errors', m.errors, m.errors ? 'bad' : ''), tile('retries', m.retries), tile('timeouts', m.timeouts),
        tile('overloaded', m.overloaded, m.overloaded ? 'bad' : ''), tile('dead-lettered', m.dlq, m.dlq ? 'warn' : ''),
        m.queued > 0 && tile('queued → processed', `${m.queued} → ${m.processed}`, m.lost ? 'bad' : 'ok'),
        m.duplicates > 0 && tile('duplicate writes', m.duplicates, 'bad')),
      trap && h('div.ab-trap', h('b', 'The zero-failures trap. '),
        `The dashboard counts failures from status codes, and every request got a 2xx, so it shows 0. Yet ${m.dlq} request${m.dlq === 1 ? '' : 's'} failed inside and went to the dead-letter queue${m.hidden ? `, ${m.hidden} of them answered 204 as if nothing happened` : ''}. Nothing counts what is not reported: alert on DLQ depth, and do not turn failures into success codes.`),
      m.lost > 0 && h('div.ab-trap', h('b', `${m.lost} queued message${m.lost === 1 ? '' : 's'} never processed. `), m.lostWhy),
      m.duplicates > 0 && h('p.muted.small', 'Duplicate writes: an attempt timed out, the route retried, but the service had already done the work the first time. Retrying non-idempotent calls needs an idempotency key.'));
  }

  function paintOutcomes(r) {
    const groups = new Map();
    for (const x of r.results) { const k = x.code + '|' + x.why; if (!groups.has(k)) groups.set(k, { ...x, n: 0 }); groups.get(k).n++; }
    fill(outcomesEl, h('div.eyebrow', 'What happened'),
      h('ul.ab-outcome-list', [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 8).map(g => h(`li.${tone(g.code)}`,
        h('span.ab-code.' + tone(g.code), `${g.code || '—'} ${A.CODE_TEXT[g.code] || ''}`),
        h('span.ab-n', g.n > 1 ? `× ${g.n}` : `${g.latency} ms`),
        h('div.ab-why', g.why)))));
  }

  // ------------------------------------------------------------ goals, stars, XP

  const goalsEl = h('div.nb-goals');
  function evaluate() {
    paintSend();
    if (!challenge.xp) { fill(goalsEl, h('span.muted.small', 'Sandbox: no goals. Pick a challenge above to earn XP.')); return; }
    const j = A.judge(model, challenge);
    const best = saved.stars[challenge.id] || 0;
    fill(goalsEl, h('div.nb-goal-head',
      h('b', j.ok ? '✓ Goal met' : 'Goal not met yet'),
      h('span.muted.small', `Par ${challenge.par} (${COST_LABEL[challenge.id] || 'blocks + wires'}). You: ${j.cost}.`),
      h('span.nb-stars', starText(Math.max(best, j.stars)))),
    !j.ok && h('p.small.nb-why', j.why),
    h('p.muted.small', 'Judged on the challenge scenario with a fixed random seed, so it is fair and repeatable. Press ◎ to watch it.'));
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
    chipsEl.replaceChildren(...A.CHALLENGES.map(c => h(`button.pk-ch${c.id === challenge.id ? '.active' : ''}${saved.solved[c.id] ? '.solved' : ''}`, { type: 'button', onclick: () => pick(c) },
      c.title, c.xp ? h('span.nb-chip-stars', saved.stars[c.id] ? ' ' + starText(saved.stars[c.id]) : ` +${c.xp}`) : '')));
    counter.textContent = `${A.CHALLENGES.filter(c => c.xp && saved.solved[c.id]).length} / ${A.CHALLENGES.filter(c => c.xp).length} solved`;
  }
  const briefEl = h('div.pk-brief');
  function paintBrief() {
    fill(briefEl, h('div', { html: md(challenge.brief) }),
      h('button.btn.ghost.small', { type: 'button', onclick: () => { model = challenge.setup(); last = null; fill(metricsEl); fill(outcomesEl); board.select(null); changed(); requestAnimationFrame(() => board.fit()); } }, 'Reset'));
  }
  function pick(c) {
    challenge = c;
    model = c.setup();
    last = null;
    fill(metricsEl); fill(outcomesEl);
    paintChips(); paintBrief();
    board.select(null);
    changed();
    requestAnimationFrame(() => board.fit());
  }

  container.replaceChildren(
    h('div.pk-top', chipsEl, counter),
    briefEl,
    goalsEl,
    h('div.ab-sendbar', sendEl),
    h('div.nb-main',
      h('div.nb-left', board.el, h('div.ab-under', outcomesEl, metricsEl)),
      h('div.nb-right', board.inspectorEl, chaosEl)));
  paintChips(); paintBrief();
  board.render();
  paintChaos();
  evaluate();
  requestAnimationFrame(() => board.fit());
  return () => { sendRun++; board.stop(); };
}
