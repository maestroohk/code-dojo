// Messaging builder: one page, two modes. RabbitMQ: producer apps publish to exchanges, bindings route to
// queues (drawn as message trays), consumer apps read them with prefetch and acks; dead-lettering, retries,
// parking lots and broker restarts. Kafka: producers write keyed records to topics whose partitions are
// append-only logs spread over brokers, consumer groups split the partitions, offsets and lag, broker and
// consumer failures, retention and compaction. Every message is animated along the cables and every routing,
// partitioning and delivery decision is explained in the run log.
// The simulations live in rabbitsim.js and kafkasim.js (DOM-free, tested in Node); the page shell in buildlab.js.
import { h } from './util.js';
import * as game from './game.js';
import { builderLab, controls, fill } from './buildlab.js';
import * as RS from './rabbitsim.js';
import * as KS from './kafkasim.js';

export const MODES = {
  rabbitmq: { label: 'RabbitMQ', icon: '🐇', text: 'Exchanges, bindings, queues, acks and dead-lettering' },
  kafka: { label: 'Kafka', icon: '🧾', text: 'Partitions, keys, replicas, consumer groups and offsets' },
};

/** The page: a mode switch, then the builder for that mode (each with its own saved progress). */
export function msgBuildLab(container, onXp, mode) {
  const st = game.state.labs['msgbuild-mode'] ||= { mode: 'rabbitmq' };
  if (!MODES[mode]) mode = MODES[st.mode] ? st.mode : 'rabbitmq';
  if (st.mode !== mode) { st.mode = mode; game.save(); }
  const host = h('div');
  container.replaceChildren(
    h('div.mb-modes', { role: 'tablist' }, Object.entries(MODES).map(([id, x]) => h(`a.mb-mode${id === mode ? '.active' : ''}`, { href: `#/labs/msgbuild/${id}`, role: 'tab', 'aria-selected': String(id === mode) },
      h('span.mb-mode-icon', x.icon), h('span', h('b', x.label), h('span.muted.small', x.text))))),
    host);
  return mode === 'kafka' ? kafkaLab(host, onXp) : rabbitLab(host, onXp);
}

// ---------------------------------------------------------------- shared helpers

const uniqueName = (m, kind, base) => { let i = 1, n = base; while (m.blocks.some(b => b.kind === kind && b.name === n)) n = `${base}-${++i}`; return n; };
const uniqueId = (m, id) => { let x = id.replace(/[^\w.-]/g, '_'); while (m.blocks.some(b => b.id === x)) x += 'x'; return x; };
const nameRule = (m, sim, kind, self) => v => {
  if (!v) return 'A name is needed.';
  if (!sim.validName(v)) return 'Use letters, digits and - _ . only.';
  if (m.blocks.some(b => b !== self && b.kind === kind && b.name === v)) return `There is already a ${sim.KINDS[kind].label.toLowerCase()} called ${v}.`;
  return true;
};
const sec = t => `${(Math.round(t * 100) / 100).toFixed(2)}s`;
const removeBtn = (onclick, label = 'Remove') => h('button.btn.ghost.small', { type: 'button', onclick }, label);
const inspectHead = (title, ...btns) => h('div.pk-inspect-head', h('b', title), ...btns);
const chips = (n, cls, max = 14) => h('div.mb-chips', Array.from({ length: Math.min(n, max) }, () => h(`span.mb-chip.${cls}`)), n > max ? h('span.mb-more', `+${n - max}`) : null);

// ================================================================ RabbitMQ

const R_COLORS = { producer: '#5b8def', exchange: '#d9786a', queue: '#c9a24a', consumer: '#3fb68b' };
const R_ART = { producer: 'producerapp', exchange: 'exchange', queue: 'tray', consumer: 'consumerapp' };
const R_KINDS = Object.fromEntries(Object.entries(RS.KINDS).map(([k, v]) => [k, { ...v, color: R_COLORS[k], art: R_ART[k], width: k === 'queue' ? 210 : 190 }]));
const EX_HELP = {
  direct: 'Copies a message to every queue whose binding key equals the routing key exactly.',
  topic: 'Keys are words split by dots. In a binding, * matches exactly one word and # matches zero or more.',
  fanout: 'Copies every message to every bound queue and ignores the routing key. For broadcasts.',
  headers: 'Ignores the routing key and matches message headers against binding arguments, with x-match all (every one) or any (at least one).',
};

function rabbitLab(container, onXp) {
  let lastRun = null;                 // { model, R } of the latest run, for the device bodies
  return builderLab(container, onXp, {
    lab: 'msgbuild-rabbit',
    sim: RS,
    costLabel: 'blocks + wires',
    board: api => rabbitBoard(api, () => (lastRun?.model === api.model ? lastRun.R : null), () => { lastRun = null; }),
    form: api => rabbitForm(api, () => { lastRun = null; }),
    actions: ch => (ch.xp
      ? [{ id: 'challenge', label: ch.action?.label || '▶ Publish and consume', title: ch.action?.title || 'Publish every message and let the consumers work until the queues settle' },
        ...(ch.scenario ? [{ id: 'plain', label: '▶ Publish and consume (no incident)', title: 'The same run without the incident' }] : [])]
      : [{ id: 'plain', label: '▶ Publish and consume', title: 'Publish every message and let the consumers work until the queues settle' },
        { id: 'restart', label: '💥 Restart the broker', title: 'The RabbitMQ node restarts about one second in and is back two seconds later' },
        { id: 'kill', label: '💀 Kill a consumer', title: 'The first consumer crashes one second in and stays down' }]),
    run: (m, id, ch) => { const out = rabbitRun(m, id, ch); lastRun = { model: m, R: out.R }; return out; },
    yaml: { title: 'rabbitmqadmin + RabbitMQ.Client', text: RS.toText, note: 'The commands that would declare this board on a real broker, then the same in C# with RabbitMQ.Client 7. It follows the board.' },
  });
}

function rabbitBoard(api, run, forget) {
  const m = () => api.model;
  const blk = id => RS.byId(m(), id);
  const changed = () => { forget(); api.changed(); };
  const { field, text, num, check, select, lines } = controls(changed, api.say);
  const exOptions = (self, none = 'none') => [['', none], ...RS.ofKind(m(), 'exchange').filter(e => e !== self).map(e => [e.id, e.name])];

  function add(kind, at) {
    const base = { producer: 'shop', exchange: 'orders', queue: 'orders', consumer: 'worker' }[kind];
    const name = uniqueName(m(), kind, base);
    const b = RS.block(kind, uniqueId(m(), `${kind[0]}-${name}`), name, at.x, at.y);
    m().blocks.push(b);
    changed();
    return b;
  }

  // Settings that point at another exchange are drawn as dashed wires too: dead-letter, alternate, park.
  const derived = () => {
    const out = [];
    for (const q of RS.ofKind(m(), 'queue')) if (q.dlx && blk(q.dlx)) out.push({ id: 'D-' + q.id, kind: 'dlx', from: { block: q.id, port: 'out' }, to: { block: q.dlx }, owner: q.id, label: 'dead-letter' });
    for (const e of RS.ofKind(m(), 'exchange')) if (e.ae && blk(e.ae)) out.push({ id: 'A-' + e.id, kind: 'ae', from: { block: e.id, port: 'out' }, to: { block: e.ae }, owner: e.id, label: 'alternate' });
    for (const c of RS.ofKind(m(), 'consumer')) if (Number(c.parkAfter) > 0 && c.parkTo && blk(c.parkTo)) out.push({ id: 'K-' + c.id, kind: 'park', from: { block: c.id }, to: { block: c.parkTo }, owner: c.id, label: `park after ${c.parkAfter}` });
    return out;
  };
  const wireKind = w => { const f = blk(w.from)?.kind; return f === 'producer' ? 'pub' : f === 'exchange' ? 'bind' : 'sub'; };

  function body(b) {
    const R = run();
    const line = t => h('div.ab-line', t);
    const tags = list => { const t = list.filter(Boolean); return t.length ? h('div.bk-tags', t.map(x => (Array.isArray(x) ? h(`span.bk-tag.${x[1]}`, x[0]) : h('span.bk-tag', x)))) : null; };
    if (b.kind === 'producer') {
      const specs = (b.messages || []).map(RS.parseMsg);
      const total = specs.reduce((s, x) => s + (x.count || 0), 0);
      return [h('div.bk-name', b.name), line(`${total} message${total === 1 ? '' : 's'}${Number(b.rate) > 0 ? ` at ${b.rate}/s` : ', all at once'}`),
        specs.slice(0, 3).map(s => (s.error ? line('⚠ bad line') : h('code.ab-op', `${RS.msgText(s)}${s.count > 1 ? ` ×${s.count}` : ''}${s.poison ? ' ☠' : ''}${s.failTimes ? ` fail×${s.failTimes}` : ''}`))),
        tags([b.persistent ? 'persistent' : ['transient', 'warn'], b.confirms && 'confirms', b.mandatory && 'mandatory'])];
    }
    if (b.kind === 'exchange') {
      return [h('div.bk-name', b.name), h('code.ab-op', b.type), tags([!b.durable && ['not durable', 'warn'], b.ae && blk(b.ae) && `AE → ${blk(b.ae).name}`])];
    }
    if (b.kind === 'queue') {
      const q = R?.queues.get(b.id);
      const cfg = tags([b.qtype === 'quorum' ? 'quorum' : 'classic', b.qtype !== 'quorum' && !b.durable && ['not durable', 'warn'], Number(b.ttl) > 0 && `TTL ${b.ttl} ms`, b.dlx && blk(b.dlx) && `DLX → ${blk(b.dlx).name}`,
        b.qtype === 'quorum' && `delivery-limit ${Number(b.deliveryLimit) > 0 ? b.deliveryLimit : 'off'}`, Number(b.maxLength) > 0 && `max ${b.maxLength}`]);
      if (!q) return [h('div.bk-name', b.name), chips(0, 'ready'), line('ready 0'), cfg];
      return [h('div.bk-name', b.name), chips(q.ready, q.heldMsgs.some(x => x.spec.poison) ? 'poison' : 'ready'),
        line(`ready ${q.ready} · unacked ${q.unacked} · peak ${q.peak}`), line(`delivered ${q.delivered} · redelivered ${q.redelivered}${q.dead ? ` · dead-lettered ${q.dead}` : ''}`), cfg];
    }
    const c = R?.consumers.get(b.id);
    const q = RS.queueOf(m(), b);
    return [h('div.bk-name', b.name), line(q ? `reads ${q.name}` : 'not subscribed'),
      line(b.autoAck ? 'autoAck' : `prefetch ${Number(b.prefetch) || '∞'} · ${b.onError === 'reject' ? 'reject' : b.onError === 'ack' ? 'ack on error' : 'nack requeue'}`),
      c && line(`processed ${c.processed}${c.failed ? ` · failed ${c.failed}` : ''}${c.lost ? ` · lost ${c.lost}` : ''}`),
      tags([`${Math.round(1000 / Math.max(1, Number(b.workMs) || 1))}/s`, Number(b.crashAfter) > 0 && ['crashes', 'warn'], Number(b.startAt) > 0 && `starts at ${b.startAt}s`])];
  }

  function bindingInspector(w) {
    const f = blk(w.from), t = blk(w.to);
    const head = inspectHead(`Binding ${f.name} → ${t.name}`, removeBtn(() => { m().wires = m().wires.filter(x => x !== w); changed(); }));
    const parts = [head, h('p.muted.small', `${f.name} is a ${f.type} exchange. ${EX_HELP[f.type]}`)];
    if (f.type === 'direct' || f.type === 'topic') {
      parts.push(field('Binding key', text(w, 'key', f.type === 'topic' ? 'order.*.created' : 'order.created'),
        f.type === 'topic' ? 'Words split by dots. * = exactly one word, # = zero or more. order.# matches order, order.created and order.eu.created.' : 'Must equal the routing key exactly, character for character.'));
    } else if (f.type === 'headers') {
      parts.push(field('x-match', select(w, 'match', [['all', 'all: every argument must match'], ['any', 'any: one is enough']])),
        field('Arguments (name=value, one per line)', lines(w, 'hargs', 'format=pdf\ntype=invoice', 3), 'Headers that start with x- are ignored for matching.'));
    } else parts.push(h('p.muted.small', 'A fanout binding has no key: every message goes to every bound queue.'));
    parts.push(h('p.muted.small', t.kind === 'exchange' ? `An exchange-to-exchange binding: matching messages are routed again by ${t.name}.` : `Matching messages are copied into ${t.name}. One copy per queue, however many bindings match.`));
    return h('div.pk-inspect', parts);
  }

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click a block or a wire to configure it.');
    if (sel.type === 'wire') {
      const d = derived().find(x => x.id === sel.id);
      if (d) {
        const o = blk(d.owner);
        const clear = removeBtn(() => { if (d.kind === 'dlx') o.dlx = ''; else if (d.kind === 'ae') o.ae = ''; else o.parkTo = ''; changed(); });
        const txt = { dlx: `${o.name}'s dead-letter exchange: messages that are rejected without requeue, expire (TTL), go over the delivery-limit or are pushed out of a full queue are republished to ${blk(d.to.block).name}, with an x-death header counting how often and why.`,
          ae: `${o.name}'s alternate exchange: a message that matches none of ${o.name}'s bindings goes to ${blk(d.to.block).name} instead of being dropped.`,
          park: `${o.name} publishes a message to ${blk(d.to.block).name} on its ${o.parkAfter}th failed attempt (it reads the attempt count from the x-death header), then acks the original.` }[d.kind];
        return h('div.pk-inspect', inspectHead(d.label, clear), h('p.muted.small', txt), h('p.muted.small', `Change it in ${o.name}'s settings.`));
      }
      const w = m().wires.find(x => x.id === sel.id);
      if (!w) return null;
      const f = blk(w.from), t = blk(w.to);
      if (wireKind(w) === 'bind') return bindingInspector(w);
      const rm = removeBtn(() => { m().wires = m().wires.filter(x => x !== w); changed(); });
      if (wireKind(w) === 'pub') return h('div.pk-inspect', inspectHead(`${f.name} publishes to ${t.name}`, rm), h('p.muted.small', `BasicPublishAsync("${t.name}", routingKey, ...): every message goes to the exchange, never straight to a queue. The exchange's bindings decide where it lands.`));
      return h('div.pk-inspect', inspectHead(`${t.name} consumes ${f.name}`, rm), h('p.muted.small', `BasicConsumeAsync("${f.name}", autoAck: ${!!t.autoAck}, ...). Several consumers on one queue compete: each message goes to one of them, round robin, as far as prefetch allows.`));
    }
    const b = blk(sel.id);
    if (!b) return null;
    const k = R_KINDS[b.kind];
    const head = inspectHead(`${k.icon} ${k.label}`, removeBtn(() => { RS.removeBlock(m(), b.id); changed(); }, 'Delete'));
    const parts = [head, field('Name', text(b, 'name', '', nameRule(m(), RS, b.kind, b)))];
    if (b.kind === 'producer') {
      parts.push(
        field('Messages (one line each)', lines(b, 'messages', 'order.created x5', 4), 'routing.key, then xN for how many, header=value pairs, "poison" (always fails) or fail=N (fails N times, then works). Start with - for no routing key.'),
        h('div.pk-two', field('Rate (msg/s, 0 = all at once)', num(b, 'rate', { min: 0, max: 1000 })), field('Starts at (s)', num(b, 'startAt', { min: 0, max: 60, step: 0.1 }))),
        check(b, 'persistent', 'Persistent (delivery mode 2: written to disk on durable queues)'),
        check(b, 'confirms', 'Publisher confirms (the broker acks every publish)'),
        check(b, 'mandatory', 'Mandatory (unroutable messages come back as basic.return)'),
        b.mandatory && check(b, 'onReturn', 'Handles returns (a BasicReturnAsync handler stores them)'),
        h('p.muted.small', 'Drag ▶ onto an exchange: that is where it publishes.'));
    }
    if (b.kind === 'exchange') {
      parts.push(field('Type', select(b, 'type', RS.EXCHANGE_TYPES.map(t => [t, t])), EX_HELP[b.type]),
        check(b, 'durable', 'Durable (survives a broker restart, with its bindings)'),
        field('Alternate exchange', select(b, 'ae', exOptions(b)), 'Where messages that match no binding go. Without one they are dropped silently.'),
        h('p.muted.small', 'Drag ▶ onto a queue (or another exchange) to bind it.'));
    }
    if (b.kind === 'queue') {
      parts.push(field('Type', select(b, 'qtype', [['classic', 'classic'], ['quorum', 'quorum (replicated, always durable)']]),
        b.qtype === 'quorum' ? 'Replicated with Raft over the cluster. Always durable, and it keeps every message on disk.' : 'A single-node queue. Durable only if you say so.'),
      b.qtype !== 'quorum' && check(b, 'durable', 'Durable (the queue survives a restart; its messages only if persistent)'),
      h('div.pk-two', field('Message TTL (ms, 0 = none)', num(b, 'ttl', { min: 0, max: 86400000, step: 100 })), field('Max length (0 = none)', num(b, 'maxLength', { min: 0, max: 100000 }))),
      field('Dead-letter exchange', select(b, 'dlx', exOptions(null)), 'Where rejected, expired and over-limit messages go. Without one they are discarded.'),
      b.dlx && field('Dead-letter routing key (empty = keep the original)', text(b, 'dlk', '')),
      b.qtype === 'quorum' && field('Delivery limit (0 = off)', num(b, 'deliveryLimit', { min: 0, max: 1000 }), 'After this many returns (nack requeue, crashes) the message is dead-lettered. RabbitMQ 4 quorum queues default to 20.'),
      h('p.muted.small', 'Drag ▶ onto a consumer app to subscribe it.'));
    }
    if (b.kind === 'consumer') {
      parts.push(
        check(b, 'autoAck', 'autoAck (the broker forgets a message as soon as it is delivered)'),
        !b.autoAck && field('Prefetch (BasicQos, 0 = unlimited)', num(b, 'prefetch', { min: 0, max: 1000 }), 'How many unacked messages it may hold at once.'),
        !b.autoAck && field('When the handler throws', select(b, 'onError', RS.ON_ERROR)),
        h('div.pk-two', field('Work per message (ms)', num(b, 'workMs', { min: 1, max: 10000 })), field('Starts at (s)', num(b, 'startAt', { min: 0, max: 60, step: 0.1 }))),
        field('Crash after N messages (0 = never)', num(b, 'crashAfter', { min: 0, max: 10000 }), 'It crashes once, in the middle of the next message, and is restarted 2 s later.'),
        !b.autoAck && h('div.pk-two', field('Park after attempt (0 = off)', num(b, 'parkAfter', { min: 0, max: 50 })), field('Park to exchange', select(b, 'parkTo', exOptions(null)))),
        h('p.muted.small', 'Wire a queue\'s ▶ onto it to subscribe. Several consumers on one queue share its messages.'));
    }
    return h('div.pk-inspect', parts);
  }

  return {
    kinds: R_KINDS,
    wireKinds: { pub: { label: '', color: '#5b8def' }, bind: { label: '', color: '#d9786a' }, sub: { label: '', color: '#3fb68b' }, dlx: { label: '', color: '#9a6fc0' }, ae: { label: '', color: '#9a6fc0' }, park: { label: '', color: '#9a6fc0' } },
    wires: () => [...m().wires.map(w => ({ id: w.id, kind: wireKind(w), from: { block: w.from, port: 'out' }, to: { block: w.to }, w })), ...derived()],
    ports: b => (RS.TARGETS[b.kind].length ? [{ id: 'out', label: '', on: m().wires.some(w => w.from === b.id),
      title: { producer: 'Drag onto an exchange: publish to it', exchange: 'Drag onto a queue or an exchange: bind it', queue: 'Drag onto a consumer app: subscribe it' }[b.kind] }] : []),
    body,
    canConnect: (from, port, to) => RS.canWire(m(), from, to),
    connect: (from, port, to) => {
      if (!RS.connect(m(), from.id, to.id)) return `A ${R_KINDS[from.kind].label.toLowerCase()} cannot be wired to a ${R_KINDS[to.kind].label.toLowerCase()}.`;
      changed();
      if (from.kind === 'exchange') {
        const w = m().wires.filter(x => x.from === from.id && x.to === to.id).pop();
        api.select({ type: 'wire', id: w.id });
        api.say(from.type === 'fanout' ? `Bound ${to.name} to ${from.name}.` : `Bound ${to.name} with key "${w.key}". Set the binding key in the inspector.`);
      }
      return false;
    },
    onDropEmpty: () => { api.say('To remove a wire, click it and press Delete.'); return false; },
    palette: [
      { kind: 'producer', title: 'A producer app: publishes messages to an exchange', add: at => add('producer', at) },
      { kind: 'exchange', title: 'An exchange: routes each message to the queues bound to it', add: at => add('exchange', at) },
      { kind: 'queue', title: 'A queue: holds messages until a consumer acks them', add: at => add('queue', at) },
      { kind: 'consumer', title: 'A consumer app: reads a queue', add: at => add('consumer', at) },
    ],
    howto: 'Drag ▶ from a producer to an exchange, an exchange to a queue (a binding), a queue to a consumer. Click a wire to set the binding key. Dashed purple wires are dead-letter and alternate exchanges.',
    inspector,
    onDelete: sel => {
      if (sel.type === 'wire') {
        const d = derived().find(x => x.id === sel.id);
        if (d) { const o = blk(d.owner); if (d.kind === 'dlx') o.dlx = ''; else if (d.kind === 'ae') o.ae = ''; else o.parkTo = ''; }
        else m().wires = m().wires.filter(w => w.id !== sel.id);
      } else RS.removeBlock(m(), sel.id);
      changed();
    },
    wireLabel: w => {
      if (w.label) return w.label;
      if (w.kind !== 'bind') return '';
      const f = blk(w.w.from);
      if (f?.type === 'fanout') return 'fanout';
      if (f?.type === 'headers') return `${w.w.match === 'any' ? 'any' : 'all'}: ${RS.headerArgs(w.w).map(a => a.join('=')).join(' ') || '(none)'}`;
      return w.w.key === '' ? '""' : w.w.key;
    },
    zones: () => [{ id: 'broker', label: 'RabbitMQ broker', tone: 2, members: m().blocks.filter(b => b.kind === 'exchange' || b.kind === 'queue').map(b => b.id) }],
  };
}

function rabbitForm(api, forget) {
  const m = api.model;
  const changed = () => { forget(); api.changed(); };
  const { lines, select, text, num, check } = controls(changed, api.say);
  const row = b => ({ onclick: e => { if (!e.target.closest('input,button,select,textarea')) api.select({ type: 'block', id: b.id }); } });
  let a = '', z = '';
  const sources = m.blocks.filter(b => RS.TARGETS[b.kind].length);
  return h('div.nb-form',
    h('div.eyebrow', 'Producers'),
    h('table.nb-ftable', h('tr', h('th', 'Name'), h('th', 'Messages'), h('th', 'Rate'), h('th', 'Publishes to'), h('th', 'Flags')),
      RS.ofKind(m, 'producer').map(p => h('tr', row(p), h('td', h('b', p.name)), h('td', lines(p, 'messages', 'order.created x5', 2)), h('td', num(p, 'rate', { min: 0, max: 1000 })),
        h('td', RS.exchangeOf(m, p)?.name || h('span.muted', 'nothing')), h('td.small', check(p, 'persistent', 'persistent'), check(p, 'confirms', 'confirms'), check(p, 'mandatory', 'mandatory'))))),
    h('div.eyebrow', 'Exchanges'),
    h('table.nb-ftable', h('tr', h('th', 'Name'), h('th', 'Type'), h('th', 'Durable'), h('th', 'Bindings')),
      RS.ofKind(m, 'exchange').map(e => h('tr', row(e), h('td', h('b', e.name)), h('td', select(e, 'type', RS.EXCHANGE_TYPES.map(t => [t, t]))), h('td', check(e, 'durable', '')),
        h('td.small', RS.bindingsOf(m, e).map(w => h('div', `→ ${RS.byId(m, w.to)?.name} `, e.type === 'direct' || e.type === 'topic' ? text(w, 'key', 'key') : h('span.muted', e.type === 'fanout' ? '(fanout)' : `x-match ${w.match}`), ' ',
          h('button.btn.ghost.small', { type: 'button', onclick: () => { m.wires = m.wires.filter(x => x !== w); changed(); } }, '✕'))))))),
    h('div.eyebrow', 'Queues'),
    h('table.nb-ftable', h('tr', h('th', 'Name'), h('th', 'Type'), h('th', 'TTL (ms)'), h('th', 'Dead-letter exchange'), h('th', 'Consumers')),
      RS.ofKind(m, 'queue').map(q => h('tr', row(q), h('td', h('b', q.name)), h('td', select(q, 'qtype', RS.QUEUE_TYPES.map(t => [t, t]))), h('td', num(q, 'ttl', { min: 0, max: 86400000, step: 100 })),
        h('td', select(q, 'dlx', [['', 'none'], ...RS.ofKind(m, 'exchange').map(e => [e.id, e.name])])), h('td.small', RS.consumersOf(m, q).map(c => c.name).join(', ') || h('span.muted', 'none'))))),
    h('div.eyebrow', 'Consumers'),
    h('table.nb-ftable', h('tr', h('th', 'Name'), h('th', 'Reads'), h('th', 'Prefetch'), h('th', 'autoAck'), h('th', 'On error'), h('th', 'ms per message')),
      RS.ofKind(m, 'consumer').map(c => h('tr', row(c), h('td', h('b', c.name)), h('td', RS.queueOf(m, c)?.name || h('span.muted', 'nothing')), h('td', num(c, 'prefetch', { min: 0, max: 1000 })),
        h('td', check(c, 'autoAck', '')), h('td', select(c, 'onError', RS.ON_ERROR)), h('td', num(c, 'workMs', { min: 1, max: 10000 }))))),
    h('div.eyebrow', 'Add a wire'),
    h('div.nb-cable-add',
      h('select', { onchange: e => { a = e.target.value; } }, h('option', { value: '' }, 'from…'), sources.map(b => h('option', { value: b.id }, `${R_KINDS[b.kind].label}: ${b.name}`))),
      h('span', '→'),
      h('select', { onchange: e => { z = e.target.value; } }, h('option', { value: '' }, 'to…'), m.blocks.filter(b => b.kind !== 'producer').map(b => h('option', { value: b.id }, `${R_KINDS[b.kind].label}: ${b.name}`))),
      h('button.btn.primary.small', { type: 'button', onclick: () => { if (!RS.connect(m, a, z)) api.say('Producer → exchange, exchange → queue or exchange, queue → consumer.'); else changed(); } }, 'Wire')),
    h('p.muted.small', 'Click a row to see every setting in the inspector.'));
}

function rabbitRun(m, id, ch) {
  const first = RS.ofKind(m, 'consumer').find(c => RS.queueOf(m, c));
  const sc = id === 'challenge' ? ch.scenario || {} : id === 'restart' ? { restartAt: 1.05 } : id === 'kill' ? { kill: { consumer: first?.name, at: 1 } } : {};
  const R = RS.simulate(m, sc);
  if (R.error) return { ok: false, verdict: R.error, steps: [], R: null };
  const steps = R.steps.map(s => ({ at: sec(s.at), who: s.who, tone: s.tone, text: s.text }));
  const c = R.counts;
  const held = [...R.queues.values()].reduce((s, q) => s + q.ready, 0);
  const done = [...R.consumers.values()].reduce((s, x) => s + x.processed, 0);
  const marks = {}, wires = {};
  for (const [bid, x] of R.consumers) marks[bid] = x.lost || (x.failed && !x.processed) ? 'bad' : x.processed ? 'ok' : 'skip';
  for (const [bid, q] of R.queues) if (q.heldMsgs.some(x => x.state === 'looping')) marks[bid] = 'bad';
  for (const w of m.wires) {
    const f = RS.byId(m, w.from), t = RS.byId(m, w.to);
    if (f?.kind === 'exchange' && t?.kind === 'queue') wires[w.id] = R.queues.get(t.id)?.in ? 'ok' : '';
    if (f?.kind === 'producer') wires[w.id] = c.unroutable || c.returnedLost ? 'bad' : 'ok';
    if (f?.kind === 'queue') { const x = R.consumers.get(t.id); wires[w.id] = x?.lost ? 'bad' : x?.processed ? 'ok' : ''; }
  }
  const ok = !c.lost && !c.looping;
  const bits = [`${c.published} published`, `${done} processed`, held && `${held} waiting in queues`, c.lost && `${c.lost} lost`, c.looping && `${c.looping} looping`, c.parked && `${c.parked} parked`].filter(Boolean);
  return { ok, verdict: `${bits.join(', ')}. ${ok ? 'No message was lost.' : 'Read the red lines for why.'}`, steps, tokens: R.tokens, marks, wires, panel: rabbitPanel(m, R), R };
}

function rabbitPanel(m, R) {
  const c = R.counts;
  const lostRows = [['dropped as unroutable', c.unroutable], ['returned, nobody listening', c.returnedLost], ['returned and handled', c.returnedHandled], ['failed under autoAck', c.lostAutoAck],
    ['lost in a crash (autoAck)', c.lostCrash], ['lost in the restart', c.lostRestart], ['lost in flight (no confirms)', c.lostInFlight], ['dead-lettered to nowhere', c.deadDropped],
    ['acked after failing', c.ackedFailures], ['still looping', c.looping], ['handled by more than one consumer', c.duplicates]].filter(x => x[1]);
  const el = h('div.yb-card');
  fill(el,
    h('div.eyebrow', 'Queues'),
    h('table.nb-rt', h('tr', h('th', 'Queue'), h('th', 'Ready'), h('th', 'Unacked'), h('th', 'Peak'), h('th', 'Delivered'), h('th', 'Redelivered'), h('th', 'Dead-lettered'), h('th', 'In/s vs can do/s')),
      [...R.queues.values()].map(q => h('tr', h('td', h('b', q.name)), h('td', q.ready), h('td', q.unacked), h('td', q.peak), h('td', q.delivered), h('td', q.redelivered), h('td', q.dead),
        h(`td.${q.inRate && q.subs && q.inRate > q.capacity ? 'yb-no' : 'muted'}`, q.inRate ? `${q.inRate} / ${q.subs ? q.capacity : 0}` : '-')))),
    h('div.eyebrow', 'Consumers'),
    h('table.nb-rt', h('tr', h('th', 'Consumer'), h('th', 'Queue'), h('th', 'Processed'), h('th', 'Failed'), h('th', 'Crashes'), h('th', 'Lost')),
      [...R.consumers.values()].map(x => h('tr', h('td', h('b', x.name)), h('td.muted', x.queue || '-'), h('td', x.processed), h('td', x.failed), h('td', x.crashes), h(`td${x.lost ? '.yb-no' : ''}`, x.lost)))),
    lostRows.length > 0 && h('div.eyebrow', 'Where messages went wrong'),
    lostRows.length > 0 && h('ul.yb-plain', lostRows.map(([l, n]) => h('li', h('b', String(n)), ' ', l))),
    h('p.muted.small', `Simulated until ${sec(R.end)}.`));
  return el;
}

// ================================================================ Kafka

const K_COLORS = { producer: '#5b8def', broker: '#8f84c9', topic: '#c9a24a', consumer: '#3fb68b' };
const K_ART = { producer: 'producerapp', broker: 'broker', topic: 'log', consumer: 'consumerapp' };
const K_KINDS = Object.fromEntries(Object.entries(KS.KINDS).map(([k, v]) => [k, { ...v, color: K_COLORS[k], art: K_ART[k], width: k === 'topic' ? 280 : k === 'broker' ? 150 : 190 }]));
const COMMIT_HELP = {
  after: 'Process the record, then commit (EnableAutoOffsetStore=false and StoreOffset after the work, or Commit). At-least-once: a crash can replay a few records.',
  before: 'Commit as soon as the record is received, then process it. At-most-once: a crash loses what was in progress.',
  autostore: 'Confluent.Kafka\'s default: Consume() stores the offset immediately and a background thread commits every 5 s, whether or not the work is done.',
};

function kafkaLab(container, onXp) {
  let lastRun = null;
  return builderLab(container, onXp, {
    lab: 'msgbuild-kafka',
    sim: KS,
    costLabel: 'blocks + wires',
    board: api => kafkaBoard(api, () => (lastRun?.model === api.model ? lastRun.R : null), () => { lastRun = null; }),
    form: api => kafkaForm(api, () => { lastRun = null; }),
    actions: ch => (ch.xp
      ? [{ id: 'challenge', label: ch.action?.label || '▶ Produce and consume', title: ch.action?.title || 'Run producers and consumers for a minute' },
        ...(ch.scenario?.kill || ch.scenario?.outages || ch.scenario?.lostAcks ? [{ id: 'plain', label: '▶ Without the incident', title: 'The same minute with nothing going wrong' }] : [])]
      : [{ id: 'plain', label: '▶ Produce and consume', title: 'Run producers and consumers for a minute' },
        { id: 'kill-broker', label: '💥 Kill broker 2', title: 'Broker 2 dies 30 s in, right after a burst of writes' },
        { id: 'kill-consumer', label: '💀 Kill a consumer', title: 'The first consumer dies 10 s in and stays down' },
        { id: 'restart-consumer', label: '↻ Restart the consumer', title: 'The first consumer crashes mid-batch at 20 s and is restarted at 25 s' }]),
    run: (m, id, ch) => { const out = kafkaRun(m, id, ch); lastRun = { model: m, R: out.R }; return out; },
    yaml: { title: 'kafka-topics + Confluent.Kafka', text: KS.toText, note: 'The CLI that creates these topics and the client configs for each app, as Confluent.Kafka property names. It follows the board.' },
  });
}

/** Where each partition's replicas live before anything runs (the same layout the simulator uses). */
function layout(m, t) {
  const br = KS.brokerList(m);
  if (!br.length) return [];
  return Array.from({ length: Math.max(1, Number(t.partitions) || 1) }, (_, p) => {
    const replicas = Array.from({ length: Math.min(br.length, Math.max(1, Number(t.rf) || 1)) }, (_, i) => br[(p + i) % br.length].id);
    const isr = replicas.filter(id => br.find(x => x.id === id).b.up !== false);
    return { p, replicas, isr, leader: isr[0] ?? null, offline: !isr.length, tail: [], end: 0, start: 0 };
  });
}

function kafkaBoard(api, run, forget) {
  const m = () => api.model;
  const blk = id => KS.byId(m(), id);
  const changed = () => { forget(); api.changed(); };
  const { field, text, num, check, select, lines } = controls(changed, api.say);

  function add(kind, at) {
    const base = { producer: 'shop', broker: 'broker', topic: 'orders', consumer: 'worker' }[kind];
    let name = uniqueName(m(), kind, base);
    if (kind === 'broker') { let i = KS.ofKind(m(), 'broker').length + 1; while (m().blocks.some(b => b.kind === 'broker' && b.name === `broker-${i}`)) i++; name = `broker-${i}`; }
    const settings = kind === 'topic' ? { rf: Math.min(3, Math.max(1, KS.ofKind(m(), 'broker').length)), minIsr: Math.min(2, Math.max(1, KS.ofKind(m(), 'broker').length - 1)) } : {};
    const b = KS.block(kind, uniqueId(m(), `${kind[0]}-${name}`), name, at.x, at.y, settings);
    m().blocks.push(b);
    changed();
    return b;
  }

  function strips(b) {
    const R = run();
    const parts = R?.topics.get(b.id)?.parts || layout(m(), b);
    return h('div.mb-strips', parts.slice(0, 8).map(P => h(`div.mb-strip${P.offline ? '.off' : ''}`,
      h('span.mb-pn', `P${P.p}`),
      h('span.mb-cells', P.tail.length ? P.tail.slice(-8).map(r => h(`span.mb-cell${r.gone ? '.gone' : ''}${r.dup ? '.dup' : ''}${r.tomb ? '.tomb' : ''}`, { title: `offset ${r.off}: ${r.key ?? 'no key'} → ${r.value ?? 'tombstone (null)'}${r.dup ? ' (duplicate)' : ''}${r.gone ? ' (deleted)' : ''}` }, String(r.off)))
        : h('span.mb-cell.empty', '0')),
      h('span.mb-lead', { title: `replicas on brokers ${P.replicas.join(', ')}; in-sync: ${P.isr.join(', ') || 'none'}` }, P.offline ? 'offline' : `L${P.leader} · ISR ${P.isr.join(',')}`),
      R && h('span.mb-end', { title: 'log start offset … log-end offset' }, `${P.start}…${P.end}`))),
    parts.length > 8 && h('div.nb-sub', `+ ${parts.length - 8} more partitions`));
  }

  function body(b) {
    const R = run();
    const line = t => h('div.ab-line', t);
    const tags = list => { const t = list.filter(Boolean); return t.length ? h('div.bk-tags', t.map(x => (Array.isArray(x) ? h(`span.bk-tag.${x[1]}`, x[0]) : h('span.bk-tag', x)))) : null; };
    if (b.kind === 'producer') {
      return [h('div.bk-name', b.name), line(`${KS.rateText(Number(b.rate) || 0)}${Number(b.backlog) ? ` + ${b.backlog} old` : ''}`),
        line(`key: ${b.keyMode === 'entity' ? `${b.entity || 'order'} id` : b.keyMode === 'random' ? 'random' : 'none'}`),
        tags([`acks=${b.acks}`, b.idempotence ? 'idempotent' : ['not idempotent', b.acks === 'all' ? '' : 'warn'], (b.deletes || []).length > 0 && `${b.deletes.length} tombstone${b.deletes.length > 1 ? 's' : ''}`])];
    }
    if (b.kind === 'broker') {
      const id = KS.brokerList(m()).find(x => x.b === b)?.id;
      const lead = R ? [...R.topics.values()].flatMap(t => t.parts.filter(P => P.leader === id).map(P => `${t.name}-${P.p}`)) : [];
      return [h('div.bk-name', b.name), line(`id ${id}`), b.up === false ? tags([['down', 'bad']]) : R && line(lead.length ? `leads ${lead.slice(0, 3).join(', ')}${lead.length > 3 ? '…' : ''}` : 'leads nothing')];
    }
    if (b.kind === 'topic') {
      return [h('div.bk-name', b.name), strips(b), tags([`RF ${b.rf}`, `min ISR ${b.minIsr}`, b.cleanup === 'compact' ? 'compact' : `retention ${retText(b.retentionMs)}`, Number(b.minIsr) >= Number(b.rf) && Number(b.rf) > 1 && ['min ISR = RF', 'warn'], Number(b.rf) === 1 && ['RF 1', 'warn']])];
    }
    const c = R?.consumers.get(b.id);
    return [h('div.bk-name', b.name), line(`group ${b.groupId}`), line(`${b.rate}/s · ${b.commit === 'after' ? 'commit after' : b.commit === 'before' ? 'commit before' : 'auto store+commit'}`),
      c && line(c.assigned.length ? `owns ${c.assigned.join(', ')}` : c.alive ? 'idle: no partition' : 'down'),
      c && line(`processed ${c.processed}`),
      tags([`reset ${b.reset}`, b.idempotent && 'idempotent', b.alive === false && ['off', 'bad'], Number(b.joinAt) > 0 && `starts at ${retText(Number(b.joinAt) * 1000)}`])];
  }

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click a block or a wire to configure it.');
    if (sel.type === 'wire') {
      const w = m().wires.find(x => x.id === sel.id);
      if (!w) return null;
      const f = blk(w.from), t = blk(w.to);
      const rm = removeBtn(() => { m().wires = m().wires.filter(x => x !== w); changed(); });
      if (f.kind === 'producer') return h('div.pk-inspect', inspectHead(`${f.name} produces to ${t.name}`, rm), h('p.muted.small', `ProduceAsync("${t.name}", message). The key picks the partition: the same key always goes to the same partition (as long as the partition count stays the same).`));
      return h('div.pk-inspect', inspectHead(`${t.name} subscribes to ${f.name}`, rm), h('p.muted.small', `consumer.Subscribe("${f.name}") with group.id ${t.groupId}. Members of one group split the partitions; every other group gets its own copy of everything.`));
    }
    const b = blk(sel.id);
    if (!b) return null;
    const k = K_KINDS[b.kind];
    const head = inspectHead(`${k.icon} ${k.label}`, removeBtn(() => { KS.removeBlock(m(), b.id); changed(); }, 'Delete'));
    const parts = [head, field('Name', text(b, 'name', '', nameRule(m(), KS, b.kind, b)))];
    if (b.kind === 'producer') {
      parts.push(
        field('Key', select(b, 'keyMode', KS.KEY_MODES), b.keyMode === 'entity' ? 'Same key, same partition: every event of one order stays in order.' : b.keyMode === 'none' ? 'No key: the sticky partitioner fills one partition per batch, then switches. No ordering per entity.' : 'A random key per record: events of one entity scatter over partitions.'),
        h('div.pk-two', field('Entity name', text(b, 'entity', 'order')), field('How many entities', num(b, 'entities', { min: 1, max: 1000 }))),
        h('div.pk-two', field('Rate (records/s)', num(b, 'rate', { min: 0, max: 1000, step: 0.1 })), field('Max records (0 = no limit)', num(b, 'count', { min: 0, max: 100000 }))),
        field('acks', select(b, 'acks', KS.ACKS), 'When the broker says "saved". all waits for every in-sync replica.'),
        check(b, 'idempotence', 'enable.idempotence (needs acks=all; retries cannot create duplicates)'),
        h('div.pk-two', field('Retries', num(b, 'retries', { min: 0, max: 100 })), field('Already in the topic', num(b, 'backlog', { min: 0, max: 10000 }))),
        field('Tombstones at the end (keys to delete, one per line)', lines(b, 'deletes', 'customer-3', 2)),
        h('p.muted.small', 'Drag ▶ onto a topic.'));
    }
    if (b.kind === 'broker') {
      parts.push(check(b, 'up', 'Running'), h('p.muted.small', 'A broker stores partition replicas. Each partition has one leader (all reads and writes go there) and followers that copy it; the in-sync ones form the ISR.'));
    }
    if (b.kind === 'topic') {
      parts.push(
        h('div.pk-two', field('Partitions', num(b, 'partitions', { min: 1, max: 24 })), field('Replication factor', num(b, 'rf', { min: 1, max: 5 }))),
        field('min.insync.replicas', num(b, 'minIsr', { min: 1, max: 5 }), 'With acks=all, a write needs at least this many in-sync replicas. RF 3 + min ISR 2 survives one broker loss.'),
        field('cleanup.policy', select(b, 'cleanup', [['delete', 'delete: drop records older than retention.ms'], ['compact', 'compact: keep the latest record per key']])),
        b.cleanup === 'delete' && field('retention.ms', num(b, 'retentionMs', { min: 60000, max: 31536000000, step: 60000 }), `${retText(b.retentionMs)}. The broker default is 7 days (604800000).`),
        h('p.muted.small', 'Drag ▶ onto a consumer app to subscribe it.'));
    }
    if (b.kind === 'consumer') {
      parts.push(
        field('group.id', text(b, 'groupId', 'billing', v => (v ? true : 'A consumer group needs an id.')), 'Same group: share the partitions. Different group: each gets every record.'),
        h('div.pk-two', field('Rate (records/s)', num(b, 'rate', { min: 0, max: 10000 })), field('Batch size', num(b, 'batch', { min: 1, max: 500 }))),
        field('Offsets', select(b, 'commit', KS.COMMITS), COMMIT_HELP[b.commit]),
        field('auto.offset.reset', select(b, 'reset', KS.RESETS), 'Where a group starts when it has no committed offset (or its offset was deleted).'),
        field('Assignment', select(b, 'assignor', KS.ASSIGNORS)),
        check(b, 'idempotent', 'Idempotent (remembers handled ids and skips repeats)'),
        check(b, 'alive', 'Running'),
        field('Starts at (s)', num(b, 'joinAt', { min: 0, max: 1e7 })));
    }
    return h('div.pk-inspect', parts);
  }

  return {
    kinds: K_KINDS,
    wireKinds: { prod: { label: '', color: '#5b8def' }, sub: { label: '', color: '#3fb68b' } },
    wires: () => m().wires.map(w => ({ id: w.id, kind: blk(w.from)?.kind === 'producer' ? 'prod' : 'sub', from: { block: w.from, port: 'out' }, to: { block: w.to }, w })),
    ports: b => (KS.TARGETS[b.kind].length ? [{ id: 'out', label: '', on: m().wires.some(w => w.from === b.id), title: b.kind === 'producer' ? 'Drag onto a topic: produce to it' : 'Drag onto a consumer app: subscribe it' }] : []),
    body,
    canConnect: (from, port, to) => KS.canWire(m(), from, to),
    connect: (from, port, to) => { if (!KS.connect(m(), from.id, to.id)) return `A ${K_KINDS[from.kind].label.toLowerCase()} cannot be wired to a ${K_KINDS[to.kind].label.toLowerCase()}.`; changed(); return false; },
    onDropEmpty: () => { api.say('To remove a wire, click it and press Delete.'); return false; },
    palette: [
      { kind: 'producer', title: 'A producer app: writes keyed records to a topic', add: at => add('producer', at) },
      { kind: 'broker', title: 'A broker: one Kafka server in the cluster', add: at => add('broker', at) },
      { kind: 'topic', title: 'A topic: partitions spread over the brokers', add: at => add('topic', at) },
      { kind: 'consumer', title: 'A consumer app in a consumer group', add: at => add('consumer', at) },
    ],
    howto: 'Drag ▶ from a producer to a topic and from a topic to consumers. Brokers need no wires: partitions are placed on them. Consumers with the same group.id share the partitions.',
    inspector,
    onDelete: sel => { if (sel.type === 'wire') m().wires = m().wires.filter(w => w.id !== sel.id); else KS.removeBlock(m(), sel.id); changed(); },
    wireLabel: w => {
      if (w.kind === 'prod') { const p = blk(w.w.from); return p ? `key: ${p.keyMode === 'entity' ? 'id' : p.keyMode} · acks=${p.acks}` : ''; }
      const c = blk(w.w.to), R = run();
      const own = R?.consumers.get(c?.id)?.assigned.filter(n => n.startsWith(blk(w.w.from)?.name + '-')).map(n => 'P' + n.split('-').pop());
      return own ? (own.length ? own.join(',') : 'idle') : c?.groupId || '';
    },
    blockClass: b => (b.kind === 'broker' && b.up === false ? 'mb-down' : ''),
    zones: () => [
      { id: 'cluster', label: 'Kafka cluster', tone: 3, members: m().blocks.filter(b => b.kind === 'broker' || b.kind === 'topic').map(b => b.id) },
      ...[...new Set(KS.ofKind(m(), 'consumer').map(c => c.groupId))].map((g, i) => ({ id: 'g-' + g, label: `group ${g}`, tone: [1, 0, 4, 2][i % 4], members: KS.ofKind(m(), 'consumer').filter(c => c.groupId === g).map(c => c.id) })),
    ],
  };
}
const retText = ms => { const s = Number(ms) / 1000; return s >= 86400 ? `${Math.round(s / 8640) / 10} d` : s >= 3600 ? `${Math.round(s / 360) / 10} h` : s >= 60 ? `${Math.round(s / 6) / 10} min` : `${s} s`; };

function kafkaForm(api, forget) {
  const m = api.model;
  const changed = () => { forget(); api.changed(); };
  const { select, num, check, text } = controls(changed, api.say);
  const row = b => ({ onclick: e => { if (!e.target.closest('input,button,select,textarea')) api.select({ type: 'block', id: b.id }); } });
  let a = '', z = '';
  return h('div.nb-form',
    h('div.eyebrow', 'Producers'),
    h('table.nb-ftable', h('tr', h('th', 'Name'), h('th', 'Key'), h('th', 'acks'), h('th', 'Idempotent'), h('th', 'Rate'), h('th', 'Topic')),
      KS.ofKind(m, 'producer').map(p => h('tr', row(p), h('td', h('b', p.name)), h('td', select(p, 'keyMode', KS.KEY_MODES)), h('td', select(p, 'acks', KS.ACKS)), h('td', check(p, 'idempotence', '')),
        h('td', num(p, 'rate', { min: 0, max: 1000, step: 0.1 })), h('td', KS.topicOf(m, p)?.name || h('span.muted', 'nothing'))))),
    h('div.eyebrow', 'Topics'),
    h('table.nb-ftable', h('tr', h('th', 'Name'), h('th', 'Partitions'), h('th', 'RF'), h('th', 'min ISR'), h('th', 'cleanup.policy'), h('th', 'retention.ms')),
      KS.ofKind(m, 'topic').map(t => h('tr', row(t), h('td', h('b', t.name)), h('td', num(t, 'partitions', { min: 1, max: 24 })), h('td', num(t, 'rf', { min: 1, max: 5 })), h('td', num(t, 'minIsr', { min: 1, max: 5 })),
        h('td', select(t, 'cleanup', [['delete', 'delete'], ['compact', 'compact']])), h('td', num(t, 'retentionMs', { min: 60000, max: 31536000000, step: 60000 }))))),
    h('div.eyebrow', 'Consumers'),
    h('table.nb-ftable', h('tr', h('th', 'Name'), h('th', 'group.id'), h('th', 'Rate'), h('th', 'Offsets'), h('th', 'auto.offset.reset'), h('th', 'Reads')),
      KS.ofKind(m, 'consumer').map(c => h('tr', row(c), h('td', h('b', c.name)), h('td', text(c, 'groupId', 'billing')), h('td', num(c, 'rate', { min: 0, max: 10000 })), h('td', select(c, 'commit', KS.COMMITS)),
        h('td', select(c, 'reset', KS.RESETS)), h('td.small', KS.topicsOf(m, c).map(t => t.name).join(', ') || h('span.muted', 'nothing'))))),
    h('div.eyebrow', 'Brokers'),
    h('ul.nb-cables', KS.ofKind(m, 'broker').map(b => h('li', `${b.name} `, check(b, 'up', 'running')))),
    h('div.eyebrow', 'Add a wire'),
    h('div.nb-cable-add',
      h('select', { onchange: e => { a = e.target.value; } }, h('option', { value: '' }, 'from…'), m.blocks.filter(b => KS.TARGETS[b.kind].length).map(b => h('option', { value: b.id }, `${K_KINDS[b.kind].label}: ${b.name}`))),
      h('span', '→'),
      h('select', { onchange: e => { z = e.target.value; } }, h('option', { value: '' }, 'to…'), m.blocks.filter(b => b.kind === 'topic' || b.kind === 'consumer').map(b => h('option', { value: b.id }, `${K_KINDS[b.kind].label}: ${b.name}`))),
      h('button.btn.primary.small', { type: 'button', onclick: () => { if (!KS.connect(m, a, z)) api.say('Producer → topic, or topic → consumer.'); else changed(); } }, 'Wire')),
    h('p.muted.small', 'Click a row to see every setting in the inspector.'));
}

function kafkaRun(m, id, ch) {
  const first = KS.ofKind(m, 'consumer').find(c => KS.topicsOf(m, c).length && c.alive !== false);
  const sc = id === 'challenge' ? ch.scenario || {} : id === 'kill-broker' ? { kill: { broker: 2, at: 30 } }
    : id === 'kill-consumer' ? { outages: [{ consumer: first?.name, from: 10, to: null }] } : id === 'restart-consumer' ? { outages: [{ consumer: first?.name, from: 20.25, to: 25 }] }
      : ch.scenario?.duration ? { duration: ch.scenario.duration, dt: ch.scenario.dt } : {};
  const R = KS.simulate(m, sc);
  if (R.error) return { ok: false, verdict: R.error, steps: [], R: null };
  const t = s => (R.duration > 2 * 86400 ? `d${(s / 86400).toFixed(2)}` : R.duration > 7200 ? `${(s / 3600).toFixed(2)}h` : s < 0 ? '-1h' : sec(s));
  const steps = R.steps.map(s => ({ at: t(s.at), who: s.who, tone: s.tone, text: s.text }));
  const c = R.counts;
  const marks = {}, wires = {};
  for (const x of KS.brokerList(m)) if (x.b.up === false || sc.kill?.broker === x.id) marks[x.b.id] = 'bad';
  for (const [bid, x] of R.consumers) marks[bid] = !x.alive ? 'bad' : x.assigned.length ? 'ok' : 'skip';
  for (const [tid, tp] of R.topics) if (tp.parts.some(P => P.offline || P.lost)) marks[tid] = 'bad';
  for (const w of m.wires) {
    const f = KS.byId(m, w.from);
    if (f?.kind === 'producer') wires[w.id] = c.failed || c.lostAcked || c.lostUnacked || c.logDuplicates ? 'bad' : 'ok';
    else { const x = R.consumers.get(w.to); wires[w.id] = !x?.alive ? 'bad' : x.assigned.length ? 'ok' : ''; }
  }
  let lost = c.lostAcked + c.lostUnacked + c.failed, dup = c.logDuplicates, behind = 0, order = 0, growing = [];
  for (const g of R.groups.values()) { lost += g.lostCommit + g.deletedUnread + g.resetSkipped + g.missed; dup += g.dupEffects; behind = Math.max(behind, g.lag); order += g.violations; if (g.grows) growing.push(g.gid); }
  const ok = !lost && !dup && !order && !growing.length;
  const bits = [`${c.written} written`, lost && `${lost} lost or never read`, dup && `${dup} duplicated`, order && `${order} keys handled out of order`, growing.length ? `lag growing in ${growing.join(', ')}` : `worst lag ${behind}`].filter(Boolean);
  return { ok, verdict: `${bits.join(', ')}. ${ok ? 'Nothing was lost, duplicated or out of order.' : 'Read the red lines for why.'}`, steps, tokens: R.tokens, marks, wires, panel: kafkaPanel(m, R), R };
}

function kafkaPanel(m, R) {
  const c = R.counts;
  const issues = [['acknowledged, then lost with the leader (acks=1)', c.lostAcked], ['lost with the leader (acks=0)', c.lostUnacked], ['writes failed (NotEnoughReplicas)', c.notEnough], ['writes failed (partition offline)', c.offline],
    ['rejected: no key on a compacted topic', c.rejectedNoKey], ['duplicates written by retries', c.logDuplicates], ['retries deduplicated by the idempotent producer', c.dedupedByBroker]].filter(x => x[1]);
  const el = h('div.yb-card');
  fill(el,
    h('div.eyebrow', 'Partitions'),
    h('table.nb-rt', h('tr', h('th', 'Partition'), h('th', 'Leader'), h('th', 'Replicas'), h('th', 'ISR'), h('th', 'Log start'), h('th', 'Log end')),
      [...R.topics.values()].flatMap(t => t.parts.map(P => h('tr', h('td', h('b', `${t.name}-${P.p}`)), h(`td${P.offline ? '.yb-no' : ''}`, P.offline ? 'offline' : P.leader), h('td.muted', P.replicas.join(',')),
        h(`td${P.isr.length < P.replicas.length ? '.yb-no' : ''}`, P.isr.join(',') || '-'), h('td', P.start), h('td', P.end))))),
    h('div.eyebrow', 'Consumer groups'),
    h('table.nb-rt', h('tr', h('th', 'Group'), h('th', 'Partition'), h('th', 'Owner'), h('th', 'Committed'), h('th', 'Log end'), h('th', 'LAG')),
      [...R.groups.values()].flatMap(g => g.parts.map((p, i) => h('tr', h('td', i ? '' : h('b', g.gid)), h('td', p.name), h(`td${p.owner === '-' ? '.muted' : ''}`, p.owner), h('td', p.committed ?? '-'), h('td', p.end), h(`td${p.lag > 50 ? '.yb-no' : ''}`, p.lag))))),
    h('div.eyebrow', 'Per group'),
    h('table.nb-rt', h('tr', h('th', 'Group'), h('th', 'Read'), h('th', 'Lag over time'), h('th', 'Lost or skipped'), h('th', 'Twice'), h('th', 'Out of order')),
      [...R.groups.values()].map(g => h('tr', h('td', h('b', g.gid)), h('td', g.unique), h('td.muted', g.lagAt.map(x => x.lag).join(' → ')),
        h(`td${g.lostCommit + g.deletedUnread + g.resetSkipped + g.missed ? '.yb-no' : ''}`, { title: `committed but never processed ${g.lostCommit}; deleted by retention before reading ${g.deletedUnread}; skipped by auto.offset.reset ${g.resetSkipped + g.missed}` }, g.lostCommit + g.deletedUnread + g.resetSkipped + g.missed), h(`td${g.dupEffects ? '.yb-no' : ''}`, g.dupEffects), h(`td${g.violations ? '.yb-no' : ''}`, g.violations)))),
    issues.length > 0 && h('div.eyebrow', 'On the producer side'),
    issues.length > 0 && h('ul.yb-plain', issues.map(([l, n]) => h('li', h('b', String(n)), ' ', l))),
    h('p.muted.small', 'LAG = log-end offset minus the committed offset, per partition: what kafka-consumer-groups --describe shows.'));
  return el;
}
