// System design board: rack real equipment (users, DNS, a CDN, load balancers, app server racks, cache clusters, a
// primary database with shards and a standby, read replicas, a stream with workers, a storage array), cable it, set the
// traffic, inject failures, and run a 10-minute load test. The dashboard looks like a Grafana board: latency
// percentiles, throughput and errors, utilisation per component, cache hit rate, replica lag and queue backlog, each
// with the incident shaded and a shared crosshair; plus plain-English findings, a capacity sheet, the monthly bill and
// the back-of-the-envelope numbers. Goals are judged live on a fixed seed. The model lives in sdsim.js (DOM-free).
import { h, md } from './util.js';
import * as game from './game.js';
import { createBoard } from './blocks.js';
import * as S from './sdsim.js';

const LAB = 'sysdesign';
const COLORS = { client: '#5b8def', dns: '#6fb3d9', cdn: '#4fb7c9', lb: '#d08a4a', app: '#3fb68b', cache: '#3fb6a8', db: '#a8957a', replica: '#b8a57f', queue: '#c9a24a', worker: '#7fb35a', objstore: '#8f9bb0' };
const ART = { client: 'users', dns: 'dnsserver', cdn: 'edgepop', lb: 'loadbalancer', app: 'rack', cache: 'cache', db: 'database', replica: 'dbreplica', queue: 'log', worker: 'consumerapp', objstore: 'storagearray' };
const KINDS = Object.fromEntries(Object.entries(S.KINDS).map(([k, v]) => [k, { ...v, color: COLORS[k], width: 220, art: ART[k] }]));
const NAMES = { client: 'Users', dns: 'DNS', cdn: 'CDN', lb: 'Load balancer', app: 'API servers', cache: 'Cache', db: 'Primary DB', replica: 'Read replicas', queue: 'Stream', worker: 'Workers', objstore: 'Object storage' };
const INCIDENTS = {
  az: { label: 'Zone A of region 1 fails', until: true },
  region: { label: 'Region 1 goes dark', until: true },
  flush: { label: 'Cache flushed (FLUSHALL)', until: false },
  hotkey: { label: 'Celebrity key: half the reads', until: true, extra: { share: 0.5 } },
  slowdb: { label: 'Database 4× slower (bad plan)', until: true, extra: { factor: 4 } },
  spike: { label: 'Traffic spike 3×', until: true, extra: { factor: 3 } },
  slownode: { label: 'One app server 10× slower (gray failure)', until: true },
  retrystorm: { label: 'Clients retry every failure 3× at once', until: false },
};
// Grafana-like series colours (no purple)
const C = { green: '#73bf69', yellow: '#fade2a', orange: '#ff9830', red: '#f2495c', blue: '#5794f2', cyan: '#8ab8ff', teal: '#5ac8c8', sand: '#d6b77a', lime: '#b6e36c' };
const UTIL_COLORS = [C.blue, C.orange, C.teal, C.sand, C.lime, C.cyan, C.yellow];
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const starText = n => '★'.repeat(n) + '☆'.repeat(3 - n);
const pct = x => `${Math.round((x || 0) * 100)}%`;
const tone = u => (u >= 1 ? 'bad' : u >= 0.85 ? 'hot' : u >= 0.7 ? 'warm' : 'ok');
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };

export function sysDesignLab(container, onXp) {
  const saved = game.state.labs[LAB] ||= { solved: {}, stars: {}, challenge: 'first-service', model: null, modelFor: null, view: 'board' };
  saved.stars ||= {}; saved.solved ||= {};
  saved.sandbox ||= { incidents: [] };
  let challenge = S.CHALLENGES.find(c => c.id === saved.challenge) || S.CHALLENGES[1];
  let model = saved.model && saved.modelFor === challenge.id ? saved.model : challenge.setup();
  let judged = null;          // { run, goals, ok, cost, stars }
  let shownTick = null;       // the tick the board shows (playback / crosshair); null = peak values
  let playing = 0;
  let win = 'all';
  const meters = new Map();   // block id -> update(tick)

  const blk = id => S.byId(model, id);
  const persist = () => { saved.model = model; saved.modelFor = challenge.id; saved.challenge = challenge.id; game.save(); };
  const scenario = () => (challenge.xp ? challenge.scenario : { incidents: saved.sandbox.incidents });
  const isLocked = () => challenge.xp > 0;

  let timer = 0;
  function changed() {
    persist();
    playing++;
    shownTick = null;
    clearTimeout(timer);
    timer = setTimeout(() => { evaluate(); board.render(); paintSide(); }, 60);
  }

  const wireKind = w => {
    const f = blk(w.from), t = blk(w.to);
    if (f?.kind === 'db' && t?.kind === 'replica') return 'replication';
    if (t?.kind === 'queue') return 'publish';
    if (f?.kind === 'queue') return 'consume';
    if (t?.kind === 'db' || t?.kind === 'replica') return 'sql';
    if (t?.kind === 'cache') return 'cache';
    if (t?.kind === 'objstore') return 'presign';
    if (f?.kind === 'client' || f?.kind === 'dns') return 'https';
    return 'http';
  };

  // ------------------------------------------------------------ the board

  const board = createBoard({
    kinds: KINDS,
    portSide: 'right',
    arrows: true,
    wireKinds: { https: { label: 'HTTPS' }, http: { label: 'HTTP' }, sql: { label: 'SQL' }, cache: { label: 'GET/SET' }, publish: { label: 'publish' }, consume: { label: 'consume' }, replication: { label: 'WAL stream', color: '#b8a57f' }, presign: { label: 'presigned URL' } },
    blocks: () => model.blocks,
    wires: () => model.wires.map(w => ({ id: w.id, kind: wireKind(w), from: { block: w.from, port: 'out' }, to: { block: w.to } })),
    ports: b => (S.TARGETS[b.kind].length ? [{ id: 'out', label: '', on: model.wires.some(w => w.from === b.id), title: `Drag onto ${S.TARGETS[b.kind].map(k => S.KINDS[k].label).join(', ')}` }] : []),
    body: blockBody,
    canConnect: (from, port, to) => S.canWire(model, from, to),
    connect: (from, port, to) => {
      if (!S.connect(model, from.id, to.id)) return `${S.KINDS[from.kind].label} cannot be wired to ${S.KINDS[to.kind].label}.`;
      changed();
      return false;
    },
    onDropEmpty: from => {
      const n = model.wires.length;
      model.wires = model.wires.filter(w => w.from !== from.id);
      if (n !== model.wires.length) changed();
      return false;
    },
    palette: Object.keys(S.KINDS).map(kind => ({ kind, label: NAMES[kind], title: `Add ${S.KINDS[kind].label.toLowerCase()} (drag it onto the floor, or click)`, add: at => addBlock(kind, at) })),
    howto: 'Drag equipment to move it. Drag a ▶ port onto the next device to cable it; drop it on empty floor to unplug. Click to configure; Delete removes. Wheel zooms.',
    inspector,
    onDelete: sel => {
      if (sel.type === 'wire') model.wires = model.wires.filter(w => w.id !== sel.id);
      else {
        if (blk(sel.id)?.kind === 'client' && isLocked()) { board.say('The users are the requirement: they stay.'); return; }
        model.blocks = model.blocks.filter(b => b.id !== sel.id); model.wires = model.wires.filter(w => w.from !== sel.id && w.to !== sel.id);
      }
      changed();
    },
    onMove: () => persist(),
    blockClass: b => blockTone(b),
    wireState: w => wireTone(w.to.block),
    wireLabel: w => ({ https: 'HTTPS', sql: 'SQL', cache: 'GET/SET', publish: 'publish', consume: 'consume', replication: 'WAL', presign: 'presigned' }[w.kind] || ''),
    zones: () => {
      const z = [];
      const edge = model.blocks.filter(b => b.kind === 'dns' || b.kind === 'cdn').map(b => b.id);
      if (edge.length) z.push({ id: 'edge', label: 'internet edge', tone: 2, members: edge });
      for (const r of [1, 2]) {
        const members = model.blocks.filter(b => !['client', 'dns', 'cdn'].includes(b.kind) && (b.region || 1) === r).map(b => b.id);
        if (members.length) z.push({ id: 'r' + r, label: `region ${r}${r === 1 ? ' · zones A, B, C' : ' · standby region'}`, tone: r === 1 ? 1 : 3, members });
      }
      return z;
    },
    form: formView,
    view: saved.view,
    onView: v => { saved.view = v; persist(); },
  });

  function addBlock(kind, at) {
    if (kind === 'client' && model.blocks.some(b => b.kind === 'client')) return 'One Users block is enough: set its traffic in the inspector.';
    let i = 1;
    while (model.blocks.some(b => b.id === kind + i)) i++;
    const b = S.block(kind, kind + i, `${NAMES[kind]}${i > 1 ? ' ' + i : ''}`, at.x, at.y);
    model.blocks.push(b);
    changed();
    return b;
  }

  // what a block looks like at the shown tick (or at its worst over the run)
  const tickAt = () => (judged?.run?.ticks ? (shownTick != null ? judged.run.ticks[shownTick] : null) : null);
  const utilOf = (b, t) => {
    const R = judged?.run;
    if (!R?.ticks) return null;
    if (t) return t.util[b.id];
    return R.windows.all.maxUtil[b.id];
  };
  function blockTone(b) {
    const t = tickAt();
    const R = judged?.run;
    if (!R?.ticks) return '';
    const dead = isDead(b, t);
    if (dead) return 'bad dead';
    const u = utilOf(b, t);
    if (u == null) return '';
    return u >= 1 ? 'bad' : u >= 0.85 ? 'hot' : '';
  }
  function isDead(b, t) {
    if (!t) return false;
    const inc = scenario().incidents || [];
    const on = k => inc.find(i => i.kind === k && t.t >= i.at && t.t < (i.until ?? Infinity));
    if (on('region') && (b.region || 1) === 1 && !['client', 'dns', 'cdn'].includes(b.kind)) return true;
    if (b.kind === 'app' && t.alive?.[b.id] === 0) return true;
    if (b.kind === 'db' && (t.dbMode === 'down' || t.dbMode === 'failover')) return true;
    if (b.kind === 'cache' && t.cache?.[b.id]?.dead) return true;
    return false;
  }
  function wireTone(toId) {
    if (!judged?.run?.ticks) return '';
    const to = blk(toId);
    if (!to) return '';
    const t = tickAt();
    if (isDead(to, t)) return 'bad';
    const u = utilOf(to, t);
    if (u == null) return judged.run.windows.all.errRate > 0.05 && !t ? '' : 'ok';
    return u >= 1 ? 'bad' : 'ok';
  }

  function meter(label, u, extra = '') {
    const v = u == null ? null : Math.max(0, u);
    return h(`div.sd-meter.${v == null ? 'idle' : tone(v)}`,
      h('span.sd-meter-l', label),
      h('span.sd-meter-bar', h('span.sd-meter-fill', { style: { width: v == null ? '0%' : Math.min(100, v * 100) + '%' } })),
      h('span.sd-meter-v', v == null ? '—' : v > 9.99 ? '>999%' : pct(v)), extra && h('span.sd-meter-x', extra));
  }

  /** A row of small units (instances, nodes, shards, partitions) with a light each. */
  function units(n, lit = () => 'ok', max = 16) {
    const shown = Math.min(n, max);
    return h('div.sd-units', Array.from({ length: shown }, (_, i) => h(`span.sd-unit.${lit(i)}`)), n > max && h('span.sd-units-more', `+${n - max}`));
  }

  function blockBody(b) {
    const line = t => h('div.sd-line', t);
    const tags = [];
    const t = tickAt();
    const R = judged?.run?.ticks ? judged.run : null;
    let lines = [];
    const u = R ? utilOf(b, t) : null;
    if (b.kind === 'client') {
      lines = [h('div.sd-big', `${S.fmtQps(b.qps)} req/s`), line(`${b.readPct}% reads · ${b.respKB} KB out`), line(`${S.fmtQps(b.keys)} keys · skew ${b.skew}`)];
      if (b.uploadKB) lines.push(line(`uploads ${b.uploadKB >= 1000 ? b.uploadKB / 1000 + ' MB' : b.uploadKB + ' KB'}`));
      if (R) { const x = t || R.ticks.reduce((a, c) => (c.attempts > a.attempts ? c : a), R.ticks[0]); if (x.clientAmp > 1.2) tags.push(h('span.bk-tag.bad', `retries ×${x.clientAmp.toFixed(1)}`)); }
    }
    if (b.kind === 'dns') { lines = [line(`${b.policy} routing · TTL ${b.ttl} s`), line(b.healthChecks ? 'health-checked failover' : 'no health checks')]; }
    if (b.kind === 'cdn') { const cl = model.blocks.find(x => x.kind === 'client'); lines = [line(`hit ${b.hitPct}% of cacheable`), line(`${cl?.cacheablePct ?? 0}% of reads cacheable`)]; }
    if (b.kind === 'lb') { lines = [line(`${b.layer} · ${b.algo}`), line(b.healthChecks ? 'health checks on' : 'no health checks'), line(b.rateLimit ? `limit ${S.fmtQps(b.rateLimit)}/s` : 'no rate limit')]; }
    if (b.kind === 'app') {
      const sz = S.SIZES.app[b.size];
      const alive = t?.alive?.[b.id] ?? b.instances;
      const dead = (t?.appState?.[b.id]?.total ?? b.instances) - alive;
      lines = [line(`${b.instances} × ${b.size} (${sz.vcpu} vCPU) · ${b.azs} AZ${b.azs === 1 ? '' : 's'}`), line(`${b.cpuMs} ms CPU per request`),
        units(t?.appState?.[b.id]?.total ?? b.instances, i => (i < dead ? 'off' : u == null ? 'idle' : tone(u))), meter('CPU', u)];
      if (R && R.windows.all.maxUtil[b.id + ':nic'] > 0.5) lines.push(meter('NIC', t ? t.util[b.id + ':nic'] : R.windows.all.maxUtil[b.id + ':nic']));
      if (b.breaker) tags.push(h('span.bk-tag', 'breaker'));
      if (b.nearCache) tags.push(h('span.bk-tag', 'near cache'));
      if (b.retries) tags.push(h('span.bk-tag.warn', `${b.retries} retr${b.retries === 1 ? 'y' : 'ies'}${b.backoff === 'jitter' ? ' + jitter' : ''}`));
    }
    if (b.kind === 'cache') {
      const sz = S.SIZES.cache[b.size];
      const hit = t ? t.hit : R ? Math.min(...R.ticks.map(x => x.hit ?? 1)) : null;
      lines = [line(`${b.nodes} × ${sz.mem} GB · TTL ${b.ttl} s${b.azs > 1 ? ' · replicated' : ''}`), units(b.nodes, i => (u == null ? 'idle' : i === 0 ? tone(u) : tone(t?.cache?.[b.id]?.avgUtil ?? 0))), meter('busiest node', u)];
      if (hit != null) lines.push(meter(t ? 'hit rate' : 'lowest hit', hit, ''));
      if (b.coalesce) tags.push(h('span.bk-tag', 'single-flight'));
    }
    if (b.kind === 'db') {
      const sz = S.SIZES.db[b.size];
      const su = t ? t.shardUtil : R ? Array.from({ length: b.shards }, (_, i) => Math.max(...R.ticks.map(x => x.shardUtil[i] || 0))) : [];
      lines = [line(`${b.shards > 1 ? b.shards + ' shards × ' : ''}${b.size} (${sz.vcpu} vCPU)${b.shards > 1 ? ' · ' + b.partition : ''}`), line(`max_connections ${sz.maxConn}${b.pooler ? ' · pooler' : ''}`)];
      if (b.shards > 1) lines.push(units(b.shards, i => (su[i] == null ? 'idle' : tone(su[i]))));
      lines.push(meter(b.shards > 1 ? 'busiest shard' : 'CPU', u));
      if (b.standby) tags.push(h('span.bk-tag', 'standby'));
      if (!b.indexed) tags.push(h('span.bk-tag.bad', 'Seq Scan'));
      const conns = t?.connRefused ?? (R ? Math.max(...R.ticks.map(x => x.connRefused)) : 0);
      if (conns > 0) tags.push(h('span.bk-tag.bad', 'too many clients'));
    }
    if (b.kind === 'replica') {
      const lag = t ? t.lag[b.id] : R?.ticks ? Math.max(0, ...R.ticks.map(x => x.lag[b.id] || 0)) : null;
      lines = [line(`${b.count} × ${b.size} per shard${b.promote ? ' · promotable' : ''}`), units(b.count, () => (u == null ? 'idle' : tone(u))), meter('CPU', u)];
      if (lag != null) tags.push(h(`span.bk-tag${lag > 1 ? '.bad' : lag > 0.3 ? '.warn' : ''}`, `lag ${lag >= 1 ? lag.toFixed(1) + ' s' : Math.round(lag * 1000) + ' ms'}`));
    }
    if (b.kind === 'queue') {
      const q = t ? t.queue[b.id] : R?.ticks ? R.ticks.reduce((a, c) => ((c.queue[b.id]?.backlog || 0) > (a?.backlog || 0) ? c.queue[b.id] : a), null) : null;
      lines = [line(`${b.partitions} partitions · ${S.fmtQps(b.partitions * 1000)} msg/s`), units(b.partitions, () => (u == null ? 'idle' : tone(u)), 24), meter('publish', u)];
      if (q) tags.push(h(`span.bk-tag${q.backlog > 1000 ? '.warn' : ''}`, `backlog ${S.fmtQps(q.backlog)}`));
    }
    if (b.kind === 'worker') {
      lines = [line(`${b.instances} × ${b.size} · batch ${b.batch}`), units(b.instances, i => (i >= (model.blocks.find(x => x.kind === 'queue' && model.wires.some(w => w.from === x.id && w.to === b.id))?.partitions ?? 99) ? 'off' : u == null ? 'idle' : tone(u))), meter('busy', u)];
    }
    if (b.kind === 'objstore') lines = [line('11 nines durability'), line('direct uploads (presigned)')];
    if ((b.region || 1) === 2 && !['client', 'dns', 'cdn'].includes(b.kind)) tags.push(h('span.bk-tag', 'region 2'));
    if (isDead(b, t)) tags.unshift(h('span.bk-tag.bad', 'DOWN'));
    return [h('div.bk-name', b.name), lines, tags.length > 0 && h('div.bk-tags', tags)];
  }

  // ------------------------------------------------------------ inspector

  const field = (label, control, help) => h('label.pk-field', h('span', label), control, help && h('span.muted.small', help));
  const num = (b, key, opts = {}) => h('input', { type: 'number', value: b[key], min: opts.min ?? 0, max: opts.max, step: opts.step || 1, disabled: !!opts.disabled,
    onchange: e => { b[key] = Math.max(opts.min ?? 0, Math.min(opts.max ?? 1e9, Number(e.target.value) || 0)); changed(); } });
  const check = (b, key, label, disabled) => h('label.ab-check', h('input', { type: 'checkbox', checked: !!b[key], disabled: !!disabled, onchange: e => { b[key] = e.target.checked; changed(); } }), ' ', label);
  const text = (b, key) => h('input', { value: b[key] ?? '', onchange: e => { b[key] = e.target.value.trim() || b[key]; changed(); } });
  const select = (b, key, options, disabled, asNum) => h('select', { disabled: !!disabled, onchange: e => { b[key] = asNum ? Number(e.target.value) : e.target.value; changed(); } },
    options.map(([v, l]) => h('option', { value: v, selected: String(b[key]) === String(v) }, l)));
  const sizes = kind => Object.entries(S.SIZES[kind]).map(([k, v]) => [k, kind === 'cache' ? `${k}: ${v.mem} GB, ${S.fmtQps(v.ops)} ops/s, ${S.fmtUsd(v.usd)}/mo` : `${k}: ${v.vcpu} vCPU, ${S.fmtUsd(v.usd)}/mo`]);
  const regionSel = b => field('Region', select(b, 'region', [[1, 'Region 1'], [2, 'Region 2']], false, true));

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click a device or a cable to configure it. Click Users to see the traffic.');
    if (sel.type === 'wire') {
      const w = model.wires.find(x => x.id === sel.id);
      if (!w) return null;
      return h('div.pk-inspect',
        h('div.pk-inspect-head', h('b', 'Cable'), h('button.btn.ghost.small', { type: 'button', onclick: () => { model.wires = model.wires.filter(x => x !== w); changed(); } }, 'Unplug')),
        h('p', `${blk(w.from)?.name} → ${blk(w.to)?.name} (${wireKind(w)})`));
    }
    const b = blk(sel.id);
    if (!b) return null;
    const k = KINDS[b.kind];
    const lock = b.kind === 'client' && isLocked();
    const parts = [
      h('div.pk-inspect-head', h('b', `${k.icon} ${k.label}`),
        !lock && h('button.btn.ghost.small', { type: 'button', onclick: () => { model.blocks = model.blocks.filter(x => x !== b); model.wires = model.wires.filter(w => w.from !== b.id && w.to !== b.id); board.select(null); changed(); } }, 'Remove')),
      field('Name', text(b, 'name')),
    ];
    if (b.kind === 'client') parts.push(
      lock && h('p.muted.small', 'The traffic is the requirement in a challenge, so it is locked. The Sandbox lets you change it.'),
      h('div.pk-two', field('Peak requests/s', num(b, 'qps', { min: 1, max: 2000000, step: 500, disabled: lock })), field('Reads %', num(b, 'readPct', { max: 100, disabled: lock }))),
      h('div.pk-two', field('Distinct keys', num(b, 'keys', { min: 1, step: 100000, disabled: lock }), 'The working set: products, users, links.'), field('Key skew (Zipf s)', num(b, 'skew', { min: 0, max: 1.5, step: 0.05, disabled: lock }), '0 = uniform, 1 = a few keys dominate.')),
      h('div.pk-two', field('Object size KB', num(b, 'objKB', { min: 0.1, step: 0.5, disabled: lock }), 'One cached item.'), field('Response KB', num(b, 'respKB', { min: 0.1, step: 1, disabled: lock }))),
      h('div.pk-two', field('Stored per write KB', num(b, 'rowKB', { min: 0, step: 0.1, disabled: lock })), field('Cacheable at the edge %', num(b, 'cacheablePct', { max: 100, disabled: lock }))),
      h('div.pk-two', field('Uploads % of writes', num(b, 'uploadPct', { max: 100, disabled: lock })), field('Upload size KB', num(b, 'uploadKB', { step: 100, disabled: lock }))),
      h('div.pk-two', field('Write keys', select(b, 'writeKeys', [['random', 'random ids'], ['time-ordered', 'time-ordered ids']], lock)), field('Round trip to region ms', num(b, 'rttMs', { step: 5, disabled: lock }))),
      field('Users near region 1 %', num(b, 'share1', { max: 100, disabled: lock }), 'Used by latency-based DNS with two regions.'));
    if (b.kind === 'dns') parts.push(
      field('Routing policy', select(b, 'policy', [['simple', 'simple (all records, round robin)'], ['latency', 'latency-based (nearest region)'], ['failover', 'failover (primary, then secondary)']])),
      h('div.pk-two', field('TTL s', num(b, 'ttl', { min: 0, step: 10 }), 'Resolvers keep an answer this long.'), h('div', check(b, 'healthChecks', 'Health checks'))),
      h('p.muted.small', 'Wire DNS to one load balancer per region. Without health checks it keeps handing out a dead region\'s address.'));
    if (b.kind === 'cdn') parts.push(field('Hit rate % of cacheable reads', num(b, 'hitPct', { max: 100 })), h('p.muted.small', 'Serves cacheable reads from the edge, about 12 ms from the user. What is cacheable is set on Users.'));
    if (b.kind === 'lb') parts.push(
      h('div.pk-two', field('Layer', select(b, 'layer', [['L4', 'L4 (TCP)'], ['L7', 'L7 (HTTP)']])), field('Algorithm', select(b, 'algo', [['round-robin', 'round robin'], ['least-conn', 'least connections']]))),
      check(b, 'healthChecks', 'Health checks (3 failures 10 s apart remove an instance)'),
      field('Rate limit (requests/s)', num(b, 'rateLimit', { step: 500 }), '0 = off. The excess gets a fast 429 instead of queueing.'), regionSel(b));
    if (b.kind === 'app') parts.push(
      h('div.pk-two', field('Instances', num(b, 'instances', { min: 1, max: 2000 })), field('Size', select(b, 'size', sizes('app')))),
      h('div.pk-two', field('Availability zones', select(b, 'azs', [[1, '1 zone'], [2, '2 zones'], [3, '3 zones']], false, true)), field('CPU ms per request', num(b, 'cpuMs', { min: 0.1, step: 0.5, disabled: isLocked() }), isLocked() ? 'Set by the code, not by you.' : '')),
      h('div.pk-two', field('DB connections per instance', num(b, 'pool', { min: 1, max: 200 })), field('DB timeout ms', num(b, 'timeoutMs', { min: 10, step: 50 }))),
      h('div.pk-two', field('Retries on DB errors', num(b, 'retries', { max: 5 })), field('Backoff', select(b, 'backoff', [['none', 'none (immediate)'], ['jitter', 'exponential + jitter, 10% budget']]))),
      check(b, 'breaker', 'Circuit breaker on database calls (fail fast when it is drowning)'),
      check(b, 'nearCache', 'Near cache: the 10,000 hottest keys in memory, 5 s TTL'),
      check(b, 'saltHotKeys', 'Salt hot keys across shards (writes)'),
      field('Autoscale up to (instances)', num(b, 'autoscaleMax', { max: 2000 }), '0 = off. Targets 60% CPU; a new instance takes 2 minutes to boot.'), regionSel(b));
    if (b.kind === 'cache') parts.push(
      h('div.pk-two', field('Nodes', num(b, 'nodes', { min: 1, max: 200 })), field('Node size', select(b, 'size', sizes('cache')))),
      h('div.pk-two', field('TTL s', num(b, 'ttl', { min: 0, step: 60 }), '0 = no expiry.'), field('Replicas', select(b, 'azs', [[1, 'none'], [2, 'one per node, another zone']], false, true))),
      check(b, 'coalesce', 'Single-flight: concurrent misses for a key share one query'),
      h('p.muted.small', 'Cache-aside: the API servers read it first, query the database on a miss and fill it; a write deletes the key.'), regionSel(b));
    if (b.kind === 'db') parts.push(
      h('div.pk-two', field('Instance size', select(b, 'size', sizes('db'))), field('Shards', num(b, 'shards', { min: 1, max: 64 }))),
      field('Partitioning', select(b, 'partition', [['hash', 'hash of the key'], ['range', 'range of the key']])),
      check(b, 'indexed', 'The hot query has an index (else: Seq Scan)'),
      check(b, 'standby', 'Synchronous standby in another zone (automatic failover, about 30 s)'),
      check(b, 'pooler', 'Connection pooler in transaction mode (PgBouncer-style)'),
      h('p.muted.small', 'Wire its ▶ to Read replicas to stream the write-ahead log to them.'), regionSel(b));
    if (b.kind === 'replica') parts.push(
      h('div.pk-two', field('Replicas per shard', num(b, 'count', { min: 1, max: 15 })), field('Size', select(b, 'size', sizes('db')))),
      check(b, 'promote', 'May be promoted to primary if the primary\'s region is lost'),
      h('p.muted.small', 'Wire API servers → replicas to send reads here. Replication is asynchronous: reads can be a little stale.'), regionSel(b));
    if (b.kind === 'queue') parts.push(field('Partitions', num(b, 'partitions', { min: 1, max: 512 }), '1,000 messages/s each; one consumer per partition per group.'), regionSel(b));
    if (b.kind === 'worker') parts.push(
      h('div.pk-two', field('Instances', num(b, 'instances', { min: 1, max: 1000 })), field('Size', select(b, 'size', sizes('app')))),
      h('div.pk-two', field('CPU ms per message', num(b, 'cpuMs', { min: 0.1, step: 0.5 })), field('Batch size', num(b, 'batch', { min: 1, max: 1000 }), 'Rows per commit.')),
      h('p.muted.small', 'Wire the stream → workers → Primary DB.'), regionSel(b));
    if (b.kind === 'objstore') parts.push(h('p.muted.small', 'Wire API servers → object storage: clients then upload and download files directly with presigned URLs, and the database keeps only metadata.'), regionSel(b));
    return h('div.pk-inspect', parts);
  }

  // ------------------------------------------------------------ form view

  function formView() {
    let a = '', z = '';
    return h('div.ab-form',
      h('table.nb-ftable', h('tr', h('th', 'Equipment'), h('th', 'Settings'), h('th', 'Calls')),
        model.blocks.map(b => h('tr', { onclick: e => { if (!e.target.closest('input,button,select')) board.select({ type: 'block', id: b.id }); } },
          h('td', h('b', `${KINDS[b.kind].icon} ${b.name}`), h('div.muted.small', KINDS[b.kind].label)),
          h('td.small', blockBody(b).slice(1)),
          h('td.small', S.outs(model, b).map(t => t.name).join(', ') || h('span.muted', '—'))))),
      h('div.nb-cable-add',
        h('select', { onchange: e => { a = e.target.value; } }, h('option', { value: '' }, 'from…'), model.blocks.filter(b => S.TARGETS[b.kind].length).map(b => h('option', { value: b.id }, b.name))),
        h('span', '→'),
        h('select', { onchange: e => { z = e.target.value; } }, h('option', { value: '' }, 'to…'), model.blocks.map(b => h('option', { value: b.id }, b.name))),
        h('button.btn.primary.small', { type: 'button', onclick: () => { if (!S.connect(model, a, z)) board.say('That cable is not allowed.'); else changed(); } }, 'Cable')),
      h('p.muted.small', 'Click a row to edit it in the inspector.'));
  }

  // ------------------------------------------------------------ failure injection

  const chaosEl = h('div.ab-chaos.sd-chaos');
  function paintSide() {
    const inc = scenario().incidents || [];
    if (isLocked()) {
      fill(chaosEl, h('div.eyebrow', 'Failure injection (part of the challenge)'),
        inc.length ? h('ul.sd-inc-list', inc.map(i => h('li', h('span.sd-inc-t', S.fmtTime(i.at)), ' ', INCIDENTS[i.kind]?.label || i.kind, i.until && i.until < 600 && INCIDENTS[i.kind]?.until ? h('span.muted', ` until ${S.fmtTime(i.until)}`) : '')))
          : h('p.muted.small', 'No incident: a steady peak for 10 minutes.'),
        h('p.muted.small', 'Free experiments go in the Sandbox.'));
      return;
    }
    const times = Array.from({ length: 10 }, (_, i) => i * 60);
    fill(chaosEl, h('div.eyebrow', 'Failure injection'),
      Object.entries(INCIDENTS).map(([kind, d]) => {
        const cur = inc.find(i => i.kind === kind);
        const setInc = patch => {
          const list = (saved.sandbox.incidents || []).filter(i => i.kind !== kind);
          if (patch) list.push({ kind, at: 240, ...(d.until ? { until: 360 } : kind === 'flush' ? { until: 250 } : {}), ...(d.extra || {}), ...cur, ...patch });
          saved.sandbox.incidents = list.sort((x, y) => x.at - y.at);
          changed();
        };
        return h('div.ab-chaos-row',
          h('label.ab-check', h('input', { type: 'checkbox', checked: !!cur, onchange: e => setInc(e.target.checked ? {} : null) }), ' ', d.label),
          cur && h('span.sd-inc-when', 'at ', h('select', { onchange: e => setInc({ at: Number(e.target.value) }) }, times.map(t => h('option', { value: t, selected: cur.at === t }, S.fmtTime(t)))),
            d.until && [' for ', h('select', { onchange: e => setInc({ until: cur.at + Number(e.target.value) }) }, [60, 120, 180, 360, 600].map(s => h('option', { value: s, selected: (cur.until - cur.at) === s }, s >= 600 ? 'the rest' : `${s / 60} min`)))]));
      }));
  }

  // ------------------------------------------------------------ dashboard (Grafana-like)

  const statsEl = h('div.sd-stats');
  const chartsEl = h('div.sd-charts');
  const findingsEl = h('div.sd-panel.sd-findings');
  const sheetEl = h('div.sd-panel.sd-sheet');
  const billEl = h('div.sd-panel.sd-bill');
  const estEl = h('div.sd-panel.sd-est');
  const dashEl = h('div.sd-dash', h('div.sd-dash-head', h('span.sd-dash-title', '▦ Load test dashboard'), h('span.muted.small', ' · 10 minutes at peak, 10 s per point, fixed seed')), statsEl, chartsEl, h('div.sd-dash-grid', findingsEl, sheetEl, billEl, estEl));
  let charts = [];

  function goalNumber(re) { for (const g of judged?.goals || []) { const m = g.label.match(re); if (m) return Number(m[1].replace(/,/g, '')); } return null; }

  function paintDash() {
    const R = judged?.run;
    if (!R || R.error) { fill(statsEl, h('div.sd-panel.sd-empty', R?.error || 'Cable the equipment to run the load test.')); fill(chartsEl); fill(findingsEl); fill(sheetEl); fill(billEl); fill(estEl); charts = []; return; }
    const w = R.windows[win] || R.windows.all;
    const peakAttempts = Math.max(...R.ticks.map(t => t.attempts));
    const hits = R.ticks.map(t => t.hit).filter(x => x != null);
    const p99goal = goalNumber(/p99 under ([\d,]+) ms/);
    const stat = (label, value, cls, sub) => h(`div.sd-stat.${cls || 'neutral'}`, h('div.sd-stat-l', label), h('div.sd-stat-v', value), sub && h('div.sd-stat-s', sub));
    fill(statsEl,
      stat('peak load', `${S.fmtQps(R.ticks[0].offered)}/s`, 'neutral', peakAttempts > R.ticks[0].offered * 1.2 ? `${S.fmtQps(peakAttempts)} attempts with retries` : 'requests at peak'),
      stat('p50', w.p50 ? S.fmtMs(w.p50) : '—', 'neutral'),
      stat('p99', w.p99 ? S.fmtMs(w.p99) : '—', !w.p99 ? 'bad' : p99goal && w.p99 >= p99goal ? 'bad' : w.p99 > 300 ? 'warn' : 'ok', p99goal ? `goal < ${p99goal} ms` : ''),
      stat('availability', `${(w.avail * 100).toFixed(w.avail > 0.999 ? 2 : 1)}%`, w.avail >= 0.999 ? 'ok' : w.avail >= 0.99 ? 'warn' : 'bad', `${(w.errRate * 100).toFixed(2)}% of attempts failed`),
      hits.length ? stat('cache hit (lowest)', pct(Math.min(...hits)), Math.min(...hits) > 0.8 ? 'ok' : 'warn') : null,
      stat('monthly cost', S.fmtUsd(R.cost.total), challenge.xp && R.cost.total > S.budgetOf(challenge) ? 'bad' : 'neutral', challenge.xp ? `par ${S.fmtUsd(challenge.par)}` : ''));

    const ts = R.ticks.map(t => t.t);
    const inc = R.scenario.incidents || [];
    const bands = inc.filter(i => i.kind !== 'retrystorm').map(i => ({ from: i.at, to: Math.max(i.at + 10, i.until ?? R.scenario.duration), label: INCIDENTS[i.kind]?.label || i.kind }));
    const utilSeries = [];
    let ci = 0;
    for (const b of model.blocks) {
      if (!R.ticks.some(t => t.util[b.id] != null)) continue;
      utilSeries.push({ name: b.name + (b.kind === 'cache' ? ' (busiest node)' : b.kind === 'db' && b.shards > 1 ? ' (busiest shard)' : ''), color: UTIL_COLORS[ci++ % UTIL_COLORS.length], values: R.ticks.map(t => (t.util[b.id] ?? 0) * 100) });
    }
    const specs = [
      { title: 'Latency of successful requests', unit: 'ms', log: true, series: [
        { name: 'p50', color: C.green, values: R.ticks.map(t => t.p50 || null) },
        { name: 'p95', color: C.yellow, values: R.ticks.map(t => t.p95 || null) },
        { name: 'p99', color: C.red, values: R.ticks.map(t => t.p99 || null) }], threshold: p99goal ? { v: p99goal, label: `goal ${p99goal} ms` } : null },
      { title: 'Throughput', unit: '/s', series: [
        { name: 'requests', color: C.blue, values: R.ticks.map(t => t.offered) },
        peakAttempts > R.ticks[0].offered * 1.05 && { name: 'attempts (with retries)', color: C.cyan, dash: true, values: R.ticks.map(t => t.attempts) },
        { name: 'failed', color: C.red, area: true, values: R.ticks.map(t => t.attempts * t.err) }].filter(Boolean) },
      { title: 'Utilisation', unit: '%', series: utilSeries, threshold: { v: 100, label: 'saturated' }, warnAt: 70, clampMax: 200 },
      { title: 'Errors', unit: '%', series: [
        { name: 'failed attempts', color: C.red, area: true, values: R.ticks.map(t => t.err * 100) },
        { name: 'shed fast (429/503)', color: C.orange, values: R.ticks.map(t => t.shed * 100) }], fixedMax: 100 },
    ];
    if (hits.length) specs.push({ title: 'Cache hit rate', unit: '%', series: [{ name: 'hit rate', color: C.teal, values: R.ticks.map(t => (t.hit ?? 0) * 100) }], fixedMax: 100 });
    const lagIds = Object.keys(R.ticks[0].lag || {});
    if (lagIds.length) specs.push({ title: 'Replication lag', unit: 's', series: lagIds.map((id, i) => ({ name: S.byId(model, id)?.name || id, color: [C.sand, C.orange][i % 2], values: R.ticks.map(t => t.lag[id] ?? null) })), threshold: { v: 1, label: '1 s' } });
    const qIds = Object.keys(R.ticks[0].queue || {});
    if (qIds.length) specs.push({ title: 'Stream backlog', unit: 'msgs', series: qIds.map(id => ({ name: S.byId(model, id)?.name || id, color: C.yellow, area: true, values: R.ticks.map(t => t.queue[id]?.backlog ?? 0) })) });
    charts = specs.map(sp => chart({ ...sp, ts, bands, duration: R.scenario.duration }));
    fill(chartsEl, charts.map(c => c.el));

    const tabs = ['all', 'before', 'during', 'after'].filter(k => R.windows[k]);
    fill(findingsEl, h('div.sd-panel-head', h('span', 'Why: findings'), tabs.length > 1 && h('span.sd-tabs', tabs.map(k => h(`button.sd-tab${k === win ? '.active' : ''}`, { type: 'button', onclick: () => { win = k; paintDash(); } }, { all: 'whole test', before: 'before', during: 'during', after: 'after' }[k])))),
      h('ul.sd-find', S.explain(model, R, win).map(f => h(`li.${f.tone}`, f.text))));

    // capacity sheet: every component's worst moment
    const rows = model.blocks.filter(b => R.windows.all.maxUtil[b.id] != null).map(b => {
      const peakT = R.ticks.reduce((a, c) => ((c.util[b.id] ?? 0) > (a.util[b.id] ?? 0) ? c : a), R.ticks[0]);
      const u = R.windows[win]?.maxUtil[b.id] ?? R.windows.all.maxUtil[b.id];
      return h('tr', h('td', b.name), h('td.small.muted', capacityText(b)), h(`td.sd-num.${tone(u)}`, u > 9.99 ? '>999%' : pct(u)), h('td.small.muted', S.fmtTime(peakT.t)));
    });
    fill(sheetEl, h('div.sd-panel-head', h('span', 'Capacity sheet')), h('table.sd-table', h('tr', h('th', 'Component'), h('th', 'Capacity'), h('th', 'Peak'), h('th', 'at')), rows),
      h('p.muted.small', 'Utilisation = work arriving ÷ work it can do. Past about 70-80%, waiting time climbs steeply (M/M/c); past 100%, the queue grows until requests time out.'));
    fill(billEl, h('div.sd-panel-head', h('span', 'Monthly bill'), h('span.muted.small', 'illustrative list prices')),
      h('table.sd-table', R.cost.lines.map(l => h('tr', h('td', l.name), h('td.small.muted', l.what), h('td.sd-num', S.fmtUsd(l.usd)))),
        h('tr.sd-total', h('td', 'Total'), h('td', challenge.xp ? `par ${S.fmtUsd(challenge.par)} · budget ${S.fmtUsd(S.budgetOf(challenge))}` : ''), h('td.sd-num', S.fmtUsd(R.cost.total)))),
      h('p.muted.small', 'Average load is taken as half the peak. Storage is priced at its size after one year.'));
    const e = R.est;
    const kv = (k, v) => h('tr', h('td', k), h('td.sd-num', v));
    fill(estEl, h('div.sd-panel-head', h('span', 'Back of the envelope')), e && h('table.sd-table',
      kv('peak / average', `${S.fmtQps(e.peak)}/s · ${S.fmtQps(e.avg)}/s`), kv('reads / writes at peak', `${S.fmtQps(e.reads)}/s · ${S.fmtQps(e.writes)}/s`),
      kv('bandwidth out / in', `${fmtBits(e.outMbps)} · ${fmtBits(e.inMbps)}`), kv('cores of CPU at 100% / 60%', `${Math.ceil(e.coresAt100)} · ${Math.ceil(e.coresAt60)}`),
      kv('rows per day', S.fmtQps(e.rowsPerDay)), kv('data per year', `${e.gbPerYear >= 1000 ? (e.gbPerYear / 1000).toFixed(1) + ' TB' : Math.round(e.gbPerYear) + ' GB'}${e.blobTbPerYear ? ` + ${e.blobTbPerYear.toFixed(0)} TB of files` : ''}`),
      kv('working set', `${e.workingSetGB.toFixed(1)} GB`), kv('reads taken by the top 1% of keys', pct(e.top1pct))),
      h('p.muted.small', 'cores = QPS × CPU seconds per request. Average QPS = daily requests ÷ 86,400.'));
    if (shownTick != null) for (const c of charts) c.cursor(shownTick);
  }

  const fmtBits = mbps => (mbps >= 1000 ? `${(mbps / 1000).toFixed(1)} Gbps` : `${Math.round(mbps)} Mbps`);
  function capacityText(b) {
    if (b.kind === 'app') return `${b.instances} × ${S.SIZES.app[b.size].vcpu} vCPU = ${S.fmtQps((b.instances * S.SIZES.app[b.size].vcpu * 1000) / b.cpuMs)} req/s`;
    if (b.kind === 'db') return `${b.shards} × ${S.SIZES.db[b.size].vcpu} vCPU`;
    if (b.kind === 'cache') return `${S.fmtQps(S.SIZES.cache[b.size].ops)} ops/s per node`;
    if (b.kind === 'replica') return `${b.count} × ${S.SIZES.db[b.size].vcpu} vCPU per shard`;
    if (b.kind === 'queue') return `${S.fmtQps(b.partitions * 1000)} msg/s`;
    if (b.kind === 'worker') return `${b.instances} × ${S.SIZES.app[b.size].vcpu} vCPU`;
    return '';
  }

  /** One time-series panel: grid, axis, incident bands, lines/areas, legend, threshold, shared crosshair. */
  function chart(sp) {
    const W = 560, H = 190, L = 46, Rp = 10, T = 12, B = 22;
    const pw = W - L - Rp, ph = H - T - B;
    const all = sp.series.flatMap(s => s.values).filter(v => v != null && isFinite(v));
    let max = sp.fixedMax ?? Math.max(1, ...all, sp.threshold?.v ? sp.threshold.v * 1.1 : 0);
    if (sp.clampMax) max = Math.min(max, sp.clampMax);
    let min = 0;
    if (sp.log) { min = 1; max = 10 ** Math.ceil(Math.log10(Math.max(10, ...all, sp.threshold?.v || 0))); }
    else max = niceMax(max);
    const x = t => L + (t / sp.duration) * pw;
    const y = v => {
      const vv = Math.min(v, max);
      if (sp.log) return T + ph - ((Math.log10(Math.max(min, vv)) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) * ph;
      return T + ph - (vv / max) * ph;
    };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sd-chart-svg', preserveAspectRatio: 'none' });
    for (const b of sp.bands) {
      svg.append(sv('rect', { x: x(b.from), y: T, width: Math.max(2, x(b.to) - x(b.from)), height: ph, class: 'sd-band' }));
      svg.append(sv('line', { x1: x(b.from), x2: x(b.from), y1: T, y2: T + ph, class: 'sd-band-edge' }));
    }
    const ticksY = sp.log ? Array.from({ length: Math.round(Math.log10(max)) + 1 }, (_, i) => 10 ** i) : [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
    for (const v of ticksY) {
      svg.append(sv('line', { x1: L, x2: W - Rp, y1: y(v), y2: y(v), class: 'sd-grid' }));
      svg.append(sv('text', { x: L - 6, y: y(v) + 3.5, class: 'sd-axis', 'text-anchor': 'end' }, fmtAxis(v, sp.unit)));
    }
    for (let m = 0; m <= sp.duration / 60; m += 2) svg.append(sv('text', { x: x(m * 60), y: H - 6, class: 'sd-axis', 'text-anchor': 'middle' }, `${m}:00`));
    if (sp.warnAt) svg.append(sv('line', { x1: L, x2: W - Rp, y1: y(sp.warnAt), y2: y(sp.warnAt), class: 'sd-thresh warn' }));
    if (sp.threshold) {
      svg.append(sv('line', { x1: L, x2: W - Rp, y1: y(sp.threshold.v), y2: y(sp.threshold.v), class: 'sd-thresh' }));
      svg.append(sv('text', { x: W - Rp - 4, y: y(sp.threshold.v) - 4, class: 'sd-axis sd-thresh-l', 'text-anchor': 'end' }, sp.threshold.label));
    }
    for (const s of sp.series) {
      let d = '', started = false;
      s.values.forEach((v, i) => {
        if (v == null || !isFinite(v)) { started = false; return; }
        d += `${started ? 'L' : 'M'}${x(sp.ts[i] + 5).toFixed(1)},${y(v).toFixed(1)} `;
        started = true;
      });
      if (!d) continue;
      if (s.area) {
        const pts = s.values.map((v, i) => `${x(sp.ts[i] + 5).toFixed(1)},${y(v ?? 0).toFixed(1)}`);
        svg.append(sv('path', { d: `M${x(sp.ts[0] + 5)},${y(sp.log ? min : 0)} L${pts.join(' L')} L${x(sp.ts[sp.ts.length - 1] + 5)},${y(sp.log ? min : 0)} Z`, fill: s.color, class: 'sd-area' }));
      }
      svg.append(sv('path', { d, stroke: s.color, class: `sd-line${s.dash ? ' dash' : ''}` }));
    }
    const cur = sv('line', { x1: 0, x2: 0, y1: T, y2: T + ph, class: 'sd-cursor', visibility: 'hidden' });
    svg.append(cur);
    const tip = h('div.sd-tip', { hidden: true });
    const legend = h('div.sd-legend', sp.series.map(s => h('span.sd-leg', h('i', { style: { background: s.color } }), s.name)));
    const el = h('div.sd-panel.sd-chart', h('div.sd-panel-head', h('span', sp.title), sp.bands[0] && h('span.sd-band-key', sp.bands[0].label)), h('div.sd-chart-box', svg, tip), legend);
    const cursor = i => {
      if (i == null) { cur.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
      const xx = x(sp.ts[i] + 5);
      cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); cur.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.style.left = `${(xx / W) * 100}%`;
      tip.replaceChildren(h('b', S.fmtTime(sp.ts[i])), ...sp.series.map(s => h('div', h('i', { style: { background: s.color } }), `${s.name}: ${fmtVal(s.values[i], sp.unit)}`)));
    };
    svg.addEventListener('mousemove', e => {
      const r = svg.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width * W - L) / pw * sp.duration;
      const i = Math.max(0, Math.min(sp.ts.length - 1, Math.floor(t / (sp.ts[1] - sp.ts[0] || 10))));
      if (playing && running) return;
      showTick(i);
    });
    svg.addEventListener('mouseleave', () => { if (!running) showTick(null); });
    return { el, cursor };
  }
  const niceMax = v => { const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
  const fmtAxis = (v, unit) => (unit === 'ms' ? S.fmtMs(v).replace(' ', '') : unit === '%' ? `${Math.round(v)}%` : unit === 's' ? `${+v.toFixed(1)}s` : S.fmtQps(v));
  const fmtVal = (v, unit) => (v == null ? '—' : unit === 'ms' ? S.fmtMs(v) : unit === '%' ? `${v.toFixed(1)}%` : unit === 's' ? `${v.toFixed(2)} s` : S.fmtQps(v));

  // ------------------------------------------------------------ the crosshair drives the board too

  let running = false;
  /** Updates lights, meters and cables in place (a full render would stop the requests travelling the cables). */
  function refreshLive() {
    for (const b of model.blocks) {
      const el = board.el.querySelector(`.bk-block[data-id="${CSS.escape(b.id)}"]`);
      if (!el) continue;
      el.classList.remove('bad', 'hot', 'dead');
      for (const c of blockTone(b).split(' ').filter(Boolean)) el.classList.add(c);
      el.querySelector('.bk-body')?.replaceChildren(...[blockBody(b)].flat(Infinity).filter(k => k != null && k !== false));
    }
    for (const w of model.wires) board.setWireState(w.id, wireTone(w.to));
  }
  function showTick(i) {
    shownTick = i;
    for (const c of charts) c.cursor(i);
    refreshLive();
    clockEl.textContent = i == null ? 'showing the worst moment of each component' : `showing ${S.fmtTime(judged.run.ticks[i].t)}`;
  }

  /** Replays the 10 minutes on the board: lights, meters and cables follow the clock, requests travel the cables. */
  async function play() {
    if (!judged?.run?.ticks) return;
    const my = ++playing;
    running = true;
    playBtn.disabled = true;
    const R = judged.run;
    for (let i = 0; i < R.ticks.length; i++) {
      if (my !== playing) break;
      showTick(i);
      const t = R.ticks[i];
      for (let k = 0; k < 2; k++) {
        const read = Math.random() < (model.blocks.find(b => b.kind === 'client')?.readPct ?? 90) / 100;
        const hops = pathFor(read);
        if (hops.length) board.animate(hops.map(([a, z]) => ({ from: a, to: z })), { ms: 140, cls: Math.random() < t.err ? 'bad' : 'ok', label: '', linger: 0 });
      }
      await new Promise(r => setTimeout(r, 160));
    }
    running = false;
    playBtn.disabled = false;
    if (my === playing) showTick(null);
  }
  function pathFor(read) {
    const hops = [];
    const client = model.blocks.find(b => b.kind === 'client');
    let cur = client, guard = 0;
    while (cur && guard++ < 12) {
      const next = S.outs(model, cur);
      let n = null;
      if (cur.kind === 'client' || cur.kind === 'cdn' || cur.kind === 'dns') n = next.find(x => (x.region || 1) === 1 && x.kind === 'lb') || next[0];
      else if (cur.kind === 'lb') n = next[0];
      else if (cur.kind === 'app') n = read ? (next.find(x => x.kind === 'cache') ? null : next.find(x => x.kind === 'replica') || next.find(x => x.kind === 'db')) : next.find(x => x.kind === 'queue') || next.find(x => x.kind === 'db');
      else if (cur.kind === 'queue') n = next[0];
      else if (cur.kind === 'worker') n = next.find(x => x.kind === 'db');
      if (cur.kind === 'app' && read && next.find(x => x.kind === 'cache')) { hops.push([cur.id, next.find(x => x.kind === 'cache').id]); break; }
      if (!n) break;
      hops.push([cur.id, n.id]);
      if (n.kind === 'db' || n.kind === 'replica' || n.kind === 'objstore') break;
      cur = n;
    }
    return hops;
  }

  // ------------------------------------------------------------ goals, stars, XP

  const goalsEl = h('div.nb-goals');
  const clockEl = h('span.muted.small', 'showing the worst moment of each component');
  const playBtn = h('button.btn.primary', { type: 'button', onclick: () => play(), title: 'Replay the 10-minute load test on the board' }, '▶ Run load test');
  function evaluate() {
    const j = challenge.xp ? S.judge(model, challenge) : (() => { const run = S.simulate(model, scenario(), 7); return { run, goals: [], ok: false, cost: run.cost?.total || 0, stars: 0 }; })();
    judged = j;
    paintDash();
    if (!challenge.xp) { fill(goalsEl, h('span.muted.small', 'Sandbox: no goals. Pick a challenge above to earn XP. Every change re-runs the load test.')); return; }
    const best = saved.stars[challenge.id] || 0;
    fill(goalsEl, h('div.nb-goal-head',
      h('b', j.ok ? '✓ All goals met' : 'Goals'),
      h('span.muted.small', `Par ${S.fmtUsd(challenge.par)} a month (the reference design). You: ${S.fmtUsd(j.cost)}.`),
      h('span.nb-stars', starText(Math.max(best, j.stars)))),
    h('ul.sd-goals', j.goals.map(g => h(`li.${g.ok ? 'ok' : 'bad'}`, h('span.sd-goal-mark', g.ok ? '✓' : '✗'), h('span', g.label), g.value && h('span.sd-goal-v', g.value), !g.ok && g.why && h('span.sd-goal-why', g.why)))),
    h('p.muted.small', '3 stars within 5% of par, 2 within 25%. Judged on the challenge\'s fixed incidents and random seed, so it is fair and repeatable.'));
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
    chipsEl.replaceChildren(...S.CHALLENGES.map(c => h(`button.pk-ch${c.id === challenge.id ? '.active' : ''}${saved.solved[c.id] ? '.solved' : ''}`, { type: 'button', onclick: () => pick(c) },
      c.title, c.xp ? h('span.nb-chip-stars', saved.stars[c.id] ? ' ' + starText(saved.stars[c.id]) : ` +${c.xp}`) : '')));
    counter.textContent = `${S.CHALLENGES.filter(c => c.xp && saved.solved[c.id]).length} / ${S.CHALLENGES.filter(c => c.xp).length} solved`;
  }
  const briefEl = h('div.pk-brief');
  function paintBrief() {
    fill(briefEl, h('div', { html: md(challenge.brief) }),
      h('button.btn.ghost.small', { type: 'button', onclick: () => { model = challenge.setup(); board.select(null); changed(); requestAnimationFrame(() => board.fit()); } }, 'Reset'));
  }
  function pick(c) {
    challenge = c;
    model = c.setup();
    win = 'all';
    paintChips(); paintBrief();
    board.select(null);
    changed();
    requestAnimationFrame(() => board.fit());
  }

  container.replaceChildren(h('div.sd-lab',
    h('div.pk-top', chipsEl, counter),
    briefEl,
    goalsEl,
    h('div.ab-sendbar.sd-runbar', playBtn, clockEl),
    h('div.nb-main',
      h('div.nb-left', board.el),
      h('div.nb-right', board.inspectorEl, chaosEl)),
    dashEl));
  paintChips(); paintBrief(); paintSide();
  evaluate();
  board.render();
  requestAnimationFrame(() => board.fit());
  return () => { playing++; running = false; clearTimeout(timer); board.stop(); };
}
