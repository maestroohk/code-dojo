// Network builder: place PCs, switches, routers and the Internet on a lego board, cable them, give every
// interface an address, set gateways, static routes and NAT, then ping. The packet travels hop by hop
// and every decision is explained (same subnet? which route? ARP? NAT? TTL?), including exactly why
// it failed. The simulation itself lives in netsim.js (DOM-free, tested in Node).
import { h, md } from './util.js';
import * as game from './game.js';
import { createBoard } from './blocks.js';
import * as N from './netsim.js';

const LAB = 'netbuild';
const COLORS = { pc: '#3d6f8a', switch: '#4f7a3a', router: '#b8572a', cloud: '#5f5590' };
const WIDTH = { pc: 210, switch: 300, router: 250, cloud: 220 };
const KINDS = Object.fromEntries(Object.entries(N.KINDS).map(([k, v]) => [k, { ...v, color: COLORS[k], width: WIDTH[k] }]));
/** replaceChildren that skips false/null (from `cond && node`). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const starText = n => '★'.repeat(n) + '☆'.repeat(3 - n);

export function netBuildLab(container, onXp) {
  const saved = game.state.labs[LAB] ||= { solved: {}, stars: {}, challenge: 'two-pcs', model: null, modelFor: null, view: 'board', speed: 'normal' };
  saved.stars ||= {};
  let challenge = N.CHALLENGES.find(c => c.id === saved.challenge) || N.CHALLENGES[1];
  let model = saved.model && saved.modelFor === challenge.id ? saved.model : challenge.setup();
  let nat = N.newNat();
  let wireStates = new Map();
  let badDevice = null;
  let pingRun = 0;
  let pingFrom = null, pingTo = '';
  let lastCheck = null;

  const dev = id => N.byId(model, id);
  const persist = () => { saved.model = model; saved.modelFor = challenge.id; saved.challenge = challenge.id; game.save(); };

  /** Any edit to the model: save, forget the last ping, redraw, re-judge. */
  function changed() {
    persist();
    pingRun++;
    nat = N.newNat();
    wireStates = new Map();
    badDevice = null;
    board.render();
    paintPing();
    evaluate();
  }

  // ------------------------------------------------------------ the board

  const board = createBoard({
    kinds: KINDS,
    wireKinds: { cable: { label: '', color: '#8a8f99' } },
    blocks: () => model.devices,
    wires: () => model.links.map(l => ({ id: l.id, kind: 'cable', from: { block: l.a.dev, port: l.a.port }, to: { block: l.b.dev, port: l.b.port } })),
    ports: d => N.portsOf(d).map(p => {
      const l = N.linkAt(model, d.id, p);
      const far = l && dev(N.otherEnd(l, d.id, p).dev);
      return { id: p, label: p, on: !!l, title: l ? `${p}: cabled to ${far?.name}. Drag elsewhere to re-cable, or onto empty board to unplug.` : `${p}: drag onto another device to plug in a cable` };
    }),
    body: deviceBody,
    canConnect: (from, port, to) => !!N.freePort(model, to) || (to.kind === 'router' && to.ifaces.length < N.MAX_ROUTER_IFACES),
    connect: (from, port, to, toPort) => {
      if (toPort && N.linkAt(model, to.id, toPort)) toPort = null;
      let tp = toPort || N.freePort(model, to);
      if (!tp && to.kind === 'router' && to.ifaces.length < N.MAX_ROUTER_IFACES) tp = addIface(to);
      if (!tp) return `${to.name} has no free port.`;
      model.links = model.links.filter(l => !((l.a.dev === from.id && l.a.port === port) || (l.b.dev === from.id && l.b.port === port) || (l.a.dev === to.id && l.a.port === tp) || (l.b.dev === to.id && l.b.port === tp)));
      model.links.push(N.link(from.id, port, to.id, tp));
      changed();
      return false;
    },
    onDropEmpty: (from, port) => {
      const before = model.links.length;
      model.links = model.links.filter(l => !((l.a.dev === from.id && l.a.port === port) || (l.b.dev === from.id && l.b.port === port)));
      if (model.links.length !== before) changed();
      return false;
    },
    palette: [
      { kind: 'pc', title: 'Add a PC (one network card, eth0)', add: at => addDevice('pc', at) },
      { kind: 'switch', title: 'Add an 8-port switch: joins cables into one network', add: at => addDevice('switch', at) },
      { kind: 'router', title: 'Add a router: connects networks, one interface per network', add: at => addDevice('router', at) },
      { kind: 'cloud', title: 'Add the Internet (an ISP router at 203.0.113.1 with 8.8.8.8 and 1.1.1.1 behind it)', add: at => addDevice('cloud', at) },
    ],
    howto: 'Drag a device to move it. Drag a port (●) onto another device to cable it; drop it on empty board to unplug. Click to configure. Delete removes. Wheel zooms, drag the background to pan.',
    inspector,
    onDelete: sel => {
      if (sel.type === 'wire') model.links = model.links.filter(l => l.id !== sel.id);
      else {
        const d = dev(sel.id);
        if (!d) return;
        if (d.fixed) { board.say(`${d.name} is part of this challenge and cannot be removed.`); return; }
        model.devices = model.devices.filter(x => x.id !== d.id);
        model.links = model.links.filter(l => l.a.dev !== d.id && l.b.dev !== d.id);
        if (pingFrom === d.id) pingFrom = null;
      }
      changed();
    },
    onMove: () => persist(),
    blockClass: d => [d.fixed && 'fixed', badDevice === d.id && 'bad'].filter(Boolean).join(' '),
    wireState: w => wireStates.get(w.id) || '',
    form: formView,
    view: saved.view,
    onView: v => { saved.view = v; persist(); },
  });

  function addDevice(kind, at) {
    if (kind === 'cloud' && model.devices.some(d => d.kind === 'cloud')) return 'There is only one Internet on this board.';
    const n = k => { let i = 1; while (model.devices.some(d => d.id === k + i)) i++; return i; };
    let d;
    if (kind === 'pc') { const i = n('pc'); d = N.pc('pc' + i, 'PC' + i, '', 24, '', at.x, at.y); }
    if (kind === 'switch') { const i = n('sw'); d = N.sw('sw' + i, 'SW' + i, at.x, at.y); }
    if (kind === 'router') { const i = n('r'); d = N.router('r' + i, 'R' + i, [], at.x, at.y); }
    if (kind === 'cloud') d = N.cloud(at.x, at.y);
    model.devices.push(d);
    changed();
    return d;
  }

  function addIface(d) {
    const id = 'eth' + d.ifaces.length;
    d.ifaces.push({ id, ip: '', prefix: 24 });
    return id;
  }

  function deviceBody(d) {
    const line = (a, b) => h('div.nb-line', h('span.nb-if', a), h('span', b));
    if (d.kind === 'switch') return [h('div.bk-name', d.name), h('div.nb-sub', 'Layer 2: joins cables into one network, no IP')];
    if (d.kind === 'cloud') return [h('div.bk-name', d.name), line('isp', `${N.CLOUD_IP}/${N.CLOUD_PREFIX}`), h('div.nb-sub', 'hosts 8.8.8.8 and 1.1.1.1')];
    if (d.kind === 'pc') {
      const i = d.ifaces[0];
      return [h('div.bk-name', d.name), line('ip', i.ip ? `${i.ip}/${i.prefix}` : 'no address'), line('gw', d.gateway || 'none')];
    }
    return [h('div.bk-name', d.name),
      d.ifaces.map(i => line(i.id, i.ip ? `${i.ip}/${i.prefix}` : '—')),
      h('div.bk-tags', (d.routes?.length || 0) > 0 && h('span.bk-tag', `${d.routes.length} route${d.routes.length === 1 ? '' : 's'}`),
        d.nat?.on && h('span.bk-tag', `NAT out ${d.nat.outside}`))];
  }

  // ------------------------------------------------------------ inspector

  const field = (label, control, help) => h('label.pk-field', h('span', label), control, help && h('span.muted.small', help));

  function ipInput(obj, key = 'ip', prefixKey = 'prefix', placeholder = '192.168.1.10') {
    return h('input.nb-ip', { value: obj[key] || '', placeholder, spellcheck: false, onchange: e => {
      const { ip, prefix } = N.parseIp(e.target.value);
      if (ip && !N.validIp(ip)) { board.say(`"${ip}" is not an IPv4 address (four numbers 0-255, like 192.168.1.10).`); e.target.value = obj[key] || ''; return; }
      obj[key] = ip;
      if (prefix !== undefined && prefixKey) obj[prefixKey] = prefix;
      changed();
    } });
  }
  const prefixInput = obj => h('input.nb-prefix', { type: 'number', min: 0, max: 32, value: obj.prefix, onchange: e => { obj.prefix = Math.max(0, Math.min(32, Number(e.target.value) || 0)); changed(); } });
  const cableOf = (d, p) => { const l = N.linkAt(model, d.id, p); return l ? dev(N.otherEnd(l, d.id, p).dev)?.name + ' ' + N.otherEnd(l, d.id, p).port : 'no cable'; };

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click a device or a cable to configure it.');
    if (sel.type === 'wire') {
      const l = model.links.find(x => x.id === sel.id);
      if (!l) return null;
      return h('div.pk-inspect',
        h('div.pk-inspect-head', h('b', 'Cable'), h('button.btn.ghost.small', { type: 'button', onclick: () => { model.links = model.links.filter(x => x !== l); changed(); } }, 'Unplug')),
        h('p', `${dev(l.a.dev)?.name} ${l.a.port} ↔ ${dev(l.b.dev)?.name} ${l.b.port}`),
        h('p.muted.small', 'A cable is just a wire: it carries frames between two ports. Press Delete to remove it.'));
    }
    const d = dev(sel.id);
    if (!d) return null;
    const k = KINDS[d.kind];
    const head = h('div.pk-inspect-head', h('b', `${k.icon} ${k.label}`),
      h('button.btn.ghost.small', { type: 'button', disabled: !!d.fixed, title: d.fixed ? 'Part of the challenge' : 'Delete (or press Delete)', onclick: () => removeDevice(d) }, 'Delete'));
    const name = field('Name', h('input', { value: d.name, onchange: e => { d.name = e.target.value || d.name; changed(); } }));
    if (d.kind === 'pc') {
      const i = d.ifaces[0];
      const net = N.validIp(i.ip) ? N.cidr(i.ip, i.prefix) : null;
      return h('div.pk-inspect', head, name,
        h('div.nb-ifrow', field('IP address', ipInput(i)), field('Prefix', prefixInput(i))),
        h('p.muted.small', net ? `Network ${net}: ${d.name} delivers directly to anything inside it, and sends everything else to the gateway.` : 'Type an address like 192.168.1.10 (you can type 192.168.1.10/24).'),
        field('Default gateway', ipInput(d, 'gateway', null, '192.168.1.1'), 'The router address on this network. Needed to reach any other network, and for replies to go back.'),
        h('p.muted.small', `eth0: ${cableOf(d, 'eth0')}`));
    }
    if (d.kind === 'switch') {
      return h('div.pk-inspect', head, name,
        h('p.muted.small', 'A switch has no IP address. It learns which MAC address lives behind which port and forwards frames only there. Everything cabled to it (and to switches cabled to it) is one network: one broadcast domain.'),
        h('ul.nb-ports', N.portsOf(d).map(p => h('li', h('span.nb-if', p), ' ', cableOf(d, p)))));
    }
    if (d.kind === 'cloud') {
      return h('div.pk-inspect', head,
        h('p', `The ISP router is ${N.CLOUD_IP}/${N.CLOUD_PREFIX}. Give your router an address in ${N.cidr(N.CLOUD_IP, N.CLOUD_PREFIX)} (e.g. 203.0.113.2), cable it here, and add a default route via ${N.CLOUD_IP}.`),
        h('p.muted.small', 'Behind it live the public hosts 8.8.8.8 and 1.1.1.1. Like the real internet, it drops anything addressed to a private network (10/8, 172.16/12, 192.168/16): replies to your PCs need NAT.'),
        h('p.muted.small', `isp: ${cableOf(d, 'isp')}`));
    }
    // router
    const routeDraft = { dest: '', via: '' };
    const preIn = h('input.nb-prefix', { type: 'number', min: 0, max: 32, value: 24 });
    const table = N.routingTable(d);
    const natTable = nat.tables[d.id] || [];
    return h('div.pk-inspect', head, name,
      h('div.eyebrow', 'Interfaces'),
      d.ifaces.map((i, n) => h('div.nb-ifrow',
        h('span.nb-if.big', i.id), ipInput(i, 'ip', 'prefix', '10.0.0.1'), prefixInput(i),
        h('span.muted.small.nb-cable', cableOf(d, i.id)),
        h('button.btn.ghost.small', { type: 'button', title: 'Remove this interface', disabled: d.ifaces.length <= 1 || n !== d.ifaces.length - 1,
          onclick: () => { model.links = model.links.filter(l => !((l.a.dev === d.id && l.a.port === i.id) || (l.b.dev === d.id && l.b.port === i.id))); d.ifaces.pop(); if (d.nat?.outside === i.id) d.nat.on = false; changed(); } }, '✕'))),
      d.ifaces.length < N.MAX_ROUTER_IFACES && h('button.btn.ghost.small', { type: 'button', onclick: () => { addIface(d); changed(); } }, '+ Add interface'),
      h('div.eyebrow', 'Static routes'),
      (d.routes || []).map((r, n) => h('div.nb-route',
        h('code', `${r.dest}/${r.prefix} via ${r.via}`),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { d.routes.splice(n, 1); changed(); } }, '✕'))),
      h('div.nb-route-add',
        h('input.nb-ip', { placeholder: 'network e.g. 192.168.2.0', onchange: e => { const p = N.parseIp(e.target.value); routeDraft.dest = p.ip; if (p.prefix !== undefined) preIn.value = p.prefix; } }),
        h('span', '/'),
        preIn,
        h('span', 'via'),
        h('input.nb-ip', { placeholder: 'next hop e.g. 10.0.12.2', onchange: e => { routeDraft.via = e.target.value.trim(); } }),
        h('button.btn.primary.small', { type: 'button', onclick: () => {
          const dest = routeDraft.dest;
          if (!N.validIp(dest) || !N.validIp(routeDraft.via)) { board.say('A route needs a network address and a next-hop address. Use 0.0.0.0 / 0 for a default route.'); return; }
          const prefix = Math.max(0, Math.min(32, Number(preIn.value) || 0));
          (d.routes ||= []).push({ dest: N.netOf(dest, prefix), prefix, via: routeDraft.via });
          changed();
        } }, 'Add')),
      h('p.muted.small', 'A default route is 0.0.0.0 / 0: it matches everything, but any longer prefix wins over it.'),
      h('details.nb-table', { open: true }, h('summary', 'Routing table'),
        table.length ? h('table.nb-rt', h('tr', h('th', 'Destination'), h('th', 'Via'), h('th', 'Type')),
          table.map(r => h('tr', h('td', h('code', `${r.dest}/${r.prefix}`)), h('td', r.via || r.iface), h('td.muted', r.type))))
          : h('p.muted.small', 'Empty: give the interfaces addresses.')),
      h('div.eyebrow', 'NAT'),
      h('div.nb-nat',
        h('label', h('input', { type: 'checkbox', checked: !!d.nat?.on, onchange: e => { d.nat = { ...(d.nat || {}), on: e.target.checked, outside: d.nat?.outside || d.ifaces[d.ifaces.length - 1].id }; changed(); } }), ' Translate (masquerade) to the outside interface'),
        h('label', 'outside: ', h('select', { onchange: e => { d.nat = { ...(d.nat || {}), outside: e.target.value }; changed(); } },
          d.ifaces.map(i => h('option', { value: i.id, selected: d.nat?.outside === i.id }, i.id))))),
      d.nat?.on && h('details.nb-table', { open: natTable.length > 0 }, h('summary', `Translation table (${natTable.length})`),
        natTable.length ? h('table.nb-rt', h('tr', h('th', 'Inside'), h('th', 'Outside'), h('th', 'id'), h('th', 'To')),
          natTable.map(e => h('tr', h('td', e.inside), h('td', e.outside), h('td', e.id), h('td', e.to))))
          : h('p.muted.small', 'Empty: ping something on the internet from inside.')));
  }

  function removeDevice(d) {
    if (d.fixed) return;
    model.devices = model.devices.filter(x => x.id !== d.id);
    model.links = model.links.filter(l => l.a.dev !== d.id && l.b.dev !== d.id);
    changed();
  }

  // ------------------------------------------------------------ form view

  function formView() {
    const ports = model.devices.flatMap(d => N.portsOf(d).filter(p => !N.linkAt(model, d.id, p)).map(p => ({ v: `${d.id}|${p}`, l: `${d.name} ${p}` })));
    let a = '', b = '';
    return h('div.nb-form',
      h('table.nb-ftable',
        h('tr', h('th', 'Device'), h('th', 'Interfaces'), h('th', 'Gateway / routes')),
        model.devices.map(d => h('tr', { onclick: e => { if (!e.target.closest('input,button,select')) board.select({ type: 'block', id: d.id }); } },
          h('td', h('b', `${KINDS[d.kind].icon} ${d.name}`), h('div.muted.small', KINDS[d.kind].label)),
          h('td', d.kind === 'switch' ? h('span.muted.small', `${N.portsOf(d).filter(p => N.linkAt(model, d.id, p)).length} of ${d.ifaces.length} ports used`)
            : d.kind === 'cloud' ? h('code', `${N.CLOUD_IP}/${N.CLOUD_PREFIX}`)
              : d.ifaces.map(i => h('div.nb-ifrow', h('span.nb-if', i.id), ipInput(i), prefixInput(i)))),
          h('td', d.kind === 'pc' ? ipInput(d, 'gateway', null, 'gateway')
            : d.kind === 'router' ? h('span.small', (d.routes || []).map(r => `${r.dest}/${r.prefix} → ${r.via}`).join(', ') || h('span.muted', 'no static routes'), d.nat?.on ? ` · NAT out ${d.nat.outside}` : '')
              : '')))),
      h('div.eyebrow', 'Cables'),
      model.links.length ? h('ul.nb-cables', model.links.map(l => h('li', `${dev(l.a.dev)?.name} ${l.a.port} ↔ ${dev(l.b.dev)?.name} ${l.b.port} `,
        h('button.btn.ghost.small', { type: 'button', onclick: () => { model.links = model.links.filter(x => x !== l); changed(); } }, 'Unplug'))))
        : h('p.muted.small', 'No cables yet.'),
      h('div.nb-cable-add',
        h('select', { onchange: e => { a = e.target.value; } }, h('option', { value: '' }, 'from port…'), ports.map(p => h('option', { value: p.v }, p.l))),
        h('span', '↔'),
        h('select', { onchange: e => { b = e.target.value; } }, h('option', { value: '' }, 'to port…'), ports.map(p => h('option', { value: p.v }, p.l))),
        h('button.btn.primary.small', { type: 'button', onclick: () => {
          if (!a || !b || a === b || a.split('|')[0] === b.split('|')[0]) { board.say('Pick two free ports on two different devices.'); return; }
          const [ad, ap] = a.split('|'), [bd, bp] = b.split('|');
          model.links.push(N.link(ad, ap, bd, bp));
          changed();
        } }, 'Plug in')),
      h('p.muted.small', 'Router routes and NAT are edited in the inspector: click a router row.'));
  }

  // ------------------------------------------------------------ ping

  const pingSlot = h('div.nb-ping');
  const logEl = h('ol.nb-log');
  const verdictEl = h('div.nb-verdict');

  function targets() {
    const list = [];
    for (const d of model.devices) {
      if (d.kind === 'pc' && N.validIp(d.ifaces[0].ip)) list.push({ v: d.ifaces[0].ip, l: `${d.name} (${d.ifaces[0].ip})` });
      if (d.kind === 'router') for (const i of d.ifaces) if (N.validIp(i.ip)) list.push({ v: i.ip, l: `${d.name} ${i.id} (${i.ip})` });
      if (d.kind === 'cloud') N.PUBLIC_HOSTS.forEach(ip => list.push({ v: ip, l: `Internet (${ip})` }));
    }
    return list;
  }

  function paintPing() {
    const sources = model.devices.filter(d => d.kind === 'pc' || d.kind === 'router');
    if (!sources.some(d => d.id === pingFrom)) pingFrom = sources[0]?.id || null;
    const tl = targets();
    if (!pingTo || !tl.some(t => t.v === pingTo) && !N.validIp(pingTo)) pingTo = tl.find(t => !dev(pingFrom)?.ifaces.some(i => i.ip === t.v))?.v || '';
    const custom = h('input.nb-ip', { placeholder: 'or type an address', value: tl.some(t => t.v === pingTo) ? '' : pingTo, onchange: e => { pingTo = e.target.value.trim(); } });
    fill(pingSlot, 
      h('div.nb-ping-row',
        h('b', 'Ping'),
        h('select', { onchange: e => { pingFrom = e.target.value; } }, sources.map(d => h('option', { value: d.id, selected: d.id === pingFrom }, d.name))),
        h('span', '→'),
        h('select', { onchange: e => { pingTo = e.target.value; custom.value = ''; } }, tl.map(t => h('option', { value: t.v, selected: t.v === pingTo }, t.l))),
        custom,
        h('button.btn.primary', { type: 'button', disabled: !pingFrom, onclick: () => doPing() }, '▶ Send'),
        h('select', { title: 'Animation speed', onchange: e => { saved.speed = e.target.value; game.save(); } },
          [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([v, l]) => h('option', { value: v, selected: saved.speed === v }, l)))),
      verdictEl, logEl);
  }

  async function doPing(from = pingFrom, to = pingTo) {
    const run = ++pingRun;
    board.stop();
    wireStates = new Map();
    badDevice = null;
    board.render();
    if (!N.validIp(to)) { fill(verdictEl, h('div.nb-bad', `"${to}" is not an IPv4 address.`)); return; }
    const r = N.ping(model, from, to, nat);
    logEl.replaceChildren();
    fill(verdictEl, h('div.muted', `Pinging ${to} from ${dev(from)?.name}…`));
    const ms = { slow: 900, normal: 480, fast: 160 }[saved.speed] || 480;
    let hops = 0, lastDir = null;
    for (const ev of r.events) {
      if (run !== pingRun) return;
      if (ev.dir !== lastDir) { logEl.append(h('li.nb-phase', ev.dir === 'request' ? '→ Echo request' : '← Echo reply')); lastDir = ev.dir; }
      if (ev.type === 'note') {
        const li = h(`li.nb-ev.${ev.tone}`, h('span.nb-who', dev(ev.dev)?.name || ev.dev), h('span', ev.text));
        logEl.append(li);
        logEl.scrollTop = logEl.scrollHeight;
        board.pulse(ev.dev, ev.tone === 'bad' ? 'bad' : ev.tone === 'ok' ? 'ok' : 'active');
        if (ev.tone === 'bad') badDevice = ev.dev;
        await new Promise(res => setTimeout(res, hops > 14 ? 15 : Math.min(ms * 0.5, 260)));   // a loop: hurry through the laps
      } else {
        hops++;
        const quick = hops > 14;   // a routing loop: no need to watch all 64 laps
        await board.animate([{ from: ev.from, to: ev.to, wire: ev.link }], { cls: ev.dir === 'request' ? 'req' : 'rep', ms: quick ? 60 : ms, label: quick ? '' : `TTL ${ev.ttl}` });
        if (run !== pingRun) return;
        wireStates.set(ev.link, 'active');
        board.setWireState(ev.link, 'active');
      }
    }
    if (run !== pingRun) return;
    if (r.ok) for (const id of wireStates.keys()) { wireStates.set(id, 'ok'); board.setWireState(id, 'ok'); }
    if (badDevice) board.pulse(badDevice, 'bad', 2400);
    game.sound?.(r.ok ? 'right' : 'wrong');
    fill(verdictEl, r.ok
      ? h('div.nb-ok', h('span.pk-status.ok', 'Reply'), ` ${dev(from)?.name} → ${to}: the request got there and the reply came back.`)
      : h('div.nb-bad', h('span.pk-status.bad', r.phase === 'reply' ? 'No reply' : 'Failed'), ' ', r.reason));
    board.refreshInspector();   // NAT tables may have grown
  }

  // ------------------------------------------------------------ goals, stars, XP

  const goalsEl = h('div.nb-goals');

  function evaluate() {
    if (!challenge.xp) { fill(goalsEl, h('span.muted.small', 'Sandbox: no goals. Pick a challenge above to earn XP.')); return; }
    const res = N.check(model, challenge);
    lastCheck = res;
    const best = saved.stars[challenge.id] || 0;
    fill(goalsEl, 
      h('div.nb-goal-head',
        h('b', res.ok ? '✓ All goals met' : 'Goals'),
        h('span.muted.small', `Par ${challenge.par} parts (devices + static routes). You use ${res.cost}.`),
        h('span.nb-stars', { title: 'Best so far' }, starText(Math.max(best, res.stars)))),
      h('ul.nb-goal-list', res.results.map(g => h(`li.${g.ok ? 'ok' : 'bad'}`,
        h('button.nb-goal', { type: 'button', title: 'Ping this pair', onclick: () => { pingFrom = g.from; pingTo = N.validIp(g.to) ? g.to : N.addressOf(dev(g.to)); paintPing(); doPing(); } },
          h('span.nb-mark', g.ok ? '✓' : '✕'), ` ping ${g.label}`),
        !g.ok && g.reason && h('div.muted.small', g.reason)))),
      res.extra && h('p.pk-extra', res.extra));
    if (res.ok && res.stars > best) {
      const earned = Math.round(challenge.xp * res.stars / 3) - Math.round(challenge.xp * best / 3);
      saved.stars[challenge.id] = res.stars;
      saved.solved[challenge.id] ||= game.dayKey();
      if (earned > 0) game.addXp(earned);
      game.sound?.('done');
      game.save(true);
      if (earned > 0) onXp?.(earned, `${challenge.title} ${starText(res.stars)}`);
      paintChips();
    }
  }

  // ------------------------------------------------------------ layout

  const chipsEl = h('div.pk-challenges');
  function paintChips() {
    chipsEl.replaceChildren(...N.CHALLENGES.map(c => h(`button.pk-ch${c.id === challenge.id ? '.active' : ''}${saved.solved[c.id] ? '.solved' : ''}`, {
      type: 'button', onclick: () => pick(c),
    }, c.title, c.xp ? h('span.nb-chip-stars', saved.stars[c.id] ? ' ' + starText(saved.stars[c.id]) : ` +${c.xp}`) : '')));
    counter.textContent = `${N.CHALLENGES.filter(c => c.xp && saved.solved[c.id]).length} / ${N.CHALLENGES.filter(c => c.xp).length} solved`;
  }
  const counter = h('div.muted.small');
  const briefEl = h('div.pk-brief.nb-brief');

  function paintBrief() {
    fill(briefEl, 
      h('div', h('div', { html: md(challenge.brief) }),
        h('p.muted.small.nb-tie', 'Masks still fuzzy? Drill them in the ', h('a', { href: '#/labs/subnet' }, 'Subnetting trainer'),
          '. Want real packets? The ', h('a', { href: '#/labs/net' }, 'Live network labs'), ' run ip, ping, tcpdump and NAT on real Docker networks.')),
      h('button.btn.ghost.small', { type: 'button', onclick: () => { model = challenge.setup(); board.select(null); changed(); setTimeout(() => board.fit(), 0); } }, 'Reset'));
  }

  function pick(c) {
    challenge = c;
    model = c.setup();
    pingFrom = null; pingTo = '';
    logEl.replaceChildren(); fill(verdictEl);
    paintChips(); paintBrief();
    board.select(null);
    changed();
    requestAnimationFrame(() => board.fit());
  }

  container.replaceChildren(
    h('div.pk-top', chipsEl, counter),
    briefEl,
    goalsEl,
    h('div.nb-main',
      h('div.nb-left', board.el),
      h('div.nb-right', board.inspectorEl, h('div.nb-ping-card', pingSlot))));
  paintChips(); paintBrief();
  board.render();
  paintPing();
  evaluate();
  requestAnimationFrame(() => board.fit());
  return () => { pingRun++; board.stop(); };
}
