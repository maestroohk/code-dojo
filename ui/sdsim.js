// The System design board's load simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
//
// A model is { blocks, wires }: Users, DNS, a CDN, load balancers, app server pools, cache clusters, a database
// (one primary per shard, optional standby), read replicas, queues with workers and object storage, placed in
// one or two regions. simulate() runs a 10-minute load test in 10-second ticks. Each tick it
//   1. works out the load on every component (requests per second, split by reads and writes, CDN and cache
//      hits taken out, retries added back in),
//   2. models every component as a queue: an M/M/c queue (c = cores, nodes or connections) while it keeps up,
//      and an overload model when it does not (a backlog builds, waiting time grows, and once the wait passes the
//      caller's timeout every request in it fails: congestion collapse),
//   3. samples a few hundred requests through the real path with a seeded random generator to get p50/p95/p99
//      and the error rate, and
//   4. carries state to the next tick: backlogs, replica lag, a cold cache warming up, failovers in progress,
//      autoscaling, and the client retries caused by this tick's failures (which is how a retry storm outlives
//      its trigger).
// Every number it shows can be explained from these rules; explain() turns the run into plain sentences.
// Prices are illustrative round numbers (about what large clouds list in 2026), not any provider's price list.

export const KINDS = {
  client: { label: 'Users', icon: '👥' },
  dns: { label: 'DNS', icon: '🧭' },
  cdn: { label: 'CDN', icon: '🌐' },
  lb: { label: 'Load balancer', icon: '⚖' },
  app: { label: 'App servers', icon: '🖥' },
  cache: { label: 'Cache cluster', icon: '⚡' },
  db: { label: 'Database', icon: '🛢' },
  replica: { label: 'Read replicas', icon: '⧉' },
  queue: { label: 'Queue / stream', icon: '☰' },
  worker: { label: 'Workers', icon: '⚙' },
  objstore: { label: 'Object storage', icon: '🪣' },
};

/** Instance sizes. vcpu = cores; gbps = network card; usd = per month. */
export const SIZES = {
  app: {
    S: { vcpu: 2, mem: 4, gbps: 2.5, usd: 60 },
    M: { vcpu: 4, mem: 16, gbps: 5, usd: 120 },
    L: { vcpu: 8, mem: 32, gbps: 10, usd: 240 },
    XL: { vcpu: 16, mem: 64, gbps: 12.5, usd: 480 },
  },
  db: {
    M: { vcpu: 4, mem: 32, maxConn: 400, usd: 350 },
    L: { vcpu: 8, mem: 64, maxConn: 800, usd: 700 },
    XL: { vcpu: 16, mem: 128, maxConn: 1600, usd: 1400 },
    '2XL': { vcpu: 32, mem: 256, maxConn: 3200, usd: 2800 },
  },
  // ops: requests/s one node serves. Commands run on one main thread, so a bigger node adds memory far more than speed.
  cache: {
    S: { mem: 6, ops: 80000, usd: 100 },
    M: { mem: 13, ops: 100000, usd: 180 },
    L: { mem: 26, ops: 110000, usd: 350 },
    XL: { mem: 52, ops: 120000, usd: 700 },
  },
};

export const PRICES = {
  lbBase: 20, lbPer1kRps: 6, dns: 5, cdnGB: 0.03, egressGB: 0.08, objGBMonth: 0.022, objPutPerM: 5, objGetPerM: 0.4,
  partition: 15, dbStorageGB: 0.12,
};

/** Latency constants in ms (2026 data centres): same-region hops, cross-region, the user's link. */
export const NET = { hop: 0.4, crossRegion: 70, edge: 12, lb: 0.5, l7: 0.3, cacheOp: 0.05, publish: 2, objFirstByte: 25, standbyCommit: 1, clientTimeout: 5000 };
/** Service costs in ms of one core. */
export const COST = { readMs: 0.8, writeMs: 2.5, scanFactor: 30, applyFactor: 0.2, blobWritePerKB: 0.01, blobReadPerKB: 0.005 };
const PARTITION_RATE = 1000;          // messages/s one partition accepts in this model
const AVG = 0.5;                      // the daily average is about half the peak
const MONTH_S = 30.44 * 86400, YEAR_S = 365.25 * 86400;
const DETECT_S = 30;                  // health checks: 3 failures 10 s apart
const DB_FAILOVER_S = 30, PROMOTE_S = 60, BOOT_S = 120;

export const DEFAULTS = {
  client: { qps: 2000, readPct: 90, keys: 1000000, skew: 0.9, objKB: 1, respKB: 2, rowKB: 0.3, cacheablePct: 0, uploadPct: 0, uploadKB: 0, writeKeys: 'random', share1: 100, rttMs: 40 },
  dns: { policy: 'simple', ttl: 300, healthChecks: false },
  cdn: { hitPct: 90 },
  lb: { layer: 'L7', algo: 'round-robin', healthChecks: true, rateLimit: 0, region: 1 },
  app: { instances: 4, size: 'M', cpuMs: 8, azs: 1, timeoutMs: 1000, retries: 0, backoff: 'none', breaker: false, pool: 10, nearCache: false, saltHotKeys: false, autoscaleMax: 0, region: 1 },
  cache: { nodes: 1, size: 'M', ttl: 300, azs: 1, coalesce: false, region: 1 },
  db: { size: 'L', shards: 1, partition: 'hash', indexed: true, standby: false, pooler: false, region: 1 },
  replica: { count: 1, size: 'L', promote: false, region: 1 },
  queue: { partitions: 4, region: 1 },
  worker: { instances: 2, size: 'M', cpuMs: 4, batch: 1, pool: 5, region: 1 },
  objstore: { region: 1 },
};

/** Which kinds a block's output may be wired to. */
export const TARGETS = {
  client: ['dns', 'cdn', 'lb'],
  dns: ['cdn', 'lb'],
  cdn: ['lb', 'dns'],
  lb: ['app'],
  app: ['cache', 'db', 'replica', 'queue', 'objstore'],
  cache: [],
  db: ['replica'],
  replica: [],
  queue: ['worker'],
  worker: ['db'],
  objstore: [],
};
export const SINGLE_OUT = ['client', 'cdn', 'queue'];

export const block = (kind, id, name, x = 0, y = 0, settings = {}) => ({ id, kind, name, x, y, ...DEFAULTS[kind], ...settings });
export const wire = (from, to) => ({ id: `W-${from}-${to}`, from, to });
export const byId = (m, id) => m.blocks.find(b => b.id === id);
export const outs = (m, b) => m.wires.filter(w => w.from === b.id).map(w => byId(m, w.to)).filter(Boolean);
export const ins = (m, b) => m.wires.filter(w => w.to === b.id).map(w => byId(m, w.from)).filter(Boolean);
const outsOf = (m, b, kind) => outs(m, b).filter(x => x.kind === kind);

export function canWire(m, from, to) {
  if (!from || !to || from.id === to.id) return false;
  return (TARGETS[from.kind] || []).includes(to.kind);
}

/** Adds a wire (replacing the old output of single-output blocks). Returns false if not allowed. */
export function connect(m, fromId, toId) {
  const from = byId(m, fromId), to = byId(m, toId);
  if (!canWire(m, from, to)) return false;
  if (SINGLE_OUT.includes(from.kind)) m.wires = m.wires.filter(w => w.from !== from.id);
  if (!m.wires.some(w => w.from === fromId && w.to === toId)) m.wires.push(wire(fromId, toId));
  return true;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = n => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : Math.abs(n) >= 10 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/0$/, '').replace(/\.0$/, ''));
export const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${ms >= 10 ? Math.round(ms) : ms.toFixed(1)} ms`);
export const fmtQps = q => (q >= 1e6 ? `${(q / 1e6).toFixed(1)}M` : q >= 1e4 ? `${Math.round(q / 1000)}k` : q >= 1000 ? `${(q / 1000).toFixed(1)}k` : `${Math.round(q)}`);
export const fmtUsd = u => `$${Math.round(u).toLocaleString('en-US')}`;
const pct = x => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------- queueing maths

/** Erlang C: the chance an arriving request has to wait in an M/M/c queue with offered load a = lambda/mu. */
export function erlangC(c, a) {
  if (c <= 0) return 1;
  if (a >= c) return 1;
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  const rho = a / c;
  return b / (1 - rho * (1 - b));
}

/** Mean wait in queue (ms) for an M/M/c queue: C / (c mu - lambda). mu per second per server. */
export function mmcWaitMs(c, mu, lambda) {
  if (lambda <= 0) return 0;
  if (lambda >= c * mu) return Infinity;
  return (erlangC(c, lambda / mu) / (c * mu - lambda)) * 1000;
}

// ---------------------------------------------------------------- key popularity (Zipf) and cache hit rates

const zipfCache = new Map();
/** Rank buckets for a Zipf(s) popularity over N keys: the top 64 ranks one by one, then log-spaced buckets. */
export function zipf(N, s) {
  N = Math.max(1, Math.round(N));
  const key = `${N}|${s}`;
  if (zipfCache.has(key)) return zipfCache.get(key);
  const integ = (a, b) => (Math.abs(s - 1) < 1e-9 ? Math.log(b / a) : (b ** (1 - s) - a ** (1 - s)) / (1 - s));
  const buckets = [];
  const top = Math.min(N, 64);
  for (let i = 1; i <= top; i++) buckets.push({ lo: i, hi: i, n: 1, w: i ** -s });
  if (N > 64) {
    const steps = 90;
    const ratio = (N / 64) ** (1 / steps);
    let lo = 65;
    for (let k = 1; k <= steps && lo <= N; k++) {
      const hi = k === steps ? N : Math.max(lo, Math.floor(64 * ratio ** k));
      buckets.push({ lo, hi, n: hi - lo + 1, w: integ(lo - 0.5, hi + 0.5) });
      lo = hi + 1;
    }
  }
  const total = buckets.reduce((s2, b) => s2 + b.w, 0);
  for (const b of buckets) b.p = b.w / total;
  zipfCache.set(key, buckets);
  return buckets;
}

/** Share of requests that go to the top k keys. */
export function coverage(N, s, k) {
  let c = 0;
  for (const b of zipf(N, s)) {
    if (b.lo > k) break;
    c += b.p * (b.hi <= k ? 1 : (k - b.lo + 1) / b.n);
  }
  return c;
}

/**
 * Hit rate of a cache that can hold the k most popular keys, with a TTL and cache-aside invalidation:
 * a key read r times a second and invalidated by expiry or a write stays cached for tau = 1 / (1/ttl + w),
 * so its hits per miss are r * tau (a Poisson-arrival TTL cache). hot = { share } adds one celebrity key.
 */
export function hitRate({ N, s, k, ttl, R, W = 0, hot = 0 }) {
  if (R <= 0 || k <= 0) return 0;
  const base = 1 - hot;
  let hits = 0;
  const one = (r, w) => { const tau = 1 / ((ttl > 0 ? 1 / ttl : 0) + w + 1e-12); return (r * tau) / (1 + r * tau); };
  for (const b of zipf(N, s)) {
    if (b.lo > k) break;
    const n = b.hi <= k ? b.n : k - b.lo + 1;
    const r = (R * base * b.p) / b.n, w = (W * base * b.p) / b.n;
    hits += n * r * one(r, w);
  }
  if (hot > 0) hits += R * hot * one(R * hot, W * hot);
  return clamp(hits / R, 0, 1);
}

/** Expected number of distinct keys among M random requests. */
export function distinctKeys(M, N, s) {
  let d = 0;
  for (const b of zipf(N, s)) d += b.n * (1 - Math.exp((-M * b.p) / b.n));
  return d;
}

/** DB queries left when concurrent misses for one key share one fill (single-flight): each key fills at most once per fill time. */
function coalescedFills(missRate, N, s, coldFrom, fillS) {
  // keys ranked below coldFrom are cached (their misses are expiry misses, already spread out); the rest miss on every read
  let fills = 0, plain = 0;
  for (const b of zipf(N, s)) {
    const cold = b.hi < coldFrom ? 0 : b.lo >= coldFrom ? b.n : b.hi - coldFrom + 1;
    if (!cold) continue;
    const r = (missRate * b.p) / b.n;
    plain += cold * r;
    fills += cold * Math.min(r, 1 / fillS);
  }
  return plain > 0 ? fills / plain : 1;
}

// ---------------------------------------------------------------- a stage: one queue

/**
 * Models one component for one tick. cap = requests per second it can serve (servers x rate).
 * A stage keeps a backlog between ticks. shed = admission control (excess fails fast instead of queueing).
 */
function stage(st, lambda, c, mu, timeoutMs, dt, { shed = false, svcMs = 1000 / mu } = {}) {
  const cap = c * mu;
  st.lambda = lambda; st.cap = cap; st.c = c; st.mu = mu; st.svcMs = svcMs;
  st.util = cap > 0 ? lambda / cap : (lambda > 0 ? Infinity : 0);
  st.backlog ||= 0;
  if (cap <= 0) { st.mode = 'dead'; st.e = lambda > 0 ? 1 : 0; st.waitMs = 0; st.C = 0; st.served = 0; return st; }
  if (shed) {
    st.backlog = 0;
    const admit = Math.min(lambda, cap * 0.95);
    st.e = lambda > 0 ? 1 - admit / lambda : 0;
    st.shedFrac = st.e;
    st.mode = st.e > 0.001 ? 'shed' : 'ok';
    st.C = erlangC(c, admit / mu);
    st.waitMs = mmcWaitMs(c, mu, admit);
    st.served = admit;
    return st;
  }
  if (st.backlog <= 0 && lambda < cap * 0.995) {
    st.mode = 'ok'; st.e = 0; st.C = erlangC(c, lambda / mu); st.waitMs = mmcWaitMs(c, mu, lambda); st.served = lambda;
    return st;
  }
  // Overloaded: the backlog grows by the excess and drains by the spare capacity. Work waits in line; past the
  // caller's timeout everyone in the line has given up, but the component still burns time on the queued work.
  const maxBacklog = cap * (2 * timeoutMs) / 1000;
  st.backlog = clamp(st.backlog + (lambda - cap) * dt, 0, maxBacklog);
  st.waitMs = (st.backlog / cap) * 1000 + mmcWaitMs(c, mu, Math.min(lambda, cap * 0.98));
  st.C = 1;
  st.mode = st.waitMs > timeoutMs ? 'collapse' : 'queue';
  st.e = st.mode === 'collapse' ? 1 : 0;
  st.served = Math.min(lambda, cap);
  if (st.backlog <= 0 && lambda < cap) st.mode = 'ok';
  return st;
}

/** One sampled pass through a stage: { lat, fail } in ms. */
function pass(st, rng, failLatMs) {
  if (!st || st.mode === 'dead') return { lat: 3, fail: 'down' };
  if (st.e > 0 && rng() < st.e) return { lat: st.mode === 'shed' ? 1 : failLatMs, fail: st.mode === 'shed' ? 'shed' : 'timeout' };
  let wait = 0;
  if (st.mode === 'queue') wait = st.waitMs * (0.7 + 0.6 * rng());
  else if (st.C > 0 && rng() < st.C && st.c * st.mu > st.served) wait = -Math.log(1 - rng()) * (1000 / (st.c * st.mu - st.served));
  const svc = st.svcMs * (0.5 - 0.5 * Math.log(1 - rng()));
  return { lat: wait + svc, fail: null };
}

// ---------------------------------------------------------------- topology helpers

const regionOf = b => b?.region || 1;
const appSize = b => SIZES.app[b.size] || SIZES.app.M;
const dbSize = b => SIZES.db[b.size] || SIZES.db.L;
const cacheSize = b => SIZES.cache[b.size] || SIZES.cache.M;

function active(incidents, kind, t) {
  return incidents.find(i => i.kind === kind && t >= i.at && t < (i.until ?? Infinity)) || null;
}
function since(incidents, kind, t) {
  return incidents.find(i => i.kind === kind && t >= i.at) || null;
}

/** Problems that stop a run before it starts (missing pieces). */
export function lint(m) {
  const client = m.blocks.find(b => b.kind === 'client');
  if (!client) return 'Add Users: someone has to send the traffic.';
  if (!outs(m, client).length) return 'Users are not wired to anything. Drag their ▶ port onto a load balancer, DNS or a CDN.';
  return null;
}

/** Where the client's traffic enters: [{ lb, share, cdn, dns }] for the healthy case. */
function entries(m) {
  const client = m.blocks.find(b => b.kind === 'client');
  const res = [];
  const walk = (b, share, ctx, depth) => {
    if (!b || depth > 6) return;
    if (b.kind === 'lb') { res.push({ lb: b, share, ...ctx }); return; }
    const next = outs(m, b).filter(x => ['dns', 'cdn', 'lb'].includes(x.kind));
    if (b.kind === 'cdn') { walk(next[0], share, { ...ctx, cdn: ctx.cdn || b }, depth + 1); return; }
    if (b.kind === 'dns') {
      const lbs = next;
      if (!lbs.length) return;
      for (const x of lbs) walk(x, share / lbs.length, { ...ctx, dns: b }, depth + 1);
      return;
    }
    if (b.kind === 'client') { walk(next[0], share, ctx, depth + 1); }
  };
  walk(client, 1, {}, 0);
  return res;
}

// ---------------------------------------------------------------- the simulation

export const DEFAULT_SCENARIO = { duration: 600, tick: 10, incidents: [] };

/**
 * Runs the load test. scenario: { duration, tick, incidents: [{ kind, at, until, ... }] } with kinds
 *   'az' (zone A of region 1 fails), 'region' (region 1 fails), 'flush' (cache emptied), 'hotkey' ({ share }),
 *   'slowdb' ({ factor }), 'retrystorm' (clients retry failures 3x at once), 'spike' ({ factor }), 'slownode'.
 * Returns { error } or { ticks, series, samples, windows, stages, cost, est, notes }.
 */
export function simulate(m, scenario = {}, seed = 7) {
  const problem = lint(m);
  if (problem) return { error: problem };
  const sc = { ...DEFAULT_SCENARIO, ...scenario };
  const inc = sc.incidents || [];
  const dt = sc.tick, nTicks = Math.round(sc.duration / dt);
  const rng = mulberry32(seed);
  const client = m.blocks.find(b => b.kind === 'client');
  const ent = entries(m);
  const apps = m.blocks.filter(b => b.kind === 'app');
  const caches = m.blocks.filter(b => b.kind === 'cache');
  const dbs = m.blocks.filter(b => b.kind === 'db');
  const queues = m.blocks.filter(b => b.kind === 'queue');

  // persistent state
  const S = {
    stage: {},           // id -> stage state (backlogs survive between ticks)
    poolAlive: {}, pending: {},
    cacheFilled: {},     // cache id -> keys warm (Infinity = fully warm)
    lag: {},             // replica id -> backlog of writes to apply
    qBacklog: {},
    promoted: {},        // replica id -> promoted to primary at time
    prevErr: 0,
    rpoWrites: 0, rpoSeconds: 0,
  };
  for (const a of apps) S.poolAlive[a.id] = a.instances;
  for (const c of caches) S.cacheFilled[c.id] = Infinity;
  const st = id => (S.stage[id] ||= {});

  const ticks = [];
  const samples = [];     // { t, lat, fail, read } successful and failed attempts
  const contrib = {};     // stage label -> total ms (for "where the time went")

  for (let k = 0; k < nTicks; k++) {
    const t = k * dt;
    const azDown = active(inc, 'az', t), regionDown = active(inc, 'region', t);
    const flushAt = inc.find(i => i.kind === 'flush' && i.at === t);
    const hot = active(inc, 'hotkey', t);
    const slow = active(inc, 'slowdb', t);
    const storm = since(inc, 'retrystorm', t);
    const spike = active(inc, 'spike', t);
    const slowNode = active(inc, 'slownode', t);
    const hotShare = hot ? hot.share ?? 0.5 : 0;
    const regionDead = r => !!regionDown && r === 1;
    const azFrac = (b, azs) => (azDown && regionOf(b) === 1 ? Math.ceil((b.instances ?? b.nodes ?? 1) / Math.max(1, azs)) / Math.max(1, b.instances ?? b.nodes ?? 1) : 0);
    const note = [];

    if (flushAt) for (const c of caches) S.cacheFilled[c.id] = 0;

    // 1. offered load, amplified by client retries when a retry storm is on
    const base = client.qps * (spike ? spike.factor ?? 3 : 1);
    const e0 = S.prevErr;
    const clientAmp = storm ? 1 + e0 + e0 ** 2 + e0 ** 3 : 1;
    const offered = base * clientAmp;
    const readFrac = clamp(client.readPct / 100, 0, 1);

    // 2. entry: DNS policy and failover, CDN
    const routes = [];   // { lb, share, cdn, far }
    let dnsLost = 0;
    if (ent.length) {
      const dns = ent[0].dns;
      const lbs = ent.map(e => e.lb);
      let weights = ent.map(e => e.share);
      if (dns && lbs.length > 1) {
        if (dns.policy === 'latency') weights = lbs.map(lb => (regionOf(lb) === 1 ? client.share1 / 100 : 1 - client.share1 / 100));
        else if (dns.policy === 'failover') weights = lbs.map((lb, i) => (i === 0 ? 1 : 0));
        const total = weights.reduce((a, b) => a + b, 0) || 1;
        weights = weights.map(w => w / total);
      }
      // a dead region's records are pulled only by health-checked DNS, and resolvers keep the old answer for a TTL
      if (dns && regionDown) {
        const deadIdx = lbs.map((lb, i) => (regionDead(regionOf(lb)) ? i : -1)).filter(i => i >= 0);
        const liveIdx = lbs.map((lb, i) => (!regionDead(regionOf(lb)) ? i : -1)).filter(i => i >= 0);
        if (deadIdx.length && liveIdx.length && dns.healthChecks) {
          const age = t - regionDown.at - DETECT_S;
          const moved = age <= 0 ? 0 : clamp(age / Math.max(1, dns.ttl), 0, 1);
          const deadShare = deadIdx.reduce((s, i) => s + weights[i], 0);
          const shift = deadShare * moved;
          const liveShare = liveIdx.reduce((s, i) => s + weights[i], 0) || 1;
          weights = weights.map((w, i) => (deadIdx.includes(i) ? w * (1 - moved) : w + shift * (w / liveShare || 1 / liveIdx.length)));
          if (moved < 1) note.push(`DNS is moving traffic off region 1: ${pct(moved)} of resolvers have the new answer (TTL ${dns.ttl} s after ${DETECT_S} s of failed health checks).`);
        } else if (deadIdx.length && !dns.healthChecks) note.push('DNS has no health checks, so it keeps handing out the dead region\'s address.');
      }
      ent.forEach((e, i) => routes.push({ lb: e.lb, share: weights[i], cdn: e.cdn, far: false }));
      // users near region 1 sent to a region-2 balancer pay the cross-region round trip, and vice versa
      if (dns && lbs.length > 1) for (const r of routes) {
        const near = regionOf(r.lb) === 1 ? client.share1 / 100 : 1 - client.share1 / 100;
        r.farShare = r.share > 0 ? clamp(1 - near / Math.max(r.share, 1e-9), 0, 1) : 0;
      }
    }
    const cdn = ent[0]?.cdn;
    const cdnServe = cdn ? readFrac * (client.cacheablePct / 100) * (cdn.hitPct / 100) : 0;

    // 3. load balancers -> app pools
    const lbState = {}, appState = {};
    for (const r of routes) {
      const lb = r.lb;
      const lam = offered * r.share * (1 - cdnServe);
      const ls = lbState[lb.id] ||= { lb, lambda: 0, dead: regionDead(regionOf(lb)), shed: 0, routes: [] };
      ls.lambda += lam;
      ls.routes.push(r);
    }
    for (const ls of Object.values(lbState)) {
      const lb = ls.lb;
      if (lb.rateLimit > 0 && ls.lambda > lb.rateLimit) ls.shed = 1 - lb.rateLimit / ls.lambda;
      const pools = outsOf(m, lb, 'app');
      const admitted = ls.lambda * (1 - ls.shed);
      const weights = pools.map(p => p.instances * appSize(p).vcpu);
      const wsum = weights.reduce((a, b) => a + b, 0) || 1;
      ls.pools = pools;
      pools.forEach((p, i) => {
        const as = appState[p.id] ||= { app: p, lambda: 0, lbs: [] };
        as.lambda += admitted * (weights[i] / wsum);
        as.lbs.push(lb);
      });
    }

    // 4. app pools: alive instances (zone loss, health checks, autoscaling), CPU stage, network card
    let appReadLoad = 0, appWriteLoad = 0;
    for (const as of Object.values(appState)) {
      const a = as.app, size = appSize(a);
      // autoscaling: new instances take BOOT_S to be ready
      if (a.autoscaleMax > a.instances) {
        const pend = S.pending[a.id] ||= [];
        const ready = pend.filter(p => p <= t).length;
        S.pending[a.id] = pend.filter(p => p > t);
        S.poolAlive[a.id] = Math.min(a.autoscaleMax, (S.poolAlive[a.id] ?? a.instances) + ready);
        const want = Math.ceil((as.lambda * a.cpuMs) / 1000 / size.vcpu / 0.6);
        const have = S.poolAlive[a.id] + S.pending[a.id].length;
        if (want > have) for (let i = 0; i < Math.min(want, a.autoscaleMax) - have; i++) S.pending[a.id].push(t + BOOT_S);
      } else S.poolAlive[a.id] = a.instances;
      const total = S.poolAlive[a.id];
      const deadFrac = regionDead(regionOf(a)) ? 1 : azFrac({ ...a, instances: total }, a.azs);
      const dead = Math.round(total * deadFrac);
      const alive = total - dead;
      const lb = as.lbs[0];
      // without health checks (or before they notice) the balancer still sends dead instances their share
      const noticed = lb?.healthChecks && azDown && t - azDown.at >= DETECT_S;
      as.deadShare = dead === 0 ? 0 : regionDead(regionOf(a)) ? 1 : (noticed ? 0 : dead / total);
      if (dead && !noticed && !regionDead(regionOf(a))) note.push(lb?.healthChecks ? `${lb.name} has not noticed the dead instances yet (health checks need ${DETECT_S} s).` : `${lb?.name || 'The load balancer'} has no health checks: ${dead} dead instance${dead === 1 ? '' : 's'} still get${dead === 1 ? 's' : ''} traffic.`);
      as.alive = alive; as.total = total; as.dead = dead;
      const lam = as.lambda * (1 - as.deadShare);
      const mu = 1000 / a.cpuMs;
      // a gray failure: one instance 10x slower; round robin still gives it 1/n, least-connections gives it less
      as.slowShare = 0;
      if (slowNode && alive > 1 && regionOf(a) === 1) {
        as.slowShare = lb?.algo === 'least-conn' ? 0.1 / (alive - 1 + 0.1) : 1 / alive;
        stage(st(a.id + ':slow'), lam * as.slowShare, size.vcpu, mu / 10, 2000, dt, { svcMs: a.cpuMs * 10 });
      } else S.stage[a.id + ':slow'] = undefined;
      const restC = (alive - (as.slowShare ? 1 : 0)) * size.vcpu;
      as.cpu = stage(st(a.id), lam * (1 - as.slowShare), restC, mu, 2000, dt, { shed: false, svcMs: a.cpuMs });
      // network card: response bytes, plus upload bytes when files go through the app
      const hasObj = outsOf(m, a, 'objstore').length > 0;
      const reads = lam * readFrac, writes = lam * (1 - readFrac);
      const upKB = (client.uploadPct / 100) * client.uploadKB;
      const bytesPerS = (reads * (hasObj && client.uploadKB > 0 ? 2 : client.respKB) + writes * (hasObj ? 1 : 1 + upKB)) * 1024;
      const bits = bytesPerS * 8;
      as.nic = alive > 0 ? bits / (alive * size.gbps * 1e9) : 0;
      as.served = Math.min(lam, as.cpu.cap) || 0;
      appReadLoad += as.served * readFrac;
      appWriteLoad += as.served * (1 - readFrac);
    }

    // 5. reads: near cache, cache cluster, then replicas or the primary
    const N = client.keys, s = client.skew;
    const readState = {};
    let dbReads = 0, replicaReads = 0, cacheOps = 0;
    for (const as of Object.values(appState)) {
      const a = as.app;
      const R = as.served * readFrac, W = as.served * (1 - readFrac);
      const rs = readState[a.id] = { near: 0, hit: 0, cache: null, replica: null, db: null };
      // a near cache lives in each instance, so it sees only that instance's share of the reads
      if (a.nearCache) rs.near = hitRate({ N, s, k: 10000, ttl: 5, R: R / Math.max(1, as.alive), W: W / Math.max(1, as.alive), hot: hotShare });
      const cacheB = outsOf(m, a, 'cache')[0];
      if (cacheB) {
        const cs = cacheSize(cacheB);
        const cacheDead = regionDead(regionOf(cacheB)) || (azDown && regionOf(cacheB) === 1 && cacheB.azs < 2);
        if (cacheDead) { S.cacheFilled[cacheB.id] = 0; rs.cacheDead = true; }
        const capKeys = Math.floor((cacheB.nodes * cs.mem * 0.8 * 1e6) / Math.max(0.1, client.objKB));
        const k2 = Math.min(capKeys, S.cacheFilled[cacheB.id], N);
        const full = cacheDead ? 0 : hitRate({ N, s, k: k2, ttl: cacheB.ttl, R, W, hot: hotShare });
        rs.hit = rs.near >= full ? 0 : (full - rs.near) / Math.max(1e-9, 1 - rs.near);
        rs.cache = cacheB; rs.capKeys = capKeys; rs.filled = S.cacheFilled[cacheB.id]; rs.full = full;
        cacheOps += cacheDead ? 0 : R * (1 - rs.near) + W;   // a read, or a delete on write
      }
      const missR = R * (1 - rs.near) * (1 - rs.hit);
      // single-flight: concurrent misses for the same key share one database query
      if (cacheB?.coalesce && missR > 0) {
        const coldFrom = Math.min(rs.capKeys ?? N, S.cacheFilled[cacheB.id]) + 1;
        rs.coalesce = coalescedFills(missR, N, s, coldFrom, 0.005);
      } else rs.coalesce = 1;
      rs.missR = missR;
      rs.dbReadR = missR * rs.coalesce;
      const reps = outsOf(m, a, 'replica').filter(r => !regionDead(regionOf(r)) && !S.promoted[r.id]);
      rs.replicas = reps;
      if (reps.length) replicaReads += rs.dbReadR; else if (outsOf(m, a, 'db').length) dbReads += rs.dbReadR;
    }

    // 6. writes: through a queue (async) or straight to the database
    let directWrites = 0, published = 0;
    const qState = {};
    for (const as of Object.values(appState)) {
      const a = as.app;
      const W = as.served * (1 - readFrac);
      const q = outsOf(m, a, 'queue')[0];
      if (q) { published += W; (qState[q.id] ||= { q, in: 0 }).in += W; as.async = true; } else if (outsOf(m, a, 'db').length) directWrites += W;
    }

    // 7. the database: shards, partitioning, hot keys, connections, standby failover, admission control
    // only a database something is cabled to takes part (an unplugged one is just a box in the rack)
    const db = dbs.find(d => m.wires.some(w => w.to === d.id)) || null;
    const dbState = { shards: [] };
    const anyBreaker = apps.some(a => a.breaker);
    const dbTimeout = Math.min(...apps.map(a => a.timeoutMs || 1000), 5000);
    if (db) {
      const sz = dbSize(db);
      const shards = Math.max(1, db.shards | 0);
      const slowF = slow ? slow.factor ?? 4 : 1;
      const readMs = COST.readMs * (db.indexed ? 1 : COST.scanFactor) * slowF + (outsOf(m, apps[0] || db, 'objstore').length || !client.uploadKB ? 0 : client.respKB * COST.blobReadPerKB);
      const hasObj = apps.some(a => outsOf(m, a, 'objstore').length);
      const upKB = (client.uploadPct / 100) * client.uploadKB;
      const writeMs = (COST.writeMs + (hasObj ? 0 : upKB * COST.blobWritePerKB)) * slowF;
      // which region holds the writable primary right now?
      const primaryDown = regionDead(regionOf(db)) || (azDown && regionOf(db) === 1 && !db.standby) || (azDown && db.standby && t - azDown.at < DB_FAILOVER_S && regionOf(db) === 1);
      const failingOver = azDown && db.standby && regionOf(db) === 1 && t - azDown.at < DB_FAILOVER_S;
      dbState.primaryDown = primaryDown; dbState.failingOver = failingOver;
      // a replica in another region may be promoted when the primary's region is gone
      let promoted = null;
      if (regionDown && regionDead(regionOf(db))) {
        for (const r of outsOf(m, db, 'replica')) if (!regionDead(regionOf(r)) && r.promote) {
          if (!S.promoted[r.id]) {
            S.promoted[r.id] = regionDown.at + PROMOTE_S;
            const lagS = S.lagSeconds?.[r.id] ?? 0.1;
            S.rpoSeconds = lagS; S.rpoWrites = Math.round((client.qps * (1 - readFrac)) * lagS);
          }
          if (t >= S.promoted[r.id]) promoted = r;
        }
      }
      dbState.promoted = promoted;
      // the connection limit: each app instance opens `pool` connections to every shard
      const conns = Object.values(appState).reduce((s2, as) => s2 + as.alive * (as.app.pool || 10), 0)
        + m.blocks.filter(b => b.kind === 'worker').reduce((s2, w) => s2 + w.instances * (w.pool || 5), 0);
      dbState.conns = conns; dbState.maxConn = sz.maxConn;
      dbState.connRefused = !db.pooler && conns > sz.maxConn ? 1 - sz.maxConn / conns : 0;
      if (dbState.connRefused) note.push(`${conns.toLocaleString('en-US')} connections wanted, max_connections is ${sz.maxConn}: ${pct(dbState.connRefused)} of instances cannot connect ("FATAL: sorry, too many clients already").`);
      // retries from the app multiply what reaches the database
      const retryAmp = e => {
        const r = Math.max(0, ...apps.map(a => a.retries | 0));
        if (!r || e <= 0) return 1;
        const jitter = apps.every(a => a.backoff === 'jitter');
        let amp = 0;
        for (let i = 0; i <= r; i++) amp += e ** i;
        return jitter ? Math.min(amp, 1.1) : amp;   // a retry budget caps retries at 10% of calls
      };
      dbState.readMs = readMs; dbState.writeMs = writeMs;
      // partition the load: hash spreads keys, range on time-ordered keys sends every new write to the last shard
      const writeShare = i => {
        if (db.partition === 'range' && client.writeKeys === 'time-ordered') return i === shards - 1 ? 1 : 0;
        const hotW = hotShare && !apps.some(a => a.saltHotKeys) ? hotShare : 0;
        return (1 - hotW) / shards + (i === 0 ? hotW : 0);
      };
      const readShare = i => {
        const hotR = 0;   // hot reads are absorbed by caches; uncached hot reads still spread by key
        return (1 - hotR) / shards;
      };
      dbState.writeShare = writeShare; dbState.shards = [];
      let e = S.stage[db.id + ':0']?.e || 0;
      // workers drain queues into the database with whatever capacity is left (they are a closed loop)
      const drains = {};
      for (let it = 0; it < 3; it++) {
        const amp = retryAmp(e);
        const dbR = (dbReads + (replicaReads && promoted ? 0 : 0)) * amp;
        const dbW = directWrites * amp;
        let worst = 0;
        for (let i = 0; i < shards; i++) {
          const writer = promoted ? promoted : db;
          const cores = promoted ? (SIZES.db[promoted.size] || sz).vcpu : sz.vcpu;
          const mu = 1000 / ((dbR * readShare(i) * readMs + dbW * writeShare(i) * writeMs) / Math.max(1e-9, dbR * readShare(i) + dbW * writeShare(i)) || COST.writeMs);
          const lam = dbR * readShare(i) + dbW * writeShare(i);
          const id = `${writer.id}:${i}`;
          const down = (primaryDown && !promoted);
          const sst = down ? { mode: 'dead', e: 1, util: 0, lambda: lam, cap: 0 } : stage(st(id), lam, cores, mu, dbTimeout, it === 2 ? dt : 0, { shed: anyBreaker, svcMs: 1000 / mu });
          if (down) S.stage[id] = sst;
          sst.readMs = readMs; sst.writeMs = writeMs;
          dbState.shards[i] = sst;
          worst = Math.max(worst, sst.e);
        }
        e = worst;
      }
      // queue drain: workers write in batches; a batch of b messages costs about one commit plus b small inserts
      for (const qs of Object.values(qState)) {
        const q = qs.q;
        const workers = outsOf(m, q, 'worker');
        const w = workers[0];
        const parts = Math.max(1, q.partitions | 0);
        const pubCap = parts * PARTITION_RATE;
        qs.throttled = qs.in > pubCap ? 1 - pubCap / qs.in : 0;
        const accepted = qs.in * (1 - qs.throttled);
        const backlog = S.qBacklog[q.id] || 0;
        let out = 0;
        qs.consumers = 0;
        if (w && outsOf(m, w, 'db').length && !(primaryDown && !promoted)) {
          const ws = appSize(w);
          const consumers = Math.min(w.instances, parts);
          qs.consumers = consumers; qs.idle = Math.max(0, w.instances - parts);
          const workerCap = consumers * ws.vcpu * (1000 / w.cpuMs);
          const perMsgMs = writeMs * (0.3 + 0.7 / Math.max(1, w.batch));
          // database capacity left after the app's own traffic, keeping 15% headroom (workers back off when it is busy)
          let dbLeft = 0;
          for (let i = 0; i < shards; i++) {
            const sh = dbState.shards[i];
            if (!sh || sh.mode === 'dead') continue;
            const used = sh.lambda / Math.max(1e-9, sh.mu);
            dbLeft += Math.max(0, sz.vcpu * 0.85 - used) / Math.max(1e-9, writeShare(i) * shards || 1) / shards;
          }
          const dbCapMsgs = (dbLeft * 1000) / perMsgMs;
          out = Math.min(backlog / dt + accepted, workerCap, dbCapMsgs);
          qs.workerCap = workerCap; qs.dbCapMsgs = dbCapMsgs; qs.perMsgMs = perMsgMs;
          // add the workers' writes to the shards' utilisation
          for (let i = 0; i < shards; i++) {
            const sh = dbState.shards[i];
            if (!sh || sh.mode === 'dead') continue;
            const extraCores = (out * writeShare(i) * perMsgMs) / 1000;
            sh.util = (sh.lambda / sh.mu + extraCores) / sz.vcpu;
            sh.workerMsgs = out * writeShare(i);
          }
        }
        S.qBacklog[q.id] = Math.max(0, backlog + (accepted - out) * dt);
        qs.out = out; qs.backlog = S.qBacklog[q.id];
        qs.lagS = qs.backlog > 0 ? qs.backlog / Math.max(1, out) : 0;
        drains[q.id] = qs;
      }
      dbState.drains = drains;
      dbState.retryAmp = retryAmp(e);
      // replicas: read load per replica and replication lag (replay is single-threaded)
      dbState.replicas = {};
      const reps = outsOf(m, db, 'replica');
      for (const r of reps) {
        const rsz = SIZES.db[r.size] || sz;
        const count = Math.max(1, r.count | 0);
        const lamPer = (replicaReads / shards / count) / Math.max(1, reps.length);
        const dead = regionDead(regionOf(r)) || !!S.promoted[r.id] && t >= S.promoted[r.id];
        const rst = dead ? { mode: 'dead', e: 1, util: 0 } : stage(st(r.id), lamPer, rsz.vcpu, 1000 / (COST.readMs * (db.indexed ? 1 : COST.scanFactor)), dbTimeout, dt, { shed: anyBreaker });
        if (dead) S.stage[r.id] = rst;
        const writesPerShard = (directWrites + Object.values(drains).reduce((s2, q) => s2 + q.out, 0)) / shards * Math.max(...Array.from({ length: shards }, (_, i) => writeShare(i) * shards));
        const applyCap = (1000 / (COST.writeMs * COST.applyFactor)) * (rst.util > 0.9 ? Math.max(0.1, (1 - rst.util) / 0.1) : 1);
        const baseLag = regionOf(r) !== regionOf(db) ? 0.1 + NET.crossRegion / 1000 : 0.02;
        S.lag[r.id] = Math.max(0, (S.lag[r.id] || 0) + (primaryDown ? 0 : (writesPerShard - applyCap) * dt));
        const lagS = baseLag + (S.lag[r.id] || 0) / applyCap;
        (S.lagSeconds ||= {})[r.id] = lagS;
        dbState.replicas[r.id] = { st: rst, lagS, applyCap, writesPerShard, count, lamPer };
      }
    }

    // 8. cache cluster load: per node, with the hottest key on one node
    const cacheState = {};
    for (const c of caches) {
      const cs = cacheSize(c);
      const nodes = Math.max(1, c.nodes);
      const ops = cacheOps;
      const top = hotShare > 0 ? hotShare + (1 - hotShare) * (1 / Math.max(1, zipf(N, s).reduce((a, b) => a + b.w, 0))) : coverage(N, s, 1);
      // with a near cache the hottest keys never reach the cluster
      const hotOps = apps.some(a => a.nearCache) ? 0 : ops * top;
      const rest = (ops - hotOps) / nodes;
      const dead = regionDead(regionOf(c)) || (azDown && regionOf(c) === 1 && c.azs < 2);
      const hotNode = dead ? { mode: 'dead', e: 1, util: 0 } : stage(st(c.id + ':hot'), rest + hotOps, 1, cs.ops, 50, dt, { svcMs: 1000 / cs.ops });
      const avgNode = dead ? { mode: 'dead', e: 1, util: 0 } : stage(st(c.id), rest, 1, cs.ops, 50, dt, { svcMs: 1000 / cs.ops });
      cacheState[c.id] = { hotNode, avgNode, hotOps, top, ops, dead };
    }

    // 9. warm-up: a cache refills by one key per successful database read
    for (const as of Object.values(appState)) {
      const rs = readState[as.app.id];
      if (!rs?.cache || rs.cacheDead) continue;
      if (S.cacheFilled[rs.cache.id] === Infinity) continue;
      const target = dbState.shards.length ? 1 - Math.max(...dbState.shards.map(x => x.e || 0)) : 1;
      const fetched = rs.missR * target * dt;
      S.cacheFilled[rs.cache.id] = Math.min(rs.capKeys, S.cacheFilled[rs.cache.id] + distinctKeys(fetched, N, s));
      if (S.cacheFilled[rs.cache.id] >= Math.min(rs.capKeys, N) * 0.999) S.cacheFilled[rs.cache.id] = Infinity;
    }

    // 10. sample requests through the path
    const nSamp = 160;
    let fails = 0, done = 0, shedCount = 0;
    const tickSamples = [];
    const why = {};
    const lbList = Object.values(lbState);
    const pickRoute = () => {
      let x = rng(), acc = 0;
      for (const r of routes) { acc += r.share; if (x < acc) return r; }
      return routes[routes.length - 1];
    };
    for (let i = 0; i < nSamp; i++) {
      const isRead = rng() < readFrac;
      const add = (label, ms) => { contrib[label] = (contrib[label] || 0) + ms; };
      let lat = 0, fail = null;
      const r = routes.length ? pickRoute() : null;
      if (!r) { fail = 'unwired'; lat = 0; }
      else if (isRead && cdn && rng() < cdnServe / Math.max(1e-9, readFrac)) {
        lat = NET.edge + 2 * rng(); add('CDN edge', lat);
      } else {
        const ls = lbState[r.lb.id];
        lat = client.rttMs + (r.farShare && rng() < r.farShare ? NET.crossRegion : 0);
        add('user ↔ region', lat);
        if (ls.dead) { fail = 'region'; lat += NET.clientTimeout - lat; }
        else if (ls.shed && rng() < ls.shed) { fail = 'shed'; lat += 1; }
        else {
          lat += NET.lb + (r.lb.layer === 'L7' ? NET.l7 : 0);
          const pool = ls.pools?.length ? ls.pools[Math.floor(rng() * ls.pools.length)] : null;
          const as = pool && appState[pool.id];
          if (!as) fail = 'nobackend';
          else if (as.deadShare && rng() < as.deadShare) { fail = as.alive === 0 ? 'nobackend' : 'deadinstance'; lat += 3; }
          else {
            const slowSt = as.slowShare && rng() < as.slowShare ? S.stage[as.app.id + ':slow'] : null;
            const p = pass(slowSt || as.cpu, rng, 2000);
            lat += p.lat; add('app CPU', p.lat);
            if (p.fail) fail = p.fail === 'timeout' ? 'appoverload' : p.fail === 'down' ? 'nobackend' : p.fail;
            if (!fail && as.nic > 1 && rng() < 1 - 1 / as.nic) { fail = 'nic'; lat += 3000; }
            else if (!fail && as.nic > 0.8) { const x = 2 * (as.nic - 0.8) / Math.max(0.05, 1 - Math.min(as.nic, 0.99)); lat += x; add('network card', x); }
            const a = as.app;
            const dbCall = () => {
              // one database call with the app's timeout and retries
              const tries = 1 + (a.retries | 0);
              let total = 0;
              for (let tr = 0; tr < tries; tr++) {
                if (tr > 0) total += a.backoff === 'jitter' ? 100 * rng() * 2 ** (tr - 1) : 0;
                let res;
                if (dbState.connRefused && rng() < dbState.connRefused) res = { lat: 2, fail: 'conns' };
                else if (!db || !m.wires.some(w => w.from === a.id && w.to === db.id)) res = { lat: 0, fail: 'nodb' };
                else if (dbState.primaryDown && !dbState.promoted) res = { lat: 3, fail: dbState.failingOver ? 'failover' : 'dbdown' };
                else {
                  const shard = isRead ? Math.floor(rng() * dbState.shards.length) : pickShard(dbState, rng);
                  const sh = dbState.shards[shard];
                  res = pass(sh, rng, a.timeoutMs);
                  if (res.fail === 'shed') res.fail = 'dbshed';
                  else if (res.fail) res.fail = 'dbtimeout';
                  res.lat += NET.hop + (!isRead && db.standby ? NET.standbyCommit : 0) + (regionOf(dbState.promoted || db) !== regionOf(a) ? NET.crossRegion : 0);
                  if (!res.fail && res.lat > a.timeoutMs) res = { lat: a.timeoutMs, fail: 'dbtimeout' };
                }
                total += res.lat;
                if (!res.fail) return { lat: total, fail: null };
                if (tr === tries - 1) return { lat: total, fail: res.fail };
              }
              return { lat: total, fail: 'dbtimeout' };
            };
            if (!fail && isRead) {
              const rs = readState[a.id];
              if (rs.near && rng() < rs.near) { lat += NET.cacheOp; add('near cache', NET.cacheOp); }
              else {
                let hit = false;
                if (rs.cache) {
                  const cst = cacheState[rs.cache.id];
                  const node = rng() < cst.top ? cst.hotNode : cst.avgNode;
                  const p2 = rs.cacheDead ? { lat: 1, fail: 'cachedown' } : pass(node, rng, 50);
                  lat += p2.lat + NET.hop; add('cache', p2.lat + NET.hop);
                  if (!p2.fail && rng() < rs.hit) hit = true;
                }
                if (!hit) {
                  const reps = rs.replicas;
                  if (reps?.length && dbState.replicas?.[reps[0].id]) {
                    const rep = dbState.replicas[reps[0].id];
                    const p3 = pass(rep.st, rng, a.timeoutMs);
                    const extra = NET.hop + (regionOf(reps[0]) !== regionOf(a) ? NET.crossRegion : 0);
                    lat += p3.lat + extra; add('replica', p3.lat + extra);
                    if (p3.fail) fail = p3.fail === 'down' ? 'replicadown' : 'dbtimeout';
                  } else {
                    // coalesced misses wait for the in-flight fill instead of querying
                    const d = dbCall();
                    lat += d.lat; add('database', d.lat);
                    fail = d.fail;
                  }
                }
              }
            } else if (!fail) {
              const q = outsOf(m, a, 'queue')[0];
              if (q) {
                const qs = dbState.drains?.[q.id] || { throttled: 0 };
                if (qs.throttled && rng() < qs.throttled) { fail = 'throttled'; lat += 5; }
                else { lat += NET.publish + NET.hop; add('queue publish', NET.publish + NET.hop); }
              } else {
                const d = dbCall();
                lat += d.lat; add('database', d.lat);
                fail = d.fail;
              }
            }
          }
        }
      }
      if (!fail && lat > NET.clientTimeout) { fail = 'clienttimeout'; lat = NET.clientTimeout; }
      done++;
      if (fail) { fails++; why[fail] = (why[fail] || 0) + 1; if (fail === 'shed' || fail === 'dbshed') shedCount++; }
      tickSamples.push({ t, lat, fail, read: isRead });
    }
    const e = fails / Math.max(1, done);
    S.prevErr = e;
    samples.push(...tickSamples);
    const okLat = tickSamples.filter(x => !x.fail).map(x => x.lat).sort((a, b) => a - b);
    const q = p => (okLat.length ? okLat[Math.min(okLat.length - 1, Math.ceil(p * okLat.length) - 1)] : 0);

    // what the user experienced: with client retries, a user request fails only if every attempt failed
    const userFail = storm ? e ** 4 : e;
    const util = {};
    for (const as of Object.values(appState)) { util[as.app.id] = as.cpu.util; util[as.app.id + ':nic'] = as.nic; }
    for (const [id, cst] of Object.entries(cacheState)) util[id] = cst.hotNode.util;
    if (db) util[(dbState.promoted || db).id] = Math.max(0, ...dbState.shards.map(x => x?.util || 0));
    for (const [id, r] of Object.entries(dbState.replicas || {})) util[id] = r.st.util || 0;
    for (const qs of Object.values(dbState.drains || {})) {
      const w = outsOf(m, qs.q, 'worker')[0];
      if (w) util[w.id] = qs.workerCap ? qs.out / qs.workerCap : 0;
      util[qs.q.id] = qs.in / Math.max(1, (qs.q.partitions | 0) * PARTITION_RATE);
    }
    const hitNow = (() => {
      const all = Object.values(readState);
      if (!all.length) return null;
      const rs = all[0];
      return rs.cache || rs.near ? rs.near + (1 - rs.near) * rs.hit : null;
    })();
    ticks.push({
      t, offered: base, attempts: offered, clientAmp, err: e, userErr: userFail, shed: shedCount / Math.max(1, done), why,
      p50: q(0.5), p95: q(0.95), p99: q(0.99), util, hit: hitNow, cdnServe,
      lag: Object.fromEntries(Object.entries(dbState.replicas || {}).map(([id, r]) => [id, r.lagS])),
      queue: Object.fromEntries(Object.values(dbState.drains || {}).map(qs => [qs.q.id, { backlog: qs.backlog, lagS: qs.lagS, out: qs.out, in: qs.in, consumers: qs.consumers, idle: qs.idle, throttled: qs.throttled }])),
      alive: Object.fromEntries(Object.values(appState).map(as => [as.app.id, as.alive])),
      dbMode: db ? (dbState.primaryDown && !dbState.promoted ? (dbState.failingOver ? 'failover' : 'down') : dbState.shards.map(x => x.mode).sort().pop()) : null,
      shardUtil: db ? dbState.shards.map(x => x?.util || 0) : [],
      conns: dbState.conns, maxConn: dbState.maxConn, connRefused: dbState.connRefused || 0,
      retryAmp: dbState.retryAmp || 1, appState: Object.fromEntries(Object.values(appState).map(as => [as.app.id, { util: as.cpu.util, mode: as.cpu.mode, nic: as.nic, deadShare: as.deadShare, alive: as.alive, total: as.total, slowShare: as.slowShare, waitMs: as.cpu.waitMs }])),
      dbShards: db ? dbState.shards.map(x => ({ util: x.util, mode: x.mode, waitMs: x.waitMs, lambda: x.lambda, cap: x.cap, e: x.e })) : [],
      cache: Object.fromEntries(Object.entries(cacheState).map(([id, c]) => [id, { hotUtil: c.hotNode.util, avgUtil: c.avgNode.util, top: c.top, ops: c.ops, dead: c.dead }])),
      read: Object.fromEntries(Object.entries(readState).map(([id, r]) => [id, { near: r.near, hit: r.hit, full: r.full, filled: r.filled, capKeys: r.capKeys, coalesce: r.coalesce, missR: r.missR, dbReadR: r.dbReadR }])),
      note,
    });
  }

  const R = { ticks, samples, contrib, rpo: { seconds: S.rpoSeconds, writes: S.rpoWrites }, scenario: sc, seed };
  R.cost = costOf(m);
  R.est = estimates(m);
  R.windows = windows(R);
  return R;
}

function pickShard(dbState, rng) {
  const n = dbState.shards.length;
  let x = rng(), acc = 0;
  for (let i = 0; i < n; i++) { acc += dbState.writeShare(i); if (x < acc) return i; }
  return n - 1;
}

// ---------------------------------------------------------------- windows, cost and estimates

/** Summaries for the whole run and for before / during / after the first incident. */
export function windows(R) {
  const inc = (R.scenario.incidents || [])[0];
  const end = R.scenario.duration;
  const spans = { all: [0, end] };
  if (inc) { spans.before = [0, inc.at]; spans.during = [inc.at, inc.until ?? end]; if ((inc.until ?? end) < end) spans.after = [inc.until, end]; }
  const out = {};
  for (const [name, [a, b]] of Object.entries(spans)) {
    const ts = R.ticks.filter(x => x.t >= a && x.t < b);
    const ss = R.samples.filter(x => x.t >= a && x.t < b);
    const ok = ss.filter(x => !x.fail).map(x => x.lat).sort((p, q) => p - q);
    const q = p => (ok.length ? ok[Math.min(ok.length - 1, Math.ceil(p * ok.length) - 1)] : 0);
    const demand = ts.reduce((s, x) => s + x.offered, 0) || 1;
    const avail = 1 - ts.reduce((s, x) => s + x.offered * x.userErr, 0) / demand;
    const maxUtil = {};
    for (const x of ts) for (const [id, u] of Object.entries(x.util)) maxUtil[id] = Math.max(maxUtil[id] || 0, u);
    const maxLag = Math.max(0, ...ts.flatMap(x => Object.values(x.lag)));
    out[name] = { from: a, to: b, p50: q(0.5), p95: q(0.95), p99: q(0.99), avail, errRate: ss.length ? ss.filter(x => x.fail).length / ss.length : 0, maxUtil, maxLag, n: ss.length };
  }
  return out;
}

/** Monthly bill, line by line. */
export function costOf(m) {
  const client = m.blocks.find(b => b.kind === 'client') || block('client', 'x', 'x');
  const lines = [];
  const add = (b, what, usd) => { if (usd > 0) lines.push({ id: b?.id, name: b?.name || what, what, usd }); };
  const reads = client.qps * AVG * (client.readPct / 100), writes = client.qps * AVG * (1 - client.readPct / 100);
  const yearGB = (writes * client.rowKB * YEAR_S) / 1e6;
  const hasObj = m.blocks.some(b => b.kind === 'objstore') && m.wires.some(w => byId(m, w.to)?.kind === 'objstore');
  const upKB = (client.uploadPct / 100) * client.uploadKB;
  const blobYearGB = (writes * upKB * YEAR_S) / 1e6;
  for (const b of m.blocks) {
    if (b.kind === 'app' || b.kind === 'worker') add(b, `${b.instances} × ${b.size} (${appSize(b).vcpu} vCPU)`, b.instances * appSize(b).usd);
    if (b.kind === 'cache') add(b, `${b.nodes} × ${b.size} node${b.nodes === 1 ? '' : 's'}${b.azs > 1 ? ' + a replica each in another AZ' : ''}`, b.nodes * cacheSize(b).usd * (b.azs > 1 ? 2 : 1));
    if (b.kind === 'db') {
      const copies = b.standby ? 2 : 1;
      const storeGB = yearGB + (hasObj ? 0 : blobYearGB);
      add(b, `${b.shards} shard${b.shards === 1 ? '' : 's'} × ${b.size}${b.standby ? ' + standby' : ''}`, b.shards * dbSize(b).usd * copies);
      add(b, `storage ${fmt(storeGB * copies)} GB after a year`, storeGB * copies * PRICES.dbStorageGB);
    }
    if (b.kind === 'replica') {
      const db = ins(m, b).find(x => x.kind === 'db');
      const shards = db?.shards || 1;
      add(b, `${b.count} × ${shards} shard${shards === 1 ? '' : 's'} × ${b.size}`, b.count * shards * (SIZES.db[b.size] || SIZES.db.L).usd + b.count * (yearGB + (hasObj ? 0 : blobYearGB)) * PRICES.dbStorageGB);
    }
    if (b.kind === 'lb') add(b, 'base + capacity units', PRICES.lbBase + PRICES.lbPer1kRps * Math.ceil(client.qps / 1000));
    if (b.kind === 'dns') add(b, 'hosted zone + queries', PRICES.dns);
    if (b.kind === 'queue') add(b, `${b.partitions} partitions`, b.partitions * PRICES.partition);
    if (b.kind === 'objstore') add(b, `${fmt(blobYearGB)} GB stored after a year + requests`, blobYearGB * PRICES.objGBMonth + (writes * MONTH_S / 1e6) * PRICES.objPutPerM * (client.uploadPct / 100) + (reads * MONTH_S / 1e6) * PRICES.objGetPerM * (client.cacheablePct / 100) * 0.1);
  }
  const cdnB = m.blocks.find(b => b.kind === 'cdn' && m.wires.some(w => w.to === b.id));
  const edgeShare = cdnB ? (client.cacheablePct / 100) * (cdnB.hitPct / 100) : 0;
  const readGB = (reads * client.respKB * MONTH_S) / 1e6;
  if (cdnB) add(cdnB, `${fmt(readGB * edgeShare / 1000)} TB a month from the edge`, readGB * edgeShare * PRICES.cdnGB);
  add({ id: 'egress', name: 'Data transfer out' }, `${fmt(readGB * (1 - edgeShare) / 1000)} TB a month from the origin`, readGB * (1 - edgeShare) * PRICES.egressGB);
  const total = lines.reduce((s, l) => s + l.usd, 0);
  return { lines, total: Math.round(total) };
}

/** Back-of-the-envelope numbers for the traffic as configured. */
export function estimates(m) {
  const c = m.blocks.find(b => b.kind === 'client');
  if (!c) return null;
  const reads = c.qps * (c.readPct / 100), writes = c.qps - reads;
  const app = m.blocks.find(b => b.kind === 'app');
  const cpuMs = app?.cpuMs || 8;
  const upKB = (c.uploadPct / 100) * c.uploadKB;
  return {
    peak: c.qps, avg: c.qps * AVG, reads, writes,
    outMbps: (reads * c.respKB * 8) / 1000, inMbps: (writes * (1 + upKB) * 8) / 1000,
    rowsPerDay: writes * AVG * 86400, gbPerYear: (writes * AVG * c.rowKB * YEAR_S) / 1e6, blobTbPerYear: (writes * AVG * upKB * YEAR_S) / 1e9,
    coresAt100: (c.qps * cpuMs) / 1000, coresAt60: (c.qps * cpuMs) / 600,
    workingSetGB: (c.keys * c.objKB) / 1e6,
    top1pct: coverage(c.keys, c.skew, Math.max(1, Math.round(c.keys / 100))),
  };
}

// ---------------------------------------------------------------- explanations

const FAIL_TEXT = {
  shed: 'rejected by the load balancer\'s rate limit (429)', deadinstance: 'sent to a dead instance (502)', nobackend: 'no healthy backend (503)',
  appoverload: 'timed out waiting for an app server (the CPU backlog is longer than the timeout)', nic: 'timed out on a saturated network card',
  conns: 'refused a database connection (too many clients)', dbdown: 'database down', failover: 'database failing over to its standby',
  dbtimeout: 'database call timed out', dbshed: 'failed fast: the database\'s breaker shed it (503)', replicadown: 'replica down',
  throttled: 'queue publish throttled (partitions full)', region: 'sent to the dead region (DNS still points there)', clienttimeout: 'took longer than the client\'s 5 s timeout',
  cachedown: 'cache down', nodb: 'nothing to store the data in', unwired: 'Users are not wired',
};
export const failText = k => FAIL_TEXT[k] || k;

/** Plain-English findings about a run, worst first: [{ tone: 'bad'|'warn'|'ok', text }]. */
export function explain(m, R, win = 'all') {
  if (R.error) return [{ tone: 'bad', text: R.error }];
  const out = [];
  const w = R.windows[win] || R.windows.all;
  const ts = R.ticks.filter(x => x.t >= w.from && x.t < w.to);
  if (!ts.length) return out;
  const peak = (f) => ts.reduce((best, x) => (f(x) > f(best) ? x : best), ts[0]);
  const name = id => byId(m, id)?.name || id;
  // biggest failure reasons
  const reasons = {};
  for (const x of ts) for (const [k, n] of Object.entries(x.why)) reasons[k] = (reasons[k] || 0) + n;
  const totalFails = Object.values(reasons).reduce((a, b) => a + b, 0);
  if (totalFails) {
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push({ tone: 'bad', text: `${pct(w.errRate)} of requests failed. Mostly: ${top.map(([k, n]) => `${failText(k)} (${Math.round((n / totalFails) * 100)}%)`).join('; ')}.` });
  }
  // hottest component and what its utilisation means for waiting time
  const app = m.blocks.filter(b => b.kind === 'app');
  for (const a of app) {
    const x = peak(t => t.appState[a.id]?.util || 0);
    const as = x.appState[a.id];
    if (!as) continue;
    const u = as.util;
    const c = as.alive * appSize(a).vcpu;
    if (u >= 1) out.push({ tone: 'bad', text: `${a.name} is overloaded at ${fmtTime(x.t)}: it needs ${fmt((u * c))} cores of CPU (${fmtQps(x.offered)} requests/s × ${a.cpuMs} ms) but has ${c}. Requests queue until they time out.` });
    else if (u >= 0.8 && as.waitMs >= a.cpuMs * 0.25) out.push({ tone: 'warn', text: `${a.name} peaks at ${pct(u)} CPU (${as.alive} instance${as.alive === 1 ? '' : 's'}, ${c} cores). Near the knee: an M/M/${c} queue at this load waits ${fmt(as.waitMs)} ms on average before a request even starts, and the p99 wait is several times that.` });
    else if (u >= 0.8) out.push({ tone: 'warn', text: `${a.name} peaks at ${pct(u)} CPU on ${c} cores. With that many cores the queue is still short (an average wait of ${fmt(as.waitMs)} ms), but there is little headroom left: a spike or one more lost instance pushes it over the knee.` });
    else out.push({ tone: 'ok', text: `${a.name} peaks at ${pct(u)} CPU on ${c} cores: comfortable headroom.` });
    if (as.nic > 0.7) out.push({ tone: as.nic > 1 ? 'bad' : 'warn', text: `${a.name}'s network cards peak at ${pct(as.nic)}: bytes, not CPU, are the limit. Large files should go straight to object storage with a presigned URL, and be served by the CDN.` });
    if (x.appState[a.id].deadShare > 0 && x.appState[a.id].alive > 0) out.push({ tone: 'bad', text: `${pct(x.appState[a.id].deadShare)} of ${a.name}'s traffic still went to dead instances at ${fmtTime(x.t)}.` });
  }
  const db = m.blocks.find(b => b.kind === 'db');
  if (db) {
    const x = peak(t => Math.max(0, ...t.dbShards.map(s => s.util)));
    const worst = x.dbShards.reduce((bi, s, i, arr) => (s.util > arr[bi].util ? i : bi), 0);
    const sh = x.dbShards[worst];
    if (sh) {
      const u = sh.util;
      const where = db.shards > 1 ? ` (shard ${worst + 1} of ${db.shards})` : '';
      const spread = db.shards > 1 ? x.dbShards.map(s => pct(s.util)).join(' / ') : '';
      if (x.dbMode === 'down' || x.dbMode === 'failover') out.push({ tone: 'bad', text: `${db.name} was ${x.dbMode === 'failover' ? 'failing over to its standby (about 30 s of errors)' : 'down'} at ${fmtTime(x.t)}.` });
      else if (u >= 1) out.push({ tone: 'bad', text: `${db.name}${where} hits ${pct(u)} utilisation at ${fmtTime(x.t)}: ${fmtQps(sh.lambda)} queries/s against a capacity of ${fmtQps(sh.cap)}/s. Work queues up, and once the wait passes the app's timeout every query in the line fails${R.ticks.some(t => t.retryAmp > 1.15) ? ', and retries add more load' : ''}.${spread ? ` Shards: ${spread}.` : ''}` });
      else if (u >= 0.75) out.push({ tone: 'warn', text: `${db.name}${where} peaks at ${pct(u)} utilisation. An M/M/${dbSize(db).vcpu} queue at that load waits about ${fmt(sh.waitMs)} ms on average, and the tail is far longer.${spread ? ` Shards: ${spread}.` : ''}` });
      else out.push({ tone: 'ok', text: `${db.name}${where} peaks at ${pct(u)} utilisation.${spread ? ` Shards: ${spread}.` : ''}` });
      if (!db.indexed) out.push({ tone: 'bad', text: `The query plan is a sequential scan: every read costs about ${COST.scanFactor}× an indexed lookup (${fmt(COST.readMs * COST.scanFactor)} ms of CPU instead of ${COST.readMs} ms).` });
      if (db.shards > 1) {
        const us = x.dbShards.map(s => s.util);
        const mx = Math.max(...us), avg = us.reduce((a, b) => a + b, 0) / us.length;
        if (mx > avg * 1.8) out.push({ tone: 'bad', text: `The shards are badly unbalanced: the busiest is at ${pct(mx)} while the average is ${pct(avg)}. ${db.partition === 'range' && byId(m, 'users')?.writeKeys === 'time-ordered' ? 'Range partitioning on time-ordered ids sends every new row to the last shard.' : 'One hot key lands on one shard.'}` });
      }
    }
    const xc = peak(t => t.connRefused);
    if (xc.connRefused > 0) out.push({ tone: 'bad', text: `Connections: ${xc.conns.toLocaleString('en-US')} wanted (instances × pool size), max_connections is ${xc.maxConn}. ${pct(xc.connRefused)} of instances get "FATAL: sorry, too many clients already". A pooler (transaction mode) or smaller pools fix it.` });
    else if (ts[0].conns) out.push({ tone: 'ok', text: `Connections: ${ts[0].conns.toLocaleString('en-US')} of ${ts[0].maxConn} allowed${db.pooler ? ' (through a pooler, so the server sees far fewer)' : ''}.` });
  }
  for (const c of m.blocks.filter(b => b.kind === 'cache')) {
    const x0 = ts[0], xr = Object.values(x0.read)[0];
    const xh = peak(t => t.cache[c.id]?.hotUtil || 0);
    const ch = xh.cache[c.id];
    if (xr && xr.capKeys != null) {
      const cl = byId(m, 'users') || m.blocks.find(b => b.kind === 'client');
      const fits = Math.min(1, xr.capKeys / cl.keys);
      out.push({ tone: 'ok', text: `${c.name} holds ${fmt(fits * 100)}% of the ${fmtQps(cl.keys)} keys (${c.nodes} × ${cacheSize(c).mem} GB). With Zipf skew ${cl.skew}, those keys take ${pct(coverage(cl.keys, cl.skew, xr.capKeys))} of reads, so the steady hit rate is about ${pct(xr.full ?? 0)} after TTL expiries and writes.` });
    }
    const minHit = Math.min(...ts.map(t => t.hit ?? 1));
    if (minHit < 0.5 && (ts.find(t => t.hit === minHit)?.hit ?? 1) < (ts[0].hit ?? 0)) out.push({ tone: 'bad', text: `The cache hit rate fell to ${pct(minHit)} at ${fmtTime(ts.find(t => t.hit === minHit).t)}: every miss became a database read.` });
    if (ch && ch.hotUtil >= 0.8) out.push({ tone: ch.hotUtil >= 1 ? 'bad' : 'warn', text: `One cache node is at ${pct(ch.hotUtil)} at ${fmtTime(xh.t)}: the hottest key alone takes ${pct(ch.top)} of cache traffic, and a key lives on exactly one node, so adding nodes does not spread it. A near cache in the app servers absorbs it.` });
  }
  for (const r of m.blocks.filter(b => b.kind === 'replica')) {
    const x = peak(t => t.lag[r.id] || 0);
    const lag = x.lag[r.id];
    if (lag != null) out.push({ tone: lag > 1 ? 'bad' : lag > 0.3 ? 'warn' : 'ok', text: `${r.name}: replication lag peaks at ${lag >= 1 ? fmt(lag) + ' s' : Math.round(lag * 1000) + ' ms'}${lag > 1 ? ' and growing: replay is single-threaded and the write rate per shard is above what one replica can apply' : ''}. A user who reads right after writing may not see their own write unless that read goes to the primary.` });
  }
  for (const q of m.blocks.filter(b => b.kind === 'queue')) {
    const x = peak(t => t.queue[q.id]?.backlog || 0);
    const qs = x.queue[q.id];
    if (!qs) continue;
    const last = ts[ts.length - 1].queue[q.id];
    out.push({ tone: last.backlog > 1000 ? 'bad' : qs.backlog > 0 ? 'warn' : 'ok', text: `${q.name}: backlog peaks at ${fmtQps(qs.backlog)} messages (${fmt(qs.lagS)} s behind) at ${fmtTime(x.t)}${last.backlog > 1000 ? `, and ends at ${fmtQps(last.backlog)}` : ', then drains'}.${qs.idle ? ` ${qs.idle} worker${qs.idle === 1 ? ' is' : 's are'} idle: a partition is read by one consumer of the group, so workers beyond the partition count do nothing.` : ''}${qs.throttled ? ` ${pct(qs.throttled)} of publishes were throttled: ${q.partitions} partitions take ${fmtQps(q.partitions * PARTITION_RATE)} messages/s.` : ''}` });
  }
  const amp = Math.max(...ts.map(t => t.clientAmp));
  if (amp > 1.3) out.push({ tone: 'bad', text: `Client retries multiplied the load by up to ${fmt(amp)}× (${fmtQps(Math.max(...ts.map(t => t.attempts)))} attempts/s for ${fmtQps(ts[0].offered)} real requests). Every failure comes back three more times, so an overloaded system stays overloaded after its trigger is gone.` });
  const ra = Math.max(...ts.map(t => t.retryAmp));
  if (ra > 1.15) out.push({ tone: 'warn', text: `App-level retries multiplied database calls by ${fmt(ra)}×. Retry with backoff and jitter under a budget instead.` });
  if (R.rpo?.seconds > 0 && win !== 'before') out.push({ tone: R.rpo.seconds > 5 ? 'bad' : 'warn', text: `Failover promoted a replica that was ${fmt(R.rpo.seconds)} s behind: about ${R.rpo.writes.toLocaleString('en-US')} writes acknowledged in region 1 never reached it (RPO ${fmt(R.rpo.seconds)} s).` });
  const notes = [...new Set(ts.flatMap(t => t.note))].slice(0, 3);
  for (const n of notes) out.push({ tone: 'warn', text: n });
  // where the time went
  const totalMs = Object.values(R.contrib).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(R.contrib).sort((a, b) => b[1] - a[1]).slice(0, 4);
  out.push({ tone: 'ok', text: `Where the time goes (all requests): ${top.map(([k, v]) => `${k} ${Math.round((v / totalMs) * 100)}%`).join(', ')}.` });
  const order = { bad: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

export const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- goals and challenges

/** Goal checkers. Each returns { label, ok, why, value }. */
const G = {
  p99: (ms, win = 'all') => (R, m) => {
    const w = R.windows[win] || R.windows.all;
    return { label: `p99 under ${ms} ms ${winText(win)}`, ok: w.p99 > 0 && w.p99 < ms, value: w.p99 > 0 ? fmtMs(w.p99) : 'no successes', why: w.p99 > 0 ? `p99 was ${fmtMs(w.p99)}` : 'no request succeeded' };
  },
  avail: (target, win = 'all') => (R) => {
    const w = R.windows[win] || R.windows.all;
    return { label: `availability at least ${target}% ${winText(win)}`, ok: w.avail * 100 >= target - 1e-9, value: `${(w.avail * 100).toFixed(2)}%`, why: `availability was ${(w.avail * 100).toFixed(2)}%` };
  },
  util: (kind, max, win = 'all', label) => (R, m) => {
    const w = R.windows[win] || R.windows.all;
    const ids = m.blocks.filter(b => b.kind === kind).map(b => b.id);
    const vals = ids.map(id => w.maxUtil[id] ?? 0);
    const v = Math.max(0, ...vals);
    // an app pool with no instance left is not "under its limit": it is down
    const ts = R.ticks.filter(t => t.t >= w.from && t.t < w.to);
    const wiped = kind === 'app' && ts.some(t => ids.some(id => t.alive?.[id] === 0));
    return { label: label || `${KINDS[kind].label} utilisation at most ${max}% ${winText(win)}`, ok: ids.length > 0 && !wiped && v * 100 <= max, value: wiped ? 'no instance left' : pct(v), why: !ids.length ? `there is no ${KINDS[kind].label.toLowerCase()}` : wiped ? 'every instance was down at some point' : `peaked at ${pct(v)}` };
  },
  nic: (max) => (R, m) => {
    const w = R.windows.all;
    const v = Math.max(0, ...m.blocks.filter(b => b.kind === 'app').map(b => w.maxUtil[b.id + ':nic'] ?? 0));
    return { label: `app server network cards at most ${max}%`, ok: v * 100 <= max, value: pct(v), why: `peaked at ${pct(v)}` };
  },
  lag: (s) => (R) => {
    const v = R.windows.all.maxLag;
    const has = R.ticks.some(t => Object.keys(t.lag).length);
    return { label: `replica lag under ${s} s`, ok: has && v < s, value: has ? `${fmt(v)} s` : '—', why: has ? `lag peaked at ${fmt(v)} s` : 'there are no read replicas taking reads' };
  },
  cost: (usd) => (R) => ({ label: `under ${fmtUsd(usd)} a month`, ok: R.cost.total <= usd, value: fmtUsd(R.cost.total), why: `the design costs ${fmtUsd(R.cost.total)} a month` }),
  /** The budget: 30% above par (the reference design's cost), rounded up to $500. */
  budget: () => (R, m, ch) => {
    const usd = budgetOf(ch);
    return { label: `within the budget of ${fmtUsd(usd)} a month`, ok: R.cost.total <= usd, value: fmtUsd(R.cost.total), why: `the design costs ${fmtUsd(R.cost.total)} a month` };
  },
  restored: (within) => (R) => {
    const inc = R.scenario.incidents[0];
    const from = inc.at + within;
    const bad = R.ticks.filter(t => t.t >= from && t.err > 0.01);
    return { label: `service restored within ${within} s of the outage`, ok: bad.length === 0, value: bad.length ? `still failing at ${fmtTime(bad[bad.length - 1].t)}` : 'yes', why: bad.length ? `${pct(Math.max(...bad.map(t => t.err)))} of requests were still failing at ${fmtTime(bad[0].t)}` : '' };
  },
  recovered: (within, label) => (R) => {
    const inc = R.scenario.incidents[0];
    const from = (inc.until ?? inc.at) + within;
    const bad = R.ticks.filter(t => t.t >= from && t.err > 0.01);
    return { label: label || `recovered within ${within} s after the trigger ends`, ok: bad.length === 0, value: bad.length ? `still failing at ${fmtTime(bad[bad.length - 1].t)}` : 'yes', why: bad.length ? `${pct(Math.max(...bad.map(t => t.err)))} of requests were still failing at ${fmtTime(bad[0].t)}` : '' };
  },
  drained: (by) => (R) => {
    const t = R.ticks.find(x => x.t >= by);
    const qs = Object.values(t?.queue || {});
    const backlog = qs.reduce((s, q) => s + q.backlog, 0);
    return { label: `the queue backlog is drained by ${fmtTime(by)}`, ok: qs.length > 0 && backlog < 100, value: qs.length ? fmtQps(backlog) : '—', why: qs.length ? `${fmtQps(backlog)} messages were still waiting at ${fmtTime(by)}` : 'there is no queue in the write path' };
  },
  rpo: (s) => (R) => ({ label: `data loss at failover (RPO) under ${s} s`, ok: R.rpo.seconds > 0 && R.rpo.seconds < s, value: R.rpo.seconds ? `${fmt(R.rpo.seconds)} s` : '—', why: R.rpo.seconds ? `RPO was ${fmt(R.rpo.seconds)} s` : 'no replica was promoted, so every write since the outage is refused' }),
  errors: (max, win = 'all') => (R) => {
    const w = R.windows[win] || R.windows.all;
    return { label: `errors under ${max}% ${winText(win)}`, ok: w.errRate * 100 < max, value: `${(w.errRate * 100).toFixed(2)}%`, why: `${(w.errRate * 100).toFixed(2)}% of requests failed` };
  },
};
export const GOALS = G;
const winText = w => ({ all: 'over the test', before: 'before the incident', during: 'during the incident', after: 'after the incident' }[w] || '');

const TRAFFIC_KEYS = ['qps', 'readPct', 'keys', 'skew', 'objKB', 'respKB', 'rowKB', 'cacheablePct', 'uploadPct', 'uploadKB', 'writeKeys', 'share1', 'rttMs'];

export const partsCost = m => costOf(m).total;
export const budgetOf = ch => Math.ceil((ch.par * 1.3) / 500) * 500;
export const starsFor = (cost, par) => (cost <= par * 1.05 ? 3 : cost <= par * 1.25 ? 2 : 1);

// layout helpers: a row of equipment, left to right
const X = [40, 320, 600, 880, 1160, 1440];
const Y = [60, 260, 460, 660];
const users = (s = {}) => block('client', 'users', 'Users', X[0], Y[1], s);
const lbB = (s = {}, id = 'lb', name = 'Load balancer', x = X[1], y = Y[1]) => block('lb', id, name, x, y, s);
const appB = (s = {}, id = 'app', name = 'API servers', x = X[2], y = Y[1]) => block('app', id, name, x, y, s);
const dbB = (s = {}, id = 'db', name = 'Primary DB', x = X[3], y = Y[1]) => block('db', id, name, x, y, s);
const chain = (...ids) => ids.slice(1).map((id, i) => wire(ids[i], id));
const set = (m, id, s) => { Object.assign(byId(m, id), s); return m; };
const addBlock = (m, b, ...links) => { m.blocks.push(b); for (const [a, z] of links) connect(m, a, z); return m; };

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free board with a three-tier service. Add equipment from the palette, set the traffic on **Users**, pick incidents under **Failure injection**, and press **Run load test**.',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 5000 }), lbB(), appB({ instances: 6 }), dbB()], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => m, goals: [] },

  { id: 'first-service', title: 'Your first service', xp: 20, par: 0,
    brief: 'Requirements: **2,000 requests/s at peak**, 90% reads, a p99 under 250 ms and 99.9% availability. The equipment is racked but not cabled. Wire **Users → Load balancer → API servers → Primary DB** (drag each ▶ port onto the next device), then press **Run load test**. Read the dashboard: where does the time go?',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 2000 }), lbB(), appB({ instances: 6 }), dbB()], wires: [] }),
    solve: m => { m.wires = chain('users', 'lb', 'app', 'db'); return m; },
    goals: [G.avail(99.9), G.p99(250), G.budget()] },

  { id: 'right-size', title: 'Right-size the pool', xp: 30, par: 0,
    brief: 'Launch day: **12,000 requests/s** at peak, each needs about **10 ms of CPU**. Two small servers melt. Work it out first: 12,000 × 10 ms = 120 cores of work every second. Size the **API servers** (count and size) so the CPU peaks at **70% or less** and p99 stays **under 150 ms**, within the budget. Why not 100%? Watch what queueing does to p99 as utilisation climbs.',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 12000 }), lbB(), appB({ instances: 2, size: 'S', cpuMs: 10 }), dbB({ size: 'XL' })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => set(m, 'app', { instances: 22, size: 'L' }),
    goals: [G.util('app', 70), G.p99(150), G.avail(99.9), G.budget()] },

  { id: 'slow-query', title: 'The slow query', xp: 30, par: 0,
    brief: '**Symptom first.** After a release, p99 is in **seconds** and the database sits at 100% CPU, while the API servers are bored. `pg_stat_statements` shows one query on top, and `EXPLAIN (ANALYZE, BUFFERS)` says `Seq Scan on orders ... Rows Removed by Filter: 4,812,330`. A bigger database would cost a fortune. Find the real fix in the database\'s settings: p99 **under 100 ms** within the budget.',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 3000, readPct: 90 }), lbB(), appB({ instances: 8 }), dbB({ indexed: false })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => set(m, 'db', { indexed: true }),
    goals: [G.p99(100), G.util('db', 60), G.avail(99.9), G.budget()] },

  { id: 'cache-aside', title: 'Cache the catalogue', xp: 40, par: 0,
    brief: 'A product catalogue: **30,000 requests/s**, **95% reads**, 2 million products of about 2 KB, and the usual skew (a few products are far more popular). The primary is drowning. Add a **Cache cluster** (cache-aside: the API servers check it first and fill it on a miss), size it for the hot set, and wire **API servers → cache**. Goals: database **at most 60%**, p99 **under 100 ms**, within the budget. A read replica cannot win here: count the cost.',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 30000, readPct: 95, keys: 2000000, objKB: 2, skew: 0.95 }), lbB(), appB({ instances: 20, size: 'L', cpuMs: 4 }), dbB({ size: 'XL' })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => addBlock(m, block('cache', 'cache', 'Catalogue cache', X[3], Y[0], { nodes: 2, size: 'M', ttl: 600 }), ['app', 'cache']),
    goals: [G.util('db', 60), G.p99(100), G.avail(99.9), G.budget()] },

  { id: 'read-replicas', title: 'Read replicas and lag', xp: 40, par: 0,
    brief: 'A personalised dashboard: **15,000 requests/s**, 90% reads, but every user reads *their own* rows, so a cache barely helps. The primary is past 100%. Add **Read replicas** (wire **Primary DB → Read replicas** for replication and **API servers → Read replicas** for reads). Goals: primary **at most 60%**, replica lag **under 1 s**, p99 **under 150 ms**, within the budget. Then ask: what does a user see right after saving?',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 15000, readPct: 90, keys: 50000000, skew: 0.2 }), lbB(), appB({ instances: 14, size: 'L', cpuMs: 5 }), dbB({ size: 'L' })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => addBlock(m, block('replica', 'rep', 'Read replicas', X[4], Y[1], { count: 2, size: 'L' }), ['db', 'rep'], ['app', 'rep']),
    goals: [G.util('db', 60), G.lag(1), G.p99(150), G.avail(99.9), G.budget()] },

  { id: 'pool-exhaustion', title: 'Too many connections', xp: 35, par: 0,
    brief: '**Symptom first.** Black Friday prep: someone scaled the API to **60 instances**, each with a connection pool of **20**. Now every request that misses the cache has a one-in-three chance of failing, and the logs say `FATAL: sorry, too many clients already`. The database CPU is fine. Fix it without shrinking the API tier: errors **under 0.1%**, p99 **under 150 ms**.',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 20000, readPct: 95, keys: 1000000, skew: 1 }), lbB(), appB({ instances: 60, size: 'M', cpuMs: 4, pool: 20 }), block('cache', 'cache', 'Cache', X[3], Y[0], { nodes: 1, size: 'M', ttl: 600 }), dbB({ size: 'L' })], wires: [...chain('users', 'lb', 'app', 'db'), wire('app', 'cache')] }),
    solve: m => set(m, 'db', { pooler: true }),
    goals: [G.errors(0.1), G.p99(150), G.budget()] },

  { id: 'stampede', title: 'Cache flush at peak', xp: 45, par: 0,
    brief: 'At **4:00** someone runs `FLUSHALL` on the cache in the middle of peak (**40,000 requests/s**, 95% reads). Every read misses at once, the database is buried, queries time out, the cache cannot refill and the site **never recovers**. Keep the flush (it will happen again) and make the system **recover within 60 s**: collapse concurrent misses for one key into one query, and have the database fail fast instead of queueing forever.',
    scenario: { incidents: [{ kind: 'flush', at: 240, until: 250 }] },
    setup: () => ({ blocks: [users({ qps: 40000, readPct: 95, keys: 1000000, skew: 1.05, objKB: 1 }), lbB(), appB({ instances: 24, size: 'L', cpuMs: 3 }), block('cache', 'cache', 'Cache', X[3], Y[0], { nodes: 2, size: 'M', ttl: 600 }), dbB({ size: 'XL' })], wires: [...chain('users', 'lb', 'app', 'db'), wire('app', 'cache')] }),
    solve: m => { set(m, 'cache', { coalesce: true }); return set(m, 'app', { breaker: true }); },
    goals: [G.recovered(60), G.avail(99, 'all'), G.p99(100, 'before'), G.budget()] },

  { id: 'hot-key', title: 'The celebrity key', xp: 45, par: 0,
    brief: 'At **3:00** a celebrity posts and **half of all reads** hit one key. The cache node that owns it saturates; p99 explodes while the other nodes idle. Try adding nodes first and watch it not help (a key lives on one node). Then fix it: the hottest keys should be served from memory **inside the API servers**. Goals: busiest cache node **at most 80%**, p99 **under 60 ms** during the incident.',
    scenario: { incidents: [{ kind: 'hotkey', at: 180, until: 480, share: 0.5 }] },
    setup: () => ({ blocks: [users({ qps: 200000, readPct: 99, keys: 5000000, skew: 0.9, objKB: 1 }), lbB(), appB({ instances: 60, size: 'L', cpuMs: 1.5 }), block('cache', 'cache', 'Timeline cache', X[3], Y[0], { nodes: 6, size: 'M', ttl: 300 }), dbB({ size: '2XL' })], wires: [...chain('users', 'lb', 'app', 'db'), wire('app', 'cache')] }),
    solve: m => set(m, 'app', { nearCache: true }),
    goals: [G.util('cache', 80, 'during', 'busiest cache node at most 80% during the incident'), G.p99(60, 'during'), G.avail(99.9), G.budget()] },

  { id: 'hot-shard', title: 'The hot shard', xp: 40, par: 0,
    brief: 'An events table on **8 shards**, partitioned **by range on the event id**. Ids are time-ordered (new ids are always the largest), so every insert lands on the **last shard** while seven shards idle. **8,000 requests/s, 60% writes.** Change the partitioning so the load spreads: busiest shard **at most 70%**, p99 **under 100 ms**. Moving data is a project; picking the right key on day one is a decision.',
    scenario: { incidents: [] },
    setup: () => ({ blocks: [users({ qps: 8000, readPct: 40, writeKeys: 'time-ordered', rowKB: 0.5 }), lbB(), appB({ instances: 10, size: 'M', cpuMs: 4 }), dbB({ size: 'M', shards: 8, partition: 'range' })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => set(m, 'db', { partition: 'hash' }),
    goals: [G.util('db', 70, 'all', 'busiest shard at most 70%'), G.p99(100), G.avail(99.9), G.budget()] },

  { id: 'write-burst', title: 'Absorb the write burst', xp: 50, par: 0,
    brief: 'Tickets go on sale at **2:00**: for two minutes, traffic jumps to **4×** (**20,000 requests/s, half of them orders**). The primary can take about 3,000 writes/s and the orders time out. Put a **Queue / stream** with **Workers** in the write path (wire **API servers → queue → workers → Primary DB**): the API answers *202 Accepted* at once and the workers write as fast as the database allows. Goals: availability **at least 99.9%**, p99 **under 150 ms**, backlog **drained by 7:00**, database **at most 90%**. Mind the partitions: one consumer per partition.',
    scenario: { incidents: [{ kind: 'spike', at: 120, until: 240, factor: 4 }] },
    setup: () => ({ blocks: [users({ qps: 5000, readPct: 70 }), lbB(), appB({ instances: 30, size: 'L', cpuMs: 4 }), dbB({ size: 'XL' })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => {
      addBlock(m, block('queue', 'q', 'Orders stream', X[3], Y[2], { partitions: 12 }), ['app', 'q']);
      return addBlock(m, block('worker', 'w', 'Order workers', X[4], Y[2], { instances: 4, size: 'M', cpuMs: 3, batch: 20 }), ['q', 'w'], ['w', 'db']);
    },
    goals: [G.avail(99.9), G.p99(150), G.drained(420), G.util('db', 90), G.budget()] },

  { id: 'retry-storm', title: 'The retry storm', xp: 50, par: 0,
    brief: '**Symptom first.** At **3:00** the database slows to a quarter of its speed for one minute (a bad plan, then a fix). The clients retry every failure **three times at once**. The slowdown ends at 4:00, yet the site stays down for the rest of the test: four attempts per request are more than the API servers and the database can take, so every request waits past its timeout and fails again. This is a **metastable failure**: the trigger is gone, the overload sustains itself. Make it recover **within 60 s** of the slowdown ending, without buying more servers. Try a circuit breaker on the database calls first and read why it is not enough on its own; then shed the excess at the edge, where it is cheapest.',
    scenario: { incidents: [{ kind: 'slowdb', at: 180, until: 240, factor: 4 }, { kind: 'retrystorm', at: 0 }] },
    setup: () => ({ blocks: [users({ qps: 10000, readPct: 80 }), lbB(), appB({ instances: 16, size: 'L', cpuMs: 4 }), dbB({ size: 'XL' })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => set(m, 'lb', { rateLimit: 12000 }),
    goals: [G.recovered(60, 'recovered within 60 s after the slowdown ends'), G.avail(99.9, 'before'), G.budget()] },

  { id: 'az-down', title: 'Lose a zone', xp: 55, par: 0,
    brief: 'Availability zone **A** fails at **4:00** at peak (**20,000 requests/s**). Today everything runs in zone A, the load balancer does not health-check, and the database has no standby. Requirements: availability **at least 99.5%** over the test, p99 **under 200 ms** during the outage, within the budget. Spread the API servers over **3 zones** with enough headroom for one to vanish (N+1), turn on health checks, and give the database a **standby** in another zone.',
    scenario: { incidents: [{ kind: 'az', at: 240, until: 600 }] },
    setup: () => ({ blocks: [users({ qps: 20000, readPct: 90 }), lbB({ healthChecks: false }), appB({ instances: 20, size: 'L', cpuMs: 4, azs: 1 }), dbB({ size: '2XL' })], wires: chain('users', 'lb', 'app', 'db') }),
    solve: m => { set(m, 'lb', { healthChecks: true }); set(m, 'app', { azs: 3, instances: 18 }); return set(m, 'db', { standby: true }); },
    goals: [G.avail(93), G.restored(60), G.p99(200, 'during'), G.util('app', 85, 'during', 'API CPU at most 85% with a zone down'), G.budget()] },

  { id: 'region-failover', title: 'Survive a region outage', xp: 60, par: 0,
    brief: 'Two regions. Region 1 serves everyone; region 2 is a warm standby with its own API servers and an async **replica** of the database. At **3:00** region 1 goes dark. Today DNS has no health checks and a **300 s TTL**, and nobody may promote the replica, so the site is down for good. Goals: availability **at least 95%** over the test and data loss (**RPO**) **under 5 s**. Make DNS fail over on health checks with a short TTL, and allow the replica to be promoted.',
    scenario: { incidents: [{ kind: 'region', at: 180, until: 600 }] },
    setup: () => {
      const m = { blocks: [
        users({ qps: 6000, readPct: 90, share1: 100 }),
        block('dns', 'dns', 'DNS', X[1], Y[1], { policy: 'failover', ttl: 300, healthChecks: false }),
        lbB({}, 'lb1', 'Load balancer (region 1)', X[2], Y[0]), appB({ instances: 8, size: 'L', cpuMs: 5, region: 1, azs: 3 }, 'app1', 'API servers (region 1)', X[3], Y[0]),
        dbB({ size: 'L', standby: true, region: 1 }, 'db', 'Primary DB (region 1)', X[4], Y[0]),
        lbB({ region: 2 }, 'lb2', 'Load balancer (region 2)', X[2], Y[2]), appB({ instances: 8, size: 'L', cpuMs: 5, region: 2, azs: 3 }, 'app2', 'API servers (region 2)', X[3], Y[2]),
        block('replica', 'rep2', 'Replica (region 2)', X[4], Y[2], { count: 1, size: 'L', region: 2, promote: false }),
      ], wires: [] };
      for (const [a, z] of [['users', 'dns'], ['dns', 'lb1'], ['dns', 'lb2'], ['lb1', 'app1'], ['app1', 'db'], ['lb2', 'app2'], ['app2', 'db'], ['db', 'rep2']]) connect(m, a, z);
      return m;
    },
    solve: m => { set(m, 'dns', { healthChecks: true, ttl: 60 }); return set(m, 'rep2', { promote: true }); },
    goals: [G.restored(120), G.rpo(5), G.avail(99.5, 'before'), G.budget()] },

  { id: 'photo-share', title: 'Capstone: photo sharing', xp: 80, par: 0,
    brief: 'Design it from nothing but **Users**. Requirements: **10,000 requests/s** at peak, **99% views**; an upload is a photo of about **1 MB**, a view fetches about **100 KB**, and 90% of views are of images that can be cached at the edge. Zone A fails at **5:00**. Goals: p99 **under 300 ms**, availability **at least 99%** over the test, within the budget. Where do the bytes go, and what does each gigabyte cost there? Storage in a database costs about 5× object storage per GB, and bytes served from the origin cost more than bytes from a CDN. The lessons on object storage, CDNs, caching and zones have everything you need.',
    scenario: { incidents: [{ kind: 'az', at: 300, until: 600 }] },
    setup: () => ({ blocks: [users({ qps: 10000, readPct: 99, respKB: 100, uploadPct: 100, uploadKB: 1000, cacheablePct: 90, keys: 20000000, skew: 1.0, objKB: 1, rowKB: 1 })], wires: [] }),
    solve: m => {
      addBlock(m, block('cdn', 'cdn', 'CDN', X[1], Y[0], { hitPct: 95 }), ['users', 'cdn']);
      addBlock(m, lbB({ healthChecks: true }), ['cdn', 'lb']);
      addBlock(m, appB({ instances: 3, size: 'L', cpuMs: 4, azs: 3 }), ['lb', 'app']);
      addBlock(m, block('cache', 'cache', 'Metadata cache', X[3], Y[0], { nodes: 2, size: 'M', azs: 2, ttl: 600 }), ['app', 'cache']);
      addBlock(m, dbB({ size: 'M', standby: true }), ['app', 'db']);
      return addBlock(m, block('objstore', 'obj', 'Photo bucket', X[3], Y[2]), ['app', 'obj']);
    },
    goals: [G.p99(300), G.avail(99), G.budget()] },
];

// par: the cost of the reference solution, rounded up to the next $50 (so it is a fair target)
for (const c of CHALLENGES) if (c.xp > 0) c.par = Math.ceil(costOf(c.solve(c.setup())).total / 50) * 50;

/** Judges a challenge on its fixed scenario and seed: { ok, goals, run, cost, stars }. */
export function judge(m, ch) {
  const R = simulate(m, ch.scenario, ch.seed ?? 7);
  if (R.error) return { ok: false, goals: [{ label: 'the design runs', ok: false, why: R.error }], run: R, cost: 0, stars: 0 };
  const goals = ch.goals.map(g => g(R, m, ch));
  // the traffic is the requirement: it may not be changed to make a goal pass
  const want = ch.setup().blocks.find(b => b.kind === 'client');
  const have = m.blocks.find(b => b.kind === 'client');
  const changed = TRAFFIC_KEYS.filter(k => want && have && want[k] !== have[k]);
  if (changed.length) goals.unshift({ label: 'the traffic is as specified', ok: false, why: `Users' ${changed.join(', ')} changed: the traffic is the requirement, put it back (Reset restores it)` });
  const ok = goals.every(g => g.ok);
  const cost = R.cost.total;
  return { ok, goals, run: R, cost, stars: ok ? starsFor(cost, ch.par) : 0 };
}
