// Compose builder: put services, networks, named volumes and bind mounts on the board, wire depends_on
// (with conditions), networks and mounts, publish ports from your laptop, and run `docker compose up`:
// start order, healthcheck waits, port collisions, who can reach whom by name, crashes and restarts, and
// which data survives a down. compose.yaml is generated live and can be edited back.
// The simulation lives in composesim.js (DOM-free, tested in Node); the page shell in buildlab.js.
import { h } from './util.js';
import { builderLab, controls, fill } from './buildlab.js';
import * as C from './composesim.js';

const COLORS = { host: '#5f5590', service: '#2a6aa8', network: '#4f7a3a', volume: '#6b5b4b', bind: '#8a6a2f' };
const KINDS = Object.fromEntries(Object.entries(C.KINDS).map(([k, v]) => [k, { ...v, color: COLORS[k], width: k === 'service' ? 230 : 190 }]));
const COND_SHORT = { service_started: 'started', service_healthy: 'healthy', service_completed_successfully: 'completed' };
const COND_HELP = {
  service_started: 'Waits only until the container has started. The program inside may not accept connections yet.',
  service_healthy: 'Waits until the dependency\'s healthcheck passes. Needs a healthcheck on that service.',
  service_completed_successfully: 'Waits until the dependency has run to the end and exited with code 0. For one-off jobs like migrations.',
};

export function composeBuildLab(container, onXp) {
  return builderLab(container, onXp, {
    lab: 'composebuild',
    sim: C,
    costLabel: 'blocks + wires',
    board: api => boardOptions(api),
    form: api => formView(api),
    actions: () => [
      { id: 'up', label: '▶ docker compose up', title: 'Start everything from nothing and open every published port' },
      { id: 'recreate', label: '↻ down, then up', title: 'Remove the containers, start again, and see which data survived' },
      { id: 'downv', label: '🗑 down -v, then up', title: 'Also delete the named volumes, then start again' },
    ],
    run: (m, id, ch) => runIt(m, id, ch),
    yaml: { title: 'compose.yaml', text: C.toYaml, apply: C.fromYaml, note: 'The file docker compose up would read. It follows the board; Edit lets you change it by hand.' },
  });
}

const fmt = t => `${(Math.round(t * 10) / 10).toFixed(1)}s`;

function boardOptions(api) {
  const m = () => api.model;
  const blk = id => C.byId(m(), id);
  const { field, text, num, check, select, lines } = controls(api.changed, api.say);
  const portWires = () => C.services(m()).filter(s => s.ports.length && m().blocks.some(b => b.kind === 'host'))
    .map(s => ({ id: 'P-' + s.id, kind: 'port', from: { block: m().blocks.find(b => b.kind === 'host').id, port: 'out' }, to: { block: s.id }, svc: s }));
  const kindOf = w => blk(w.to)?.kind;
  const nameOk = (kind, self) => v => {
    if (!v) return 'A name is needed.';
    if (kind === 'service' && !C.validName(v)) return 'Service names use lower-case letters, digits, - _ and . only (they become DNS names).';
    if (kind === 'bind' && !/^[./~]/.test(v)) return 'A bind mount is a laptop path: start it with ./ (relative to compose.yaml) or /.';
    if ((kind === 'network' || kind === 'volume') && !/^[a-z0-9][a-z0-9_.-]*$/.test(v)) return 'Use lower-case letters, digits, - _ and . only.';
    if (m().blocks.some(b => b !== self && b.kind === kind && b.name === v)) return `There is already a ${KINDS[kind].label.toLowerCase()} called ${v}.`;
    return true;
  };

  function add(kind, at) {
    const base = { service: 'app', network: 'net', volume: 'data', bind: './folder' }[kind];
    let i = 1, name = base;
    while (m().blocks.some(b => b.kind === kind && b.name === name)) name = `${base}${++i}`;
    let id = kind + '-' + name.replace(/[^\w]/g, '');
    while (blk(id)) id += 'x';
    const b = C.block(kind, id, name, at.x, at.y);
    m().blocks.push(b);
    api.changed();
    return b;
  }

  function body(b) {
    const line = t => h('div.ab-line', t);
    if (b.kind === 'host') {
      const pubs = C.services(m()).flatMap(s => s.ports.map(p => `localhost:${C.parsePort(p).host ?? '?'} → ${s.name}`));
      return [h('div.bk-name', b.name), pubs.length ? pubs.slice(0, 4).map(line) : line('no ports published'), h('div.nb-sub', 'Drag ▶ onto a service to publish a port')];
    }
    if (b.kind === 'service') {
      const img = C.IMAGES[b.image];
      const tags = [b.health && h('span.bk-tag', 'healthcheck'), b.restart !== 'no' && h('span.bk-tag', `restart: ${b.restart}`), b.env.length > 0 && h('span.bk-tag', `${b.env.length} env`)].filter(Boolean);
      return [h('div.bk-name', b.name), h('code.ab-op', b.image),
        line(img ? (img.oneshot ? 'one-off job' : `listens on ${img.listens}`) : 'unknown image'),
        b.ports.length > 0 && line(`ports ${b.ports.join(', ')}`),
        line(`net: ${C.netsOf(m(), b).join(', ')}`),
        tags.length > 0 && h('div.bk-tags', tags)];
    }
    if (b.kind === 'network') return [h('div.bk-name', b.name), h('div.nb-sub', 'Services on it find each other by name')];
    if (b.kind === 'volume') return [h('div.bk-name', b.name), h('div.nb-sub', 'Docker keeps it until you delete it (down -v)')];
    return [h('div.bk-name', b.name), h('div.nb-sub', 'A folder on your laptop, shown inside the container')];
  }

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click a block or a wire to configure it.');
    if (sel.type === 'wire') {
      if (sel.id.startsWith('P-')) {
        const s = blk(sel.id.slice(2));
        if (!s) return null;
        return h('div.pk-inspect', h('div.pk-inspect-head', h('b', `Published ports of ${s.name}`)),
          field('Ports (one per line, HOST:CONTAINER)', lines(s, 'ports', '8080:80'), `The left number is on your laptop, the right one inside ${s.name}. ${C.IMAGES[s.image] ? `${s.image} listens on ${C.IMAGES[s.image].listens}.` : ''}`),
          h('p.muted.small', 'Other containers never need a published port: they talk on the internal network. Publish only what you open from your laptop.'));
      }
      const w = m().wires.find(x => x.id === sel.id);
      if (!w) return null;
      const f = blk(w.from), t = blk(w.to);
      const remove = h('button.btn.ghost.small', { type: 'button', onclick: () => { m().wires = m().wires.filter(x => x !== w); api.changed(); } }, 'Remove');
      if (t.kind === 'service') {
        return h('div.pk-inspect', h('div.pk-inspect-head', h('b', `${f.name} depends_on ${t.name}`), remove),
          field('Condition', select(w, 'condition', C.CONDITIONS.map(c => [c, c]))),
          h('p.muted.small', COND_HELP[w.condition || 'service_started']),
          h('p.muted.small', `Compose starts ${t.name} before ${f.name}. depends_on only affects the start; it does not make ${t.name} reachable (that is the network's job).`));
      }
      if (t.kind === 'network') return h('div.pk-inspect', h('div.pk-inspect-head', h('b', `${f.name} joins ${t.name}`), remove), h('p.muted.small', `${f.name} can reach every other service on ${t.name} by its service name. A service that lists no network is on "default".`));
      const img = C.IMAGES[f.image];
      return h('div.pk-inspect', h('div.pk-inspect-head', h('b', `${f.name} mounts ${t.name}`), remove),
        field('Path inside the container', text(w, 'target', '/data', v => (v.startsWith('/') ? true : 'The path inside the container must start with /.'))),
        h('p.muted.small', img?.data ? `${f.image} keeps its data in ${img.data}.` : img?.role === 'nginx' ? `nginx serves files from ${C.NGINX_ROOT}.` : 'Whatever the program writes under this path is stored outside the container.'),
        h('p.muted.small', t.kind === 'volume' ? 'A named volume is storage Docker manages. It outlives containers; down -v deletes it.' : 'A bind mount shows a laptop folder inside the container. Edits on either side appear on the other at once.'));
    }
    const b = blk(sel.id);
    if (!b) return null;
    const k = KINDS[b.kind];
    const head = h('div.pk-inspect-head', h('b', `${k.icon} ${k.label}`),
      h('button.btn.ghost.small', { type: 'button', disabled: !!b.fixed, onclick: () => { m().blocks = m().blocks.filter(x => x !== b); m().wires = m().wires.filter(w => w.from !== b.id && w.to !== b.id); api.changed(); } }, 'Delete'));
    if (b.kind === 'host') {
      return h('div.pk-inspect', head, h('p', 'Your laptop. It reaches a container only through a published port: localhost:HOST goes to CONTAINER inside that service.'),
        h('p.muted.small', 'Drag the ▶ onto a service to publish its port. Click a port wire to edit or remove it.'));
    }
    const parts = [head, field('Name', text(b, 'name', '', nameOk(b.kind, b)))];
    if (b.kind === 'service') {
      const img = C.IMAGES[b.image];
      parts.push(
        field('Image', select(b, 'image', C.IMAGE_NAMES.map(n => [n, n])), img?.what),
        field('Ports (HOST:CONTAINER, one per line)', lines(b, 'ports', '8080:80', 2), img && !img.oneshot ? `Inside, ${b.image} listens on ${img.listens}.` : ''),
        field('Environment (KEY=value, one per line)', lines(b, 'env', img?.role === 'postgres' ? 'POSTGRES_PASSWORD=secret' : 'DB_HOST=db', 3)),
        check(b, 'health', 'Healthcheck'),
        b.health && h('div.pk-two', field('Test command', text(b, 'healthTest', img?.health || '')), field('Interval (s)', num(b, 'interval', { min: 1, max: 60 }))),
        b.health && h('p.muted.small', `Runs inside the container. Empty means "${img?.health || '…'}". Tools in this image: ${img?.tools.join(', ') || 'none'}.`),
        field('Restart policy', select(b, 'restart', C.RESTARTS.map(r => [r, r])), 'What Docker does when the container exits.'),
        h('p.muted.small', 'Drag ▶ onto another service (depends_on), a network (join it) or a volume or bind mount (mount it).'));
    }
    if (b.kind === 'network') parts.push(h('p.muted.small', 'A user-defined network. Compose gives it DNS: every service on it is reachable by its service name. Services on different networks cannot see each other.'));
    if (b.kind === 'volume') parts.push(h('p.muted.small', 'A named volume. Docker stores it outside any container, so it survives docker compose down. down -v deletes it.'));
    if (b.kind === 'bind') parts.push(h('p.muted.small', 'A path on your laptop, relative to compose.yaml. Mounting it shows that folder inside the container.'));
    return h('div.pk-inspect', parts);
  }

  return {
    kinds: KINDS,
    wireKinds: { dep: { label: '' }, net: { label: '', color: '#6f9a5a' }, mount: { label: '', color: '#a08a6a' }, port: { label: '', color: '#8f84c9' } },
    wires: () => [...m().wires.map(w => ({ id: w.id, kind: kindOf(w) === 'service' ? 'dep' : kindOf(w) === 'network' ? 'net' : 'mount', from: { block: w.from, port: 'out' }, to: { block: w.to }, w })), ...portWires()],
    ports: b => (C.TARGETS[b.kind].length ? [{ id: 'out', label: '', on: b.kind === 'host' ? C.services(m()).some(s => s.ports.length) : m().wires.some(w => w.from === b.id),
      title: b.kind === 'host' ? 'Drag onto a service to publish one of its ports' : 'Drag onto a service (depends_on), a network, a volume or a bind mount' }] : []),
    body,
    canConnect: (from, port, to) => C.canWire(m(), from, to),
    connect: (from, port, to) => {
      if (!C.connect(m(), from.id, to.id)) return `A ${KINDS[from.kind].label} cannot be wired to a ${KINDS[to.kind].label}.`;
      api.changed();
      if (from.kind === 'host') api.say(`Published ${to.ports[to.ports.length - 1]} on ${to.name}. Click the wire to change it.`);
      return false;
    },
    onDropEmpty: () => { api.say('To remove a wire, click it and press Delete.'); return false; },
    palette: [
      { kind: 'service', title: 'Add a service: one container from an image', add: at => add('service', at) },
      { kind: 'network', title: 'Add a network: services on it reach each other by name', add: at => add('network', at) },
      { kind: 'volume', title: 'Add a named volume: storage that outlives containers', add: at => add('volume', at) },
      { kind: 'bind', title: 'Add a bind mount: a folder from your laptop', add: at => add('bind', at) },
    ],
    howto: 'Drag a block to move it. Drag ▶ onto another block to wire it. Click a block or wire to configure it; Delete removes it. Wheel zooms.',
    inspector,
    onDelete: sel => {
      if (sel.type === 'wire') {
        if (sel.id.startsWith('P-')) { const s = blk(sel.id.slice(2)); if (s) s.ports = []; }
        else m().wires = m().wires.filter(w => w.id !== sel.id);
      } else {
        const b = blk(sel.id);
        if (!b) return;
        if (b.fixed) { api.say(`${b.name} stays: it is where you open the ports from.`); return; }
        m().blocks = m().blocks.filter(x => x !== b);
        m().wires = m().wires.filter(w => w.from !== b.id && w.to !== b.id);
      }
      api.changed();
    },
    wireLabel: w => (w.kind === 'port' ? w.svc.ports.map(p => { const pp = C.parsePort(p); return pp.error ? p : `:${pp.host ?? '?'}→${pp.container}`; }).join(' ')
      : w.kind === 'dep' ? COND_SHORT[w.w.condition || 'service_started'] : w.kind === 'mount' ? w.w.target : ''),
    blockClass: b => (b.fixed ? 'fixed' : ''),
  };
}

function formView(api) {
  const m = api.model;
  const { lines, select, text } = controls(api.changed, api.say);
  let a = '', z = '';
  const others = m.blocks.filter(b => b.kind !== 'host');
  return h('div.nb-form',
    h('table.nb-ftable',
      h('tr', h('th', 'Service'), h('th', 'Image'), h('th', 'Ports'), h('th', 'Environment'), h('th', 'Wired to')),
      C.services(m).map(s => h('tr', { onclick: e => { if (!e.target.closest('input,button,select,textarea')) api.select({ type: 'block', id: s.id }); } },
        h('td', h('b', s.name)),
        h('td', select(s, 'image', C.IMAGE_NAMES.map(n => [n, n]))),
        h('td', lines(s, 'ports', '8080:80', 2)),
        h('td', lines(s, 'env', 'KEY=value', 2)),
        h('td.small', m.wires.filter(w => w.from === s.id).map(w => {
          const t = C.byId(m, w.to);
          return h('div', `${t.kind === 'service' ? 'depends on' : t.kind === 'network' ? 'network' : 'mounts'} ${t.name}${w.condition ? ` (${COND_SHORT[w.condition]})` : ''}${w.target ? ` at ${w.target}` : ''} `,
            h('button.btn.ghost.small', { type: 'button', onclick: () => { m.wires = m.wires.filter(x => x !== w); api.changed(); } }, '✕'));
        }), m.wires.some(w => w.from === s.id) ? '' : h('span.muted', 'nothing'))))),
    h('div.eyebrow', 'Networks, volumes and bind mounts'),
    h('ul.nb-cables', m.blocks.filter(b => ['network', 'volume', 'bind'].includes(b.kind)).map(b => h('li', `${KINDS[b.kind].label}: `, text(b, 'name')))),
    h('div.eyebrow', 'Add a wire'),
    h('div.nb-cable-add',
      h('select', { onchange: e => { a = e.target.value; } }, h('option', { value: '' }, 'service…'), C.services(m).map(s => h('option', { value: s.id }, s.name))),
      h('span', '→'),
      h('select', { onchange: e => { z = e.target.value; } }, h('option', { value: '' }, 'depends on / joins / mounts…'), others.map(b => h('option', { value: b.id }, `${KINDS[b.kind].label}: ${b.name}`))),
      h('button.btn.primary.small', { type: 'button', onclick: () => { if (!C.connect(m, a, z)) api.say('Pick a service and something else to wire it to.'); else api.changed(); } }, 'Wire')),
    h('p.muted.small', 'Click a row to edit healthchecks, restart policies and wire details in the inspector.'));
}

function stateOf(x) {
  if (!x) return ['not simulated', 'bad'];
  if (x.blocked) return ['not started', 'bad'];
  if (x.exitCode === 0) return ['exited (0) · done', 'ok'];
  if (x.dead) return ['exited (1)', 'bad'];
  if (x.healthy != null) return [x.crashes ? `healthy · ${x.crashes} crash${x.crashes > 1 ? 'es' : ''} first` : 'running · healthy', x.crashes ? 'warn' : 'ok'];
  if (x.healthWhy) return ['running · unhealthy', 'bad'];
  return [x.crashes ? `running · ${x.crashes} crash${x.crashes > 1 ? 'es' : ''} first` : 'running', x.crashes ? 'warn' : 'ok'];
}

function runIt(m, id, ch) {
  const R = C.up(m, { hostBusy: ch.hostBusy });
  if (R.error) return { ok: false, verdict: R.error, steps: [] };
  const steps = R.steps.map(s => ({ at: fmt(s.at), who: s.who, tone: s.tone, text: s.text }));
  steps.unshift({ who: 'compose', tone: 'info', text: `Start order (each service after what it depends on, A to Z otherwise): ${R.order.map(s => s.name).join(', ')}.` });
  const marks = {}, wires = {};
  for (const s of C.services(m)) { const [, tone] = stateOf(R.st.get(s.id)); marks[s.id] = tone === 'bad' ? 'bad' : 'ok'; }
  for (const w of m.wires) {
    const t = C.byId(m, w.to);
    if (t?.kind !== 'service') continue;
    const ts = R.st.get(t.id), c = w.condition || 'service_started';
    const met = c === 'service_started' ? ts?.start != null : c === 'service_healthy' ? ts?.healthy != null : ts?.exitCode === 0;
    wires[w.id] = met ? 'ok' : 'bad';
  }
  const tokens = [];
  const host = m.blocks.find(b => b.kind === 'host');
  for (const r of R.requests) {
    steps.push({ who: 'laptop', tone: r.ok ? 'ok' : 'bad', text: [h('code', `open ${r.url}`), ` → ${r.why}`] });
    wires['P-' + r.svc] = wires['P-' + r.svc] === 'bad' ? 'bad' : r.ok ? 'ok' : 'bad';
    if (host) {
      const chain = [host.id, ...r.chain];
      tokens.push({ hops: chain.slice(1).map((to, i) => ({ from: chain[i], to })), label: r.port ? `:${r.port}` : '', endCls: r.ok ? 'ok' : 'bad' });
    }
  }
  let dataOk = true;
  if (id !== 'up') {
    steps.push({ who: 'compose', tone: 'info', text: id === 'downv'
      ? 'docker compose down -v: containers and networks removed, and the named volumes deleted too. Bind-mounted folders stay on your laptop.'
      : 'docker compose down: containers and networks removed. Named volumes and bind-mounted folders stay.' });
    const fate = C.dataFate(m, R, id === 'downv');
    if (!fate.length) steps.push({ who: 'compose', tone: 'info', text: 'No service here stores data (no database or cache), so there is nothing to lose.' });
    for (const f of fate) { steps.push({ who: f.svc.name, tone: f.ok ? 'ok' : 'bad', text: `${f.ok ? 'data still there' : 'data lost'}: ${f.why}` }); if (!f.ok) dataOk = false; marks[f.svc.id] = f.ok ? 'ok' : 'bad'; }
    steps.push({ who: 'compose', tone: 'info', text: 'docker compose up: the same start sequence as before, with fresh containers.' });
  }
  const list = C.services(m);
  const running = list.filter(s => R.st.get(s.id)?.running || R.st.get(s.id)?.exitCode === 0).length;
  const reqBad = R.requests.filter(r => !r.ok).length;
  const ok = running === list.length && !reqBad && dataOk;
  const verdict = `${running} of ${list.length} service${list.length === 1 ? '' : 's'} up${R.requests.length ? `; ${R.requests.length - reqBad} of ${R.requests.length} published port${R.requests.length === 1 ? '' : 's'} answer${R.requests.length - reqBad === 1 ? 's' : ''}`: '; nothing published on your laptop'}${id !== 'up' ? (dataOk ? '; data survived' : '; data was lost') : ''}.`;
  return { ok, verdict, steps, tokens, marks, wires, panel: panel(m, R) };
}

function panel(m, R) {
  const list = C.services(m);
  const el = h('div.yb-card');
  fill(el,
    h('div.eyebrow', 'Containers'),
    h('table.nb-rt', h('tr', h('th', 'Service'), h('th', 'State'), h('th', 'Networks')),
      list.map(s => { const [label, tone] = stateOf(R.st.get(s.id)); return h('tr', h('td', h('b', s.name)), h('td', h(`span.ab-code.${tone}`, label)), h('td.muted', C.netsOf(m, s).join(', '))); })),
    list.length > 1 && h('div.eyebrow', 'Who can reach whom by name'),
    list.length > 1 && h('table.nb-rt.yb-matrix', h('tr', h('th', 'from ↓ to →'), list.map(s => h('th', s.name))),
      list.map(a => h('tr', h('th', a.name), list.map(b => {
        if (a === b) return h('td.muted', '·');
        const r = R.reach(a, b);
        return h(`td.${r.ok ? 'yb-yes' : 'yb-no'}`, { title: r.why }, r.ok ? '✓' : '✕');
      })))),
    list.length > 1 && h('p.muted.small', 'A name resolves only when both services share a network. Hover a cell for the reason.'));
  return el;
}
