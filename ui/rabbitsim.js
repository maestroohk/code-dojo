// The Messaging builder's RabbitMQ simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
// A model is { blocks, wires }: producer apps, exchanges, queues and consumer apps. A wire from a producer to
// an exchange is "publishes to", from an exchange to a queue or another exchange is a binding (binding key, or
// headers arguments with x-match), from a queue to a consumer is a subscription (basic.consume).
// simulate() runs the whole thing on a simulated clock: routing exactly like RabbitMQ (direct, topic with * and
// #, fanout, headers all/any, alternate exchanges, mandatory returns), round-robin dispatch limited by prefetch,
// manual ack or autoAck, consumer crashes, nack/requeue loops, reject, TTL and delivery-limit dead-lettering
// with x-death, delayed retries through a TTL queue, parking lots, and a broker restart. Deterministic: there
// is no randomness at all, and every decision carries a plain-English reason.

export const KINDS = {
  producer: { label: 'Producer app', icon: '📤' },
  exchange: { label: 'Exchange', icon: '🔀' },
  queue: { label: 'Queue', icon: '📥' },
  consumer: { label: 'Consumer app', icon: '⚙' },
};
export const EXCHANGE_TYPES = ['direct', 'topic', 'fanout', 'headers'];
export const QUEUE_TYPES = ['classic', 'quorum'];
export const ON_ERROR = [['requeue', 'BasicNack(requeue: true)'], ['reject', 'BasicReject(requeue: false)'], ['ack', 'BasicAck anyway (swallow the error)']];
export const DEFAULTS = {
  producer: { messages: ['order.created x5'], rate: 10, persistent: true, mandatory: false, confirms: false, onReturn: false, startAt: 0 },
  exchange: { type: 'direct', durable: true, ae: '' },
  queue: { qtype: 'classic', durable: true, ttl: 0, dlx: '', dlk: '', deliveryLimit: 20, maxLength: 0 },
  consumer: { prefetch: 10, autoAck: false, onError: 'requeue', workMs: 100, crashAfter: 0, startAt: 0, parkAfter: 0, parkTo: '' },
};
/** Which kinds a block's ▶ may be wired to. */
export const TARGETS = { producer: ['exchange'], exchange: ['queue', 'exchange'], queue: ['consumer'], consumer: [] };
export const LOOP_CAP = 500;          // a requeue loop is cut off here
const IN_FLIGHT_S = 0.2;              // publishes this close before a broker crash were still in the socket buffer
const DOWN_S = 2;                     // how long a broker restart takes
const RESTART_S = 2;                  // a crashed consumer app is started again after this long

const clone = o => JSON.parse(JSON.stringify(o));
export const block = (kind, id, name, x = 0, y = 0, settings = {}) => ({ id, kind, name, x, y, ...clone(DEFAULTS[kind]), ...settings });
export const wire = (from, to, extra = {}) => ({ id: `W-${from}-${to}`, from, to, ...extra });
export const byId = (m, id) => m.blocks.find(b => b.id === id);
export const byName = (m, kind, name) => m.blocks.find(b => b.kind === kind && b.name === name);
export const ofKind = (m, kind) => m.blocks.filter(b => b.kind === kind);
export const validName = n => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(n);
const r3 = x => Math.round(x * 1000) / 1000;
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;

export function canWire(m, from, to) {
  if (!from || !to || from.id === to.id) return false;
  return (TARGETS[from.kind] || []).includes(to.kind);
}

/** A sensible first binding key: the first routing key the exchange receives. */
function guessKey(m, exId) {
  const p = m.wires.filter(w => w.to === exId).map(w => byId(m, w.from)).find(b => b?.kind === 'producer');
  const first = p && parseMsg(p.messages?.[0] || '');
  return first && !first.error ? first.key : '';
}

/** Adds a wire. A producer publishes to one exchange and a consumer reads one queue, so those replace. */
export function connect(m, fromId, toId) {
  const from = byId(m, fromId), to = byId(m, toId);
  if (!canWire(m, from, to)) return false;
  if (from.kind === 'producer') m.wires = m.wires.filter(w => w.from !== fromId);
  if (to.kind === 'consumer') m.wires = m.wires.filter(w => w.to !== toId);
  if (m.wires.some(w => w.from === fromId && w.to === toId) && from.kind !== 'exchange') return true;
  let id = `W-${fromId}-${toId}`, i = 1;
  while (m.wires.some(w => w.id === id)) id = `W-${fromId}-${toId}-${++i}`;
  const extra = from.kind === 'exchange' ? { key: from.type === 'fanout' || from.type === 'headers' ? '' : guessKey(m, fromId), match: 'all', hargs: [] } : {};
  m.wires.push({ id, from: fromId, to: toId, ...extra });
  return true;
}

/** Removes a block, its wires and every setting that points at it (dead-letter exchange, alternate exchange). */
export function removeBlock(m, id) {
  m.blocks = m.blocks.filter(b => b.id !== id);
  m.wires = m.wires.filter(w => w.from !== id && w.to !== id);
  for (const b of m.blocks) {
    if (b.ae === id) b.ae = '';
    if (b.dlx === id) b.dlx = '';
    if (b.parkTo === id) b.parkTo = '';
  }
}

export const exchangeOf = (m, p) => byId(m, m.wires.find(w => w.from === p.id)?.to);
export const queueOf = (m, c) => byId(m, m.wires.find(w => w.to === c.id && byId(m, w.from)?.kind === 'queue')?.from);
export const consumersOf = (m, q) => m.wires.filter(w => w.from === q.id).map(w => byId(m, w.to)).filter(b => b?.kind === 'consumer');
export const bindingsOf = (m, ex) => m.wires.filter(w => w.from === ex.id);

/**
 * One line of a producer's message list: `routing.key xN header=value ... poison fail=N`.
 * "-" (or nothing) as the first word is an empty routing key. -> { key, count, headers, poison, failTimes } or { error }
 */
export function parseMsg(line) {
  const words = String(line || '').trim().split(/\s+/).filter(Boolean);
  const out = { key: '', count: 1, headers: {}, poison: false, failTimes: 0 };
  if (!words.length) return { error: 'an empty message line' };
  let i = 0;
  const isOpt = w => /^x\d+$/.test(w) || w.includes('=') || w === 'poison';
  if (words[0] === '-') i = 1;
  else if (!isOpt(words[0])) { out.key = words[0]; i = 1; }
  for (; i < words.length; i++) {
    const w = words[i];
    if (/^x\d+$/.test(w)) { out.count = Math.max(1, Math.min(5000, Number(w.slice(1)))); continue; }
    if (w === 'poison') { out.poison = true; continue; }
    const eq = w.indexOf('=');
    if (eq < 1) return { error: `"${w}" in "${line}": write header=value, xN (how many), poison or fail=N` };
    const k = w.slice(0, eq), v = w.slice(eq + 1);
    if (k === 'fail') { if (!/^\d+$/.test(v)) return { error: `fail=N needs a number in "${line}"` }; out.failTimes = Number(v); continue; }
    out.headers[k] = v;
  }
  return out;
}
export const msgText = s => [s.key || '(empty key)', ...Object.entries(s.headers).map(([k, v]) => `${k}=${v}`)].join(' ');

// ---------------------------------------------------------------- routing

/** Topic matching exactly like RabbitMQ: words split on ".", * is exactly one word, # is zero or more words. */
export function topicMatch(pattern, key) {
  const p = String(pattern).split('.'), k = String(key).split('.');
  const memo = new Map();
  const go = (i, j) => {
    const id = i * 1000 + j;
    if (memo.has(id)) return memo.get(id);
    let r;
    if (i === p.length) r = j === k.length;
    else if (p[i] === '#') { r = false; for (let x = j; x <= k.length && !r; x++) r = go(i + 1, x); }
    else r = j < k.length && (p[i] === '*' || p[i] === k[j]) && go(i + 1, j + 1);
    memo.set(id, r);
    return r;
  };
  return go(0, 0);
}

export function topicWhy(pattern, key) {
  const p = String(pattern).split('.'), k = String(key).split('.');
  if (topicMatch(pattern, key)) return `"${key}" matches "${pattern}"${p.includes('#') ? ' (# = zero or more words)' : p.includes('*') ? ' (* = exactly one word)' : ''}`;
  if (!p.includes('#') && p.length !== k.length) return `"${key}" has ${plural(k.length, 'word')}; "${pattern}" matches exactly ${p.length}, so no match`;
  if (!p.includes('#')) { const i = p.findIndex((w, x) => w !== '*' && w !== k[x]); return `word ${i + 1} of "${key}" is "${k[i]}", but "${pattern}" wants "${p[i]}" there, so no match`; }
  return `"${key}" does not fit "${pattern}": the fixed words in the pattern do not line up with the key's words`;
}

/** Binding arguments for a headers exchange: "name=value" lines; x- arguments other than x-match are ignored. */
export const headerArgs = w => (w.hargs || []).map(s => { const i = s.indexOf('='); return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : null; }).filter(a => a && !a[0].startsWith('x-'));

function headersWhy(w, headers) {
  const args = headerArgs(w), match = w.match === 'any' ? 'any' : 'all';
  const has = ([k, v]) => !k.startsWith('x-') && headers[k] === v;
  const want = args.map(([k, v]) => `${k}=${v}`).join(match === 'all' ? ' and ' : ' or ');
  const hs = Object.entries(headers).filter(([k]) => !k.startsWith('x-')).map(([k, v]) => `${k}=${v}`).join(', ') || 'no headers';
  if (!args.length) return match === 'all' ? { ok: true, why: 'x-match=all with no arguments matches every message' } : { ok: false, why: 'x-match=any with no arguments never matches' };
  const hits = args.filter(has), miss = args.filter(a => !has(a));
  if (match === 'all') return miss.length ? { ok: false, why: `x-match=all needs ${want}; the message has ${hs} (missing ${miss.map(a => a.join('=')).join(', ')})` } : { ok: true, why: `x-match=all: the message has ${want}` };
  return hits.length ? { ok: true, why: `x-match=any: ${hits.map(a => a.join('=')).join(', ')} is enough` } : { ok: false, why: `x-match=any needs at least one of ${want}; the message has ${hs}` };
}

/** Does this binding take the message? -> { ok, why } */
export function bindMatch(ex, w, key, headers = {}) {
  if (ex.type === 'fanout') return { ok: true, why: 'fanout ignores the routing key: every bound queue gets a copy' };
  if (ex.type === 'headers') return headersWhy(w, headers);
  const bk = w.key ?? '';
  if (ex.type === 'topic') return { ok: topicMatch(bk, key), why: topicWhy(bk, key) };
  return bk === key ? { ok: true, why: `binding key "${bk}" = routing key "${key}"` }
    : { ok: false, why: `binding key "${bk}" is not routing key "${key}": a direct exchange needs an exact match${bk.replace(/s(?=\.|$)/, '') === key.replace(/s(?=\.|$)/, '') ? ' (look closely at the spelling)' : /[*#]/.test(bk) ? ' (* and # only mean something on a topic exchange)' : ''}` };
}

/** Where one message goes from an exchange: -> { targets: [{ q, trail }], why: [{ ok, text }], viaAe } */
export function route(m, exId, key, headers, seen = new Set(), trail = []) {
  const ex = byId(m, exId);
  const out = { targets: [], why: [] };
  if (!ex || ex.kind !== 'exchange' || seen.has(exId)) return out;
  seen.add(exId);
  const tr = [...trail, exId];
  for (const w of bindingsOf(m, ex)) {
    const dest = byId(m, w.to);
    if (!dest) continue;
    const r = bindMatch(ex, w, key, headers);
    out.why.push({ ok: r.ok, text: `${r.ok ? '✓' : '✕'} ${dest.kind === 'exchange' ? 'exchange ' : ''}${dest.name}: ${r.why}` });
    if (!r.ok) continue;
    if (dest.kind === 'queue') out.targets.push({ q: dest, trail: [...tr, dest.id] });
    else {
      const sub = route(m, dest.id, key, headers, seen, tr);
      out.targets.push(...sub.targets);
      out.why.push(...sub.why.map(x => ({ ok: x.ok, text: `  via ${dest.name}: ${x.text}` })));
    }
  }
  const ae = ex.ae && byId(m, ex.ae);
  if (!out.targets.length && ae) {
    const sub = route(m, ae.id, key, headers, seen, tr);
    out.viaAe = ae.name;
    out.why.push({ ok: !!sub.targets.length, text: `no binding of ${ex.name} matched, so its alternate exchange ${ae.name} takes the message` }, ...sub.why.map(x => ({ ok: x.ok, text: `  via ${ae.name}: ${x.text}` })));
    out.targets.push(...sub.targets);
  }
  const once = new Map();
  for (const t of out.targets) if (!once.has(t.q.id)) once.set(t.q.id, t);   // one copy per queue, however many bindings match
  out.targets = [...once.values()];
  return out;
}

// ---------------------------------------------------------------- the simulation

function heap() {
  const a = [];
  let seq = 0;
  const less = (i, j) => a[i].t < a[j].t || (a[i].t === a[j].t && a[i].seq < a[j].seq);
  const swap = (i, j) => { const x = a[i]; a[i] = a[j]; a[j] = x; };
  return {
    push(e) { e.seq = seq++; a.push(e); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(i, p)) break; swap(i, p); i = p; } },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < a.length && less(l, s)) s = l; if (r < a.length && less(r, s)) s = r; if (s === i) break; swap(i, s); i = s; } }
      return top;
    },
    get size() { return a.length; },
  };
}

export function validate(m) {
  if (!ofKind(m, 'producer').length) return 'There is no producer yet. Add one from the palette and wire it to an exchange.';
  for (const kind of Object.keys(KINDS)) {
    const names = new Set();
    for (const b of ofKind(m, kind)) {
      if (!validName(b.name || '')) return `"${b.name}" is not a valid ${KINDS[kind].label.toLowerCase()} name: letters, digits and - _ . : only.`;
      if (names.has(b.name)) return `Two ${KINDS[kind].label.toLowerCase()}s are called "${b.name}". Names must be unique.`;
      names.add(b.name);
    }
  }
  for (const p of ofKind(m, 'producer')) for (const line of p.messages || []) { const r = parseMsg(line); if (r.error) return `${p.name}: ${r.error}.`; }
  return null;
}

/**
 * Runs the board. sc: { restartAt?: seconds (broker restart, down 2 s), kill?: { consumer: name, at } (crash, no restart),
 * until?: seconds }. -> { error } or { steps, tokens, queues: Map, consumers: Map, counts, msgs: Map, end }
 */
export function simulate(m, sc = {}) {
  const err = validate(m);
  if (err) return { error: err };
  const steps = [];
  const log = (at, who, tone, text) => steps.push({ at: r3(at), who, tone, text, seq: steps.length });
  const cats = new Map();
  /** Logs the first `limit` events of a kind; the rest are summed up at the end. */
  const note = (cat, at, who, tone, text, label, limit = 2) => {
    const c = cats.get(cat) || { n: 0, who, tone, label, limit, last: at };
    c.n++; c.last = at; cats.set(cat, c);
    if (c.n <= limit) log(at, who, tone, text);
  };
  const H = heap();
  const counts = { published: 0, unroutable: 0, returnedHandled: 0, returnedLost: 0, lostAutoAck: 0, lostCrash: 0, lostRestart: 0, lostInFlight: 0,
    deadDropped: 0, looping: 0, ackedFailures: 0, parked: 0, republished: 0, maxLenDropped: 0 };
  const msgs = new Map();          // business id -> { spec, producer, processedBy: Map(name -> n), attempts: Map(consumer -> [t]) }
  const journeys = new Map();      // a few example message paths for the animation
  let now = 0, down = false;
  const upAt = sc.restartAt != null ? r3(sc.restartAt + DOWN_S) : null;

  // ---- state
  const Q = new Map(), C = new Map();
  for (const q of ofKind(m, 'queue')) Q.set(q.id, { b: q, ready: [], unacked: 0, subs: [], rr: 0, st: { in: 0, delivered: 0, redelivered: 0, acked: 0, dead: 0, expired: 0, peak: 0, firstIn: null, lastIn: null } });
  for (const c of ofKind(m, 'consumer')) {
    const q = queueOf(m, c);
    C.set(c.id, { b: c, q: q?.id || null, started: false, alive: true, paused: false, gen: 0, buffer: [], cur: null, busy: false, unacked: 0, processed: 0, failed: 0, done: 0, crashes: 0, lost: 0, crashedOnce: false, got: new Map() });
    if (q) Q.get(q.id).subs.push(c.id);
    else log(0, c.name, 'warn', `${c.name} is not subscribed to any queue, so it never receives anything. Wire a queue's ▶ onto it (that is basic.consume).`);
  }
  const quorum = qs => qs.b.qtype === 'quorum';

  const journey = (msg, outcome, cls) => {
    const sig = msg.trail.join('>') + '|' + outcome;
    if (!journeys.has(sig) && journeys.size < 40) journeys.set(sig, { trail: [...msg.trail], cls, label: msg.key || msgText(msg.spec), at: now });
  };

  // ---- publishing
  let lastPub = 0;
  for (const p of ofKind(m, 'producer')) {
    const ex = exchangeOf(m, p);
    const specs = (p.messages || []).map(parseMsg);
    const total = specs.reduce((s, x) => s + x.count, 0);
    if (!ex) { log(0, p.name, 'warn', `${p.name} is not wired to an exchange, so its ${plural(total, 'message')} go nowhere. Drag its ▶ onto an exchange.`); continue; }
    const rate = Number(p.rate) || 0;
    let n = 0;
    for (const s of specs) for (let i = 0; i < s.count; i++, n++) {
      const t = r3((Number(p.startAt) || 0) + (rate > 0 ? n / rate : 0));
      lastPub = Math.max(lastPub, t);
      H.push({ t, type: 'pub', p, ex, spec: s, n: n + 1 });
    }
    log(0, p.name, 'info', `${p.name} will publish ${plural(total, 'message')} to exchange ${ex.name}${rate > 0 ? ` at ${rate}/s` : ' all at once'}${p.persistent ? ', persistent (delivery mode 2)' : ', transient (delivery mode 1)'}${p.mandatory ? ', mandatory' : ''}${p.confirms ? ', with publisher confirms' : ', no publisher confirms'}.`);
  }
  for (const c of C.values()) if (c.q) H.push({ t: r3(Number(c.b.startAt) || 0), type: 'start', c });
  if (sc.restartAt != null) { H.push({ t: r3(sc.restartAt), type: 'down' }); H.push({ t: upAt, type: 'up' }); }
  if (sc.kill) { const c = [...C.values()].find(x => x.b.name === sc.kill.consumer) || [...C.values()].find(x => x.q); if (c) H.push({ t: r3(sc.kill.at), type: 'crash', c, gen: 0, final: true }); }

  // ---- queue operations
  function enqueue(qs, msg, t) {
    const q = qs.b;
    if (Number(q.maxLength) > 0 && qs.ready.length >= Number(q.maxLength)) {
      const head = qs.ready.shift();
      head.state = 'gone';
      counts.maxLenDropped++;
      note(`maxlen|${q.id}`, t, q.name, 'warn', `${q.name} is full (max-length ${q.maxLength}): the oldest ready message is pushed out of the head (overflow drop-head)${q.dlx ? ' and dead-lettered' : ' and discarded'}.`, 'pushed out by max-length');
      deadLetter(qs, head, 'maxlen', t);
    }
    msg.where = q.id; msg.state = 'ready'; msg.enq = (msg.enq || 0) + 1;
    qs.ready.push(msg);
    qs.st.in++;
    qs.st.firstIn ??= t; qs.st.lastIn = t;
    qs.st.peak = Math.max(qs.st.peak, qs.ready.length);
    if (Number(q.ttl) > 0) H.push({ t: r3(t + Number(q.ttl) / 1000), type: 'exp', qs, msg, enq: msg.enq });
    dispatch(qs, t);
  }

  function dispatch(qs, t) {
    if (down) return;
    const n = qs.subs.length;
    while (qs.ready.length && n) {
      let pick = -1;
      for (let k = 0; k < n; k++) {
        const c = C.get(qs.subs[(qs.rr + k) % n]);
        if (!c.alive || !c.started || c.paused) continue;
        const pf = Number(c.b.prefetch) || 0;
        if (c.b.autoAck || pf === 0 || c.unacked < pf) { pick = (qs.rr + k) % n; break; }
      }
      if (pick < 0) break;
      qs.rr = (pick + 1) % n;
      const c = C.get(qs.subs[pick]);
      const msg = qs.ready.shift();
      msg.state = 'delivered';
      qs.st.delivered++;
      if (msg.redelivered) qs.st.redelivered++;
      if (!c.b.autoAck) { c.unacked++; qs.unacked++; } else qs.st.acked++;
      if (!msg.trail.includes(c.b.id)) msg.trail.push(c.b.id);
      c.buffer.push(msg);
      if (!c.busy) startWork(c, t);
    }
  }

  function startWork(c, t) {
    if (!c.alive || c.paused) { c.busy = false; return; }
    const msg = c.buffer.shift();
    if (!msg) { c.busy = false; c.cur = null; return; }
    c.busy = true; c.cur = msg;
    const work = Math.max(1, Number(c.b.workMs) || 1) / 1000;
    if (Number(c.b.crashAfter) > 0 && !c.crashedOnce && c.done >= Number(c.b.crashAfter)) H.push({ t: r3(t + work / 2), type: 'crash', c, gen: c.gen });
    else H.push({ t: r3(t + work), type: 'done', c, msg, gen: c.gen });
  }

  function settle(c, msg) {
    if (c.b.autoAck) return;
    c.unacked = Math.max(0, c.unacked - 1);
    const qs = Q.get(msg.where);
    if (qs) qs.unacked = Math.max(0, qs.unacked - 1);
  }

  const rejectedFrom = (msg, q) => msg.xdeath.filter(d => d.queue === q && d.reason === 'rejected').reduce((s, d) => s + d.count, 0);

  function deadLetter(qs, msg, reason, t) {
    const q = qs.b;
    qs.st.dead++;
    const why = { rejected: 'was rejected without requeue', expired: `waited longer than ${q.name}'s TTL (${q.ttl} ms)`, delivery_limit: `was returned more than delivery-limit ${q.deliveryLimit} times`, maxlen: 'was pushed out of a full queue' }[reason];
    const dlx = q.dlx && byId(m, q.dlx);
    if (!dlx) {
      counts.deadDropped++;
      msg.state = 'gone';
      note(`dlnone|${q.id}|${reason}`, t, q.name, 'bad', `${msgText(msg.spec)} ${why}, and ${q.name} has no dead-letter exchange: RabbitMQ discards it. It is gone.`, `discarded (${reason}, no DLX)`);
      journey(msg, 'dropped', 'bad');
      return;
    }
    const e = msg.xdeath.find(d => d.queue === q.name && d.reason === reason);
    if (e) e.count++; else msg.xdeath.unshift({ queue: q.name, reason, count: 1 });
    msg.redelivered = false;
    const key = q.dlk || msg.key;
    const r = route(m, dlx.id, key, msg.headers);
    msg.trail.push(dlx.id);
    const where = r.targets.map(x => x.q.name);
    note(`dl|${q.id}|${reason}`, t, q.name, r.targets.length ? 'warn' : 'bad',
      `${msgText(msg.spec)} ${why}: dead-lettered to exchange ${dlx.name} with routing key "${key}" (x-death: ${msg.xdeath.map(d => `${d.queue}/${d.reason} ×${d.count}`).join(', ')})${where.length ? ` → ${where.join(', ')}.` : `, but no binding there matches: dropped.`}`,
      `dead-lettered (${reason})`);
    if (!r.targets.length) { counts.deadDropped++; msg.state = 'gone'; journey(msg, 'dropped', 'bad'); return; }
    r.targets.forEach((x, i) => { const copy = i === 0 ? msg : cloneMsg(msg); copy.trail.push(x.q.id); enqueue(Q.get(x.q.id), copy, t); });
  }

  const cloneMsg = msg => ({ ...msg, trail: [...msg.trail], xdeath: msg.xdeath.map(d => ({ ...d })) });

  function requeue(qs, msg, t, front = true) {
    msg.redelivered = true;
    msg.state = 'ready';
    msg.enq = (msg.enq || 0) + 1;
    if (front) qs.ready.unshift(msg); else qs.ready.push(msg);
    qs.st.peak = Math.max(qs.st.peak, qs.ready.length);
  }

  // ---- events
  let events = 0;
  const until = sc.until ?? 900;
  while (H.size) {
    const e = H.pop();
    if (e.t > until || ++events > 400000) { log(e.t, 'simulator', 'warn', `Stopped the clock at ${r3(e.t)} s: the run would go on (${H.size} events still waiting).`); break; }
    now = e.t;
    if (e.type === 'pub') {
      const { p, ex, spec, n } = e;
      if (sc.restartAt != null && !e.retry && e.t > sc.restartAt - IN_FLIGHT_S && e.t <= sc.restartAt) {
        if (!p.confirms) {
          counts.lostInFlight++;
          note(`inflight|${p.id}`, e.t, p.name, 'bad', `message ${n} was still in the TCP send buffer when the broker went down. Without publisher confirms BasicPublishAsync already returned, so ${p.name} believes it was sent. It never arrived.`, 'lost in flight (no confirms)');
          continue;
        }
        counts.republished++;
        note(`inflight-ok|${p.id}`, e.t, p.name, 'ok', `message ${n} was in flight when the broker went down. With publisher confirms on, no confirm came back, so ${p.name} publishes it again after the reconnect.`, 'republished (no confirm)');
        H.push({ ...e, t: upAt, retry: true });
        continue;
      }
      if (down) { H.push({ ...e, t: upAt, retry: true }); continue; }
      counts.published++;
      const bid = `${p.name}#${n}`;
      msgs.set(bid, { spec, producer: p.name, processedBy: new Map(), attempts: new Map() });
      const r = route(m, ex.id, spec.key, spec.headers);
      const hsig = JSON.stringify(spec.headers);
      note(`route|${ex.id}|${spec.key}|${hsig}`, e.t, ex.name, r.targets.length ? 'info' : 'bad',
        [`${ex.type} exchange got ${msgText(spec)}${r.viaAe ? '' : ':'} `, r.why.map(x => x.text).join('; ') || 'it has no bindings at all', r.targets.length ? ` → ${r.targets.map(x => x.q.name).join(', ')}.` : '.'],
        null, 1);
      const base = { bid, n, spec, key: spec.key, headers: spec.headers, persistent: !!p.persistent, poison: spec.poison, failTimes: spec.failTimes,
        attempts: 0, requeues: 0, redelivered: false, xdeath: [], trail: [p.id], pid: p.id };
      if (!r.targets.length) {
        if (p.mandatory) {
          base.trail.push(ex.id, p.id);
          if (p.onReturn) { counts.returnedHandled++; note(`ret-ok|${p.id}`, e.t, p.name, 'ok', `basic.return: ${msgText(spec)} was unroutable and mandatory, so RabbitMQ sent it back (NO_ROUTE, 312). ${p.name}'s BasicReturnAsync handler stores it for a retry and raises an alert.`, 'returned and handled'); journey(base, 'returned-ok', 'warn'); }
          else { counts.returnedLost++; note(`ret-lost|${p.id}`, e.t, p.name, 'bad', `basic.return: ${msgText(spec)} came back as unroutable (NO_ROUTE, 312), but nothing listens to BasicReturnAsync in ${p.name}, so it is thrown away.`, 'returned, nobody listening'); journey(base, 'returned-lost', 'bad'); }
        } else {
          counts.unroutable++;
          base.trail.push(ex.id);
          note(`drop|${ex.id}|${spec.key}`, e.t, ex.name, 'bad', `${msgText(spec)} matched no binding and ${ex.name} has no alternate exchange. It is not mandatory either, so RabbitMQ drops it silently: no error, no log line, nothing.`, 'dropped as unroutable');
          journey(base, 'dropped', 'bad');
        }
        continue;
      }
      r.targets.forEach((x, i) => {
        const copy = i === 0 ? base : cloneMsg({ ...base, trail: [p.id] });
        copy.trail = [p.id, ...x.trail];
        enqueue(Q.get(x.q.id), copy, e.t);
      });
    } else if (e.type === 'start') {
      e.c.started = true;
      const q = byId(m, e.c.q);
      log(e.t, e.c.b.name, 'info', `${e.c.b.name} subscribes to ${q.name} (BasicConsumeAsync, autoAck: ${!!e.c.b.autoAck}${e.c.b.autoAck ? '' : `, BasicQos prefetch ${Number(e.c.b.prefetch) || 'unlimited (0)'}`}).${e.c.b.autoAck && Number(e.c.b.prefetch) ? ' Prefetch does nothing with autoAck: every message is pushed at once.' : ''}`);
      dispatch(Q.get(e.c.q), e.t);
    } else if (e.type === 'done') {
      const c = e.c, msg = e.msg;
      if (e.gen !== c.gen || !c.alive) continue;
      const qs = Q.get(msg.where) || Q.get(c.q);
      msg.attempts++;
      const info = msgs.get(msg.bid);
      const ak = c.b.name;
      if (!info.attempts.has(ak)) info.attempts.set(ak, []);
      info.attempts.get(ak).push(e.t);
      const fails = msg.poison || msg.attempts <= msg.failTimes;
      if (!fails) {
        c.processed++; c.done++;
        c.got.set(msg.bid, (c.got.get(msg.bid) || 0) + 1);
        info.processedBy.set(ak, (info.processedBy.get(ak) || 0) + 1);
        settle(c, msg);
        if (!c.b.autoAck) qs.st.acked++;
        msg.state = 'done';
        note(`ok|${c.b.id}${msg.attempts > 1 ? '|retry' : ''}`, e.t, c.b.name, 'ok', `${msgText(msg.spec)} processed${msg.attempts > 1 ? ` on attempt ${msg.attempts}` : ''}${c.b.autoAck ? ' (autoAck: it had already left the queue on delivery)' : '; BasicAckAsync removes it from the queue'}.`, msg.attempts > 1 ? 'processed after a retry' : 'processed');
        journey(msg, 'ok', 'ok');
      } else {
        c.failed++;
        const reason = msg.poison ? 'it is malformed: the handler throws every time' : `a transient error (attempt ${msg.attempts} of the ${msg.failTimes} that fail)`;
        if (c.b.autoAck) {
          counts.lostAutoAck++;
          note(`fail-auto|${c.b.id}`, e.t, c.b.name, 'bad', `${msgText(msg.spec)} failed: ${reason}. With autoAck the broker deleted it on delivery, so there is nothing to retry. Lost.`, 'failed with autoAck: lost');
          journey(msg, 'lost', 'bad');
        } else if (Number(c.b.parkAfter) > 0 && msg.attempts >= Number(c.b.parkAfter) && c.b.parkTo && byId(m, c.b.parkTo)) {
          const pk = byId(m, c.b.parkTo);
          settle(c, msg);
          qs.st.acked++;
          const r = route(m, pk.id, msg.key, msg.headers);
          counts.parked++;
          note(`park|${c.b.id}`, e.t, c.b.name, r.targets.length ? 'warn' : 'bad', `${msgText(msg.spec)} failed again: ${reason}. x-death says ${qs.b.name} rejected it ${plural(rejectedFrom(msg, qs.b.name), 'time')} before; this was attempt ${msg.attempts} of ${c.b.parkAfter}, so ${c.b.name} publishes it to ${pk.name} for a human to look at and acks the original${r.targets.length ? ` → ${r.targets.map(x => x.q.name).join(', ')}` : ', but nothing is bound there: it is gone'}.`, 'parked');
          if (!r.targets.length) { counts.deadDropped++; journey(msg, 'dropped', 'bad'); }
          r.targets.forEach((x, i) => { const copy = i === 0 ? msg : cloneMsg(msg); copy.trail.push(pk.id, x.q.id); copy.parked = true; enqueue(Q.get(x.q.id), copy, e.t); });
        } else if (c.b.onError === 'ack') {
          settle(c, msg);
          qs.st.acked++;
          counts.ackedFailures++;
          msg.state = 'gone';
          note(`fail-ack|${c.b.id}`, e.t, c.b.name, 'bad', `${msgText(msg.spec)} failed: ${reason}. The handler catches the error and acks anyway, so the message is deleted. Nobody will ever know it was not processed.`, 'failed and acked: lost');
          journey(msg, 'lost', 'bad');
        } else if (c.b.onError === 'reject') {
          settle(c, msg);
          note(`fail-rej|${c.b.id}`, e.t, c.b.name, 'warn', `${msgText(msg.spec)} failed: ${reason}. BasicRejectAsync(requeue: false) hands it to the queue's dead-letter exchange.`, 'rejected');
          deadLetter(qs, msg, 'rejected', e.t);
        } else {
          settle(c, msg);
          msg.requeues++;
          const limit = Number(qs.b.deliveryLimit) || 0;
          if (quorum(qs) && limit > 0 && msg.requeues > limit) {
            note(`dlimit|${qs.b.id}`, e.t, qs.b.name, 'warn', `${msgText(msg.spec)} came back ${plural(msg.requeues, 'time')}: more than the quorum queue's delivery-limit ${limit}.`, 'delivery-limit reached');
            deadLetter(qs, msg, 'delivery_limit', e.t);
          } else if (msg.requeues >= LOOP_CAP) {
            counts.looping++;
            msg.state = 'looping';
            log(e.t, c.b.name, 'bad', `${msgText(msg.spec)} has been redelivered ${LOOP_CAP} times, still looping. Nack with requeue puts it straight back at the head of ${qs.b.name}, it fails again, forever: it burns CPU, floods the logs and holds a prefetch slot. The simulator stops it here; RabbitMQ would not.`);
            journey(msg, 'looping', 'bad');
          } else {
            note(`fail-req|${c.b.id}|${msg.poison ? 'p' : 't'}`, e.t, c.b.name, msg.poison ? 'bad' : 'warn', `${msgText(msg.spec)} failed: ${reason}. BasicNackAsync(requeue: true) puts it back on ${qs.b.name} with redelivered = true, and it is delivered again at once${msg.poison ? ': a poison message never gets better' : ', milliseconds later: the failing service has no time to recover'}.`, msg.poison ? 'requeued poison message' : 'immediate requeue');
            requeue(qs, msg, e.t, true);
          }
        }
        c.done++;
      }
      if (qs) dispatch(qs, e.t);
      startWork(c, e.t);
    } else if (e.type === 'crash') {
      const c = e.c;
      if (e.gen !== c.gen || !c.alive) continue;
      c.alive = false; c.gen++; c.crashes++; c.crashedOnce = true; c.busy = false;
      const held = [c.cur, ...c.buffer].filter(Boolean);
      c.cur = null; c.buffer = [];
      const qs = Q.get(c.q);
      if (c.b.autoAck) {
        counts.lostCrash += held.length; c.lost += held.length;
        held.forEach(x => { x.state = 'gone'; journey(x, 'lost-crash', 'bad'); });
        log(e.t, c.b.name, 'bad', `${c.b.name} crashed in the middle of a message. It held ${plural(held.length, 'message')} that autoAck had already removed from ${qs.b.name} on delivery: ${held.length ? 'all of them are lost' : 'luckily none'}. The broker never hears about it.`);
      } else {
        for (const x of held.reverse()) { requeue(qs, x, e.t, true); }
        c.unacked = 0; qs.unacked = Math.max(0, qs.unacked - held.length);
        log(e.t, c.b.name, 'warn', `${c.b.name} crashed in the middle of a message. Its connection closed with ${plural(held.length, 'unacked message')}, so RabbitMQ puts them back on ${qs.b.name} (redelivered = true). Nothing is lost; the one it was working on will be processed again.`);
      }
      if (!e.final) H.push({ t: r3(e.t + RESTART_S), type: 'restart', c });
      else log(e.t, c.b.name, 'info', `${c.b.name} stays down.`);
      dispatch(qs, e.t);
    } else if (e.type === 'restart') {
      e.c.alive = true;
      log(e.t, e.c.b.name, 'info', `${e.c.b.name} is started again (its process supervisor restarts it after ${RESTART_S} s) and subscribes again.`);
      dispatch(Q.get(e.c.q), e.t);
    } else if (e.type === 'exp') {
      const { qs, msg } = e;
      if (msg.where !== qs.b.id || msg.state !== 'ready' || msg.enq !== e.enq) continue;
      const i = qs.ready.indexOf(msg);
      if (i < 0) continue;
      qs.ready.splice(i, 1);
      qs.st.expired++;
      deadLetter(qs, msg, 'expired', e.t);
    } else if (e.type === 'down') {
      down = true;
      log(e.t, 'broker', 'bad', `The RabbitMQ node goes down (a restart: a deploy, an OOM kill, a host reboot). Every connection drops; it is back at ${upAt} s.`);
      for (const c of C.values()) {
        if (!c.alive || !c.q) continue;
        c.paused = true;
        if (c.b.autoAck) continue;
        const held = [c.cur, ...c.buffer].filter(Boolean);
        c.gen++; c.busy = false; c.cur = null; c.buffer = [];
        const qs = Q.get(c.q);
        for (const x of held.reverse()) requeue(qs, x, e.t, true);
        c.unacked = 0; qs.unacked = 0;
        if (held.length) log(e.t, c.b.name, 'info', `${c.b.name} lost its connection with ${plural(held.length, 'unacked message')}; they go back to ${qs.b.name} if the queue survives.`);
      }
      for (const ex of ofKind(m, 'exchange')) if (!ex.durable) log(e.t, ex.name, 'bad', `Exchange ${ex.name} is not durable: the restart deletes it together with all its bindings. The apps' topology recovery may declare it again, but until then every publish to it fails with NOT_FOUND.`);
      for (const qs of Q.values()) {
        const q = qs.b, n = qs.ready.length;
        if (quorum(qs)) { if (n) log(e.t, q.name, 'ok', `Quorum queue ${q.name} keeps all ${plural(n, 'message')}: quorum queues are always durable and write every message to disk (Raft log), whatever the delivery mode.`); continue; }
        if (!q.durable) {
          counts.lostRestart += n;
          qs.ready.forEach(x => { x.state = 'gone'; journey(x, 'lost-restart', 'bad'); });
          qs.ready = [];
          log(e.t, q.name, 'bad', `${q.name} is a non-durable classic queue: the restart deletes it${n ? ` and its ${plural(n, 'message')}` : ''}. When the apps declare it again, it is empty.`);
          continue;
        }
        const keep = qs.ready.filter(x => x.persistent), lost = n - keep.length;
        counts.lostRestart += lost;
        qs.ready.filter(x => !x.persistent).forEach(x => { x.state = 'gone'; journey(x, 'lost-restart', 'bad'); });
        qs.ready = keep;
        log(e.t, q.name, lost ? 'bad' : 'ok', lost
          ? `${q.name} is durable, so the queue itself survives, but ${plural(lost, 'message was', 'messages were')} transient (delivery mode 1, not persistent): kept in memory only, gone after the restart.${keep.length ? ` ${keep.length} persistent ones survive.` : ''}`
          : `${q.name} is durable and its ${plural(n, 'message is', 'messages are')} persistent: all survive the restart.`);
      }
    } else if (e.type === 'up') {
      down = false;
      log(e.t, 'broker', 'ok', 'The node is back. Clients reconnect (RabbitMQ.Client automatic recovery) and consumers subscribe again.');
      for (const c of C.values()) c.paused = false;
      for (const qs of Q.values()) dispatch(qs, e.t);
      for (const c of C.values()) if (c.alive && !c.busy && c.buffer.length) startWork(c, e.t);
    }
  }
  for (const c of cats.values()) if (c.n > c.limit && c.label) log(c.last, c.who, c.tone === 'ok' ? 'ok' : 'info', `… plus ${plural(c.n - c.limit, 'more message')} like that (${c.label}).`);

  // ---- throughput: messages in vs what the consumers can do
  for (const qs of Q.values()) {
    const span = (qs.st.lastIn ?? 0) - (qs.st.firstIn ?? 0);
    const subs = qs.subs.map(id => C.get(id));
    const cap = subs.reduce((s, c) => s + 1000 / Math.max(1, Number(c.b.workMs) || 1), 0);
    qs.st.inRate = span >= 1 ? Math.round((qs.st.in - 1) / span) : null;
    qs.st.capacity = Math.round(cap);
    if (qs.st.inRate && subs.length && (qs.st.inRate - cap > 0.5 || qs.st.inRate >= 20)) {
      const grow = qs.st.inRate - cap;
      log(now, qs.b.name, grow > 0.5 ? 'bad' : 'ok', grow > 0.5
        ? `Messages arrived at about ${qs.st.inRate}/s, but ${subs.map(c => `${c.b.name} handles ${Math.round(1000 / Math.max(1, c.b.workMs))}/s`).join(', ')} (${Math.round(cap)}/s in total): the backlog grew by about ${Math.round(grow)} messages a second and peaked at ${qs.st.peak}. Add competing consumers on this same queue.`
        : `Messages arrived at about ${qs.st.inRate}/s and the consumers can do ${Math.round(cap)}/s together, so the queue stays short (peak ${qs.st.peak} ready).`);
    }
  }
  steps.sort((a, b) => a.at - b.at || a.seq - b.seq);

  // ---- results
  const queues = new Map(), consumers = new Map();
  for (const [id, qs] of Q) queues.set(id, { name: qs.b.name, ready: qs.ready.length, unacked: qs.unacked, held: qs.ready.map(x => x.bid), heldMsgs: qs.ready, ...qs.st, subs: qs.subs.length });
  for (const [id, c] of C) consumers.set(id, { name: c.b.name, queue: c.q && byId(m, c.q).name, processed: c.processed, failed: c.failed, crashes: c.crashes, lost: c.lost, got: c.got, unique: c.got.size });
  let dupes = 0;
  for (const x of msgs.values()) { const total = [...x.processedBy.values()].reduce((s, n) => s + n, 0); if (total > 1) dupes += total - 1; }
  counts.duplicates = dupes;
  counts.lost = counts.unroutable + counts.returnedLost + counts.lostAutoAck + counts.lostCrash + counts.lostRestart + counts.lostInFlight + counts.deadDropped + counts.ackedFailures;
  const tokens = [...journeys.values()].sort((a, b) => a.at - b.at).map(j => ({ hops: j.trail.slice(1).map((to, i) => ({ from: j.trail[i], to })), cls: 'req', endCls: j.cls, label: j.label }));
  return { steps, tokens, queues, consumers, counts, msgs, end: r3(now) };
}

// ---------------------------------------------------------------- the real commands for this board

const jsonArgs = o => `'${JSON.stringify(o)}'`;
const cs = s => JSON.stringify(s);

export function queueArgs(m, q) {
  const a = {};
  if (q.qtype === 'quorum') a['x-queue-type'] = 'quorum';
  if (Number(q.ttl) > 0) a['x-message-ttl'] = Number(q.ttl);
  const dlx = q.dlx && byId(m, q.dlx);
  if (dlx) a['x-dead-letter-exchange'] = dlx.name;
  if (dlx && q.dlk) a['x-dead-letter-routing-key'] = q.dlk;
  if (q.qtype === 'quorum') a['x-delivery-limit'] = Number(q.deliveryLimit) > 0 ? Number(q.deliveryLimit) : -1;
  if (Number(q.maxLength) > 0) a['x-max-length'] = Number(q.maxLength);
  return a;
}

export function toText(m) {
  const L = [];
  const exs = ofKind(m, 'exchange'), qs = ofKind(m, 'queue');
  L.push('# The RabbitMQ topology on this board, as real commands.', '# 1) rabbitmqadmin (v2 syntax) against the management API:');
  for (const e of exs) L.push(`rabbitmqadmin declare exchange --name ${e.name} --type ${e.type} --durable ${!!e.durable}`);
  for (const q of qs) {
    const a = queueArgs(m, q);
    L.push(`rabbitmqadmin declare queue --name ${q.name} --durable ${q.qtype === 'quorum' ? true : !!q.durable}${Object.keys(a).length ? ` --arguments ${jsonArgs(a)}` : ''}`);
  }
  for (const e of exs) for (const w of bindingsOf(m, e)) {
    const d = byId(m, w.to);
    if (!d) continue;
    const ha = e.type === 'headers' ? { 'x-match': w.match === 'any' ? 'any' : 'all', ...Object.fromEntries(headerArgs(w)) } : null;
    L.push(`rabbitmqadmin declare binding --source ${e.name} --destination-type ${d.kind} --destination ${d.name}${ha ? ` --arguments ${jsonArgs(ha)}` : ` --routing-key ${cs(w.key ?? '')}`}`);
  }
  const aes = exs.filter(e => e.ae && byId(m, e.ae));
  if (aes.length) {
    L.push('# Alternate exchanges are best set by policy (no redeclare needed to change them):');
    for (const e of aes) L.push(`rabbitmqctl set_policy ${e.name}-ae "^${e.name.replace(/\./g, '\\.')}$" ${jsonArgs({ 'alternate-exchange': byId(m, e.ae).name })} --apply-to exchanges`);
  }
  const dls = qs.filter(q => q.dlx && byId(m, q.dlx));
  if (dls.length) {
    L.push('# Dead-lettering can be a policy too (then the queue arguments above are not needed):');
    for (const q of dls) L.push(`rabbitmqctl set_policy ${q.name}-dlx "^${q.name.replace(/\./g, '\\.')}$" ${jsonArgs({ 'dead-letter-exchange': byId(m, q.dlx).name, ...(q.dlk ? { 'dead-letter-routing-key': q.dlk } : {}) })} --apply-to queues`);
  }
  L.push('', '# 2) The same from C#, RabbitMQ.Client 7 (async API):', 'await using var conn = await factory.CreateConnectionAsync();');
  for (const p of ofKind(m, 'producer')) L.push(`await using var ${idf(p.name)} = await conn.CreateChannelAsync(new CreateChannelOptions(publisherConfirmationsEnabled: ${!!p.confirms}, publisherConfirmationTrackingEnabled: ${!!p.confirms}));`);
  const ch = ofKind(m, 'producer')[0] ? idf(ofKind(m, 'producer')[0].name) : 'channel';
  for (const e of exs) L.push(`await ${ch}.ExchangeDeclareAsync(${cs(e.name)}, ExchangeType.${(e.type || 'direct')[0].toUpperCase() + (e.type || 'direct').slice(1)}, durable: ${!!e.durable}${e.ae && byId(m, e.ae) ? `, arguments: new Dictionary<string, object?> { ["alternate-exchange"] = ${cs(byId(m, e.ae).name)} }` : ''});`);
  for (const q of qs) {
    const a = queueArgs(m, q);
    const args = Object.entries(a).map(([k, v]) => `[${cs(k)}] = ${typeof v === 'number' ? v : cs(v)}`).join(', ');
    L.push(`await ${ch}.QueueDeclareAsync(${cs(q.name)}, durable: ${q.qtype === 'quorum' ? true : !!q.durable}, exclusive: false, autoDelete: false${args ? `, arguments: new Dictionary<string, object?> { ${args} }` : ''});`);
  }
  for (const e of exs) for (const w of bindingsOf(m, e)) {
    const d = byId(m, w.to);
    if (!d) continue;
    const call = d.kind === 'exchange' ? 'ExchangeBindAsync' : 'QueueBindAsync';
    const ha = e.type === 'headers' ? `, arguments: new Dictionary<string, object?> { ["x-match"] = ${cs(w.match === 'any' ? 'any' : 'all')}${headerArgs(w).map(([k, v]) => `, [${cs(k)}] = ${cs(v)}`).join('')} }` : '';
    L.push(`await ${ch}.${call}(${cs(d.name)}, ${cs(e.name)}, routingKey: ${cs(e.type === 'headers' || e.type === 'fanout' ? '' : w.key ?? '')}${ha});`);
  }
  for (const p of ofKind(m, 'producer')) {
    const ex = exchangeOf(m, p);
    const first = parseMsg(p.messages?.[0] || '');
    const v = idf(p.name);
    if (p.mandatory && p.onReturn) L.push(`${v}.BasicReturnAsync += async (_, ea) => await SaveForRetry(ea);   // mandatory messages that matched nothing come back here`);
    L.push(`await ${v}.BasicPublishAsync(${cs(ex?.name || '')}, ${cs(first.error ? '' : first.key)}, mandatory: ${!!p.mandatory}, basicProperties: new BasicProperties { Persistent = ${!!p.persistent}${first.error || !Object.keys(first.headers).length ? '' : `, Headers = new Dictionary<string, object?> { ${Object.entries(first.headers).map(([k, x]) => `[${cs(k)}] = ${cs(x)}`).join(', ')} }`} }, body: body);${p.confirms ? '   // with confirms on, this awaits the broker\'s ack and throws if it nacks' : ''}`);
  }
  for (const c of ofKind(m, 'consumer')) {
    const q = queueOf(m, c);
    const v = idf(c.name);
    L.push(`# ${c.name}${q ? ` reads ${q.name}` : ' (not subscribed yet)'}`);
    if (!c.autoAck) L.push(`await ${v}.BasicQosAsync(prefetchSize: 0, prefetchCount: ${Math.max(0, Math.min(65535, Number(c.prefetch) || 0))}, global: false);${Number(c.prefetch) ? '' : '   // 0 = unlimited'}`);
    const onErr = c.onError === 'reject' ? `await ${v}.BasicRejectAsync(ea.DeliveryTag, requeue: false)` : c.onError === 'ack' ? `await ${v}.BasicAckAsync(ea.DeliveryTag, multiple: false)` : `await ${v}.BasicNackAsync(ea.DeliveryTag, multiple: false, requeue: true)`;
    if (!c.autoAck) L.push(`# on success: await ${v}.BasicAckAsync(ea.DeliveryTag, multiple: false);   on error: ${onErr};`);
    if (!c.autoAck && Number(c.parkAfter) > 0 && byId(m, c.parkTo)) L.push(`# when x-death shows ${Number(c.parkAfter) - 1} earlier attempts: publish to ${cs(byId(m, c.parkTo).name)}, then ack`);
    L.push(`await ${v}.BasicConsumeAsync(${cs(q?.name || '')}, autoAck: ${!!c.autoAck}, consumer: ${v}Consumer);`);
  }
  return L.join('\n') + '\n';
}
const idf = n => n.replace(/[^A-Za-z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : '')).replace(/^./, ch => ch.toLowerCase()).replace(/^(\d)/, '_$1');

// ---------------------------------------------------------------- challenges

export const partsCost = m => m.blocks.length + m.wires.length;
const starsFor = (c, par, slack = 2) => (c <= par ? 3 : c <= par + slack ? 2 : 1);
const goal = (label, ok, why) => ({ label, ok: !!ok, why: ok ? '' : why });
const P = (name, x, y, s) => block('producer', 'p-' + name, name, x, y, s);
const X = (name, x, y, s) => block('exchange', 'x-' + name, name, x, y, s);
const Qb = (name, x, y, s) => block('queue', 'q-' + name, name, x, y, s);
const Cb = (name, x, y, s) => block('consumer', 'c-' + name, name, x, y, s);
const bind = (from, to, extra = {}) => wire(from, to, { key: '', match: 'all', hargs: [], ...extra });
const B = (m, kind, name) => byName(m, kind, name);
const cons = (R, m, name) => { const c = B(m, 'consumer', name); return c && R.consumers?.get(c.id); };
const qr = (R, m, name) => { const q = B(m, 'queue', name); return q && R.queues?.get(q.id); };
const got = (R, m, name) => cons(R, m, name)?.unique || 0;
/** Queues (other than `except`) that hold a message of this spec at the end. */
const holding = (R, test) => [...(R.queues?.values() || [])].filter(q => q.heldMsgs.some(test));
const lostWhy = R => {
  const c = R.counts || {};
  const parts = [c.unroutable && `${c.unroutable} dropped as unroutable`, c.returnedLost && `${c.returnedLost} returned with nobody listening`, c.lostAutoAck && `${c.lostAutoAck} failed under autoAck`,
    c.lostCrash && `${c.lostCrash} lost in a crash under autoAck`, c.lostRestart && `${c.lostRestart} lost in the restart`, c.lostInFlight && `${c.lostInFlight} lost in flight`,
    c.deadDropped && `${c.deadDropped} dead-lettered to nowhere`, c.ackedFailures && `${c.ackedFailures} acked after failing`].filter(Boolean);
  return parts.length ? parts.join(', ') : '';
};
const noLoss = (R, label = 'no message is lost') => goal(label, R.counts && !R.counts.lost, `${lostWhy(R)}. Run it and read the red lines.`);

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free board. Producers publish to exchanges, bindings route to queues, consumers read them. Change exchange types, binding keys, prefetch, ack modes, TTLs and dead-lettering, then press **Publish and consume** or **Restart the broker**. The commands on the right follow every change.',
    setup: () => ({ blocks: [P('shop', 40, 200, { messages: ['order.eu.created x4', 'order.us.created x3', 'order.eu.shipped x2', 'order.us.created poison'], rate: 4 }),
      X('events', 340, 200, { type: 'topic' }), Qb('billing', 640, 60, { qtype: 'quorum', deliveryLimit: 3, dlx: 'x-dlx' }), Qb('shipping', 640, 340), X('dlx', 940, 420, { type: 'fanout' }), Qb('billing.dlq', 1240, 420),
      Cb('billing', 940, 60, { onError: 'requeue', prefetch: 10 }), Cb('warehouse', 940, 260)],
    wires: [wire('p-shop', 'x-events'), bind('x-events', 'q-billing', { key: 'order.*.created' }), bind('x-events', 'q-shipping', { key: 'order.#' }), bind('x-dlx', 'q-billing.dlq'),
      wire('q-billing', 'c-billing'), wire('q-shipping', 'c-warehouse')] }),
    solve: m => m, check: () => [] },

  { id: 'first-binding', title: 'First binding', xp: 15,
    brief: 'The shop publishes **order.created** to the direct exchange **orders**, but the **billing** service never receives a thing, and the shop sees no error. A direct exchange copies a message to every queue whose **binding key equals the routing key**, character for character. Click the binding wire and read its key.',
    setup: () => ({ blocks: [P('shop', 40, 160, { messages: ['order.created x5'], rate: 5 }), X('orders', 340, 160), Qb('billing', 640, 160), Cb('billing', 940, 160)],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-billing', { key: 'orders.created' }), wire('q-billing', 'c-billing')] }),
    solve: m => { m.wires.find(w => w.to === 'q-billing').key = 'order.created'; return m; },
    check: (m, R) => [goal('billing processes all 5 orders', got(R, m, 'billing') === 5, `billing got ${got(R, m, 'billing')} of 5. ${R.counts?.unroutable ? `${R.counts.unroutable} were dropped as unroutable: no binding key matched.` : ''}`), noLoss(R)] },

  { id: 'wildcard', title: 'The wildcard that never matches', xp: 20,
    brief: 'Orders are published to the topic exchange **events** with keys like **order.eu.created** and **order.us.created**. The warehouse queue is bound with **order.\\***, yet it stays empty. On a topic exchange keys are split into words at the dots: **\\*** matches exactly one word, **#** matches zero or more. Make the binding catch every *created* order, from any region.',
    setup: () => ({ blocks: [P('shop', 40, 160, { messages: ['order.eu.created x3', 'order.us.created x3', 'order.eu.shipped x2'], rate: 5 }), X('events', 340, 160, { type: 'topic' }), Qb('new-orders', 640, 160), Cb('warehouse', 940, 160)],
      wires: [wire('p-shop', 'x-events'), bind('x-events', 'q-new-orders', { key: 'order.*' }), wire('q-new-orders', 'c-warehouse')] }),
    solve: m => { m.wires.find(w => w.to === 'q-new-orders').key = 'order.*.created'; return m; },
    check: (m, R) => {
      const c = cons(R, m, 'warehouse');
      const created = c ? [...c.got.keys()].filter(bid => /created/.test(R.msgs.get(bid)?.spec.key)).length : 0;
      return [goal('warehouse gets all 6 created orders (EU and US)', created === 6, `warehouse got ${created} of the 6 created orders. "order.eu.created" has three words.`)];
    } },

  { id: 'fanout', title: 'Everyone gets a copy', xp: 25,
    brief: '**billing**, **email** and **analytics** each need *every* order. Today all three read the one **orders** queue, so they compete: RabbitMQ hands each message to one consumer, round robin, and each service sees only a third. A queue is a work list, not a broadcast. Give each service its own queue, all bound to the exchange (a **fanout** exchange copies to every bound queue without looking at keys).',
    setup: () => ({ blocks: [P('shop', 40, 220, { messages: ['order.created x30'], rate: 10 }), X('orders', 340, 220), Qb('orders', 640, 220), Cb('billing', 940, 60), Cb('email', 940, 220), Cb('analytics', 940, 380)],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-orders', { key: 'order.created' }), wire('q-orders', 'c-billing'), wire('q-orders', 'c-email'), wire('q-orders', 'c-analytics')] }),
    solve: m => {
      B(m, 'exchange', 'orders').type = 'fanout';
      B(m, 'queue', 'orders').name = 'billing';
      m.blocks.push(Qb('email', 640, 380), Qb('analytics', 640, 540));
      m.wires = m.wires.filter(w => !(w.from === 'q-orders' && w.to !== 'c-billing'));
      m.wires.push(bind('x-orders', 'q-email'), bind('x-orders', 'q-analytics'), wire('q-email', 'c-email'), wire('q-analytics', 'c-analytics'));
      return m;
    },
    check: (m, R) => ['billing', 'email', 'analytics'].map(n => goal(`${n} processes all 30 orders`, got(R, m, n) === 30, `${n} processed ${got(R, m, n)} of 30. Consumers on one queue share it; each service needs a queue of its own.`)) },

  { id: 'headers', title: 'Route on headers', xp: 25,
    brief: 'Reports go to the **headers** exchange **reports** with headers like `format=pdf type=invoice` and no routing key. **accounting** wants only PDF invoices; **audit** must see anything that is a PDF *or* an invoice. Both bindings use **format=pdf, type=invoice**, but the x-match settings are the wrong way round. `x-match=all` needs every argument to match, `x-match=any` needs one.',
    setup: () => ({ blocks: [P('reporting', 40, 200, { messages: ['- format=pdf type=invoice x2', '- format=csv type=invoice x2', '- format=pdf type=report x2', '- format=csv type=report x2'], rate: 5 }),
      X('reports', 340, 200, { type: 'headers' }), Qb('pdf-invoices', 640, 80), Qb('audit', 640, 320), Cb('accounting', 940, 80), Cb('auditor', 940, 320)],
    wires: [wire('p-reporting', 'x-reports'), bind('x-reports', 'q-pdf-invoices', { match: 'any', hargs: ['format=pdf', 'type=invoice'] }), bind('x-reports', 'q-audit', { match: 'all', hargs: ['format=pdf', 'type=invoice'] }),
      wire('q-pdf-invoices', 'c-accounting'), wire('q-audit', 'c-auditor')] }),
    solve: m => { m.wires.find(w => w.to === 'q-pdf-invoices').match = 'all'; m.wires.find(w => w.to === 'q-audit').match = 'any'; return m; },
    check: (m, R) => {
      const acc = cons(R, m, 'accounting'), aud = cons(R, m, 'auditor');
      const kinds = c => (c ? [...c.got.keys()].map(b => R.msgs.get(b).spec.headers) : []);
      const a = kinds(acc), d = kinds(aud);
      return [goal('accounting gets exactly the 2 PDF invoices', a.length === 2 && a.every(h => h.format === 'pdf' && h.type === 'invoice'), `accounting got ${a.length}: ${a.map(h => `${h.format} ${h.type}`).join(', ') || 'nothing'}.`),
        goal('audit gets the 6 that are a PDF or an invoice, not the CSV reports', d.length === 6 && d.every(h => h.format === 'pdf' || h.type === 'invoice'), `audit got ${d.length} (it should be 6).`)];
    } },

  { id: 'unroutable', title: 'Nowhere to go', xp: 30,
    brief: 'The shop started publishing **order.refunded**, and nobody bound a queue for it. RabbitMQ drops a message that matches no binding, **silently**: no error for the publisher, nothing in a queue. Make sure no message can vanish: give **orders** an **alternate exchange** that catches the unroutable ones in an **unrouted** queue (or publish them as **mandatory** and handle the **basic.return**).',
    setup: () => ({ blocks: [P('shop', 40, 160, { messages: ['order.created x3', 'order.refunded x2'], rate: 5 }), X('orders', 340, 160), Qb('billing', 640, 160), Cb('billing', 940, 160)],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-billing', { key: 'order.created' }), wire('q-billing', 'c-billing')] }),
    solve: m => { m.blocks.push(X('unrouted', 340, 400, { type: 'fanout' }), Qb('unrouted', 640, 400)); m.wires.push(bind('x-unrouted', 'q-unrouted')); B(m, 'exchange', 'orders').ae = 'x-unrouted'; return m; },
    check: (m, R) => {
      const refunds = holding(R, x => x.spec.key === 'order.refunded').reduce((s, q) => s + q.heldMsgs.filter(x => x.spec.key === 'order.refunded').length, 0) + (R.counts?.returnedHandled || 0);
      return [goal('billing still gets the 3 order.created', got(R, m, 'billing') === 3, `billing got ${got(R, m, 'billing')} of 3.`),
        goal('the 2 refunds are kept (in a queue, or returned to a publisher that handles them)', refunds >= 2, `${refunds} of 2 refunds were kept. ${lostWhy(R)}`),
        noLoss(R, 'nothing is dropped silently')];
    } },

  { id: 'autoack', title: 'Auto-ack ate my order', xp: 30,
    brief: '**billing** crashed after three orders, came back two seconds later, and 17 orders were never charged. It consumes with **autoAck: true**: RabbitMQ deletes a message the moment it is *delivered*, so everything in the consumer\'s memory dies with the process. Switch to **manual acks** (ack after the work is done): unacked messages go back to the queue when the connection drops.',
    setup: () => ({ blocks: [P('shop', 40, 160, { messages: ['order.created x20'], rate: 0 }), X('orders', 340, 160), Qb('orders', 640, 160), Cb('billing', 940, 160, { autoAck: true, prefetch: 10, workMs: 200, crashAfter: 3 })],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-orders', { key: 'order.created' }), wire('q-orders', 'c-billing')] }),
    solve: m => { B(m, 'consumer', 'billing').autoAck = false; return m; },
    check: (m, R) => [goal('all 20 orders are processed', got(R, m, 'billing') === 20, `billing processed ${got(R, m, 'billing')} of 20. ${lostWhy(R)}`), noLoss(R, 'no order is lost in the crash')] },

  { id: 'poison', title: 'The poison loop', xp: 35,
    brief: 'One malformed order makes the handler throw, and **billing** answers with `BasicNack(requeue: true)`. The message goes straight back to the head of the queue, fails again, and again: CPU at 100%, logs flooded, forever. A message that can never succeed must leave the queue: **reject without requeue** and give the queue a **dead-letter exchange** that routes to a **dead-letter queue** (or use a **quorum** queue with a small **delivery-limit** plus a DLX).',
    setup: () => ({ blocks: [P('shop', 40, 160, { messages: ['order.created x2', 'order.created poison', 'order.created x3'], rate: 5 }), X('orders', 340, 160), Qb('orders', 640, 160), Cb('billing', 940, 160, { workMs: 50, onError: 'requeue' })],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-orders', { key: 'order.created' }), wire('q-orders', 'c-billing')] }),
    solve: m => {
      m.blocks.push(X('dlx', 640, 400, { type: 'fanout' }), Qb('orders.dlq', 940, 400));
      m.wires.push(bind('x-dlx', 'q-orders.dlq'));
      B(m, 'queue', 'orders').dlx = 'x-dlx';
      B(m, 'consumer', 'billing').onError = 'reject';
      return m;
    },
    check: (m, R) => {
      const dlq = holding(R, x => x.spec.poison && !x.parked).filter(q => q.name !== 'orders');
      return [goal('the poison message stops looping', !R.counts?.looping, `it was redelivered ${LOOP_CAP} times and was still looping.`),
        goal('it ends up in a dead-letter queue, not deleted', dlq.length > 0, R.counts?.deadDropped ? 'it was dead-lettered, but there was no dead-letter exchange (or no queue bound to it), so it was discarded.' : 'no queue other than orders holds it at the end.'),
        goal('the 5 good orders are processed', got(R, m, 'billing') === 5, `billing processed ${got(R, m, 'billing')} of 5.`)];
    } },

  { id: 'prefetch', title: 'One greedy consumer', xp: 30,
    brief: 'Two workers read the **jobs** queue; 200 jobs were waiting overnight. **worker-1** connects first and, with **prefetch 0 (unlimited)**, RabbitMQ pushes it *all 200*. **worker-2** connects half a second later and has nothing to do. Set a **prefetch** (BasicQos) of about 10 on both: a consumer then holds at most that many unacked messages, and the rest wait in the queue for whoever is free.',
    setup: () => ({ blocks: [P('nightly', 40, 200, { messages: ['job.render x200'], rate: 0 }), X('jobs', 340, 200), Qb('jobs', 640, 200), Cb('worker-1', 940, 100, { prefetch: 0, workMs: 100, startAt: 0.2 }), Cb('worker-2', 940, 320, { prefetch: 0, workMs: 100, startAt: 0.7 })],
      wires: [wire('p-nightly', 'x-jobs'), bind('x-jobs', 'q-jobs', { key: 'job.render' }), wire('q-jobs', 'c-worker-1'), wire('q-jobs', 'c-worker-2')] }),
    solve: m => { B(m, 'consumer', 'worker-1').prefetch = 10; B(m, 'consumer', 'worker-2').prefetch = 10; return m; },
    check: (m, R) => [goal('worker-2 does at least 40% of the jobs', got(R, m, 'worker-2') >= 80, `worker-2 did ${got(R, m, 'worker-2')} of 200.`),
      goal('all 200 jobs are done within 12 s', got(R, m, 'worker-1') + got(R, m, 'worker-2') === 200 && R.end <= 12, `${got(R, m, 'worker-1') + got(R, m, 'worker-2')} jobs done, the last at ${R.end} s.`)] },

  { id: 'retry', title: 'Retry later, not now', xp: 45,
    brief: 'The payment API has short outages, so some orders fail once or twice and then work. **billing** requeues them at once, retrying within milliseconds while the API is still down, and one truly broken order loops forever. Build a **delayed retry**: reject the failure into a **retry queue with a TTL** (say 5000 ms) whose dead-letter exchange is the work exchange again, so the order comes back later. After **3 attempts**, billing should publish it to a **parking lot** queue instead (set *park after* and *park to* on the consumer).',
    setup: () => ({ blocks: [P('shop', 40, 200, { messages: ['order.created x4', 'order.created fail=2 x2', 'order.created poison'], rate: 5 }), X('orders', 340, 200), Qb('orders', 640, 200), Cb('billing', 940, 200, { workMs: 50, onError: 'requeue' })],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-orders', { key: 'order.created' }), wire('q-orders', 'c-billing')] }),
    solve: m => {
      m.blocks.push(X('orders.retry', 340, 440, { type: 'fanout' }), Qb('orders.retry', 640, 440, { ttl: 5000, dlx: 'x-orders' }), X('parking', 1240, 200, { type: 'fanout' }), Qb('parking-lot', 1240, 440));
      m.wires.push(bind('x-orders.retry', 'q-orders.retry'), bind('x-parking', 'q-parking-lot'));
      B(m, 'queue', 'orders').dlx = 'x-orders.retry';
      Object.assign(B(m, 'consumer', 'billing'), { onError: 'reject', parkAfter: 3, parkTo: 'x-parking' });
      return m;
    },
    check: (m, R) => {
      const c = cons(R, m, 'billing');
      const transient = [...(R.msgs?.entries() || [])].filter(([, x]) => x.spec.failTimes);
      const recovered = transient.filter(([b]) => c?.got.has(b)).length;
      let gap = Infinity;
      for (const [, x] of R.msgs || []) for (const ts of x.attempts.values()) for (let i = 1; i < ts.length; i++) gap = Math.min(gap, ts[i] - ts[i - 1]);
      const parked = holding(R, x => x.spec.poison).filter(q => { const b = B(m, 'queue', q.name); return b && !Number(b.ttl) && !consumersOf(m, b).length; });
      return [goal('both flaky orders succeed in the end', recovered === 2, `${recovered} of 2 flaky orders were processed. ${lostWhy(R)}`),
        goal('retries wait at least 1 s', gap >= 1, gap === Infinity ? 'nothing was retried' : `two attempts of the same order were only ${Math.round(gap * 1000)} ms apart.`),
        goal('the broken order ends in a parking-lot queue (no consumer, no TTL)', parked.length > 0, R.counts?.looping ? 'it is still looping.' : 'no queue without consumers and without a TTL holds it at the end.'),
        goal('nothing is lost or looping', R.counts && !R.counts.lost && !R.counts.looping, R.counts?.looping ? `${R.counts.looping} message is still looping.` : `${lostWhy(R)}.`)];
    } },

  { id: 'restart', title: 'Survive a broker restart', xp: 40, scenario: { restartAt: 1.05 },
    action: { label: '💥 Publish, then restart the broker', title: 'The shop publishes 20 orders; one second in, the RabbitMQ node restarts' },
    brief: 'The **orders** queue is read by a nightly job, so orders wait in it all day. Then the RabbitMQ node restarts and most of the day\'s orders are gone. Three things lost them: the queue is a **non-durable classic** queue, the messages are **transient** (not persistent), and the shop publishes **without publisher confirms**, so messages still in flight vanished while the shop thought they were sent. Use a **durable quorum queue** (or durable + persistent), a **durable** exchange, and **confirms**.',
    setup: () => ({ blocks: [P('shop', 40, 160, { messages: ['order.created x20'], rate: 10, persistent: false, confirms: false }), X('orders', 340, 160, { durable: false }), Qb('orders', 640, 160, { durable: false })],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-orders', { key: 'order.created' })] }),
    solve: m => { Object.assign(B(m, 'queue', 'orders'), { qtype: 'quorum', durable: true }); B(m, 'exchange', 'orders').durable = true; Object.assign(B(m, 'producer', 'shop'), { persistent: true, confirms: true }); return m; },
    check: (m, R) => {
      const q = B(m, 'queue', 'orders'), x = B(m, 'exchange', 'orders'), st = qr(R, m, 'orders');
      return [goal('the orders queue survives the restart', q && (q.qtype === 'quorum' || q.durable), 'a non-durable classic queue is deleted by a restart.'),
        goal('the orders exchange is durable', x?.durable, 'a non-durable exchange and its bindings are deleted by a restart.'),
        goal('all 20 orders are in the queue afterwards', st?.ready === 20, `${st?.ready ?? 0} of 20 are there. ${lostWhy(R)}`),
        goal('no publish is lost in flight', !R.counts?.lostInFlight, `${R.counts?.lostInFlight} messages were in the socket buffer when the node went down, and without confirms the shop never knew.`)];
    } },

  { id: 'backlog', title: 'Drain the backlog', xp: 40,
    brief: 'Black Friday: the shop publishes **100 orders a second** and **billing** handles 40 a second (25 ms each). The **orders** queue grows by 60 every second and customers wait minutes for their receipt. Add **competing consumers on the same queue** until they can keep up (about 40/s each). A queue per consumer would not help: each would get *every* order, and orders would be charged three times.',
    setup: () => ({ blocks: [P('shop', 40, 220, { messages: ['order.created x3000'], rate: 100 }), X('orders', 340, 220), Qb('orders', 640, 220), Cb('billing-1', 940, 220, { workMs: 25, prefetch: 10 })],
      wires: [wire('p-shop', 'x-orders'), bind('x-orders', 'q-orders', { key: 'order.created' }), wire('q-orders', 'c-billing-1')] }),
    solve: m => { m.blocks.push(Cb('billing-2', 940, 400, { workMs: 25, prefetch: 10 }), Cb('billing-3', 940, 580, { workMs: 25, prefetch: 10 })); m.wires.push(wire('q-orders', 'c-billing-2'), wire('q-orders', 'c-billing-3')); return m; },
    check: (m, R) => {
      const st = [...(R.queues?.values() || [])].reduce((s, q) => Math.max(s, q.peak), 0);
      const done = new Set([...(R.consumers?.values() || [])].flatMap(c => [...c.got.keys()])).size;
      return [goal('the backlog never passes 100 messages', st <= 100, `a queue peaked at ${st} ready messages.`),
        goal('every order is processed exactly once', done === 3000 && !R.counts?.duplicates, `${done} of 3000 processed${R.counts?.duplicates ? `, ${R.counts.duplicates} more than once (one queue per consumer gives each consumer every order)` : ''}.`)];
    } },
];
for (const c of CHALLENGES) c.par ??= partsCost(c.solve(c.setup()));

/** Judges a challenge: { ok, goals, cost, stars, run }. */
export function judge(m, ch) {
  const R = simulate(m, ch.scenario || {});
  const goals = R.error ? [goal('the board runs', false, R.error)] : ch.check(m, R).filter(Boolean);
  const ok = goals.length > 0 && goals.every(g => g.ok);
  const cost = partsCost(m);
  return { ok, goals, cost, stars: ok ? starsFor(cost, ch.par) : 0, run: R };
}
