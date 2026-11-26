// The Messaging builder's Kafka simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
// A model is { blocks, wires }: producer apps, brokers, topics and consumer apps. A wire from a producer to a
// topic is "produces to", from a topic to a consumer is "subscribes". Brokers are not wired: every topic's
// partitions are spread over them (leader + followers, the in-sync replica set).
// simulate() runs a time-stepped clock: records are hashed by key to a partition (CRC32, like librdkafka's
// default consistent_random partitioner; keyless records stick to one partition per batch), written to an
// append-only log with acks and min.insync.replicas, replicated (consumers only read up to the high
// watermark), and read by consumer groups: one owner per partition, range or round-robin assignment sorted by
// member id, rebalances when members join or die, offsets committed before or after processing or by the
// background auto-commit. Broker failures, lost acks and producer retries, consumer crashes, retention and
// compaction are all modelled, and every decision carries a plain-English reason. Deterministic: the only
// randomness is a fixed-seed generator.

export const KINDS = {
  producer: { label: 'Producer app', icon: '📤' },
  broker: { label: 'Broker', icon: '🖥' },
  topic: { label: 'Topic', icon: '🧾' },
  consumer: { label: 'Consumer app', icon: '⚙' },
};
export const KEY_MODES = [['entity', 'entity id (order-1, order-2, ...)'], ['none', 'no key (null)'], ['random', 'a random key per record']];
export const ACKS = [['0', '0: do not wait'], ['1', '1: the leader has it'], ['all', 'all: every in-sync replica has it']];
export const COMMITS = [['after', 'commit after processing'], ['before', 'commit before processing'], ['autostore', 'auto commit, offset stored on receive (the default)']];
export const RESETS = [['latest', 'latest (the default)'], ['earliest', 'earliest']];
export const ASSIGNORS = [['range', 'range'], ['roundrobin', 'round robin']];
export const DEFAULTS = {
  producer: { keyMode: 'entity', entity: 'order', entities: 6, acks: 'all', idempotence: true, rate: 10, count: 0, retries: 5, backlog: 0, startAt: 0, deletes: [] },
  broker: { up: true },
  topic: { partitions: 3, rf: 3, minIsr: 2, retentionMs: 604800000, cleanup: 'delete' },
  consumer: { groupId: 'billing', rate: 20, commit: 'after', reset: 'latest', alive: true, idempotent: false, batch: 10, joinAt: 0, assignor: 'range' },
};
export const TARGETS = { producer: ['topic'], broker: [], topic: ['consumer'], consumer: [] };
export const STATES = ['created', 'paid', 'packed', 'shipped'];
const REPL_LAG_S = 0.2;          // followers are this far behind the leader
const SESSION_TIMEOUT_S = 45;    // session.timeout.ms default (45 s since Kafka 3.0 / librdkafka 1.9)
const AUTO_COMMIT_S = 5;         // auto.commit.interval.ms default
const STICKY_BATCH = 8;          // keyless records per partition before the sticky partitioner moves on
const COMPACT_LAG_S = 3600;      // records younger than this are in the active segment: never compacted
const DELETE_RETENTION_S = 86400; // delete.retention.ms default: tombstones live this long after compaction

const clone = o => JSON.parse(JSON.stringify(o));
export const block = (kind, id, name, x = 0, y = 0, settings = {}) => ({ id, kind, name, x, y, ...clone(DEFAULTS[kind]), ...settings });
export const wire = (from, to, extra = {}) => ({ id: `W-${from}-${to}`, from, to, ...extra });
export const byId = (m, id) => m.blocks.find(b => b.id === id);
export const byName = (m, kind, name) => m.blocks.find(b => b.kind === kind && b.name === name);
export const ofKind = (m, kind) => m.blocks.filter(b => b.kind === kind);
export const validName = n => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n);
const r3 = x => Math.round(x * 1000) / 1000;
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
export const rateText = r => (r >= 0.1 ? `${Math.round(r * 100) / 100}/s` : r * 3600 >= 1 ? `${Math.round(r * 3600 * 10) / 10}/hour` : `${Math.round(r * 86400 * 10) / 10}/day`);

export function canWire(m, from, to) {
  if (!from || !to || from.id === to.id) return false;
  return (TARGETS[from.kind] || []).includes(to.kind);
}
/** Adds a wire. A producer writes to one topic (a new wire replaces the old one). */
export function connect(m, fromId, toId) {
  const from = byId(m, fromId), to = byId(m, toId);
  if (!canWire(m, from, to)) return false;
  if (from.kind === 'producer') m.wires = m.wires.filter(w => w.from !== fromId);
  if (!m.wires.some(w => w.from === fromId && w.to === toId)) m.wires.push(wire(fromId, toId));
  return true;
}
export function removeBlock(m, id) {
  m.blocks = m.blocks.filter(b => b.id !== id);
  m.wires = m.wires.filter(w => w.from !== id && w.to !== id);
}
export const topicOf = (m, p) => byId(m, m.wires.find(w => w.from === p.id)?.to);
export const topicsOf = (m, c) => m.wires.filter(w => w.to === c.id).map(w => byId(m, w.from)).filter(b => b?.kind === 'topic');
export const consumersOf = (m, t) => m.wires.filter(w => w.from === t.id).map(w => byId(m, w.to)).filter(b => b?.kind === 'consumer');
export const producersOf = (m, t) => m.wires.filter(w => w.to === t.id).map(w => byId(m, w.from)).filter(b => b?.kind === 'producer');
/** Brokers in id order: broker-1 has id 1, and so on (by name order when the names have no number). */
export function brokerList(m) {
  const list = ofKind(m, 'broker').slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return list.map((b, i) => ({ b, id: Number((b.name.match(/(\d+)$/) || [])[1]) || i + 1 }));
}

// ---------------------------------------------------------------- partitioning

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** CRC32 of a string's UTF-8 bytes (what librdkafka's consistent_random partitioner hashes). */
export function crc32(s) {
  const bytes = new TextEncoder().encode(String(s));
  let c = 0xffffffff;
  for (const x of bytes) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const partitionOf = (key, n) => crc32(key) % n;

/** A small fixed-seed generator (mulberry32): the same run gives the same "random" keys every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- the simulation

export function validate(m) {
  if (!ofKind(m, 'topic').length) return 'There is no topic yet. Add one from the palette.';
  if (!ofKind(m, 'broker').length) return 'There are no brokers. A Kafka cluster needs at least one.';
  for (const kind of Object.keys(KINDS)) {
    const names = new Set();
    for (const b of ofKind(m, kind)) {
      if (!validName(b.name || '')) return `"${b.name}" is not a valid ${KINDS[kind].label.toLowerCase()} name: letters, digits and - _ . only.`;
      if (names.has(b.name)) return `Two ${KINDS[kind].label.toLowerCase()}s are called "${b.name}". Names must be unique.`;
      names.add(b.name);
    }
  }
  const n = ofKind(m, 'broker').length;
  for (const t of ofKind(m, 'topic')) {
    if (!(Number(t.partitions) >= 1)) return `${t.name}: a topic needs at least one partition.`;
    if (Number(t.rf) < 1) return `${t.name}: the replication factor is at least 1.`;
    if (Number(t.rf) > n) return `kafka-topics --create ${t.name} fails: "InvalidReplicationFactorException: Replication factor: ${t.rf} larger than available brokers: ${n}."`;
  }
  for (const p of ofKind(m, 'producer')) {
    if (p.idempotence && p.acks !== 'all') return `${p.name} does not start: "\`acks\` must be set to \`all\` when \`enable.idempotence\` is true". The idempotent producer needs every in-sync replica to confirm, or it could not promise "exactly one copy".`;
  }
  for (const c of ofKind(m, 'consumer')) if (!String(c.groupId || '').trim()) return `${c.name} has no group.id: a subscribing consumer must have one.`;
  return null;
}

/**
 * Runs the board. sc: { duration (s, default 60), dt (s, default 0.1), kill: { broker: id, at }, lostAcks: bool,
 * outages: [{ consumer: name, from, to|null }] }.
 * -> { error } or { steps, tokens, topics: Map, groups: Map, consumers: Map, counts, duration }
 */
export function simulate(m, sc = {}) {
  const err = validate(m);
  if (err) return { error: err };
  const duration = sc.duration ?? 60, dt = sc.dt ?? 0.1;
  const steps = [];
  const log = (at, who, tone, text) => steps.push({ at: r3(at), who, tone, text, seq: steps.length });
  const cats = new Map();
  const note = (cat, at, who, tone, text, label, limit = 2) => {
    const c = cats.get(cat) || { n: 0, who, tone, label, limit, last: at };
    c.n++; c.last = at; cats.set(cat, c);
    if (c.n <= limit) log(at, who, tone, text);
  };
  const random = rng(20260);
  const counts = { produced: 0, written: 0, lostAcked: 0, lostUnacked: 0, failed: 0, notEnough: 0, offline: 0, rejectedNoKey: 0, logDuplicates: 0, dedupedByBroker: 0, retried: 0 };
  const journeys = [];

  // ---- the cluster
  const brokers = brokerList(m);
  const up = new Map(brokers.map(x => [x.id, x.b.up !== false]));
  const bname = id => `broker ${id}`;
  for (const x of brokers) if (!up.get(x.id)) log(0, x.b.name, 'warn', `${x.b.name} is down at the start.`);
  const T = new Map();
  for (const t of ofKind(m, 'topic')) {
    const P = [], n = brokers.length, rf = Number(t.rf), np = Number(t.partitions);
    for (let p = 0; p < np; p++) {
      const replicas = Array.from({ length: rf }, (_, i) => brokers[(p + i) % n].id);
      const isr = replicas.filter(id => up.get(id));
      P.push({ p, replicas, isr, leader: isr[0] ?? null, offline: !isr.length, log: [], start: 0, sticky: 0 });
    }
    T.set(t.id, { b: t, parts: P, compact: t.cleanup === 'compact', retention: Number(t.retentionMs) / 1000 });
    const lay = P.map(x => `${t.name}-${x.p}: leader ${x.leader ?? 'none'}, replicas ${x.replicas.join(',')}`).join('; ');
    log(0, t.name, 'info', `Topic ${t.name}: ${plural(np, 'partition')}, replication factor ${rf}, min.insync.replicas ${t.minIsr}, cleanup.policy=${t.cleanup}${t.cleanup === 'delete' ? `, retention.ms=${t.retentionMs}` : ''}. ${lay}.`);
  }
  /** The high watermark: consumers only see records every in-sync replica has (followers are REPL_LAG_S behind). */
  const highWater = (P, now) => {
    let i = P.log.length;
    if (P.isr.length > 1) while (i > 0 && P.log[i - 1].t > now - REPL_LAG_S) i--;
    return i;
  };

  // ---- producers: the records each one will send
  const sends = [];
  for (const p of ofKind(m, 'producer')) {
    const t = topicOf(m, p);
    if (!t) { log(0, p.name, 'warn', `${p.name} is not wired to a topic, so it produces nothing.`); continue; }
    const rate = Math.max(0, Number(p.rate) || 0);
    const cap = Number(p.count) > 0 ? Number(p.count) : Infinity;
    const k = Math.max(1, Number(p.entities) || 1);
    const seq = new Map();
    const make = (i, at) => {
      const entity = `${p.entity || 'order'}-${(i % k) + 1}`;
      const s = (seq.get(entity) || 0) + 1;
      seq.set(entity, s);
      const key = p.keyMode === 'entity' ? entity : p.keyMode === 'random' ? Math.floor(random() * 2 ** 32).toString(16).padStart(8, '0') : null;
      return { p, t, i, at: r3(at), entity, seq: s, key, value: (p.entity === 'customer' ? `profile v${s}` : STATES[(s - 1) % STATES.length]), bid: `${p.name}/${entity}#${s}` };
    };
    let i = 0;
    const backlog = Math.max(0, Number(p.backlog) || 0);
    for (let j = 0; j < backlog; j++, i++) sends.push(make(i, -3600 + (j * 3600) / backlog));
    const start = Number(p.startAt) || 0;
    if (rate > 0) for (let j = 0; i - backlog < cap && start + j / rate < duration; j++, i++) sends.push(make(i, start + j / rate));
    for (const d of p.deletes || []) {
      const at = sends.filter(x => x.p === p).reduce((s, x) => Math.max(s, x.at), 0) + 1;
      sends.push({ p, t, i: i++, at: r3(at), entity: d, seq: (seq.get(d) || 0) + 1, key: p.keyMode === 'entity' ? d : null, value: null, tomb: true, bid: `${p.name}/${d}#del` });
    }
    log(0, p.name, 'info', `${p.name} produces to ${t.name}${rate ? ` at ${rateText(rate)}` : ''}${backlog ? ` (and ${backlog} records were already written an hour ago)` : ''}: key = ${p.keyMode === 'entity' ? `the ${p.entity || 'order'} id` : p.keyMode === 'random' ? 'a random value' : 'none'}, acks=${p.acks}, enable.idempotence=${!!p.idempotence}, retries=${p.retries}.`);
  }
  sends.sort((a, b) => a.at - b.at || a.i - b.i);

  function partitionFor(s, Tt) {
    const n = Tt.parts.length;
    if (s.key != null) return partitionOf(s.key, n);
    const st = Tt.stickyFor ??= new Map();
    const cur = st.get(s.p.id) || { p: Math.floor(random() * n), left: STICKY_BATCH };
    if (cur.left <= 0) { cur.p = (cur.p + 1 + Math.floor(random() * Math.max(1, n - 1))) % n; cur.left = STICKY_BATCH; }
    cur.left--; st.set(s.p.id, cur);
    return cur.p;
  }

  function write(s, now) {
    const Tt = T.get(s.t.id), tname = s.t.name;
    counts.produced++;
    if (Tt.compact && s.key == null) {
      counts.rejectedNoKey++; counts.failed++;
      note(`nokey|${s.p.id}`, now, s.p.name, 'bad', `Broker: Invalid record (InvalidRecordException: "Compacted topic cannot accept message without key"). ${tname} is compacted: it keeps the latest value per key, so a record without a key has nowhere to belong.`, 'rejected: no key on a compacted topic');
      return;
    }
    const pn = partitionFor(s, Tt);
    const P = Tt.parts[pn];
    if (P.offline) {
      counts.offline++; counts.failed++;
      note(`off|${P.p}|${s.t.id}`, now, s.p.name, 'bad', `${tname}-${pn} is offline: its only replica${P.replicas.length > 1 ? 's are' : ' is'} on ${P.replicas.map(bname).join(', ')}, which is down. The producer retries until message.timeout.ms, then the delivery report says "Local: Message timed out".`, `failed: ${tname}-${pn} offline`);
      return;
    }
    if (s.p.acks === 'all' && P.isr.length < Number(s.t.minIsr)) {
      counts.notEnough++; counts.failed++;
      note(`nei|${s.t.id}`, now, s.p.name, 'bad', `${tname}-${pn} has only ${plural(P.isr.length, 'in-sync replica')} (${P.isr.map(bname).join(', ') || 'none'}), but min.insync.replicas is ${s.t.minIsr}. With acks=all the leader refuses the write: "Broker: Not enough in-sync replicas" (NotEnoughReplicasException). The order is not saved.`, 'failed: NotEnoughReplicas');
      return;
    }
    const rec = { off: P.log.length, p: pn, topic: s.t.id, key: s.key, entity: s.entity, seq: s.seq, value: s.value, tomb: !!s.tomb, t: s.at, acks: s.p.acks, prod: s.p.id, bid: s.bid };
    P.log.push(rec);
    counts.written++;
    if (journeys.length < 60) journeys.push({ s, p: pn, at: now });
    note(`w|${s.t.id}|${pn}`, now, s.p.name, 'info', `${s.key == null ? 'keyless record' : `key ${s.key}`} (${s.entity} ${s.value ?? 'deleted (tombstone)'}) → ${tname}-${pn}${s.key == null ? ': no key, so the sticky partitioner fills one partition per batch, then moves on' : s.p.keyMode === 'random' ? `: crc32("${s.key}") % ${Tt.parts.length} = ${pn}. A random key lands anywhere, so ${s.entity}'s events spread over partitions` : `: crc32("${s.key}") % ${Tt.parts.length} = ${pn}, always the same partition for this key`}; offset ${rec.off}, leader ${bname(P.leader)}.`, `written to ${tname}-${pn}`, 1);
    // A lost acknowledgement: the record is written, but the producer never hears so and sends it again.
    if (sc.lostAcks && s.p.acks !== '0' && s.i % 25 === 12) {
      if (!(Number(s.p.retries) > 0)) { counts.failed++; note(`ackloss0|${s.p.id}`, now, s.p.name, 'warn', `The ack for ${s.entity} ${s.value} was lost on the network and retries=0: the app gets an error for a record that was in fact written.`, 'ack lost, no retry'); return; }
      counts.retried++;
      if (s.p.idempotence) {
        counts.dedupedByBroker++;
        note(`ackloss-idem|${s.p.id}`, now, s.p.name, 'ok', `The ack for ${s.entity} ${s.value} was lost, so the producer retries. It is idempotent: the retry carries the same producer id and sequence number, and the leader sees it already has that batch. It acks again without writing a second copy.`, 'retry deduplicated by the broker');
      } else {
        const dup = { ...rec, off: P.log.length, dup: true };
        P.log.push(dup);
        counts.logDuplicates++;
        note(`ackloss|${s.p.id}`, now, s.p.name, 'bad', `The ack for ${s.entity} ${s.value} was lost on the network. The producer cannot tell "not written" from "written, ack lost", so it retries, and ${tname}-${pn} now holds it twice (offsets ${rec.off} and ${dup.off}). Without enable.idempotence the broker has no way to spot the copy.`, 'duplicate written by a retry');
      }
    }
  }

  function killBroker(id, now) {
    if (!up.get(id)) return;
    up.set(id, false);
    log(now, bname(id), 'bad', `💥 ${bname(id)} dies${now > 0 ? ' right after a burst of writes' : ' (it is down for maintenance from the start)'}.`);
    for (const Tt of T.values()) for (const P of Tt.parts) {
      if (!P.replicas.includes(id)) continue;
      const wasLeader = P.leader === id;
      P.isr = P.isr.filter(x => x !== id);
      const name = `${Tt.b.name}-${P.p}`;
      if (!wasLeader) { log(now, name, 'warn', `${name}: follower ${bname(id)} leaves the ISR, which is now ${P.isr.map(bname).join(', ') || 'empty'}.${P.isr.length < Number(Tt.b.minIsr) ? ` That is fewer than min.insync.replicas=${Tt.b.minIsr}: acks=all writes to it will fail.` : ''}`); continue; }
      if (!P.isr.length) { P.offline = true; P.leader = null; log(now, name, 'bad', `${name} goes offline: ${bname(id)} held its only copy (replication factor ${Tt.b.rf}). Nobody can read or write it until that broker comes back, and if its disk is gone, so is the data.`); continue; }
      P.leader = P.isr[0];
      const cut = P.log.findIndex(r => r.t > now - REPL_LAG_S);
      if (cut < 0) { log(now, name, 'ok', `${name}: leadership moves to ${bname(P.leader)} (it was in the ISR and had everything).`); continue; }
      const tail = P.log.splice(cut);
      const lost = tail.filter(r => r.acks !== 'all'), kept = tail.filter(r => r.acks === 'all');
      for (const r of kept) { r.off = P.log.length; P.log.push(r); counts.retried++; }
      for (const r of lost) { if (r.acks === '1') counts.lostAcked++; else counts.lostUnacked++; r.lostAt = now; }
      counts.written -= lost.length;
      P.lost = (P.lost || []).concat(lost);
      log(now, name, lost.length ? 'bad' : 'ok', lost.length
        ? `${name}: leadership moves to ${bname(P.leader)}. The last ${plural(lost.length, 'record')} (${lost.map(r => `${r.entity} ${r.value}`).join(', ')}) were only on ${bname(id)}: the followers fetch about ${REPL_LAG_S * 1000} ms behind. With acks=${lost[0].acks} the producer ${lost[0].acks === '1' ? 'already had its ack, so the shop believes they are saved' : 'never waits for anything'}. They are gone.`
        : `${name}: leadership moves to ${bname(P.leader)}. ${plural(kept.length, 'record')} written just before the crash had not reached every in-sync replica, so with acks=all they were never acknowledged: the producer sends them again to the new leader. Nothing acknowledged is lost.`);
    }
  }

  // ---- consumer groups
  const G = new Map(), CS = new Map();
  for (const c of ofKind(m, 'consumer')) {
    const topics = topicsOf(m, c);
    const gid = String(c.groupId).trim();
    const g = G.get(gid) || { gid, members: [], committed: new Map(), stored: new Map(), firstStart: new Map(), processed: new Map(), effects: new Map(), seen: new Set(),
      order: [], cache: new Map(), deletedUnread: 0, resetSkipped: 0, dupSkipped: 0, lagAt: [], rebalances: 0, skipped: new Set(), topics: new Set(), lastCommitTick: 0, owners: new Map() };
    G.set(gid, g);
    const cs = { b: c, g, topics: topics.map(t => t.id), alive: c.alive !== false, joined: false, assigned: [], pos: new Map(), batch: [], budget: 0, processed: 0, got: new Map(), downUntil: null };
    topics.forEach(t => g.topics.add(t.id));
    g.members.push(cs);
    CS.set(c.id, cs);
    if (!topics.length) log(0, c.name, 'warn', `${c.name} subscribes to no topic. Wire a topic's ▶ onto it.`);
    if (c.alive === false) log(0, c.name, 'warn', `${c.name} is switched off.`);
  }
  const pk = (tid, p) => `${tid}:${p}`;
  const partOf = key => { const [tid, p] = key.split(':'); return T.get(tid).parts[Number(p)]; };
  const pname = key => { const [tid, p] = key.split(':'); return `${T.get(tid).b.name}-${p}`; };

  function commitNow(cs, how) {
    const g = cs.g;
    for (const k of cs.assigned) {
      const v = how === 'stored' ? g.stored.get(k) : cs.pos.get(k);
      if (v != null) g.committed.set(k, v);
    }
  }

  function processRec(cs, r, at) {
    const g = cs.g;
    const rk = `${r.topic}:${r.p}:${r.off}`;
    g.processed.set(rk, (g.processed.get(rk) || 0) + 1);
    cs.processed++;
    if (cs.b.idempotent && g.seen.has(r.bid)) {
      g.dupSkipped++;
      note(`idem|${g.gid}`, at, cs.b.name, 'ok', `${r.entity} ${r.value} was handled before (${g.processed.get(rk) > 1 ? 'a redelivery after the crash' : 'a duplicate in the log'}). The consumer is idempotent: it checks the order id in its processed-ids table and skips it.`, 'duplicate skipped by the idempotent consumer');
      return;
    }
    g.seen.add(r.bid);
    g.effects.set(r.bid, (g.effects.get(r.bid) || 0) + 1);
    cs.got.set(r.bid, (cs.got.get(r.bid) || 0) + 1);
    g.order.push({ entity: r.entity, seq: r.seq, at, by: cs.b.name, p: r.p });
    if (r.tomb) g.cache.delete(r.entity); else g.cache.set(r.entity, { value: r.value, seq: r.seq });
    if (g.effects.get(r.bid) > 1) note(`dupfx|${g.gid}`, at, cs.b.name, 'bad', `${r.entity} ${r.value} is processed a second time: ${g.processed.get(rk) > 1 ? 'the consumer had done it, but the offset was not committed before the crash, so it is read again' : 'the log holds two copies of it'}. Without an idempotent consumer, that is a second charge or a second email.`, 'processed twice');
  }

  function resetPos(cs, k, now, why) {
    const P = partOf(k), g = cs.g;
    const to = cs.b.reset === 'earliest' ? P.start : P.log.length;
    if (why) {
      const from = cs.pos.get(k) ?? g.committed.get(k) ?? 0;
      let deleted = 0, jumped = 0;
      for (let o = from; o < to; o++) { const r = P.log[o]; if (!r) continue; if (g.processed.has(`${r.topic}:${r.p}:${r.off}`)) continue; g.skipped.add(`${r.topic}:${r.p}:${r.off}`); if (r.deleted) deleted++; else jumped++; }
      const gone = P.start - from;
      g.deletedUnread += Math.max(0, gone);
      g.resetSkipped += Math.max(0, to - P.start);
      log(now, cs.b.name, 'bad', `OffsetOutOfRange on ${pname(k)}: the committed offset ${from} no longer exists, because retention already deleted everything before offset ${P.start}. ${plural(Math.max(0, gone), 'record')} were deleted before ${g.gid} read them. auto.offset.reset=${cs.b.reset} now applies: ${cs.b.reset === 'earliest' ? `it restarts at ${P.start}, the oldest record left` : `it jumps to the end (${to}), skipping another ${plural(Math.max(0, to - P.start), 'record')} that still exist`}.`);
    }
    cs.pos.set(k, to);
    return to;
  }

  function rebalance(g, now, why) {
    g.rebalances++;
    const live = g.members.filter(x => x.alive && x.joined);
    for (const x of live) {
      if (x.batch.length) { for (const r of x.batch.splice(0)) processRec(x, r, now); }
      if (x.b.commit === 'autostore') commitNow(x, 'stored'); else commitNow(x, 'pos');
    }
    for (const x of g.members) x.assigned = [];
    const sorted = live.slice().sort((a, b) => (a.b.name < b.b.name ? -1 : a.b.name > b.b.name ? 1 : 0));
    const assignor = sorted[0]?.b.assignor || 'range';
    const lines = [];
    if (assignor === 'roundrobin') {
      const all = [...g.topics].flatMap(tid => T.get(tid).parts.map(P => ({ tid, P })));
      let i = 0;
      for (const { tid, P } of all) {
        const subs = sorted.filter(x => x.topics.includes(tid));
        if (!subs.length) continue;
        subs[i++ % subs.length].assigned.push(pk(tid, P.p));
      }
    } else {
      for (const tid of g.topics) {
        const subs = sorted.filter(x => x.topics.includes(tid));
        const np = T.get(tid).parts.length;
        if (!subs.length) continue;
        const per = Math.floor(np / subs.length), extra = np % subs.length;
        let p = 0;
        subs.forEach((x, i) => { const n = per + (i < extra ? 1 : 0); for (let j = 0; j < n; j++) x.assigned.push(pk(tid, p++)); });
      }
    }
    g.owners = new Map();
    for (const x of sorted) {
      for (const k of x.assigned) {
        g.owners.set(k, x.b.name);
        const c = g.committed.get(k);
        if (c != null) x.pos.set(k, c);
        else {
          const P = partOf(k);
          const at = resetPos(x, k, now, null);
          if (!g.firstStart.has(k)) {
            g.firstStart.set(k, at);
            if (x.b.reset === 'latest') g.missed = (g.missed || 0) + (P.log.length - P.start);
            if (x.b.reset === 'latest' && P.log.length > P.start) note(`latest|${g.gid}`, now, x.b.name, 'warn', `${g.gid} has no committed offset on ${pname(k)} yet, so auto.offset.reset=latest starts at the end (offset ${at}): the ${plural(P.log.length - P.start, 'record')} already there are never read by this group.`, 'new group starts at the end');
          }
        }
      }
      lines.push(`${x.b.name} ← ${x.assigned.length ? x.assigned.map(pname).join(', ') : 'nothing (idle: more members than partitions)'}`);
    }
    if (sorted.length) log(now, `group ${g.gid}`, sorted.some(x => !x.assigned.length) ? 'warn' : 'info', `Rebalance (${why}), ${assignor} assignment over members sorted by id: ${lines.join('; ')}.${sorted.some(x => !x.assigned.length) ? ' A partition has exactly one owner in a group, so extra members just wait.' : ''}`);
    else log(now, `group ${g.gid}`, 'bad', `Rebalance (${why}): no live members. Nobody reads ${[...g.topics].map(t => T.get(t).b.name).join(', ')} for this group, and the lag grows.`);
  }

  function poll(cs, now) {
    const g = cs.g, max = Math.max(1, Number(cs.b.batch) || 1);
    for (const k of cs.assigned) {
      const P = partOf(k);
      const pos = cs.pos.get(k) ?? 0;
      if (pos < P.start) resetPos(cs, k, now, 'out of range');
    }
    const out = [];
    const heads = new Map(cs.assigned.map(k => [k, cs.pos.get(k)]));
    while (out.length < max) {
      let best = null, bk = null;
      for (const k of cs.assigned) {
        const P = partOf(k);
        if (P.offline) continue;
        let o = heads.get(k);
        const top = highWater(P, now);
        while (o < top && P.log[o]?.gone) o++;
        heads.set(k, o);
        if (o >= top) continue;
        const r = P.log[o];
        if (!best || r.t < best.t) { best = r; bk = k; }
      }
      if (!best) break;
      out.push(best);
      heads.set(bk, heads.get(bk) + 1);
    }
    for (const [k, o] of heads) cs.pos.set(k, o);
    cs.lastBatch = out.length;
    if (!out.length) return out;
    if (cs.b.commit === 'before') commitNow(cs, 'pos');
    else if (cs.b.commit === 'autostore') for (const k of cs.assigned) g.stored.set(k, cs.pos.get(k));
    return out;
  }

  // ---- outages and joins as timed events
  const events = [];
  for (const cs of CS.values()) if (cs.alive && cs.topics.length) events.push({ t: Number(cs.b.joinAt) || 0, type: 'join', cs });
  for (const o of sc.outages || []) {
    const cs = [...CS.values()].find(x => x.b.name === o.consumer) || [...CS.values()].find(x => x.alive && x.topics.length);
    if (!cs) continue;
    events.push({ t: o.from, type: 'crash', cs });
    if (o.to != null) events.push({ t: o.to, type: 'back', cs });
  }
  if (sc.kill) events.push({ t: sc.kill.at, type: 'kill', id: sc.kill.broker });
  events.sort((a, b) => a.t - b.t);

  // backlog records written "an hour ago" (before the clock starts)
  let si = 0;
  while (si < sends.length && sends[si].at < 0) write(sends[si++], sends[si - 1].at);

  const samples = 6;
  let nextSample = 0, lastCompact = -Infinity;
  for (let now = 0; now <= duration + 1e-9; now = r3(now + dt)) {
    while (events.length && events[0].t <= now + 1e-9) {
      const e = events.shift();
      if (e.type === 'join') {
        // members that start together are handled in one rebalance (the coordinator waits group.initial.rebalance.delay.ms)
        const batch = [e.cs];
        for (let i = 0; i < events.length && events[i].t <= now + 1e-9;) {
          if (events[i].type === 'join' && events[i].cs.g === e.cs.g) batch.push(events.splice(i, 1)[0].cs); else i++;
        }
        batch.forEach(x => { x.joined = true; });
        rebalance(e.cs.g, now, `${batch.map(x => x.b.name).join(', ')} joined`);
      }
      else if (e.type === 'kill') killBroker(e.id, now);
      else if (e.type === 'crash') {
        const cs = e.cs;
        if (!cs.alive) continue;
        cs.alive = false;
        const held = cs.batch.splice(0);
        cs.assigned = []; cs.pos = new Map(); cs.budget = 0;    // a dead process forgets everything it had in memory
        const committedPast = held.filter(r => (cs.g.committed.get(pk(r.topic, r.p)) ?? 0) > r.off).length;
        log(now, cs.b.name, 'bad', `💀 ${cs.b.name} crashes${held.length ? ` with ${plural(held.length, 'record')} of its batch not processed yet` : ''}.${held.length ? (committedPast ? ` ${committedPast} of them were already committed (${cs.b.commit === 'before' ? 'commit before processing' : 'the background auto-commit stored their offsets on receive'}), so after a restart the group will start after them: they are never processed.` : ` The batch's offsets were not committed yet, so after a restart the whole batch is read again${cs.lastBatch > held.length ? `, including the ${cs.lastBatch - held.length} records it had already processed` : ''}.`) : ''} The group only notices after session.timeout.ms (${SESSION_TIMEOUT_S} s) unless it comes back first.`);
        events.push({ t: now + SESSION_TIMEOUT_S, type: 'timeout', cs });
        events.sort((a, b) => a.t - b.t);
      } else if (e.type === 'timeout') {
        if (!e.cs.alive && e.cs.joined) { e.cs.joined = false; rebalance(e.cs.g, now, `${e.cs.b.name} missed its heartbeats for ${SESSION_TIMEOUT_S} s and was removed`); }
      } else if (e.type === 'back') {
        const cs = e.cs;
        cs.alive = true; cs.joined = true;
        log(now, cs.b.name, 'info', `↻ ${cs.b.name} starts again and rejoins ${cs.g.gid}. It resumes from the group's committed offsets.`);
        rebalance(cs.g, now, `${cs.b.name} rejoined`);
      }
    }
    // produce
    while (si < sends.length && sends[si].at < now + dt - 1e-9) write(sends[si++], now);
    // retention and compaction
    for (const Tt of T.values()) for (const P of Tt.parts) {
      if (!Tt.compact) {
        while (P.start < P.log.length && P.log[P.start].t < now - Tt.retention) { P.log[P.start].deleted = true; P.start++; }
      }
    }
    if (now - lastCompact >= 60) {
      lastCompact = now;
      for (const Tt of T.values()) if (Tt.compact) for (const P of Tt.parts) {
        const latest = new Map();
        for (const r of P.log) latest.set(r.key, r.off);
        for (const r of P.log) {
          if (r.gone || r.t > now - COMPACT_LAG_S) continue;
          if (latest.get(r.key) !== r.off) { r.gone = true; Tt.compacted = (Tt.compacted || 0) + 1; }
          else if (r.tomb && r.t < now - COMPACT_LAG_S - DELETE_RETENTION_S) { r.gone = true; Tt.compacted = (Tt.compacted || 0) + 1; }
        }
      }
    }
    // consume
    for (const cs of CS.values()) {
      if (!cs.alive || !cs.joined || !cs.assigned.length) continue;
      const rate = Math.max(0, Number(cs.b.rate) || 0);
      cs.budget = Math.min(cs.budget + rate * dt, rate * dt + 1);
      let k = 0;
      while (cs.budget >= 1) {
        if (!cs.batch.length) { cs.batch = poll(cs, now); if (!cs.batch.length) break; }
        processRec(cs, cs.batch.shift(), r3(now + k / Math.max(rate, 1e-9) ));
        k++; cs.budget--;
        if (!cs.batch.length && cs.b.commit === 'after') commitNow(cs, 'pos');
      }
    }
    // the background auto-commit
    const tick = Math.floor(now / AUTO_COMMIT_S + 1e-9);
    for (const g of G.values()) {
      if (tick === g.lastCommitTick) continue;
      g.lastCommitTick = tick;
      for (const cs of g.members) if (cs.alive && cs.joined && cs.b.commit === 'autostore') commitNow(cs, 'stored');
    }
    // lag samples
    if (now >= nextSample - 1e-9) {
      for (const g of G.values()) g.lagAt.push({ t: now, lag: lagOf(g) });
      nextSample += duration / samples;
    }
  }
  for (const c of cats.values()) if (c.n > c.limit && c.label) log(c.last, c.who, c.tone === 'ok' ? 'ok' : c.tone === 'bad' ? 'bad' : 'info', `… plus ${plural(c.n - c.limit, 'more record')} like that (${c.label}).`);

  function lagOf(g) {
    let lag = 0;
    for (const tid of g.topics) for (const P of T.get(tid).parts) {
      const k = pk(tid, P.p);
      const c = g.committed.get(k) ?? g.firstStart.get(k) ?? P.start;
      lag += Math.max(0, P.log.length - Math.max(c, P.start));
    }
    return lag;
  }

  // ---- results
  const groups = new Map();
  for (const g of G.values()) {
    const parts = [];
    let lostCommit = 0;
    // records a live member holds in its current batch are still on their way, not lost
    for (const x of g.members) if (x.alive) for (const r of x.batch) g.skipped.add(`${r.topic}:${r.p}:${r.off}`);
    for (const tid of g.topics) for (const P of T.get(tid).parts) {
      const k = pk(tid, P.p);
      const committed = g.committed.get(k);
      const from = g.firstStart.get(k) ?? 0;
      for (let o = from; o < (committed ?? 0); o++) {
        const r = P.log[o];
        if (!r || r.gone) continue;
        const rk = `${r.topic}:${r.p}:${r.off}`;
        if (!g.processed.has(rk) && !g.skipped.has(rk)) lostCommit++;
      }
      parts.push({ key: k, name: pname(k), owner: g.owners.get(k) || '-', committed: committed ?? null, end: P.log.length, start: P.start, lag: Math.max(0, P.log.length - Math.max(committed ?? g.firstStart.get(k) ?? P.start, P.start)) });
    }
    const perEntity = new Map();
    for (const x of g.order) { if (!perEntity.has(x.entity)) perEntity.set(x.entity, []); perEntity.get(x.entity).push(x); }
    let violations = 0;
    const bad = [];
    for (const [ent, list] of perEntity) {
      const sorted = list.slice().sort((a, b) => a.at - b.at);
      for (let i = 1; i < sorted.length; i++) if (sorted[i].seq < sorted[i - 1].seq) { violations++; bad.push(ent); break; }
    }
    let dupEffects = 0;
    for (const n of g.effects.values()) if (n > 1) dupEffects += n - 1;
    let reprocessed = 0;
    for (const n of g.processed.values()) if (n > 1) reprocessed += n - 1;
    const lag = lagOf(g);
    groups.set(g.gid, { gid: g.gid, members: g.members.map(x => x.b.name), parts, lag, lagAt: g.lagAt, lostCommit, deletedUnread: g.deletedUnread, resetSkipped: g.resetSkipped, missed: g.missed || 0,
      dupEffects, reprocessed, dupSkipped: g.dupSkipped, violations, violatedKeys: bad, effects: g.effects, cache: g.cache, rebalances: g.rebalances, idle: g.members.filter(x => x.alive && x.joined && !x.assigned.length).map(x => x.b.name),
      processed: [...g.processed.values()].reduce((s, n) => s + n, 0), unique: g.effects.size });
    const last = g.lagAt.map(x => x.lag);
    const grows = last.length > 2 && last[last.length - 1] > last[1] + 20 && last[last.length - 1] > 50;
    groups.get(g.gid).grows = grows;
    if (g.members.some(x => x.joined || x.alive)) {
      const rateIn = [...g.topics].reduce((s, tid) => s + producersOf(m, T.get(tid).b).reduce((a, p) => a + (Number(p.rate) || 0), 0), 0);
      const rateOut = g.members.filter(x => x.alive).reduce((s, x) => s + (x.assigned.length ? Number(x.b.rate) || 0 : 0), 0);
      log(duration, `group ${g.gid}`, grows ? 'bad' : 'ok', grows
        ? `Lag keeps growing: ${last.map(Math.round).join(' → ')} over the run. Records arrive at about ${rateIn}/s; the members that own partitions handle ${rateOut}/s together. Add members to this group (up to one per partition), make each one faster, or add partitions.`
        : `Lag at the end: ${lag}${last.length ? ` (samples ${last.map(Math.round).join(' → ')})` : ''}.`);
    }
  }
  // group ids that differ only by a trailing number look like instances of one service that should share a group
  const stems = new Map();
  for (const gid of G.keys()) { const s = gid.replace(/[-_.]?\d+$/, ''); if (s !== gid) stems.set(s, [...(stems.get(s) || []), gid]); }
  for (const [s, ids] of stems) if (ids.length > 1) log(duration, `group ${ids[0]}`, 'warn', `${ids.join(' and ')} look like instances of one "${s}" service, but each has its own group.id, so each one receives every record and does the work again. Instances of one service share one group.id.`);
  // keys spread over several partitions: order is only guaranteed inside one partition
  const split = new Map();
  for (const Tt of T.values()) {
    const where = new Map();
    for (const P of Tt.parts) for (const r of P.log) { if (!where.has(r.entity)) where.set(r.entity, new Set()); where.get(r.entity).add(P.p); }
    split.set(Tt.b.id, [...where].filter(([, s]) => s.size > 1).map(([e, s]) => ({ entity: e, parts: [...s].sort() })));
    const sp = split.get(Tt.b.id);
    const what = (sp[0]?.entity || 'entity').replace(/-\d+$/, '');
    if (sp.length) log(duration, Tt.b.name, 'bad', `${plural(sp.length, `${what} has`, `${what}s have`)} events in more than one partition (${sp.slice(0, 3).map(x => `${x.entity} in ${x.parts.map(p => `${Tt.b.name}-${p}`).join(' and ')}`).join('; ')}${sp.length > 3 ? '; …' : ''}). Kafka keeps order only inside a partition, and different consumers read different partitions at their own pace, so "shipped" can be handled before "paid".`);
  }
  steps.sort((a, b) => a.at - b.at || a.seq - b.seq);

  const topics = new Map();
  for (const [id, Tt] of T) topics.set(id, { name: Tt.b.name, compacted: Tt.compacted || 0, parts: Tt.parts.map(P => ({ p: P.p, leader: P.leader, replicas: P.replicas, isr: P.isr, offline: P.offline, start: P.start, end: P.log.length,
    live: P.log.filter(r => !r.gone && !r.deleted).length, tail: P.log.slice(-12).map(r => ({ off: r.off, key: r.key, value: r.value, gone: !!r.gone || !!r.deleted, dup: !!r.dup, tomb: r.tomb })), lost: (P.lost || []).length, dups: P.log.filter(r => r.dup).length })) });
  const consumers = new Map();
  for (const [id, cs] of CS) consumers.set(id, { name: cs.b.name, gid: cs.g.gid, processed: cs.processed, unique: cs.got.size, got: cs.got, assigned: cs.assigned.map(pname), alive: cs.alive });
  const tokens = journeys.slice(0, 14).map(j => {
    const owner = G.size ? [...G.values()].map(g => g.owners.get(pk(j.s.t.id, j.p))).find(Boolean) : null;
    const c = owner && byName(m, 'consumer', owner);
    const hops = [{ from: j.s.p.id, to: j.s.t.id }];
    if (c && topicsOf(m, c).some(t => t.id === j.s.t.id)) hops.push({ from: j.s.t.id, to: c.id });
    return { hops, cls: 'req', endCls: 'ok', label: `${j.s.key == null ? '∅' : j.s.key}→p${j.p}` };
  });
  return { steps, tokens, topics, groups, consumers, counts, split, duration };
}

// ---------------------------------------------------------------- the real commands for this board

const CONFIG_COMMIT = {
  after: { EnableAutoCommit: 'false', EnableAutoOffsetStore: 'false', how: 'consumer.Commit(result) after the work (or StoreOffset + auto commit)' },
  before: { EnableAutoCommit: 'false', EnableAutoOffsetStore: 'false', how: 'consumer.Commit(result) BEFORE the work' },
  autostore: { EnableAutoCommit: 'true', EnableAutoOffsetStore: 'true', how: 'nothing: Consume() stores the offset, a background thread commits it every 5 s' },
};

export function toText(m) {
  const L = [];
  const bootstrap = brokerList(m).map(x => `${x.b.name}:9092`).join(',') || 'localhost:9092';
  L.push('# The Kafka setup on this board, as real commands and client configs.', '# 1) Topics (kafka-topics.sh ships with Kafka):');
  for (const t of ofKind(m, 'topic')) {
    L.push(`kafka-topics.sh --bootstrap-server ${bootstrap.split(',')[0]} --create --topic ${t.name} --partitions ${t.partitions} --replication-factor ${t.rf} --config min.insync.replicas=${t.minIsr} --config cleanup.policy=${t.cleanup}${t.cleanup === 'delete' ? ` --config retention.ms=${t.retentionMs}` : ''}`);
  }
  const gids = [...new Set(ofKind(m, 'consumer').map(c => c.groupId))];
  if (gids.length) {
    L.push('# Lag per partition, and who owns what:');
    for (const g of gids) L.push(`kafka-consumer-groups.sh --bootstrap-server ${bootstrap.split(',')[0]} --describe --group ${g}`);
  }
  L.push('', '# 2) Confluent.Kafka (librdkafka) configs in C#:');
  for (const p of ofKind(m, 'producer')) {
    const t = topicOf(m, p);
    L.push(`ProducerConfig ${p.name}:   # new ProducerConfig { ... } → new ProducerBuilder<string, string>(config).Build()`,
      `  BootstrapServers: ${bootstrap}`,
      `  Acks: Acks.${p.acks === 'all' ? 'All' : p.acks === '1' ? 'Leader' : 'None'}`,
      `  EnableIdempotence: ${!!p.idempotence}`,
      `  MessageSendMaxRetries: ${Number(p.retries) || 0}`,
      `  # librdkafka hashes keys with CRC32 (consistent_random); Java clients use murmur2. Mixed fleets: Partitioner = Partitioner.Murmur2Random`,
      `  # ProduceAsync("${t?.name || ''}", new Message<string, string> { Key = ${p.keyMode === 'entity' ? `${p.entity || 'order'}.Id` : p.keyMode === 'random' ? 'Guid.NewGuid().ToString()' : 'null'}, Value = json })`);
  }
  for (const c of ofKind(m, 'consumer')) {
    const cc = CONFIG_COMMIT[c.commit] || CONFIG_COMMIT.after;
    L.push(`ConsumerConfig ${c.name}:   # consumer.Subscribe(${JSON.stringify(topicsOf(m, c).map(t => t.name))})`,
      `  BootstrapServers: ${bootstrap}`,
      `  GroupId: ${c.groupId}`,
      `  AutoOffsetReset: AutoOffsetReset.${c.reset === 'earliest' ? 'Earliest' : 'Latest'}`,
      `  EnableAutoCommit: ${cc.EnableAutoCommit}`,
      `  EnableAutoOffsetStore: ${cc.EnableAutoOffsetStore}`,
      `  PartitionAssignmentStrategy: PartitionAssignmentStrategy.${c.assignor === 'roundrobin' ? 'RoundRobin' : 'Range'}`,
      `  # commits: ${cc.how}${c.idempotent ? '; skips order ids it has already handled' : ''}`);
  }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- challenges

export const partsCost = m => m.blocks.length + m.wires.length;
const starsFor = (c, par, slack = 2) => (c <= par ? 3 : c <= par + slack ? 2 : 1);
const goal = (label, ok, why) => ({ label, ok: !!ok, why: ok ? '' : why });
const brokers3 = () => [1, 2, 3].map(i => block('broker', `b-${i}`, `broker-${i}`, 420 + (i - 1) * 200, 40));
const Pr = (name, x, y, s) => block('producer', 'p-' + name, name, x, y, s);
const Tp = (name, x, y, s) => block('topic', 't-' + name, name, x, y, s);
const Co = (name, x, y, s) => block('consumer', 'c-' + name, name, x, y, s);
const B = (m, kind, name) => byName(m, kind, name);
const grp = (R, gid) => R.groups?.get(gid);
const con = (R, m, name) => { const c = B(m, 'consumer', name); return c && R.consumers?.get(c.id); };

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free board: a three-broker cluster, a topic, a producer and two consumer groups. Change keys, acks, partitions, replication, commit modes and group ids, then **Produce and consume**, **Kill broker 2**, **Kill a consumer** or **Restart the consumer**. The commands and configs on the right follow every change.',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { rate: 20, entities: 8 }), Tp('orders', 520, 300), Co('billing-1', 1000, 220, { groupId: 'billing', rate: 15 }), Co('billing-2', 1000, 400, { groupId: 'billing', rate: 15 }), Co('email', 1000, 600, { groupId: 'email', rate: 30 })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-billing-1'), wire('t-orders', 'c-billing-2'), wire('t-orders', 'c-email')] }),
    solve: m => m, check: () => [] },

  { id: 'same-key', title: 'Same key, same partition', xp: 20, scenario: { duration: 20 },
    brief: 'Shipping sometimes handles an order\'s **shipped** event before its **paid** event. The shop produces with a **random key**, so each event of one order lands in any of the three partitions, and three consumers read those partitions in parallel. Kafka only keeps order **inside one partition**. Key every record by its **order id**: the same key always hashes to the same partition.',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { keyMode: 'random', rate: 10, count: 120, entities: 6 }), Tp('orders', 520, 300), Co('shipping-1', 1000, 160, { groupId: 'shipping', rate: 4 }), Co('shipping-2', 1000, 340, { groupId: 'shipping', rate: 4 }), Co('shipping-3', 1000, 520, { groupId: 'shipping', rate: 4 })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-shipping-1'), wire('t-orders', 'c-shipping-2'), wire('t-orders', 'c-shipping-3')] }),
    solve: m => { B(m, 'producer', 'shop').keyMode = 'entity'; return m; },
    check: (m, R) => {
      const sp = R.split ? [...R.split.values()].flat() : [];
      const g = grp(R, 'shipping');
      return [goal('every order\'s events are in one partition', !sp.length, `${sp.length} orders are spread over several partitions (${sp.slice(0, 2).map(x => `${x.entity}: ${x.parts.join(', ')}`).join('; ')}).`),
        goal('no order is handled out of order', g && !g.violations, g ? `${g.violations} orders were handled out of order (${g.violatedKeys.slice(0, 3).join(', ')}).` : 'there is no shipping group.')];
    } },

  { id: 'idle-consumers', title: 'More consumers than partitions', xp: 25,
    brief: 'Payments are piling up, so someone scaled **billing** to four instances. Nothing got faster: **payments** has only **2 partitions**, and inside a group each partition has exactly one owner, so two instances sit idle. Give the topic enough partitions for every member. (In production, adding partitions moves keys to new partitions: plan the count up front.)',
    setup: () => ({ blocks: [...brokers3(), Pr('checkout', 40, 300, { rate: 40, entities: 48, entity: 'payment' }), Tp('payments', 520, 300, { partitions: 2 }), ...[1, 2, 3, 4].map(i => Co(`billing-${i}`, 1000, 80 + (i - 1) * 170, { groupId: 'billing', rate: 15 }))],
      wires: [wire('p-checkout', 't-payments'), ...[1, 2, 3, 4].map(i => wire('t-payments', `c-billing-${i}`))] }),
    solve: m => { B(m, 'topic', 'payments').partitions = 4; return m; },
    check: (m, R) => {
      const g = grp(R, 'billing');
      return [goal('every billing instance owns a partition', g && !g.idle.length, g ? `${g.idle.join(', ')} ${g.idle.length === 1 ? 'is' : 'are'} idle.` : 'there is no billing group.'),
        goal('billing keeps up (lag under 60 at the end)', g && g.lag < 60, g ? `the lag is ${g.lag} and growing.` : '')];
    } },

  { id: 'lag', title: 'Lag keeps growing', xp: 25,
    brief: 'The **analytics** dashboard is minutes behind. Clicks arrive at **100/s** across 6 partitions; the one **analytics** consumer handles 40/s, so its **lag** (log-end offset minus committed offset) grows every second. Add **competing consumers to the same group**. A consumer with a different group.id would not help: it would read everything again on its own.',
    setup: () => ({ blocks: [...brokers3(), Pr('web', 40, 300, { keyMode: 'none', rate: 100, entity: 'session', entities: 50 }), Tp('clicks', 520, 300, { partitions: 6 }), Co('analytics-1', 1000, 300, { groupId: 'analytics', rate: 40 })],
      wires: [wire('p-web', 't-clicks'), wire('t-clicks', 'c-analytics-1')] }),
    solve: m => { m.blocks.push(Co('analytics-2', 1000, 480, { groupId: 'analytics', rate: 40 }), Co('analytics-3', 1000, 660, { groupId: 'analytics', rate: 40 })); m.wires.push(wire('t-clicks', 'c-analytics-2'), wire('t-clicks', 'c-analytics-3')); return m; },
    check: (m, R) => {
      const g = grp(R, 'analytics');
      return [goal('the analytics group\'s lag stays under 200', g && g.lag < 200 && g.lagAt.every(x => x.lag < 400), g ? `lag ${g.lagAt.map(x => x.lag).join(' → ')}.` : 'there is no analytics group.'),
        goal('every click is read by the analytics group, once', g && g.unique + g.lag >= R.counts.written && !g.dupEffects, g ? `analytics processed ${g.unique} of ${R.counts.written}${g.dupEffects ? `, ${g.dupEffects} twice` : ''}.` : '')];
    } },

  { id: 'two-groups', title: 'Two groups, two emails', xp: 25,
    brief: 'Customers get **every confirmation email twice**. The email service runs two instances, and each was deployed with its own **group.id** (email-1, email-2). Separate groups each get *every* message, which is exactly right for different services (billing has its own group) but wrong for two copies of the same service. Put both email instances in **one group** so they share the work.',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { rate: 5, count: 30, entities: 30 }), Tp('orders', 520, 300), Co('email-1', 1000, 160, { groupId: 'email-1' }), Co('email-2', 1000, 340, { groupId: 'email-2' }), Co('billing', 1000, 540, { groupId: 'billing' })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-email-1'), wire('t-orders', 'c-email-2'), wire('t-orders', 'c-billing')] }),
    solve: m => { B(m, 'consumer', 'email-1').groupId = 'email'; B(m, 'consumer', 'email-2').groupId = 'email'; return m; },
    check: (m, R) => {
      const sent = new Map();
      for (const c of R.consumers?.values() || []) if (c.name.startsWith('email')) for (const [b, n] of c.got) sent.set(b, (sent.get(b) || 0) + n);
      const twice = [...sent.values()].filter(n => n > 1).length;
      const bill = con(R, m, 'billing');
      return [goal('each order gets exactly one email', sent.size === 30 && !twice, `${twice} orders got two emails${sent.size < 30 ? `, ${30 - sent.size} got none` : ''}.`),
        goal('billing still sees every order', bill?.unique === 30, `billing processed ${bill?.unique ?? 0} of 30.`)];
    } },

  { id: 'acks', title: 'acks=1 lost an order', xp: 35, scenario: { kill: { broker: 2, at: 30 } },
    action: { label: '💥 Produce, then kill broker 2', title: '60 s of orders; at 30 s broker 2 dies right after a burst of writes' },
    brief: 'Broker 2 died, and three orders the shop had been told were **saved** disappeared. The producer uses **acks=1**: the leader acknowledges as soon as *it* has the record, before the followers copy it. Lose the leader in that window and the new leader never had them. Use **acks=all** with **min.insync.replicas=2** on a topic with **replication factor 3**: an ack then means two brokers have it, and one can fail.',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { acks: '1', idempotence: false, rate: 50, entities: 30 }), Tp('orders', 520, 300, { minIsr: 1 }), Co('billing', 1000, 300, { rate: 80 })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-billing')] }),
    solve: m => { Object.assign(B(m, 'producer', 'shop'), { acks: 'all', idempotence: true }); B(m, 'topic', 'orders').minIsr = 2; return m; },
    check: (m, R) => {
      const t = B(m, 'topic', 'orders'), p = B(m, 'producer', 'shop');
      return [goal('no acknowledged order is lost', R.counts && !R.counts.lostAcked && !R.counts.lostUnacked, `${(R.counts?.lostAcked || 0) + (R.counts?.lostUnacked || 0)} orders were lost when the leader died.`),
        goal('acks=all, replication factor 3, min.insync.replicas 2', p?.acks === 'all' && Number(t?.rf) === 3 && Number(t?.minIsr) === 2, `now: acks=${p?.acks}, RF ${t?.rf}, min.insync.replicas ${t?.minIsr}. With min.insync.replicas=1, acks=all is only as strong as the leader once the followers fall out of the ISR.`),
        goal('no write fails', R.counts && !R.counts.failed, `${R.counts?.failed} writes failed.`)];
    } },

  { id: 'too-strict', title: 'Too strict to write', xp: 30, scenario: { kill: { broker: 2, at: 0 } },
    action: { label: '▶ Produce with broker 2 down', title: 'broker 2 is down for a rolling upgrade while orders keep coming' },
    brief: 'During a rolling upgrade, **broker 2** is down for a few minutes and every order fails with **NotEnoughReplicasException**. The topic has replication factor 3 and **min.insync.replicas=3**: acks=all then needs all three brokers, so losing *any* one stops all writes. The usual setting is RF 3 with min.insync.replicas **2**: one broker can be down, and every ack still means two copies.',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { rate: 20 }), Tp('orders', 520, 300, { minIsr: 3 }), Co('billing', 1000, 300, { rate: 40 })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-billing')] }),
    solve: m => { B(m, 'topic', 'orders').minIsr = 2; return m; },
    check: (m, R) => {
      const t = B(m, 'topic', 'orders'), p = B(m, 'producer', 'shop');
      return [goal('orders are written while broker 2 is down', R.counts && !R.counts.failed && R.counts.written > 0, `${R.counts?.failed} writes failed (${R.counts?.notEnough} NotEnoughReplicas).`),
        goal('still safe: acks=all and min.insync.replicas of at least 2', p?.acks === 'all' && Number(t?.minIsr) >= 2, 'turning safety off (acks=1 or min.insync.replicas=1) is not the fix: one more failure would lose data.')];
    } },

  { id: 'duplicates', title: 'Duplicates from retries', xp: 30, scenario: { lostAcks: true },
    action: { label: '▶ Produce over a flaky network', title: 'every 25th acknowledgement is lost on the way back to the producer' },
    brief: 'The topic holds some orders **twice**. The network sometimes drops the broker\'s acknowledgement; the producer cannot tell "not written" from "written, ack lost", so it **retries**, and the broker appends a second copy. Turn on **enable.idempotence** (it needs **acks=all**): the producer numbers its batches, and the broker drops a retry it already has. In librdkafka, and so Confluent.Kafka, it is off by default.',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { acks: '1', idempotence: false, rate: 20 }), Tp('orders', 520, 300), Co('billing', 1000, 300, { rate: 40 })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-billing')] }),
    solve: m => { Object.assign(B(m, 'producer', 'shop'), { acks: 'all', idempotence: true }); return m; },
    check: (m, R) => [goal('no duplicate records in the log', R.counts && !R.counts.logDuplicates, `${R.counts?.logDuplicates} orders were written twice.`),
      goal('no order is dropped instead', R.counts && !R.counts.failed, `${R.counts?.failed} writes failed. Setting retries to 0 trades duplicates for lost orders.`)] },

  { id: 'commit-crash', title: 'Committed, then crashed', xp: 40, scenario: { outages: [{ consumer: 'billing', from: 20.25, to: 25 }] },
    action: { label: '💀 Consume, crash at 20 s, restart', title: 'billing crashes in the middle of a batch at 20.25 s and is restarted at 25 s' },
    brief: 'billing crashed and restarted, and some orders were **never charged**. It uses Confluent.Kafka\'s defaults: **EnableAutoCommit=true** with **EnableAutoOffsetStore=true**, so an offset is stored the moment Consume() returns the record and a background thread commits it every 5 s, *before* the work is done. Commit **after processing** instead (EnableAutoOffsetStore=false, StoreOffset or Commit after the work). That can replay a few records after a crash, so make the consumer **idempotent** (skip order ids it has already charged).',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { rate: 10, backlog: 600 }), Tp('orders', 520, 300, { partitions: 1, rf: 3 }), Co('billing', 1000, 300, { rate: 20, commit: 'autostore', reset: 'earliest' })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-billing')] }),
    solve: m => { Object.assign(B(m, 'consumer', 'billing'), { commit: 'after', idempotent: true }); return m; },
    check: (m, R) => {
      const g = grp(R, 'billing');
      return [goal('no order is lost in the crash', g && !g.lostCommit, g ? `${g.lostCommit} orders were committed but never processed.` : 'there is no billing group.'),
        goal('no order is charged twice', g && !g.dupEffects, g ? `${g.dupEffects} orders were charged twice: after the crash they were read again.` : '')];
    } },

  { id: 'new-service', title: 'The new service saw nothing', xp: 25,
    brief: 'The new **reporting** service went live and its first report is missing the **500 orders** already in the topic. It is a brand-new group with no committed offsets, and **auto.offset.reset=latest** (the default) starts a new group at the *end* of each partition. Set it to **earliest** to read the backlog. (It only applies when a group has no offsets yet; to rewind an existing group, use `kafka-consumer-groups --reset-offsets --to-earliest --execute`.)',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { rate: 5, backlog: 500 }), Tp('orders', 520, 300), Co('reporting', 1000, 300, { groupId: 'reporting', rate: 100 })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-reporting')] }),
    solve: m => { B(m, 'consumer', 'reporting').reset = 'earliest'; return m; },
    check: (m, R) => {
      const c = con(R, m, 'reporting');
      return [goal('reporting reads all the old orders and the new ones', c && c.unique === R.counts.written, `reporting processed ${c?.unique ?? 0} of ${R.counts?.written ?? '?'} orders.`)];
    } },

  { id: 'retention', title: 'Retention ate the backlog', xp: 35, scenario: { duration: 4 * 3600, dt: 60, outages: [{ consumer: 'billing', from: 600, to: 3 * 3600 + 600 }] },
    action: { label: '▶ Run 4 hours (billing down for 3)', title: 'billing is down from 10 minutes in until 3 h 10 min' },
    brief: 'billing was down for **three hours** and, when it came back, it skipped straight to the newest orders: everything in between was never charged. The topic keeps data for **retention.ms = 1 hour**, so the unread records were deleted while billing was away. Its committed offset pointed at deleted data (**OffsetOutOfRange**) and **auto.offset.reset** decided where to go. Keep data longer than the worst outage you plan for (the broker default is 7 days, 604800000 ms).',
    setup: () => ({ blocks: [...brokers3(), Pr('shop', 40, 300, { rate: 1, entities: 50 }), Tp('orders', 520, 300, { retentionMs: 3600000 }), Co('billing', 1000, 300, { rate: 20 })],
      wires: [wire('p-shop', 't-orders'), wire('t-orders', 'c-billing')] }),
    solve: m => { B(m, 'topic', 'orders').retentionMs = 604800000; return m; },
    check: (m, R) => {
      const g = grp(R, 'billing');
      return [goal('nothing is deleted before billing reads it', g && !g.deletedUnread && !g.resetSkipped, g ? `${g.deletedUnread} records were deleted unread${g.resetSkipped ? ` and ${g.resetSkipped} more skipped by auto.offset.reset` : ''}.` : 'there is no billing group.'),
        goal('billing has caught up by the end', g && g.lag < 100, g ? `the lag is ${g.lag}.` : '')];
    } },

  { id: 'compaction', title: 'Latest value per key', xp: 40, scenario: { duration: 10 * 86400 + 3600, dt: 3600 },
    action: { label: '▶ Run 10 days, then start the cache', title: 'ten days of profile updates; then a new profile cache reads the topic from the start' },
    brief: 'A new **profile-cache** service reads **customer-profiles** from the start to build *the current profile of every customer*. But the topic deletes records after a day, so customers who have not changed their profile recently are missing, and customer-3, who deleted their account, must not appear. This is what **cleanup.policy=compact** is for: Kafka keeps at least the **latest record per key** forever, and a **tombstone** (a null value) deletes a key. Compaction needs keys: the CRM currently produces without one.',
    setup: () => ({ blocks: [...brokers3(), Pr('crm', 40, 300, { keyMode: 'none', entity: 'customer', entities: 8, count: 24, rate: 24 / (10 * 86400), deletes: ['customer-3'] }), Tp('customer-profiles', 520, 300, { retentionMs: 86400000 }),
      Co('profile-cache', 1000, 300, { groupId: 'profile-cache', reset: 'earliest', rate: 50, joinAt: 10 * 86400 + 60 })],
    wires: [wire('p-crm', 't-customer-profiles'), wire('t-customer-profiles', 'c-profile-cache')] }),
    solve: m => { B(m, 'producer', 'crm').keyMode = 'entity'; B(m, 'topic', 'customer-profiles').cleanup = 'compact'; return m; },
    check: (m, R) => {
      const g = grp(R, 'profile-cache');
      const cache = g?.cache || new Map();
      const want = ['customer-1', 'customer-2', 'customer-4', 'customer-5', 'customer-6', 'customer-7', 'customer-8'];
      const have = want.filter(k => cache.get(k)?.seq === 3);
      return [goal('the cache holds the latest profile of all 7 active customers', have.length === 7, `${have.length} of 7 are there with their latest version. ${R.counts?.rejectedNoKey ? `${R.counts.rejectedNoKey} records were rejected for having no key.` : ''}`),
        goal('customer-3 (deleted) is not in the cache', !cache.has('customer-3') && have.length > 0, cache.has('customer-3') ? 'customer-3 is still there: the tombstone was not read.' : 'the cache is empty.')];
    } },
];
for (const c of CHALLENGES) c.par ??= partsCost(c.solve(c.setup()));

export function judge(m, ch) {
  const R = simulate(m, ch.scenario || {});
  const goals = R.error ? [goal('the board runs', false, R.error)] : ch.check(m, R).filter(Boolean);
  const ok = goals.length > 0 && goals.every(g => g.ok);
  const cost = partsCost(m);
  return { ok, goals, cost, stars: ok ? starsFor(cost, ch.par) : 0, run: R };
}
