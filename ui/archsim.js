// The architecture builder's simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
// A model is { blocks, wires }: a Client, an API gateway, integration routes, backend services, queues,
// caches and databases, wired left to right. run() sends a burst of requests through it and returns, per
// request, the status the client saw, its latency, a trace of hops (for animation) and a plain-English
// reason; plus a metrics dashboard. Randomness (failure rates, cache hits) comes from a seeded generator,
// so a challenge is judged the same way every time.

export const KINDS = {
  client: { label: 'Client', icon: '📱' },
  gateway: { label: 'API gateway', icon: '🛡' },
  route: { label: 'Integration route', icon: '⇢' },
  cache: { label: 'Cache', icon: '⚡' },
  queue: { label: 'Queue', icon: '☰' },
  service: { label: 'Backend service', icon: '⚙' },
  db: { label: 'Database', icon: '🛢' },
};

export const DEFAULTS = {
  client: { op: 'GET /products', token: 'valid', scopes: 'products:read orders:read orders:write', burst: 20 },
  gateway: { auth: false, scope: '', rateLimit: 0, timeout: 5000 },
  route: { transform: false, timeout: 1000, retries: 0, backoff: 50, deadLetter: false, dlqReply: '502' },
  cache: { hitRate: 80 },
  queue: {},
  service: { latency: 80, failRate: 0, down: false, capacity: 0, expects: 'v1' },
  db: { latency: 20, down: false },
};

/** Which kinds a block's output may be wired to. */
export const TARGETS = {
  client: ['gateway', 'route', 'service', 'cache', 'queue'],
  gateway: ['route', 'service', 'cache', 'queue'],
  route: ['service', 'cache', 'queue'],
  cache: ['service', 'route'],
  queue: ['service', 'route'],
  service: ['db', 'cache', 'queue', 'service'],
  db: [],
};
/** Kinds with a single downstream: wiring a new one replaces the old wire. Services may call many. */
export const SINGLE_OUT = ['client', 'gateway', 'route', 'cache', 'queue'];

export const block = (kind, id, name, x = 0, y = 0, settings = {}) => ({ id, kind, name, x, y, ...DEFAULTS[kind], ...settings });
export const wire = (from, to) => ({ id: `W-${from}-${to}`, from, to });
export const byId = (m, id) => m.blocks.find(b => b.id === id);
export const outs = (m, b) => m.wires.filter(w => w.from === b.id).map(w => byId(m, w.to)).filter(Boolean);
const next = (m, b) => outs(m, b)[0] || null;

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

const scopeSet = s => new Set(String(s || '').split(/[\s,]+/).filter(Boolean));
const ok2xx = c => c >= 200 && c < 300;

export const CODE_TEXT = { 0: 'no answer', 200: 'OK', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

// ---------------------------------------------------------------- one request through the blocks

function call(ctx, from, to, req, trace) {
  trace.push({ type: 'hop', from: from.id, to: to.id });
  if (trace.length > 400) return { code: 508, latency: 0, why: 'The request went round in a loop of wires.' };
  const res = HANDLERS[to.kind](ctx, to, req, trace);
  trace.push({ type: 'back', from: to.id, to: from.id, code: res.code });
  return res;
}

const HANDLERS = {
  gateway(ctx, b, req, trace) {
    if (b.auth) {
      if (req.token === 'none') return { code: 401, latency: 2, why: `${b.name} requires a bearer token and this request has none. 401 means "who are you?".` };
      if (req.token === 'expired') return { code: 401, latency: 2, why: `${b.name} checked the token: it has expired. 401 again: the caller must get a fresh token.` };
      if (b.scope && !req.scopes.has(b.scope)) return { code: 403, latency: 2, why: `The token is valid but lacks the scope "${b.scope}" (it has: ${[...req.scopes].join(', ') || 'none'}). 403 means "I know who you are, and you may not".` };
    }
    const n = ctx.gw[b.id] = (ctx.gw[b.id] || 0) + 1;
    if (b.rateLimit > 0 && n > b.rateLimit) return { code: 429, latency: 1, why: `${b.name} allows ${b.rateLimit} requests per second; this was number ${n}. Rejected cheaply before it touched the backend.` };
    const nxt = next(ctx.m, b);
    if (!nxt) return { code: 502, latency: 2, why: `${b.name} has no upstream wired, so it has nowhere to send the request.` };
    const res = call(ctx, b, nxt, req, trace);
    const latency = res.latency + 2;
    if (b.timeout > 0 && latency > b.timeout) return { ...res, code: 504, latency: b.timeout, why: `${b.name} waited its full ${b.timeout} ms budget and gave up (504). Behind it: ${res.why}` };
    if (res.code === 500 || res.code === 503) return { ...res, code: 502, latency, why: `${nxt.name} answered ${res.code}, which ${b.name} reports as 502 Bad Gateway: ${res.why}` };
    return { ...res, latency };
  },

  route(ctx, b, req, trace) {
    if (b.transform) req = { ...req, format: 'v2' };
    const nxt = next(ctx.m, b);
    if (!nxt) return { code: 502, latency: 1, why: `${b.name} is not wired to anything downstream.` };
    const attempts = 1 + Math.max(0, b.retries | 0);
    let total = 0, last = null, ghosts = 0;
    for (let a = 0; a < attempts; a++) {
      if (a > 0) { total += b.backoff | 0; ctx.metrics.retries++; }
      const res = call(ctx, b, nxt, req, trace);
      if (b.timeout > 0 && res.latency > b.timeout) {
        total += b.timeout; ctx.metrics.timeouts++;
        if (ok2xx(res.code)) ghosts++;     // the backend finished the work; nobody waited for the answer
        last = { timeout: true, res };
        continue;
      }
      total += res.latency;
      if (res.code >= 500) { last = { res }; continue; }
      if (ghosts && req.method !== 'GET') ctx.metrics.duplicates += ghosts;
      const tried = a > 0 ? ` (attempt ${a + 1} of ${attempts}: ${a} retr${a === 1 ? 'y' : 'ies'} hid the earlier failure${a === 1 ? '' : 's'})` : '';
      return { ...res, latency: total + 1, why: res.why + tried };
    }
    const cause = last.timeout ? `no answer within ${b.timeout} ms` : last.res.why;
    const tries = attempts > 1 ? `all ${attempts} attempts failed` : 'it failed and retries are off';
    if (b.deadLetter) {
      ctx.dlq.push(req.i);
      const code = Number(b.dlqReply) || 502;
      const why = code === 204
        ? `${b.name}: ${tries} (${cause}). The message went to the dead-letter queue and the caller got 204 No Content, which looks exactly like success. Nobody will count this as a failure.`
        : code === 202
          ? `${b.name}: ${tries} (${cause}). Parked in the dead-letter queue for replay; the caller got 202 Accepted, so it knows the work is not done yet.`
          : `${b.name}: ${tries} (${cause}). The caller gets an honest ${code}, and the message is also kept in the dead-letter queue for replay.`;
      return { code, latency: total + 1, dlq: true, why };
    }
    return { code: last.timeout ? 504 : 502, latency: total + 1, why: `${b.name}: ${tries}. ${last.timeout ? `Each one timed out after ${b.timeout} ms.` : cause}` };
  },

  cache(ctx, b, req, trace) {
    const nxt = next(ctx.m, b);
    if (req.method === 'GET') {
      if (ctx.rng() * 100 < b.hitRate) return { code: 200, latency: 3, why: `${b.name} had a fresh copy: cache hit in 3 ms, the backend never saw it.` };
      if (!nxt) return { code: 200, latency: 2, why: `${b.name} missed and has nothing behind it (an empty answer).` };
      const res = call(ctx, b, nxt, req, trace);
      return { ...res, latency: res.latency + 3, why: `Cache miss, so ${b.name} asked ${nxt.name}: ${res.why}` };
    }
    if (!nxt) return { code: 502, latency: 1, why: `${b.name} only answers reads; writes need something behind it.` };
    const res = call(ctx, b, nxt, req, trace);
    return { ...res, latency: res.latency + 1 };
  },

  queue(ctx, b, req) {
    ctx.queued.push({ req, q: b });
    return { code: 202, latency: 4, why: `${b.name} stored the message and answered 202 Accepted at once. A consumer will process it at its own pace.` };
  },

  service(ctx, b, req, trace) {
    if (!ctx.drain) {
      const n = ctx.svc[b.id] = (ctx.svc[b.id] || 0) + 1;
      if (b.capacity > 0 && n > b.capacity) { ctx.metrics.overloaded++; ctx.metrics.errors++; return { code: 503, latency: 25, why: `${b.name} is overloaded: it can take ${b.capacity} requests per second and this was number ${n}.` }; }
    }
    ctx.metrics.attempts++;
    if (b.down) { ctx.metrics.errors++; return { code: 503, latency: 3, why: `${b.name} is down (connection refused).` }; }
    if (b.expects === 'v2' && req.format !== 'v2') return { code: 400, latency: 5, why: `${b.name} expects the v2 payload, but the client sends v1 and nothing in between transformed it. 400: retrying will never help.` };
    let latency = Math.round(b.latency * (1 + ctx.rng() * 0.1));
    if (ctx.rng() * 100 < b.failRate) { ctx.metrics.errors++; return { code: 500, latency, why: `${b.name} threw an error (it fails ${b.failRate}% of the time).` }; }
    for (const dep of outs(ctx.m, b)) {
      const res = call(ctx, b, dep, req, trace);
      latency += res.latency;
      if (res.code >= 500) { ctx.metrics.errors++; return { code: 500, latency, why: `${b.name} failed because its dependency ${dep.name} failed: ${res.why}` }; }
    }
    return { code: 200, latency, why: `${b.name} handled it in ${latency} ms.` };
  },

  db(ctx, b) {
    if (b.down) return { code: 500, latency: 3, why: `${b.name} is down.` };
    return { code: 200, latency: Math.round(b.latency * (1 + ctx.rng() * 0.1)), why: `${b.name} answered.` };
  },
};

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/**
 * Sends requests from the Client block. scenario: { count } (a burst of the client's own request) or
 * { requests: [{ token, scopes, op }] } (each overrides the client's settings). Returns
 * { error } or { results, metrics }.
 */
export function run(m, scenario = {}, seed = 7) {
  const client = m.blocks.find(b => b.kind === 'client');
  if (!client) return { error: 'Add a Client block: someone has to send the requests.' };
  const ctx = { m, rng: mulberry32(seed), gw: {}, svc: {}, dlq: [], queued: [], drain: false,
    metrics: { attempts: 0, errors: 0, overloaded: 0, retries: 0, timeouts: 0, duplicates: 0 } };
  const specs = scenario.requests || Array.from({ length: Math.max(1, Math.min(200, scenario.count ?? client.burst ?? 1)) }, () => ({}));
  const results = specs.map((spec, i) => {
    const s = { op: client.op, token: client.token, scopes: client.scopes, ...spec };
    const [method, path] = String(s.op).split(' ');
    const req = { i, op: s.op, method, path, token: s.token, scopes: scopeSet(s.scopes), format: 'v1' };
    const trace = [];
    const first = next(m, client);
    if (!first) return { i, spec, code: 0, latency: 0, why: 'The client is not wired to anything yet.', trace };
    const res = call(ctx, client, first, req, trace);
    return { i, spec, code: res.code, latency: res.latency, why: res.why, dlq: !!res.dlq, trace };
  });
  // Consumers drain the queues afterwards, pulling one message at a time (so they are never overloaded).
  ctx.drain = true;
  let processed = 0, lost = 0;
  const lostWhy = [];
  for (const { req, q } of ctx.queued) {
    const consumer = next(m, q);
    if (!consumer) { lost++; if (lostWhy.length < 1) lostWhy.push(`${q.name} has no consumer wired: messages pile up forever.`); continue; }
    const res = call(ctx, q, consumer, req, []);
    if (ok2xx(res.code)) processed++; else { lost++; if (lostWhy.length < 1) lostWhy.push(res.why); }
  }
  const lat = results.map(r => r.latency);
  const byCode = {};
  for (const r of results) byCode[r.code] = (byCode[r.code] || 0) + 1;
  const okCount = results.filter(r => ok2xx(r.code)).length;
  const metrics = {
    total: results.length, ok: okCount, failed: results.length - okCount, byCode,
    p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(0, ...lat),
    ...ctx.metrics, dlq: ctx.dlq.length, queued: ctx.queued.length, processed, lost, lostWhy: lostWhy[0] || '',
    hidden: results.filter(r => r.dlq && ok2xx(r.code) && r.code !== 202).length,   // "successes" that really were failures (202 at least says "not done yet")
  };
  return { results, metrics };
}

// ---------------------------------------------------------------- challenges

export const starsFor = (c, par, slack = 2) => (c <= par ? 3 : c <= par + slack ? 2 : 1);
const partsCost = m => m.blocks.length + m.wires.length;

const flow = (names = {}, settings = {}) => {
  const s = k => settings[k] || {};
  return {
    blocks: [
      block('client', 'client', names.client || 'Web app', 40, 140, s('client')),
      block('gateway', 'gw', names.gw || 'API gateway', 340, 140, s('gw')),
      block('route', 'route', names.route || 'Orders route', 640, 140, s('route')),
      block('service', 'svc', names.svc || 'Orders', 940, 140, s('svc')),
    ],
    wires: [wire('client', 'gw'), wire('gw', 'route'), wire('route', 'svc')],
  };
};

const expectCodes = (r, codes) => {
  const bad = r.results.map((x, i) => [x, codes[i]]).filter(([x, c]) => x.code !== c);
  return bad.length ? bad.map(([x, c]) => `request ${x.i + 1} (${x.spec.token ? 'token ' + x.spec.token : x.spec.scopes || ''}) got ${x.code || 'nothing'}, wanted ${c}`).join('; ') : true;
};

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free board. Wire a client through a gateway and a route to services, add queues, caches and databases, break things with the failure switches and watch the metrics.',
    scenario: { count: 10 }, setup: () => flow({ route: 'Products route', svc: 'Catalog' }, { client: { op: 'GET /products' } }), solve: m => m, check: () => 'Sandbox: nothing to solve.' },

  { id: 'hello', title: 'Hello, request', xp: 15, par: 7,
    brief: 'Four blocks, no wires. Wire **Client → API gateway → Integration route → Catalog** (drag each block\'s ▶ port onto the next block) and send a request. You want a **200**.',
    scenario: { count: 1 },
    setup: () => ({ ...flow({ route: 'Products route', svc: 'Catalog' }, { client: { op: 'GET /products' } }), wires: [] }),
    solve: m => { m.wires = flow().wires; return m; },
    check: (r, m) => {
      if (r.results[0].code !== 200) return `the request got ${r.results[0].code || 'no answer'}, not 200`;
      const kinds = new Set(r.results[0].trace.map(t => byId(m, t.to)?.kind));
      return (kinds.has('gateway') && kinds.has('route')) || 'the request must pass through the gateway and the route';
    } },

  { id: 'auth', title: 'No token, no entry', xp: 20, par: 7,
    brief: 'Anyone can call the orders API: the gateway lets requests without a token straight through. Make the gateway **require authentication**: no token or an expired one must get **401**, a valid token still gets 200.',
    scenario: { requests: [{ token: 'none' }, { token: 'expired' }, { token: 'valid' }] },
    setup: () => flow({}, { client: { op: 'GET /orders' } }),
    solve: m => { byId(m, 'gw').auth = true; return m; },
    check: r => expectCodes(r, [401, 401, 200]) },

  { id: 'scopes', title: 'Who may write?', xp: 25, par: 7,
    brief: 'Authentication is on, but a read-only token can still **create orders**. A valid token says *who* you are; a **scope** says *what you may do*. Make `POST /orders` need the `orders:write` scope: the read-only caller should get **403**, the writer 200.',
    scenario: { requests: [{ scopes: 'orders:read' }, { scopes: 'orders:read orders:write' }] },
    setup: () => flow({}, { client: { op: 'POST /orders' }, gw: { auth: true } }),
    solve: m => { byId(m, 'gw').scope = 'orders:write'; return m; },
    check: r => expectCodes(r, [403, 200]) },

  { id: 'contract', title: 'Translate the contract', xp: 25, par: 7,
    brief: 'The Orders service moved to a **v2 payload**, the mobile app still sends v1, and every call fails with **400**. Retrying a 400 never helps. Let the integration route do its job: **transform** the message on the way through.',
    scenario: { count: 3 },
    setup: () => flow({}, { client: { op: 'POST /orders' }, svc: { expects: 'v2' } }),
    solve: m => { byId(m, 'route').transform = true; return m; },
    check: r => r.results.every(x => x.code === 200) || `got ${[...new Set(r.results.map(x => x.code))].join(', ')}, wanted 200` },

  { id: 'retries', title: 'Flaky inventory', xp: 35, par: 2, cost: m => byId(m, 'route')?.retries ?? 99,
    brief: 'The Inventory service fails **30%** of calls at random, so a burst of 20 orders has several failures. Make every order succeed **using retries** on the integration route (no touching the service). Stars for using as few retries as it takes: each retry adds load and latency.',
    scenario: { count: 20 },
    setup: () => flow({ route: 'Inventory route', svc: 'Inventory' }, { client: { op: 'POST /orders' }, svc: { failRate: 30, latency: 60 } }),
    solve: m => { byId(m, 'route').retries = 2; return m; },
    check: (r, m) => {
      if (byId(m, 'svc')?.failRate < 30) return 'keep the Inventory service flaky (30%): fix it with retries, not by fixing the service';
      return r.metrics.failed === 0 || `${r.metrics.failed} of ${r.metrics.total} orders still fail`;
    } },

  { id: 'timeouts', title: 'Slow is not dead', xp: 30, par: 8, cost: m => Math.ceil((byId(m, 'route')?.timeout || 99999) / 100),
    brief: 'Pricing answers in about **700 ms**, but the route gives up after 500 ms, retries, gives up again: **504** every time, while Pricing did the work for nothing. Set a timeout that fits the real latency. Stars for a *tight* timeout, not an enormous one (a huge timeout lets a dead service tie up callers).',
    scenario: { count: 10 },
    setup: () => flow({ route: 'Pricing route', svc: 'Pricing' }, { client: { op: 'GET /prices' }, route: { timeout: 500, retries: 1 }, svc: { latency: 700 } }),
    solve: m => { byId(m, 'route').timeout = 800; return m; },
    check: (r, m) => {
      if (byId(m, 'svc')?.latency < 700) return 'Pricing really takes 700 ms: change the timeout, not the service';
      return r.metrics.failed === 0 || `${r.metrics.failed} requests still fail (${Object.keys(r.metrics.byCode).join(', ')})`;
    } },

  { id: 'trap', title: 'The 204 trap', xp: 40, par: 7,
    brief: 'Inventory is down. The dashboard shows **zero failures**. Look closer: the route parks every failed order in the dead-letter queue and answers **204 No Content**, so the client believes it worked and nothing is counted. Keep the dead-letter queue (we want to replay those orders) and keep the outage, but make the failure **visible** to the caller.',
    scenario: { count: 10 },
    setup: () => flow({ route: 'Inventory route', svc: 'Inventory' }, { client: { op: 'POST /orders' }, route: { retries: 1, deadLetter: true, dlqReply: '204' }, svc: { down: true } }),
    solve: m => { byId(m, 'route').dlqReply = '502'; return m; },
    check: (r, m) => {
      if (!byId(m, 'svc')?.down) return 'keep Inventory down: the point is to make an outage visible';
      if (!byId(m, 'route')?.deadLetter) return 'keep dead-lettering on, so the orders can be replayed later';
      return r.metrics.hidden === 0 || `${r.metrics.hidden} dead-lettered orders were still reported as success`;
    } },

  { id: 'ratelimit', title: 'Protect the backend', xp: 40, par: 7,
    brief: 'A marketing email sends a burst of **60** searches at once. Search can handle **20 per second**; beyond that it falls over, the route retries (making it worse), and everyone gets 502. Have the gateway **rate limit** so Search is never overloaded: the excess should get a fast, cheap **429** instead.',
    scenario: { count: 60 },
    setup: () => flow({ route: 'Search route', svc: 'Search' }, { client: { op: 'GET /search' }, route: { retries: 2 }, svc: { capacity: 20, latency: 60 } }),
    solve: m => { byId(m, 'gw').rateLimit = 20; return m; },
    check: (r, m) => {
      if (byId(m, 'svc')?.capacity !== 20) return 'Search can only take 20 per second: keep its capacity at 20';
      if (r.metrics.overloaded) return `Search was overloaded ${r.metrics.overloaded} times`;
      const fives = r.results.filter(x => x.code >= 500).length;
      if (fives) return `${fives} requests got a 5xx`;
      return r.metrics.ok >= 15 || `only ${r.metrics.ok} searches succeeded; at least 15 should`;
    } },

  { id: 'queue', title: 'Absorb the burst', xp: 45, par: 9,
    brief: 'A flash sale: **60 orders** in one second, and the Orders service handles 20 per second. A rate limit would turn customers away with 429. Orders are worth keeping: put a **Queue** between the route and the service so every order is accepted now (**202**) and processed as fast as Orders can go. Nothing may be lost.',
    scenario: { count: 60 },
    setup: () => flow({}, { client: { op: 'POST /orders' }, svc: { capacity: 20 } }),
    solve: m => {
      m.blocks.push({ ...block('queue', 'q', 'Order queue', 790, 340) });
      m.wires = m.wires.filter(w => w.from !== 'route');
      m.wires.push(wire('route', 'q'), wire('q', 'svc'));
      return m;
    },
    check: (r, m) => {
      if (byId(m, 'svc')?.capacity !== 20) return 'Orders can only take 20 per second: keep its capacity at 20';
      const bad = r.results.filter(x => !(x.code >= 200 && x.code < 300) || x.dlq).length;
      if (bad) return `${bad} orders were rejected, failed or dead-lettered`;
      if (r.metrics.overloaded) return `Orders was overloaded ${r.metrics.overloaded} times`;
      return r.metrics.lost === 0 || `${r.metrics.lost} orders were never processed: ${r.metrics.lostWhy}`;
    } },

  { id: 'cache', title: 'Fast reads', xp: 35, par: 11,
    brief: 'The product page calls Catalog (about 250 ms) which queries its database (about 120 ms). Median latency is over 370 ms. Product data changes rarely: put a **Cache** in front of Catalog to get the **median (p50) under 50 ms**.',
    scenario: { count: 40 },
    setup: () => {
      const m = flow({ route: 'Products route', svc: 'Catalog' }, { client: { op: 'GET /products' }, svc: { latency: 250 } });
      m.blocks.push(block('db', 'db', 'Products DB', 940, 380, { latency: 120 }));
      m.wires.push(wire('svc', 'db'));
      return m;
    },
    solve: m => {
      m.blocks.push(block('cache', 'cache', 'Product cache', 790, 380, { hitRate: 80 }));
      m.wires = m.wires.filter(w => w.from !== 'route');
      m.wires.push(wire('route', 'cache'), wire('cache', 'svc'));
      return m;
    },
    check: (r, m) => {
      if (!byId(m, 'svc') || !byId(m, 'db') || byId(m, 'svc').latency < 250 || byId(m, 'db').latency < 120 || !m.wires.some(w => w.from === 'svc' && w.to === 'db')) return 'keep Catalog and its database as slow as they are: cache them instead';
      if (r.metrics.failed) return `${r.metrics.failed} requests failed`;
      return r.metrics.p50 < 50 || `p50 is ${r.metrics.p50} ms; get it under 50 ms`;
    } },
];

/** Judges a challenge with its fixed scenario and seed: { ok, why, run, cost, stars }. */
export function judge(m, ch) {
  const r = run(m, ch.scenario, ch.seed ?? 7);
  if (r.error) return { ok: false, why: r.error, run: r, cost: 0, stars: 0 };
  const verdict = ch.check(r, m);
  const c = ch.cost ? ch.cost(m) : partsCost(m);
  const ok = verdict === true;
  return { ok, why: ok ? null : verdict, run: r, cost: c, stars: ok ? starsFor(c, ch.par) : 0 };
}
