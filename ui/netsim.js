// The network builder's simulator: pure JavaScript, no DOM, so it runs in the browser and in Node tests.
// A model is { devices, links }. Devices are PCs, switches, routers and one "Internet" cloud; links are
// cables between two device ports. ping() walks a real echo request and echo reply through the model:
// a host decides "same subnet or gateway?", ARP finds the next hop inside one broadcast domain (switches
// just carry frames), routers pick the longest matching prefix, decrement TTL, and can NAT on the way out.
// Every decision becomes an event, so the UI can animate the packet hop by hop and explain each step.

// ---------------------------------------------------------------- addresses

export const ip2n = s => s.split('.').reduce((n, o) => n * 256 + Number(o), 0);
export const n2ip = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
export const validIp = s => typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(o => Number(o) <= 255);
const maskN = p => (p <= 0 ? 0 : 2 ** 32 - 2 ** (32 - p));
const andN = (a, b) => [24, 16, 8, 0].reduce((n, s) => n + ((Math.floor(a / 2 ** s) % 256) & (Math.floor(b / 2 ** s) % 256)) * 2 ** s, 0);
export const netOf = (ip, p) => n2ip(andN(ip2n(ip), maskN(p)));
export const inSubnet = (ip, net, p) => validIp(ip) && validIp(net) && andN(ip2n(ip), maskN(p)) === andN(ip2n(net), maskN(p));
export const cidr = (ip, p) => `${netOf(ip, p)}/${p}`;
export const isPrivate = ip => validIp(ip) && (inSubnet(ip, '10.0.0.0', 8) || inSubnet(ip, '172.16.0.0', 12) || inSubnet(ip, '192.168.0.0', 16));

/** Accepts "192.168.1.10/24" in an IP field: returns { ip, prefix } (prefix may be undefined). */
export function parseIp(text) {
  const [ip, p] = String(text || '').trim().split('/');
  return { ip: ip || '', prefix: p !== undefined && p !== '' ? Math.max(0, Math.min(32, Number(p) || 0)) : undefined };
}

// ---------------------------------------------------------------- devices

export const KINDS = {
  pc: { label: 'PC', icon: '🖥' },
  switch: { label: 'Switch', icon: '⇄' },
  router: { label: 'Router', icon: '✣' },
  cloud: { label: 'Internet', icon: '☁' },
};

export const CLOUD_IP = '203.0.113.1';
export const CLOUD_PREFIX = 24;
export const PUBLIC_HOSTS = ['8.8.8.8', '1.1.1.1'];
const SWITCH_PORTS = 8;
export const MAX_ROUTER_IFACES = 6;

export const pc = (id, name, ip = '', prefix = 24, gateway = '', x = 0, y = 0, extra = {}) =>
  ({ id, kind: 'pc', name, x, y, ifaces: [{ id: 'eth0', ip, prefix }], gateway, ...extra });
export const sw = (id, name, x = 0, y = 0, extra = {}) =>
  ({ id, kind: 'switch', name, x, y, ifaces: Array.from({ length: SWITCH_PORTS }, (_, i) => ({ id: 'p' + (i + 1) })), ...extra });
export const router = (id, name, ifaces = [], x = 0, y = 0, extra = {}) => ({
  id, kind: 'router', name, x, y,
  ifaces: (ifaces.length ? ifaces : [['', 24], ['', 24]]).map(([ip, prefix], i) => ({ id: 'eth' + i, ip, prefix })),
  routes: [], nat: { on: false, outside: '' }, ...extra,
});
export const cloud = (x = 0, y = 0, extra = {}) =>
  ({ id: 'net', kind: 'cloud', name: 'Internet', x, y, ifaces: [{ id: 'isp', ip: CLOUD_IP, prefix: CLOUD_PREFIX }], fixed: true, ...extra });
export const link = (a, ap, b, bp) => ({ id: `L-${a}.${ap}-${b}.${bp}`, a: { dev: a, port: ap }, b: { dev: b, port: bp } });

export const portsOf = d => d.ifaces.map(i => i.id);
export const byId = (m, id) => m.devices.find(d => d.id === id);
export const linkAt = (m, dev, port) => m.links.find(l => (l.a.dev === dev && l.a.port === port) || (l.b.dev === dev && l.b.port === port));
export const otherEnd = (l, dev, port) => (l.a.dev === dev && l.a.port === port ? l.b : l.a);
const iface = (d, id) => d.ifaces.find(i => i.id === id);
const addressed = i => i && validIp(i.ip) && Number.isFinite(i.prefix);
const owns = (d, ip) => d.ifaces.some(i => i.ip === ip) || (d.kind === 'cloud' && PUBLIC_HOSTS.includes(ip));
export const freePort = (m, d) => portsOf(d).find(p => !linkAt(m, d.id, p));

/** The address someone would "ping" for a device: a PC's IP, a router's first address, the cloud's 8.8.8.8. */
export function addressOf(d) {
  if (!d) return '';
  if (d.kind === 'cloud') return PUBLIC_HOSTS[0];
  return d.ifaces.find(i => validIp(i.ip))?.ip || '';
}

/** A router's routing table as a learner would see it: connected networks first, then static routes. */
export function routingTable(d) {
  const rows = [];
  for (const i of d.ifaces) if (addressed(i)) rows.push({ dest: netOf(i.ip, i.prefix), prefix: i.prefix, via: null, iface: i.id, type: 'connected' });
  for (const r of d.routes || []) rows.push({ dest: r.dest, prefix: Number(r.prefix), via: r.via, iface: null, type: 'static' });
  return rows;
}

// ---------------------------------------------------------------- layer 2: who can I reach on this cable?

/** Everything reachable from one port without crossing a router: the broadcast domain. */
function segment(m, devId, port) {
  const first = linkAt(m, devId, port);
  if (!first) return { cabled: false, ends: [] };
  const ends = [];
  const seenSwitch = new Set();
  // BFS; each item carries the hop path taken so far (for animation).
  const queue = [{ at: otherEnd(first, devId, port), path: [{ from: devId, to: otherEnd(first, devId, port).dev, link: first.id }] }];
  while (queue.length) {
    const { at, path } = queue.shift();
    const d = byId(m, at.dev);
    if (!d) continue;
    if (d.kind !== 'switch') { ends.push({ dev: d, port: at.port, path }); continue; }
    if (seenSwitch.has(d.id)) continue;
    seenSwitch.add(d.id);
    for (const p of portsOf(d)) {
      if (p === at.port) continue;
      const l = linkAt(m, d.id, p);
      if (!l) continue;
      const nxt = otherEnd(l, d.id, p);
      queue.push({ at: nxt, path: [...path, { from: d.id, to: nxt.dev, link: l.id, outPort: p }] });
    }
  }
  return { cabled: true, ends };
}

// ---------------------------------------------------------------- layer 3: where does this packet go next?

/** { outIf, nextHop, text } or { fail } */
function decide(m, d, dst) {
  if (d.kind === 'pc') {
    const i = d.ifaces[0];
    if (!addressed(i)) return { fail: `${d.name} has no IP address, so it cannot send anything.` };
    if (inSubnet(dst, i.ip, i.prefix)) return { outIf: i.id, nextHop: dst, text: `${dst} is inside ${d.name}'s own network ${cidr(i.ip, i.prefix)}, so it delivers directly (no router needed).` };
    if (!d.gateway) return { fail: `${dst} is outside ${d.name}'s network ${cidr(i.ip, i.prefix)}, and ${d.name} has no default gateway. It has nowhere to send it.` };
    if (!inSubnet(d.gateway, i.ip, i.prefix)) return { fail: `${d.name}'s default gateway ${d.gateway} is not inside its own network ${cidr(i.ip, i.prefix)}. A gateway must be reachable directly, on the same subnet.` };
    return { outIf: i.id, nextHop: d.gateway, text: `${dst} is outside ${cidr(i.ip, i.prefix)}, so ${d.name} hands it to its default gateway ${d.gateway}.` };
  }
  if (d.kind === 'cloud') {
    if (inSubnet(dst, CLOUD_IP, CLOUD_PREFIX)) return { outIf: 'isp', nextHop: dst, text: `The ISP router delivers to ${dst} on its customer network ${cidr(CLOUD_IP, CLOUD_PREFIX)}.` };
    if (isPrivate(dst)) return { fail: `${dst} is a private address (10/8, 172.16/12, 192.168/16). Internet routers have no route to private networks: every home and office reuses them. Something has to translate it to a public address first (NAT).` };
    return { fail: `The lab internet has no host ${dst}. Try 8.8.8.8 or 1.1.1.1.` };
  }
  if (d.kind === 'router') {
    const table = routingTable(d);
    const matches = [];
    const notes = [];
    for (const r of table) {
      if (!validIp(r.dest) || !Number.isFinite(r.prefix) || !inSubnet(dst, r.dest, r.prefix)) continue;
      if (r.type === 'static') {
        const out = d.ifaces.find(i => addressed(i) && inSubnet(r.via, i.ip, i.prefix));
        if (!out) { notes.push(`route ${r.dest}/${r.prefix} via ${r.via} is unusable: ${r.via} is not on any of ${d.name}'s connected networks`); continue; }
        matches.push({ ...r, iface: out.id });
      } else matches.push(r);
    }
    if (!matches.length) {
      return { fail: `${d.name} has no route to ${dst}: no connected network or static route contains it${notes.length ? ` (${notes.join('; ')})` : ''}. Routers drop what they cannot route (and answer "destination unreachable").` };
    }
    // Longest prefix wins; on a tie a connected network beats a static route.
    matches.sort((a, b) => b.prefix - a.prefix || (a.type === 'connected' ? -1 : 1));
    const best = matches[0];
    const others = matches.slice(1).map(r => `${r.dest}/${r.prefix}`);
    const why = others.length ? ` It also matches ${others.join(', ')}, but /${best.prefix} is the longest (most specific) prefix, so it wins.` : '';
    if (best.type === 'connected') return { outIf: best.iface, nextHop: dst, text: `${d.name} looks up ${dst}: it is on the connected network ${best.dest}/${best.prefix} (${best.iface}), so it delivers directly.${why}`, notes };
    return { outIf: best.iface, nextHop: best.via, text: `${d.name} looks up ${dst}: route ${best.dest}/${best.prefix} via ${best.via} (out ${best.iface}).${why}`, notes };
  }
  return { fail: `A ${d.kind} does not route.` };
}

// ---------------------------------------------------------------- one direction of travel

export const newNat = () => ({ seq: 0, tables: {} });

function travel(m, nat, startDev, pkt, dir, events) {
  const note = (dev, text, tone = 'info') => events.push({ type: 'note', dev: dev.id, text, tone, dir });
  let d = startDev, inIf = null, originated = true;
  for (let guard = 0; guard < 400; guard++) {
    if (!originated) {
      // A reply coming back in on the NAT outside interface: translate the destination back.
      if (d.kind === 'router' && d.nat?.on && inIf === d.nat.outside) {
        const entry = (nat.tables[d.id] || []).find(e => e.outside === pkt.dst && e.id === pkt.id);
        if (entry) {
          note(d, `NAT on ${d.name}: ${pkt.dst} (id ${pkt.id}) is in the translation table, so the destination becomes ${entry.inside} again.`, 'nat');
          pkt.dst = entry.inside;
        }
      }
      if (owns(d, pkt.dst)) { note(d, `${d.name} owns ${pkt.dst}: the ${dir === 'request' ? 'echo request' : 'echo reply'} has arrived.`, 'ok'); return { ok: true, dev: d, pkt }; }
      if (d.kind === 'pc') return fail(d, `${d.name} received a packet for ${pkt.dst}, but a PC is not a router: it drops traffic that is not addressed to it.`);
      if (d.kind === 'router') {
        pkt.ttl--;
        if (pkt.ttl <= 0) return fail(d, `TTL reached 0 at ${d.name}. The packet has been passed around in a loop until it expired: two routers are pointing at each other for ${pkt.dst}.`);
      }
    } else if (owns(d, pkt.dst)) { note(d, `${pkt.dst} is ${d.name}'s own address.`, 'ok'); return { ok: true, dev: d, pkt }; }

    const r = decide(m, d, pkt.dst);
    if (r.fail) return fail(d, r.fail);
    for (const n of r.notes || []) note(d, n, 'warn');
    if (d.kind === 'router' && pkt.ttl < 60 && guard > 3) note(d, `${r.text} (TTL now ${pkt.ttl})`, 'info');
    else note(d, d.kind === 'router' ? `${r.text} TTL ${pkt.ttl + 1} → ${pkt.ttl}.` : r.text);

    // NAT on the way out: inside → outside rewrites the source to the router's public address.
    if (d.kind === 'router' && d.nat?.on && r.outIf === d.nat.outside && inIf !== d.nat.outside && !originated) {
      const out = iface(d, d.nat.outside);
      if (addressed(out)) {
        const table = nat.tables[d.id] ||= [];
        if (!table.some(e => e.inside === pkt.src && e.id === pkt.id)) table.push({ inside: pkt.src, outside: out.ip, id: pkt.id, to: pkt.dst });
        note(d, `NAT on ${d.name}: source ${pkt.src} → ${out.ip} (the address of ${out.id}), and it remembers id ${pkt.id} so the reply can be translated back.`, 'nat');
        pkt.src = out.ip;
      }
    }

    // Layer 2: ARP for the next hop on the outgoing interface's segment.
    const seg = segment(m, d.id, r.outIf);
    if (!seg.cabled) return fail(d, `${d.name}'s ${r.outIf} has no cable plugged in, so ARP for ${r.nextHop} goes nowhere.`);
    const hits = seg.ends.filter(e => e.dev.ifaces.some(i => i.id === e.port && i.ip === r.nextHop) || (e.dev.kind === 'cloud' && r.nextHop === CLOUD_IP));
    if (!hits.length) {
      const seen = seg.ends.map(e => `${e.dev.name}${iface(e.dev, e.port)?.ip ? ' (' + iface(e.dev, e.port).ip + ')' : ''}`);
      return fail(d, `ARP "who has ${r.nextHop}?" got no answer on ${d.name}'s ${r.outIf}. ${seen.length ? `That segment reaches ${seen.join(', ')}, and none of them has that address.` : 'Nothing with an address is on that segment.'}`);
    }
    if (hits.length > 1) return fail(d, `Two devices answer ARP for ${r.nextHop} (${hits.map(h => h.dev.name).join(' and ')}): a duplicate IP address. Frames go to whichever answered last.`);
    const hit = hits[0];
    note(d, `ARP: ${hit.dev.name} answers "${r.nextHop} is at my MAC". ${d.name} sends the frame out ${r.outIf}.`, 'arp');
    for (const step of hit.path) {
      const from = byId(m, step.from);
      if (from.kind === 'switch') note(from, `${from.name} forwards the frame out ${step.outPort} (it learned which port leads to that MAC). Switches never look at IP addresses.`, 'info');
      events.push({ type: 'hop', from: step.from, to: step.to, link: step.link, dir, src: pkt.src, dst: pkt.dst, ttl: pkt.ttl });
    }
    d = hit.dev; inIf = hit.port; originated = false;
  }
  return fail(d, 'The packet went round too many times.');

  function fail(dev, text) { events.push({ type: 'note', dev: dev.id, text, tone: 'bad', dir }); return { ok: false, dev, reason: text }; }
}

/**
 * Ping from device `srcId` to address `dstIp`. Returns
 * { ok, phase: 'request'|'reply'|'done', reason, events, reached }.
 * `nat` (from newNat()) keeps translation tables between pings.
 */
export function ping(m, srcId, dstIp, nat = newNat()) {
  const events = [];
  const src = byId(m, srcId);
  if (!src) return { ok: false, phase: 'request', reason: 'No such source device.', events };
  if (!validIp(dstIp)) return { ok: false, phase: 'request', reason: `"${dstIp}" is not an IPv4 address.`, events };
  let srcIp = src.ifaces[0]?.ip;
  if (src.kind === 'router') {
    const r = decide(m, src, dstIp);
    srcIp = r.outIf ? iface(src, r.outIf).ip : src.ifaces.find(addressed)?.ip;
  }
  if (src.kind === 'cloud') srcIp = PUBLIC_HOSTS[0];
  if (src.kind === 'switch') return { ok: false, phase: 'request', reason: 'A switch has no IP address to ping from.', events };
  if (!validIp(srcIp)) return { ok: false, phase: 'request', reason: `${src.name} has no IP address.`, events: [{ type: 'note', dev: src.id, text: `${src.name} has no IP address, so it cannot send anything.`, tone: 'bad', dir: 'request' }] };
  const id = ++nat.seq;
  events.push({ type: 'note', dev: src.id, text: `${src.name} sends an ICMP echo request: ${srcIp} → ${dstIp}, TTL 64.`, tone: 'info', dir: 'request' });
  const req = travel(m, nat, src, { src: srcIp, dst: dstIp, ttl: 64, id }, 'request', events);
  if (!req.ok) return { ok: false, phase: 'request', reason: req.reason, at: req.dev?.id, events };
  const back = { src: req.pkt.dst, dst: req.pkt.src, ttl: 64, id };
  events.push({ type: 'note', dev: req.dev.id, text: `${req.dev.name} answers with an echo reply: ${back.src} → ${back.dst}. Now the return trip has to work too.`, tone: 'info', dir: 'reply' });
  const rep = travel(m, nat, req.dev, back, 'reply', events);
  if (!rep.ok) return { ok: false, phase: 'reply', reached: req.dev.id, at: rep.dev?.id, events,
    reason: `The request reached ${req.dev.name}, but the reply never came back: ${rep.reason}` };
  if (rep.dev.id !== src.id) return { ok: false, phase: 'reply', reached: req.dev.id, events, reason: `The reply was delivered to ${rep.dev.name}, not ${src.name}.` };
  events.push({ type: 'note', dev: src.id, text: `Reply received. ${src.name} → ${dstIp} works both ways.`, tone: 'ok', dir: 'reply' });
  return { ok: true, phase: 'done', events };
}

// ---------------------------------------------------------------- challenges

/** Parts used: devices plus static routes. Fewer is tidier (a default route beats ten specific ones). */
export const cost = m => m.devices.length + m.devices.reduce((n, d) => n + (d.routes?.length || 0), 0);
export const starsFor = (c, par) => (c <= par ? 3 : c <= par + 2 ? 2 : 1);
const target = (m, t) => (validIp(t) ? t : addressOf(byId(m, t)));

/** Runs every goal ping of a challenge: { ok, results: [{ from, to, label, ok, reason }], cost, stars }. */
export function check(m, ch) {
  const results = [];
  const nat = newNat();
  for (const [from, to] of goalPairs(m, ch)) {
    const dst = target(m, to);
    const r = dst ? ping(m, from, dst, nat) : { ok: false, reason: `${byId(m, to)?.name || to} has no address yet.` };
    results.push({ from, to, label: `${byId(m, from)?.name || from} → ${byId(m, to)?.name || to}${dst && byId(m, to) ? ` (${dst})` : ''}`, ok: r.ok, reason: r.reason, phase: r.phase });
  }
  const extra = ch.extra ? ch.extra(m) : true;
  const ok = results.length > 0 && results.every(r => r.ok) && extra === true;
  const c = cost(m);
  return { ok, results, extra: extra === true ? null : extra, cost: c, stars: ok ? starsFor(c, ch.par) : 0 };
}

function goalPairs(m, ch) {
  const g = ch.goal || [];
  if (ch.allPairs) {
    const ids = ch.allPairs;
    const pairs = [];
    for (const a of ids) for (const b of ids) if (a !== b) pairs.push([a, b]);
    return [...pairs, ...g];
  }
  return g;
}

const R = (dest, prefix, via) => ({ dest, prefix, via });
const routerOf = (m, id) => byId(m, id);

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free board. Drop in PCs, switches and routers, cable them up, give them addresses and ping around. Nothing is graded here.',
    setup: () => ({ devices: [pc('pc1', 'PC1', '192.168.1.10', 24, '', 80, 80), pc('pc2', 'PC2', '192.168.1.20', 24, '', 420, 80)], links: [] }),
    solve: m => m },

  { id: 'two-pcs', title: 'Two PCs talk', xp: 15, par: 2,
    brief: 'PC1 has an address; PC2 has none and no cable. **Cable them together** (drag a port onto the other PC) and give PC2 an address in the **same network** as PC1, so `PC1 → PC2` works.',
    goal: [['pc1', 'pc2']],
    setup: () => ({ devices: [pc('pc1', 'PC1', '192.168.1.10', 24, '', 80, 100, { fixed: true }), pc('pc2', 'PC2', '', 24, '', 460, 100, { fixed: true })], links: [] }),
    solve: m => { byId(m, 'pc2').ifaces[0].ip = '192.168.1.20'; m.links.push(link('pc1', 'eth0', 'pc2', 'eth0')); return m; } },

  { id: 'switch', title: 'Three on a switch', xp: 20, par: 4,
    brief: 'One cable joins two PCs. For three, add a **switch** from the palette and cable every PC to it. A switch joins cables into one network; it needs no address. Every PC must reach every other.',
    allPairs: ['pc1', 'pc2', 'pc3'],
    setup: () => ({ devices: [pc('pc1', 'PC1', '192.168.1.10', 24, '', 60, 60, { fixed: true }), pc('pc2', 'PC2', '192.168.1.20', 24, '', 340, 60, { fixed: true }), pc('pc3', 'PC3', '192.168.1.30', 24, '', 620, 60, { fixed: true })], links: [] }),
    solve: m => { m.devices.push(sw('sw1', 'SW1', 340, 300)); m.links.push(link('pc1', 'eth0', 'sw1', 'p1'), link('pc2', 'eth0', 'sw1', 'p2'), link('pc3', 'eth0', 'sw1', 'p3')); return m; } },

  { id: 'mask', title: 'The wrong mask', xp: 25, par: 3,
    brief: 'Both PCs are on the same switch and in "192.168.1.something", yet `PC1 → PC2` fails. Ping it and read **which direction** breaks. The [Subnetting trainer](#/labs/subnet) explains what /25 does to 192.168.1.200.',
    allPairs: ['pc1', 'pc2'],
    setup: () => ({ devices: [pc('pc1', 'PC1', '192.168.1.10', 24, '', 60, 60, { fixed: true }), pc('pc2', 'PC2', '192.168.1.200', 25, '', 560, 60, { fixed: true }), sw('sw1', 'SW1', 310, 300)],
      links: [link('pc1', 'eth0', 'sw1', 'p1'), link('pc2', 'eth0', 'sw1', 'p2')] }),
    solve: m => { byId(m, 'pc2').ifaces[0].prefix = 24; return m; } },

  { id: 'two-nets', title: 'Same switch, different networks', xp: 25, par: 3,
    brief: 'PC1 is `10.0.1.10/24` and PC2 is `10.0.2.20/24`. They share a switch, but each one thinks the other is in a foreign network and looks for a gateway that does not exist. Make them talk. (A router would work too, but the tidy fix uses fewer parts.)',
    allPairs: ['pc1', 'pc2'],
    setup: () => ({ devices: [pc('pc1', 'PC1', '10.0.1.10', 24, '', 60, 60, { fixed: true }), pc('pc2', 'PC2', '10.0.2.20', 24, '', 560, 60, { fixed: true }), sw('sw1', 'SW1', 310, 300)],
      links: [link('pc1', 'eth0', 'sw1', 'p1'), link('pc2', 'eth0', 'sw1', 'p2')] }),
    solve: m => { byId(m, 'pc2').ifaces[0].ip = '10.0.1.20'; return m; } },

  { id: 'first-router', title: 'Your first router', xp: 35, par: 3,
    brief: 'Two networks: `192.168.1.0/24` and `192.168.2.0/24`. Add a **router**, cable one interface into each network, give each interface an address in its network (by convention `.1`), and set each PC\'s **default gateway** to the router address on its side.',
    allPairs: ['pc1', 'pc2'],
    setup: () => ({ devices: [pc('pc1', 'PC1', '192.168.1.10', 24, '', 60, 80, { fixed: true }), pc('pc2', 'PC2', '192.168.2.10', 24, '', 620, 80, { fixed: true })], links: [] }),
    solve: m => {
      m.devices.push(router('r1', 'R1', [['192.168.1.1', 24], ['192.168.2.1', 24]], 330, 320));
      m.links.push(link('pc1', 'eth0', 'r1', 'eth0'), link('pc2', 'eth0', 'r1', 'eth1'));
      byId(m, 'pc1').gateway = '192.168.1.1'; byId(m, 'pc2').gateway = '192.168.2.1';
      return m;
    } },

  { id: 'no-gateway', title: 'Halfway there', xp: 30, par: 3,
    brief: 'Ping `PC1 → PC2`. The request **arrives**, PC2 even answers, and still the ping fails. Every conversation needs a way *back*. Find what PC2 is missing.',
    allPairs: ['pc1', 'pc2'],
    setup: () => ({ devices: [pc('pc1', 'PC1', '192.168.1.10', 24, '192.168.1.1', 60, 80, { fixed: true }), router('r1', 'R1', [['192.168.1.1', 24], ['192.168.2.1', 24]], 330, 320, { fixed: true }),
      pc('pc2', 'PC2', '192.168.2.10', 24, '', 620, 80, { fixed: true })],
    links: [link('pc1', 'eth0', 'r1', 'eth0'), link('pc2', 'eth0', 'r1', 'eth1')] }),
    solve: m => { byId(m, 'pc2').gateway = '192.168.2.1'; return m; } },

  { id: 'static', title: 'Two routers, static routes', xp: 40, par: 6,
    brief: 'R1 and R2 are joined by a small transit network `10.0.12.0/30`. Each router only knows the networks plugged into it. Add a **static route** on each router (inspector → Routes) so it knows where the far LAN is, and which neighbour to hand it to.',
    allPairs: ['pc1', 'pc2'],
    setup: () => ({ devices: [
      pc('pc1', 'PC1', '192.168.1.10', 24, '192.168.1.1', 40, 60, { fixed: true }),
      router('r1', 'R1', [['192.168.1.1', 24], ['10.0.12.1', 30]], 220, 320, { fixed: true }),
      router('r2', 'R2', [['10.0.12.2', 30], ['192.168.2.1', 24]], 520, 320, { fixed: true }),
      pc('pc2', 'PC2', '192.168.2.10', 24, '192.168.2.1', 700, 60, { fixed: true })],
    links: [link('pc1', 'eth0', 'r1', 'eth0'), link('r1', 'eth1', 'r2', 'eth0'), link('r2', 'eth1', 'pc2', 'eth0')] }),
    solve: m => { routerOf(m, 'r1').routes.push(R('192.168.2.0', 24, '10.0.12.2')); routerOf(m, 'r2').routes.push(R('192.168.1.0', 24, '10.0.12.1')); return m; } },

  { id: 'return-route', title: 'The one-way street', xp: 40, par: 6,
    brief: 'Someone configured both routers. The request reaches PC2, but the reply dies on R2. Read R2\'s routing table carefully: routes are exact about which network they cover.',
    allPairs: ['pc1', 'pc2'],
    setup: () => {
      const m = CHALLENGES.find(c => c.id === 'static').setup();
      routerOf(m, 'r1').routes.push(R('192.168.2.0', 24, '10.0.12.2'));
      routerOf(m, 'r2').routes.push(R('192.168.10.0', 24, '10.0.12.1'));
      return m;
    },
    solve: m => { routerOf(m, 'r2').routes[0].dest = '192.168.1.0'; return m; } },

  { id: 'loop', title: 'Round and round', xp: 45, par: 6,
    brief: 'The ping fails with **TTL exceeded**. Every router lowers a packet\'s TTL by one, so a packet caught in a loop eventually dies instead of circling forever. Find out why R1 and R2 keep handing the packet to each other, and fix the cause (not the symptom).',
    allPairs: ['pc1', 'pc2'],
    setup: () => {
      const m = CHALLENGES.find(c => c.id === 'static').setup();
      routerOf(m, 'r1').routes.push(R('192.168.2.0', 24, '10.0.12.2'));
      routerOf(m, 'r2').routes.push(R('0.0.0.0', 0, '10.0.12.1'));
      routerOf(m, 'r2').ifaces[1].ip = '192.168.3.1';
      return m;
    },
    solve: m => { routerOf(m, 'r2').ifaces[1].ip = '192.168.2.1'; return m; } },

  { id: 'nat', title: 'Hello, Internet', xp: 40, par: 4,
    brief: 'R1 has a public address `203.0.113.2` on the ISP link and a default route to the ISP. `PC1 → 8.8.8.8` still fails on the way back: the internet cannot answer a private `192.168.x.x` address. Turn on **NAT** on R1 with the ISP-facing interface as *outside*, and watch the translation table fill in.',
    goal: [['pc1', '8.8.8.8']],
    setup: () => ({ devices: [
      pc('pc1', 'PC1', '192.168.1.10', 24, '192.168.1.1', 60, 80, { fixed: true }),
      router('r1', 'R1', [['192.168.1.1', 24], ['203.0.113.2', 24]], 330, 320, { fixed: true, routes: [R('0.0.0.0', 0, '203.0.113.1')] }),
      cloud(640, 80)],
    links: [link('pc1', 'eth0', 'r1', 'eth0'), link('r1', 'eth1', 'net', 'isp')] }),
    solve: m => { routerOf(m, 'r1').nat = { on: true, outside: 'eth1' }; return m; } },

  { id: 'lpm', title: 'Longest prefix wins', xp: 50, par: 8,
    brief: 'R1 sends everything to the internet with a default route `0.0.0.0/0`. A new server sits behind R3 in `10.0.5.0/24`. Do not touch the default route: add a **more specific** one. A /24 beats a /0 for addresses it covers, and the default still catches the rest. Both `PC1 → Server` and `PC1 → 8.8.8.8` must work.',
    goal: [['pc1', 'srv'], ['pc1', '8.8.8.8']],
    setup: () => ({ devices: [
      pc('pc1', 'PC1', '192.168.1.10', 24, '192.168.1.1', 40, 60, { fixed: true }),
      router('r1', 'R1', [['192.168.1.1', 24], ['203.0.113.2', 24], ['10.0.13.1', 30]], 300, 260, { fixed: true, routes: [R('0.0.0.0', 0, '203.0.113.1')], nat: { on: true, outside: 'eth1' } }),
      cloud(620, 60),
      router('r3', 'R3', [['10.0.13.2', 30], ['10.0.5.1', 24]], 300, 520, { fixed: true, routes: [R('0.0.0.0', 0, '10.0.13.1')] }),
      pc('srv', 'Server', '10.0.5.10', 24, '10.0.5.1', 640, 520, { fixed: true })],
    links: [link('pc1', 'eth0', 'r1', 'eth0'), link('r1', 'eth1', 'net', 'isp'), link('r1', 'eth2', 'r3', 'eth0'), link('r3', 'eth1', 'srv', 'eth0')] }),
    solve: m => { routerOf(m, 'r1').routes.push(R('10.0.5.0', 24, '10.0.13.2')); return m; } },

  { id: 'capstone', title: 'Three subnets and NAT to the internet', xp: 60, par: 6,
    brief: 'Three departments, three networks: `192.168.1.0/24`, `192.168.2.0/24`, `192.168.3.0/24`, and one ISP link (use `203.0.113.2/24`; the ISP is `203.0.113.1`). Build the router (it can have up to six interfaces: **+ Add interface**), set gateways, a default route and NAT. Every PC must reach every other PC **and** 8.8.8.8.',
    allPairs: ['pc1', 'pc2', 'pc3'], goal: [['pc1', '8.8.8.8'], ['pc2', '8.8.8.8'], ['pc3', '8.8.8.8']],
    setup: () => ({ devices: [
      pc('pc1', 'Sales', '192.168.1.10', 24, '', 40, 60, { fixed: true }),
      pc('pc2', 'Dev', '192.168.2.10', 24, '', 320, 60, { fixed: true }),
      pc('pc3', 'Ops', '192.168.3.10', 24, '', 600, 60, { fixed: true }),
      cloud(880, 340)], links: [] }),
    solve: m => {
      const r = router('r1', 'R1', [['192.168.1.1', 24], ['192.168.2.1', 24], ['192.168.3.1', 24], ['203.0.113.2', 24]], 380, 360);
      r.routes.push(R('0.0.0.0', 0, '203.0.113.1'));
      r.nat = { on: true, outside: 'eth3' };
      m.devices.push(r);
      m.links.push(link('pc1', 'eth0', 'r1', 'eth0'), link('pc2', 'eth0', 'r1', 'eth1'), link('pc3', 'eth0', 'r1', 'eth2'), link('r1', 'eth3', 'net', 'isp'));
      byId(m, 'pc1').gateway = '192.168.1.1'; byId(m, 'pc2').gateway = '192.168.2.1'; byId(m, 'pc3').gateway = '192.168.3.1';
      return m;
    } },
];
