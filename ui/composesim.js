// The Compose builder's simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
// A model is { blocks, wires }: your laptop, services, networks, named volumes and bind mounts. A wire
// from a service to another service is depends_on (with a condition), to a network joins it, to a volume
// or bind mount mounts it at a path. Published ports live on the service and are drawn from the laptop.
// up() simulates `docker compose up` on a clock: start order, healthcheck waits, port collisions, name
// resolution per network, app connections that crash, restarts; then requests from the laptop, and
// (optionally) a down + up to show which data survives. Every outcome carries a plain-English reason.
import * as Y from './miniyaml.js';

export const KINDS = {
  host: { label: 'Your laptop', icon: '💻' },
  service: { label: 'Service', icon: '🐳' },
  network: { label: 'Network', icon: '🕸' },
  volume: { label: 'Named volume', icon: '🛢' },
  bind: { label: 'Bind mount', icon: '📁' },
};

/**
 * The images you can run. listens: the port the program listens on inside the container. readyS: seconds
 * from container start until it accepts connections. tools: programs inside the image (for healthchecks).
 */
export const IMAGES = {
  'nginx:1.27': { listens: 80, readyS: 1, tools: ['curl'], health: 'curl -f http://localhost/', role: 'nginx', what: 'a web server' },
  'postgres:16': { listens: 5432, readyS: 6, tools: ['pg_isready', 'psql'], health: 'pg_isready -U postgres', role: 'postgres', data: '/var/lib/postgresql/data',
    needsEnv: 'POSTGRES_PASSWORD', what: 'a database' },
  'redis:7': { listens: 6379, readyS: 1, tools: ['redis-cli'], health: 'redis-cli ping', role: 'redis', data: '/data', what: 'a cache' },
  'shop-api:1.0': { listens: 3000, readyS: 2, tools: ['wget'], health: 'wget -qO- http://localhost:3000/health', role: 'api', connects: true, needsSchema: true,
    what: 'the shop API (reads DB_HOST and DB_PORT, connects to Postgres at startup)' },
  'shop-web:1.0': { listens: 80, readyS: 1, tools: ['wget'], health: 'wget -qO- http://localhost/', role: 'web',
    what: 'the shop website (forwards /api calls to API_HOST, port 3000)' },
  'shop-migrate:1.0': { listens: 0, readyS: 0, runS: 4, tools: [], role: 'migrate', connects: true, oneshot: true,
    what: 'a one-off job: creates the tables in DB_HOST, then exits' },
};
export const IMAGE_NAMES = Object.keys(IMAGES);
export const CONDITIONS = ['service_started', 'service_healthy', 'service_completed_successfully'];
export const RESTARTS = ['no', 'on-failure', 'unless-stopped', 'always'];
export const NGINX_ROOT = '/usr/share/nginx/html';

export const DEFAULTS = {
  host: {},
  service: { image: 'nginx:1.27', ports: [], env: [], health: false, healthTest: '', interval: 2, restart: 'no' },
  network: {}, volume: {}, bind: {},
};
/** Which kinds a block's ▶ may be wired to. */
export const TARGETS = { host: ['service'], service: ['service', 'network', 'volume', 'bind'], network: [], volume: [], bind: [] };

const clone = o => JSON.parse(JSON.stringify(o));
export const block = (kind, id, name, x = 0, y = 0, settings = {}) => ({ id, kind, name, x, y, ...clone(DEFAULTS[kind]), ...settings });
export const wire = (from, to, extra = {}) => ({ id: `W-${from}-${to}`, from, to, ...extra });
export const byId = (m, id) => m.blocks.find(b => b.id === id);
export const byName = (m, kind, name) => m.blocks.find(b => b.kind === kind && b.name === name);
export const services = m => m.blocks.filter(b => b.kind === 'service');
export const validName = n => /^[a-z0-9][a-z0-9_.-]*$/.test(n);
const fmt = t => `${(Math.round(t * 10) / 10).toFixed(1)}s`;

export function envOf(s) {
  const out = {};
  for (const line of s.env || []) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** "8080:80", "127.0.0.1:8080:80", "80" -> { host, container, ip } or { error }. */
export function parsePort(p) {
  const s = String(p).trim().replace(/\/tcp$/, '');
  const m = s.match(/^(?:(\d+\.\d+\.\d+\.\d+):)?(?:(\d+):)?(\d+)$/);
  if (!m) return { error: `"${p}" is not a port mapping. Write HOST:CONTAINER, like 8080:80.` };
  const host = m[2] ? Number(m[2]) : null, container = Number(m[3]);
  if ((host != null && (host < 1 || host > 65535)) || container < 1 || container > 65535) return { error: `"${p}": ports go from 1 to 65535.` };
  return { host, container, ip: m[1] || '0.0.0.0' };
}

export function canWire(m, from, to) {
  if (!from || !to || from.id === to.id) return false;
  return (TARGETS[from.kind] || []).includes(to.kind);
}

/** Adds a wire (or a published port, for the laptop). Returns false if not allowed. */
export function connect(m, fromId, toId) {
  const from = byId(m, fromId), to = byId(m, toId);
  if (!canWire(m, from, to)) return false;
  if (from.kind === 'host') {
    const img = IMAGES[to.image];
    const want = img?.listens || 80;
    const used = new Set(services(m).flatMap(s => s.ports.map(p => parsePort(p).host)).filter(Boolean));
    let hostPort = want < 1024 ? 8080 : want;
    while (used.has(hostPort)) hostPort++;
    to.ports.push(`${hostPort}:${want}`);
    return true;
  }
  if (m.wires.some(w => w.from === fromId && w.to === toId)) return true;
  const extra = to.kind === 'service' ? { condition: 'service_started' } : to.kind === 'network' ? {} : { target: '/data' };
  m.wires.push(wire(fromId, toId, extra));
  return true;
}

export const depsOf = (m, s) => m.wires.filter(w => w.from === s.id && byId(m, w.to)?.kind === 'service').map(w => ({ w, d: byId(m, w.to) }));
export const netsOf = (m, s) => {
  const n = m.wires.filter(w => w.from === s.id && byId(m, w.to)?.kind === 'network').map(w => byId(m, w.to).name);
  return n.length ? n : ['default'];
};
export const mountsOf = (m, s) => m.wires.filter(w => w.from === s.id && ['volume', 'bind'].includes(byId(m, w.to)?.kind)).map(w => ({ w, v: byId(m, w.to), target: (w.target || '').trim() }));
export const sharedNets = (m, a, b) => netsOf(m, a).filter(n => netsOf(m, b).includes(n));

/** Kahn's algorithm, alphabetical among the ready ones (same rule as the lesson). -> { order } or { cycle } */
export function startOrder(m) {
  const list = services(m);
  const done = new Set(), order = [];
  while (order.length < list.length) {
    const ready = list.filter(s => !done.has(s.id) && depsOf(m, s).every(({ d }) => done.has(d.id))).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!ready.length) return { cycle: list.filter(s => !done.has(s.id)).map(s => s.name).sort() };
    done.add(ready[0].id); order.push(ready[0]);
  }
  return { order };
}

function healthOk(s, img) {
  const test = (s.healthTest || '').trim() || img.health || '';
  if (!test) return { ok: false, why: 'the healthcheck has no test command' };
  const tool = test.replace(/^(CMD-SHELL|CMD)\s+/, '').split(/\s+/)[0];
  if (!img.tools.includes(tool)) return { ok: false, why: `"${tool}: not found". A healthcheck runs inside the container, and the ${s.image} image does not contain ${tool} (it has: ${img.tools.join(', ') || 'nothing useful'}). Try "${img.health}".` };
  const pm = test.match(/localhost:(\d+)/);
  const port = pm ? Number(pm[1]) : /https?:\/\/localhost\b/.test(test) ? 80 : null;
  if (port != null && port !== img.listens) return { ok: false, why: `the check calls port ${port}, but ${s.image} listens on ${img.listens}: connection refused every time` };
  return { ok: true, test };
}

/**
 * Simulates `docker compose up` (from nothing). opts: { hostBusy: { port: 'what uses it' } }.
 * -> { error } or { order, st: Map(id -> state), steps, requests, reach }
 */
export function up(m, opts = {}) {
  const list = services(m);
  const steps = [];
  const log = (at, s, tone, text) => steps.push({ at, who: s?.name ?? '', id: s?.id, tone, text, seq: steps.length });
  if (!list.length) return { error: 'There are no services yet. Add one from the palette.' };
  const names = new Map();
  for (const s of list) {
    if (!validName(s.name)) return { error: `"${s.name}" is not a valid service name: use lower-case letters, digits, - _ and . only.` };
    if (names.has(s.name)) return { error: `Two services are called "${s.name}". Service names must be unique: they are also the DNS names.` };
    names.set(s.name, s);
  }
  const so = startOrder(m);
  if (so.cycle) return { error: `Dependency cycle detected among ${so.cycle.join(', ')}: each waits for the other, so nothing can start. Remove one depends_on wire.` };
  for (const s of list) for (const p of s.ports) { const pp = parsePort(p); if (pp.error) return { error: `${s.name}: ${pp.error}` }; }
  for (const s of list) for (const { v, target } of mountsOf(m, s)) if (!target.startsWith('/')) return { error: `${s.name}: the mount of ${v.name} needs an absolute path inside the container, like /data.` };

  const busy = opts.hostBusy || {};
  const taken = new Map();   // host port -> service name
  const st = new Map();
  const visiting = new Set();

  const nets = [...new Set(list.flatMap(s => netsOf(m, s)))];
  nets.forEach(n => log(0, null, 'info', `Network ${n} created.${n === 'default' ? ' Services that list no network join this one.' : ''}`));
  m.blocks.filter(b => b.kind === 'volume').forEach(v => log(0, null, 'info', `Volume ${v.name} created (if it did not exist yet).`));

  function get(s) {
    if (st.has(s.id)) return st.get(s.id);
    if (visiting.has(s.id)) return { start: null, why: 'it is waiting on itself' };
    visiting.add(s.id);
    const r = startOne(s);
    visiting.delete(s.id);
    st.set(s.id, r);
    return r;
  }

  function connectCheck(s, at) {
    const env = envOf(s);
    const host = env.DB_HOST;
    const port = Number(env.DB_PORT || 5432);
    if (!host) return { why: 'DB_HOST is not set, so the app does not know where its database is.' };
    if (host === 'localhost' || host === '127.0.0.1') return { why: `connect ECONNREFUSED 127.0.0.1:${port}. Inside a container, localhost is that container itself: not your laptop, not the db container. Use the service name instead.` };
    const t = names.get(host);
    if (!t) return { why: `getaddrinfo ENOTFOUND ${host}: no service is called "${host}". On a Compose network, each service is found by its service name.` };
    if (t === s) return { why: `${host} is this service itself, and it does not listen on ${port}.` };
    if (!sharedNets(m, s, t).length) return { why: `getaddrinfo ENOTFOUND ${host}: ${host} exists, but ${s.name} and ${host} share no network, so the name does not resolve. ${s.name} is on ${netsOf(m, s).join(', ')}; ${host} is on ${netsOf(m, t).join(', ')}.` };
    const ts = get(t);
    if (ts.start == null) return { why: `getaddrinfo ENOTFOUND ${host}: ${host} never started (${ts.why}).` };
    if (at < ts.start) return { why: `getaddrinfo ENOTFOUND ${host}: the ${host} container does not exist yet (it starts at ${fmt(ts.start)}). Nothing told Compose to start ${host} first.` };
    if (ts.dead && at >= ts.exit) return { why: `connect ECONNREFUSED ${host}:${port}: ${host} has exited (${ts.why}).` };
    const timg = IMAGES[t.image];
    if (timg.role !== 'postgres') return { why: `${host} runs ${t.image}, not Postgres: the app cannot talk to it.` };
    if (timg.listens !== port) {
      const pub = t.ports.map(parsePort).find(p => p.host === port);
      return { why: `connect ECONNREFUSED ${host}:${port}: inside the network ${host} listens on ${timg.listens}.${pub ? ` ${port} is the port published on your laptop; containers talk to each other on the container port.` : ''}` };
    }
    if (at < ts.ready) return { why: `connect ECONNREFUSED ${host}:${port}: the ${host} container is running, but Postgres is still initialising and accepts connections only from ${fmt(ts.ready)}. Started is not ready.` };
    const img = IMAGES[s.image];
    if (img.needsSchema) {
      const mig = list.find(x => IMAGES[x.image]?.role === 'migrate' && envOf(x).DB_HOST === host);
      if (mig) {
        const ms = get(mig);
        if (ms.exitCode !== 0 || ms.exit == null) return { why: `error: relation "orders" does not exist. The ${mig.name} job never finished, so the tables were never created.` };
        if (ms.exit > at) return { why: `error: relation "orders" does not exist. ${mig.name} is still creating the tables (done at ${fmt(ms.exit)}); ${s.name} started too early.` };
      }
    }
    return { ok: true, why: `connected to ${host}:${port}` };
  }

  function startOne(s) {
    const img = IMAGES[s.image];
    let t = 0;
    const blocked = why => { log(t, s, 'bad', `not started: ${why}`); return { start: null, why, blocked: true }; };
    for (const { w, d } of depsOf(m, s)) {
      const ds = get(d);
      const cond = w.condition || 'service_started';
      if (cond === 'service_started') {
        if (ds.start == null) return blocked(`dependency ${d.name} failed to start`);
        t = Math.max(t, ds.start);
      } else if (cond === 'service_healthy') {
        if (!d.health) return blocked(`it waits for ${d.name} to be healthy, but ${d.name} has no healthcheck, so it can never report healthy ("dependency failed to start: container ${d.name} has no healthcheck configured")`);
        if (ds.healthy == null) return blocked(`${d.name} never became healthy, so Compose gave up waiting ("dependency failed to start: container ${d.name} is unhealthy")`);
        log(ds.healthy, s, 'info', `${d.name} is healthy: the wait is over.`);
        t = Math.max(t, ds.healthy);
      } else {
        if (ds.exit == null || ds.exitCode !== 0) return blocked(`it waits for ${d.name} to finish successfully, and it did not (${ds.why || 'it never exits'})`);
        log(ds.exit, s, 'info', `${d.name} completed successfully: the wait is over.`);
        t = Math.max(t, ds.exit);
      }
    }
    if (!img) return blocked(`pull access denied for ${s.image}: there is no such image`);
    for (const p of s.ports.map(parsePort)) {
      if (p.host == null) continue;
      if (busy[p.host]) return blocked(`Bind for 0.0.0.0:${p.host} failed: port is already allocated. ${busy[p.host]} already listens on ${p.host}. Publish a different host port, like ${p.host + 1}:${p.container}.`);
      if (taken.has(p.host)) return blocked(`Bind for 0.0.0.0:${p.host} failed: port is already allocated by ${taken.get(p.host)}. A host port can belong to one container only.`);
    }
    s.ports.map(parsePort).forEach(p => p.host != null && taken.set(p.host, s.name));
    const start = t + 0.5;
    const pub = s.ports.map(parsePort).map(p => (p.host ? `localhost:${p.host} → ${p.container}` : `a random laptop port → ${p.container}`));
    log(start, s, 'info', `container started (${s.image})${pub.length ? `, publishing ${pub.join(', ')}` : ''}.`);
    if (img.needsEnv && !envOf(s)[img.needsEnv]) {
      const why = `Postgres refuses to initialise: "superuser password is not specified". Set ${img.needsEnv} in its environment.`;
      log(start + 0.4, s, 'bad', `exited with code 1: ${why}`);
      return { start, exit: start + 0.4, exitCode: 1, dead: true, why };
    }
    let at = start + 0.3, crashes = 0;
    if (img.connects) {
      for (;;) {
        const c = connectCheck(s, at);
        if (c.ok) break;
        crashes++;
        log(at, s, 'bad', `crashed: ${c.why}`);
        if (s.restart === 'no' || crashes > 5) {
          if (s.restart !== 'no') log(at, s, 'bad', 'gave up after 5 restarts.');
          return { start, exit: at, exitCode: 1, dead: true, crashes, why: c.why };
        }
        const wait = 2 ** (crashes - 1);
        at += wait;
        log(at, s, 'warn', `restart: ${s.restart} starts it again (restart ${crashes}, after ${wait}s).`);
        at += 0.3;
      }
      if (crashes) log(at, s, 'warn', `connected on attempt ${crashes + 1}: it works now, but it crashed ${crashes} time${crashes === 1 ? '' : 's'} first.`);
    }
    if (img.oneshot) {
      const exit = at + img.runS;
      log(exit, s, 'ok', `created the tables and exited with code 0 (done; a one-off job is supposed to stop).`);
      return { start, exit, exitCode: 0, crashes, why: 'completed' };
    }
    const ready = at + img.readyS;
    log(ready, s, 'ok', `ready: accepting connections on port ${img.listens}.`);
    const r = { start, ready, crashes, running: true };
    if (s.health) {
      const hc = healthOk(s, img);
      const iv = Math.max(1, Number(s.interval) || 2);
      if (hc.ok) { r.healthy = start + Math.max(1, Math.ceil((ready - start) / iv)) * iv; log(r.healthy, s, 'ok', `healthy: "${hc.test}" passed (checked every ${iv}s).`); }
      else { r.healthWhy = hc.why; log(start + iv * 3, s, 'bad', `unhealthy after 3 failed checks: ${hc.why}`); }
    }
    return r;
  }

  for (const s of so.order) get(s);
  steps.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const reach = (a, b) => {
    const sb = st.get(b.id);
    if (a === b) return { ok: false, why: 'itself' };
    if (!sharedNets(m, a, b).length) return { ok: false, why: `no shared network (${a.name}: ${netsOf(m, a).join(', ')}; ${b.name}: ${netsOf(m, b).join(', ')})` };
    if (!sb?.running) return { ok: false, why: `${b.name} is not running` };
    return { ok: true, why: `both on ${sharedNets(m, a, b).join(', ')}` };
  };
  const res = { order: so.order, st, steps, reach };
  res.requests = laptopRequests(m, res);
  return res;
}

/** What you see when you open each published port on your laptop. */
function laptopRequests(m, R) {
  const out = [];
  for (const s of services(m)) {
    const img = IMAGES[s.image];
    for (const p of s.ports.map(parsePort)) {
      const url = p.host ? `localhost:${p.host}` : `a random port → ${p.container}`;
      const r = { svc: s.id, port: p.host, url, chain: [s.id], ok: false };
      const ss = R.st.get(s.id);
      if (!ss?.running) r.why = `${s.name} is not running, so nothing answers on ${url}.`;
      else if (p.container !== img.listens) r.why = `${url} is forwarded to port ${p.container} in ${s.name}, but ${s.image} listens on ${img.listens}. The connection is reset ("empty reply from server"). Publish ${p.host || 8080}:${img.listens} instead.`;
      else Object.assign(r, serve(m, R, s, r.chain));
      out.push(r);
    }
  }
  return out;
}

function serve(m, R, s, chain) {
  const img = IMAGES[s.image];
  if (img.role === 'nginx') {
    const mt = mountsOf(m, s).find(x => x.v.kind === 'bind' && x.target === NGINX_ROOT);
    if (mt) return { ok: true, page: 'files', why: `nginx serves your files from ${mt.v.name} (bind-mounted at ${NGINX_ROOT}). Edit a file on your laptop and reload: the change is there at once.` };
    const wrong = mountsOf(m, s).find(x => x.v.kind === 'bind');
    return { ok: true, page: 'default', why: `nginx answers with its default "Welcome to nginx!" page.${wrong ? ` ${wrong.v.name} is mounted at ${wrong.target}, but nginx serves ${NGINX_ROOT}.` : ''}` };
  }
  if (img.role === 'postgres' || img.role === 'redis') return { ok: true, page: 'db', why: `a ${img.role === 'postgres' ? 'Postgres client (psql)' : 'redis-cli'} on your laptop can connect here. Handy for debugging, but anyone who can reach your laptop can try too.` };
  if (img.role === 'api') {
    const host = envOf(s).DB_HOST;
    const db = services(m).find(x => x.name === host);
    if (db) chain.push(db.id);
    return { ok: true, page: 'orders', why: `the API answers GET /orders with rows from ${host}.` };
  }
  if (img.role === 'web') {
    const host = envOf(s).API_HOST || 'api';
    const api = services(m).find(x => x.name === host);
    if (!api) return { ok: false, why: `the page loads, but /api calls fail: getaddrinfo ENOTFOUND ${host} (no service has that name).` };
    if (!sharedNets(m, s, api).length) return { ok: false, why: `the page loads, but /api calls fail: getaddrinfo ENOTFOUND ${host}. ${s.name} and ${host} share no network.` };
    if (!R.st.get(api.id)?.running) return { ok: false, why: `the page loads, but /api calls fail with 502: ${host} is not running.` };
    if (IMAGES[api.image].role !== 'api') return { ok: false, why: `${host} runs ${api.image}, not the shop API.` };
    chain.push(api.id);
    const inner = serve(m, R, api, chain);
    return { ok: inner.ok, page: 'orders', why: `the shop page loads and its /api call goes to ${host}:3000; ${inner.why}` };
  }
  return { ok: false, why: 'nothing to see here.' };
}

/** Where data lives for each stateful service, and whether a down (+ -v) keeps it. */
export function dataFate(m, R, removeVolumes) {
  const out = [];
  for (const s of services(m)) {
    const img = IMAGES[s.image];
    if (!img?.data) continue;
    const ss = R.st.get(s.id);
    if (!ss?.running) { out.push({ svc: s, ok: false, why: `${s.name} never ran, so it stored nothing.` }); continue; }
    const mt = mountsOf(m, s).find(x => x.target === img.data);
    const elsewhere = mountsOf(m, s).filter(x => x.target !== img.data);
    if (!mt) {
      out.push({ svc: s, ok: false, why: `${s.name} kept its files in ${img.data} inside the container's own layer. "down" removed the container, and the data went with it.${elsewhere.length ? ` (${elsewhere.map(x => `${x.v.name} is mounted at ${x.target}`).join('; ')}, but ${s.image} writes to ${img.data}, so that mount stayed empty.)` : ''}` });
      continue;
    }
    if (mt.v.kind === 'volume' && removeVolumes) { out.push({ svc: s, ok: false, why: `${s.name} stored its files in the named volume ${mt.v.name}, but "down -v" deletes named volumes. Only use -v when you mean "wipe the data".` }); continue; }
    out.push({ svc: s, ok: true, why: mt.v.kind === 'volume'
      ? `${s.name} stores ${img.data} in the named volume ${mt.v.name}. Docker keeps the volume when the container is removed, and the new container mounts it again.`
      : `${s.name} stores ${img.data} in ${mt.v.name} on your laptop (a bind mount). It survives down, and even down -v.` });
  }
  return out;
}

// ---------------------------------------------------------------- YAML out and back in

export function toYaml(m) {
  const L = [];
  const list = services(m);
  if (!list.length) return 'services: {}\n';
  L.push('services:');
  for (const s of list) {
    L.push(`  ${s.name}:`, `    image: ${Y.scalar(s.image)}`);
    if (s.ports.length) L.push('    ports:', ...s.ports.map(p => `      - ${Y.quoted(p)}`));
    const env = Object.entries(envOf(s));
    if (env.length) L.push('    environment:', ...env.map(([k, v]) => `      ${k}: ${Y.scalar(v)}`));
    const deps = depsOf(m, s);
    if (deps.length) { L.push('    depends_on:'); for (const { w, d } of deps) L.push(`      ${d.name}:`, `        condition: ${w.condition || 'service_started'}`); }
    if (s.health) L.push('    healthcheck:', `      test: ["CMD-SHELL", ${Y.quoted((s.healthTest || '').trim() || IMAGES[s.image]?.health || '')}]`, `      interval: ${Math.max(1, Number(s.interval) || 2)}s`);
    if (s.restart && s.restart !== 'no') L.push(`    restart: ${s.restart}`);
    const nets = m.wires.filter(w => w.from === s.id && byId(m, w.to)?.kind === 'network').map(w => byId(m, w.to).name);
    if (nets.length) L.push('    networks:', ...nets.map(n => `      - ${Y.scalar(n)}`));
    const mounts = mountsOf(m, s);
    if (mounts.length) L.push('    volumes:', ...mounts.map(x => `      - ${Y.scalar(`${x.v.name}:${x.target}`)}`));
  }
  const nets = m.blocks.filter(b => b.kind === 'network');
  if (nets.length) L.push('', 'networks:', ...nets.map(n => `  ${n.name}:`));
  const vols = m.blocks.filter(b => b.kind === 'volume');
  if (vols.length) L.push('', 'volumes:', ...vols.map(v => `  ${v.name}:`));
  return L.join('\n') + '\n';
}

const listOf = v => (v == null ? [] : Array.isArray(v) ? v : typeof v === 'object' ? Object.keys(v) : [v]);

/** Rebuilds the model from compose.yaml text, keeping block positions by name. -> model or an error string. */
export function fromYaml(old, text) {
  let doc;
  try { doc = Y.parse(text); } catch (e) { return e.message; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'The file must be a map with a "services:" key at the top.';
  for (const k of Object.keys(doc)) if (!['services', 'networks', 'volumes', 'name', 'version'].includes(k)) return `Unknown top-level key "${k}". Use services, networks and volumes.`;
  const S = doc.services;
  if (!S || typeof S !== 'object' || Array.isArray(S)) return 'There is no "services:" map.';
  const pos = new Map(old.blocks.map(b => [b.kind + ':' + b.name, b]));
  const m = { blocks: old.blocks.filter(b => b.kind === 'host').map(clone), wires: [] };
  let slot = 0;
  const place = (kind, name, settings) => {
    const was = pos.get(kind + ':' + name);
    const id = was?.id || `${kind}-${name}`.replace(/[^\w.-]/g, '_');
    const col = { service: 380, network: 760, volume: 760, bind: 760 }[kind];
    const b = block(kind, id, name, was?.x ?? col, was?.y ?? 40 + (slot++ % 8) * 150, settings);
    m.blocks.push(b);
    return b;
  };
  const netNames = listOf(doc.networks).map(String), volNames = listOf(doc.volumes).map(String);
  netNames.forEach(n => place('network', n, {}));
  volNames.forEach(v => place('volume', v, {}));
  const pending = [];
  for (const [name, def] of Object.entries(S)) {
    if (!validName(name)) return `"${name}" is not a valid service name: lower-case letters, digits, - _ and . only.`;
    const d = def || {};
    if (typeof d !== 'object' || Array.isArray(d)) return `services.${name} must be a map (image:, ports:, ...).`;
    for (const k of Object.keys(d)) if (!['image', 'ports', 'environment', 'depends_on', 'healthcheck', 'restart', 'networks', 'volumes'].includes(k)) {
      return k === 'build' ? `services.${name}: "build:" is not supported in this lab. Pick an image: ${IMAGE_NAMES.join(', ')}.` : `services.${name}: "${k}" is not supported in this lab (supported: image, ports, environment, depends_on, healthcheck, restart, networks, volumes).`;
    }
    if (!d.image) return `services.${name} has no image.`;
    let env = [];
    if (Array.isArray(d.environment)) env = d.environment.map(String);
    else if (d.environment && typeof d.environment === 'object') env = Object.entries(d.environment).map(([k, v]) => `${k}=${v ?? ''}`);
    let health = false, healthTest = '', interval = 2;
    if (d.healthcheck) {
      health = true;
      const t = d.healthcheck.test;
      healthTest = Array.isArray(t) ? (['CMD-SHELL', 'CMD'].includes(t[0]) ? t.slice(1) : t).join(' ') : String(t ?? '').replace(/^CMD-SHELL\s+/, '');
      interval = parseInt(String(d.healthcheck.interval ?? '2'), 10) || 2;
    }
    const s = place('service', name, { image: String(d.image), ports: listOf(d.ports).map(String), env, health, healthTest, interval, restart: String(d.restart ?? 'no') });
    if (!RESTARTS.includes(s.restart)) return `services.${name}: restart must be one of ${RESTARTS.join(', ')}.`;
    for (const p of s.ports) { const pp = parsePort(p); if (pp.error) return `services.${name}: ${pp.error}`; }
    pending.push({ s, d });
  }
  for (const { s, d } of pending) {
    const deps = Array.isArray(d.depends_on) ? d.depends_on.map(n => [String(n), 'service_started']) : Object.entries(d.depends_on || {}).map(([n, v]) => [n, v?.condition || 'service_started']);
    for (const [n, cond] of deps) {
      const t = byName(m, 'service', n);
      if (!t) return `service "${s.name}" depends on undefined service "${n}".`;
      if (!CONDITIONS.includes(cond)) return `service "${s.name}": condition must be one of ${CONDITIONS.join(', ')}.`;
      m.wires.push(wire(s.id, t.id, { condition: cond }));
    }
    for (const n of listOf(d.networks).map(String)) {
      const t = byName(m, 'network', n);
      if (!t) return `service "${s.name}" refers to undefined network ${n}: declare it under the top-level networks: key.`;
      m.wires.push(wire(s.id, t.id));
    }
    for (const v of listOf(d.volumes).map(String)) {
      const i = v.indexOf(':');
      if (i < 1) return `service "${s.name}": the volume "${v}" needs SOURCE:TARGET, like data:/var/lib/postgresql/data.`;
      const src = v.slice(0, i), target = v.slice(i + 1).replace(/:(ro|rw)$/, '');
      let t;
      if (/^[./~]/.test(src)) t = byName(m, 'bind', src) || place('bind', src, {});
      else if (!(t = byName(m, 'volume', src))) return `service "${s.name}" refers to undefined volume ${src}: declare it under the top-level volumes: key.`;
      m.wires.push(wire(s.id, t.id, { target }));
    }
  }
  return m;
}

// ---------------------------------------------------------------- challenges

const partsCost = m => m.blocks.length + m.wires.length;
const starsFor = (c, par, slack = 2) => (c <= par ? 3 : c <= par + slack ? 2 : 1);
const laptop = () => block('host', 'laptop', 'Your laptop', 20, 200, { fixed: true });
const svc = (name, x, y, s) => block('service', name, name, x, y, s);
const pg = (x, y, s = {}) => svc('db', x, y, { image: 'postgres:16', env: ['POSTGRES_PASSWORD=secret'], ...s });
const api = (x, y, s = {}) => svc('api', x, y, { image: 'shop-api:1.0', env: ['DB_HOST=db', 'DB_PORT=5432'], ...s });
const S = (m, name) => byName(m, 'service', name);
const req = (R, port) => R.requests?.find(r => r.port === port);
const goal = (label, ok, why) => ({ label, ok: !!ok, why: ok ? '' : why });
const whyNot = (R, m, name) => {
  const s = S(m, name), x = s && R.st?.get(s.id);
  if (!s) return `there is no service called ${name}`;
  if (!x) return R.error || 'it was not simulated';
  return x.why || x.healthWhy || (x.running ? '' : 'it is not running');
};
const runs = (R, m, name) => { const s = S(m, name); return !!(s && R.st?.get(s.id)?.running); };
const runningGoal = (R, m, name) => goal(`${name} is running`, runs(R, m, name), whyNot(R, m, name));
const noCrash = (R, m, name) => {
  const x = S(m, name) && R.st?.get(S(m, name).id);
  const why = !x?.crashes ? whyNot(R, m, name)
    : x.running ? `${name} crashed ${x.crashes} time${x.crashes === 1 ? '' : 's'} before it worked: a restart policy only hides the problem. Read the first crash in the log.`
      : `${name} crashed: ${x.why}`;
  return goal(`${name} starts on the first try (no crash)`, x?.running && !x.crashes, why);
};
const reqGoal = (R, port, label, test = r => r.ok) => { const r = req(R, port); return goal(label, r && test(r), r ? r.why : `nothing is published on localhost:${port}`); };

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free board. Add services, networks, volumes and bind mounts, wire them, and press **docker compose up**. The compose.yaml on the right follows every change, and you can edit it by hand.',
    setup: () => ({ blocks: [laptop(), svc('web', 340, 80, { image: 'shop-web:1.0', ports: ['8080:80'] }), api(340, 300), pg(700, 300, { health: true }), block('volume', 'v-db', 'db-data', 1040, 300)],
      wires: [wire('api', 'db', { condition: 'service_healthy' }), wire('web', 'api'), wire('db', 'v-db', { target: '/var/lib/postgresql/data' })] }),
    solve: m => m, check: () => [] },

  { id: 'publish', title: 'Open the door', xp: 15,
    brief: 'nginx is running, but **http://localhost:8080** on your laptop shows nothing. A container\'s ports are private until you **publish** one: `HOST:CONTAINER`. Publish laptop port **8080** to the port nginx listens on. Drag the laptop\'s ▶ onto the service, or type it in the inspector.',
    setup: () => ({ blocks: [laptop(), svc('web', 380, 180)], wires: [] }),
    solve: m => { S(m, 'web').ports = ['8080:80']; return m; },
    check: (m, R) => [reqGoal(R, 8080, 'localhost:8080 shows the nginx page')] },

  { id: 'collision', title: 'One port, one owner', xp: 20,
    brief: 'Two nginx sites, **site** and **docs**. `docker compose up` starts one and fails the other: *port is already allocated*. Each host port can belong to one container. Keep site on **8080** and give docs another laptop port. Inside, both still listen on 80: that is fine, each container has its own ports.',
    setup: () => ({ blocks: [laptop(), svc('site', 380, 80, { ports: ['8080:80'] }), svc('docs', 380, 320, { ports: ['8080:80'] })], wires: [] }),
    solve: m => { S(m, 'docs').ports = ['8081:80']; return m; },
    check: (m, R) => [reqGoal(R, 8080, 'localhost:8080 shows site', r => r.ok && r.svc === 'site'), goal('docs answers on some other laptop port', R.requests?.some(r => r.svc === 'docs' && r.ok && r.port && r.port !== 8080), whyNot(R, m, 'docs') || 'publish docs on a free port, like 8081:80')] },

  { id: 'password', title: 'The database that quits', xp: 20,
    brief: 'The **db** container starts and stops a second later with exit code 1, so the API waits forever. Press **docker compose up** and read the db line. The postgres image refuses to create a database without a superuser password: give it the environment variable it asks for.',
    setup: () => ({ blocks: [laptop(), api(380, 120, { ports: ['3000:3000'] }), pg(740, 120, { env: [], health: true })], wires: [wire('api', 'db', { condition: 'service_healthy' })] }),
    solve: m => { S(m, 'db').env = ['POSTGRES_PASSWORD=secret']; return m; },
    check: (m, R) => [goal('db is healthy', S(m, 'db') && R.st?.get(S(m, 'db').id)?.healthy != null, whyNot(R, m, 'db')), runningGoal(R, m, 'api'), reqGoal(R, 3000, 'localhost:3000 lists the orders')] },

  { id: 'localhost', title: 'localhost is not your laptop', xp: 25,
    brief: 'The API crashes with `ECONNREFUSED 127.0.0.1:5432`. Its **DB_HOST** says `localhost`, which worked when everything ran on your laptop. In a container, localhost is the container itself. Containers on the same Compose network find each other **by service name**.',
    setup: () => ({ blocks: [laptop(), api(380, 120, { ports: ['3000:3000'], env: ['DB_HOST=localhost', 'DB_PORT=5432'] }), pg(740, 120, { health: true })], wires: [wire('api', 'db', { condition: 'service_healthy' })] }),
    solve: m => { S(m, 'api').env = ['DB_HOST=db', 'DB_PORT=5432']; return m; },
    check: (m, R) => [noCrash(R, m, 'api'), reqGoal(R, 3000, 'localhost:3000 lists the orders')] },

  { id: 'inside-port', title: 'Inside port, outside port', xp: 25,
    brief: 'You already run Postgres on your laptop, so it owns port 5432. Someone published the db as **5433:5432** so you can reach it with psql, then "to match" changed the API\'s **DB_PORT** to 5433. Now the API cannot connect. Keep 5433 for your laptop, and make the API connect the way containers really talk to each other.',
    hostBusy: { 5432: 'The Postgres installed on your laptop' },
    setup: () => ({ blocks: [laptop(), api(380, 120, { ports: ['3000:3000'], env: ['DB_HOST=db', 'DB_PORT=5433'] }), pg(740, 120, { health: true, ports: ['5433:5432'] })], wires: [wire('api', 'db', { condition: 'service_healthy' })] }),
    solve: m => { S(m, 'api').env = ['DB_HOST=db', 'DB_PORT=5432']; return m; },
    check: (m, R) => [noCrash(R, m, 'api'), reqGoal(R, 3000, 'localhost:3000 lists the orders'), goal('psql on your laptop still reaches db', R.requests?.some(r => r.svc === 'db' && r.ok), whyNot(R, m, 'db') || 'publish db on a free laptop port (5432 is taken)')] },

  { id: 'healthy', title: 'Started is not ready', xp: 30,
    brief: 'api `depends_on` db, so Compose starts db first. Still the API crashes: Postgres needs about **6 seconds** after its container starts before it accepts connections, and plain depends_on only waits for the *start*. Give db a **healthcheck** and make api wait for **service_healthy** (click the wire to change its condition). A restart policy is not the answer here: crashing until it works hides the real problem.',
    setup: () => ({ blocks: [laptop(), api(380, 120, { ports: ['3000:3000'] }), pg(740, 120)], wires: [wire('api', 'db', { condition: 'service_started' })] }),
    solve: m => { S(m, 'db').health = true; m.wires.find(w => w.from === 'api').condition = 'service_healthy'; return m; },
    check: (m, R) => [noCrash(R, m, 'api'), reqGoal(R, 3000, 'localhost:3000 lists the orders')] },

  { id: 'bad-check', title: 'A check that cannot pass', xp: 30,
    brief: 'db has a healthcheck now, yet it is **unhealthy** forever and api never starts. The check is `curl -f http://localhost:5432`. A healthcheck runs *inside* the db container, with only the programs that image contains. Use the tool Postgres ships for exactly this.',
    setup: () => ({ blocks: [laptop(), api(380, 120, { ports: ['3000:3000'] }), pg(740, 120, { health: true, healthTest: 'curl -f http://localhost:5432' })], wires: [wire('api', 'db', { condition: 'service_healthy' })] }),
    solve: m => { S(m, 'db').healthTest = 'pg_isready -U postgres'; return m; },
    check: (m, R) => [goal('db is healthy', S(m, 'db') && R.st?.get(S(m, 'db').id)?.healthy != null, whyNot(R, m, 'db')), noCrash(R, m, 'api')] },

  { id: 'networks', title: 'Keep the database private', xp: 40,
    brief: 'Everything sits on the one **default** network, so the website container can talk straight to the database. If web is ever compromised, so is your data. Split it: a **front** network for web and api, a **back** network for api and db. api joins both. The shop page must still work end to end.',
    setup: () => ({ blocks: [laptop(), svc('web', 340, 60, { image: 'shop-web:1.0', ports: ['8080:80'], env: ['API_HOST=api'] }), api(340, 300), pg(700, 300, { health: true })],
      wires: [wire('api', 'db', { condition: 'service_healthy' }), wire('web', 'api')] }),
    solve: m => {
      m.blocks.push(block('network', 'n-front', 'front', 700, 60), block('network', 'n-back', 'back', 1040, 300));
      m.wires.push(wire('web', 'n-front'), wire('api', 'n-front'), wire('api', 'n-back'), wire('db', 'n-back'));
      return m;
    },
    check: (m, R) => {
      const web = S(m, 'web'), db = S(m, 'db');
      return [reqGoal(R, 8080, 'localhost:8080: the shop page loads its orders'),
        goal('web cannot reach db by name', web && db && !sharedNets(m, web, db).length, web && db ? `web and db are both on ${sharedNets(m, web, db).join(', ')}` : 'keep the web and db services'),
        goal('db is not published on your laptop', db && !db.ports.length, 'db publishes a port: anyone who can reach your laptop can try to log in'),
        runningGoal(R, m, 'db')];
    } },

  { id: 'volume', title: 'Data that survives', xp: 40,
    brief: 'Press **down, then up**. The orders are gone: `docker compose down` removes containers, and db kept its files inside its own container. Add a **named volume** and mount it where Postgres keeps its data, **/var/lib/postgresql/data** (click the mount wire to set the path). Then try **down -v** to see what -v does.',
    setup: () => ({ blocks: [laptop(), api(380, 120, { ports: ['3000:3000'] }), pg(740, 120, { health: true })], wires: [wire('api', 'db', { condition: 'service_healthy' })] }),
    solve: m => { m.blocks.push(block('volume', 'v-db', 'db-data', 1060, 120)); m.wires.push(wire('db', 'v-db', { target: '/var/lib/postgresql/data' })); return m; },
    check: (m, R) => {
      const f = R.error ? [] : dataFate(m, R, false).filter(x => x.svc.name === 'db');
      return [noCrash(R, m, 'api'), goal('the orders survive down + up', f[0]?.ok, f[0]?.why || whyNot(R, m, 'db'))];
    } },

  { id: 'bind', title: 'Serve your own files', xp: 30,
    brief: 'You are building a site in the **./site** folder on your laptop and want nginx to serve it, live, without rebuilding an image. That is a **bind mount**: a laptop folder appears inside the container. Wire **site → ./site** and mount it where nginx looks for its pages.',
    setup: () => ({ blocks: [laptop(), svc('site', 380, 120, { ports: ['8080:80'] }), block('bind', 'b-site', './site', 740, 120)], wires: [] }),
    solve: m => { m.wires.push(wire('site', 'b-site', { target: NGINX_ROOT })); return m; },
    check: (m, R) => [reqGoal(R, 8080, 'localhost:8080 shows your files, not the nginx welcome page', r => r.ok && r.page === 'files')] },

  { id: 'migrate', title: 'Migrations first', xp: 45,
    brief: 'A **migrate** job creates the tables and exits. api waits for db to be healthy, but not for migrate, so it starts while the tables are still missing and crashes: `relation "orders" does not exist`. A one-off job never becomes "healthy": it **completes**. Make api wait for the right condition.',
    setup: () => ({ blocks: [laptop(), api(380, 60, { ports: ['3000:3000'] }), svc('migrate', 380, 320, { image: 'shop-migrate:1.0', env: ['DB_HOST=db'] }), pg(760, 180, { health: true })],
      wires: [wire('api', 'db', { condition: 'service_healthy' }), wire('migrate', 'db', { condition: 'service_healthy' })] }),
    solve: m => { m.wires.push(wire('api', 'migrate', { condition: 'service_completed_successfully' })); return m; },
    check: (m, R) => [noCrash(R, m, 'api'), goal('migrate finished with exit code 0', S(m, 'migrate') && R.st?.get(S(m, 'migrate').id)?.exitCode === 0, whyNot(R, m, 'migrate')), reqGoal(R, 3000, 'localhost:3000 lists the orders')] },
];
for (const c of CHALLENGES) c.par ??= partsCost(c.solve(c.setup()));

/** Judges a challenge: { ok, goals, cost, stars, run }. */
export function judge(m, ch) {
  const R = up(m, { hostBusy: ch.hostBusy });
  const goals = R.error ? [goal('docker compose up runs', false, R.error)] : ch.check(m, R).filter(Boolean);
  const ok = goals.length > 0 && goals.every(g => g.ok);
  const cost = partsCost(m);
  return { ok, goals, cost, stars: ok ? starsFor(cost, ch.par) : 0, run: R };
}
