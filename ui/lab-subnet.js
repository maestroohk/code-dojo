// Subnetting trainer: endless generated questions until the maths is automatic. After every answer
// the address and mask are laid out bit by bit, so you see WHY the answer is what it is: the mask
// splits network bits from host bits, AND gives the network, setting host bits gives the broadcast.
import { h } from './util.js';
import * as game from './game.js';

const ip2n = s => s.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const n2ip = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
const maskN = p => (p === 0 ? 0 : (2 ** 32 - 2 ** (32 - p)));
const and = (a, b) => [24, 16, 8, 0].reduce((n, s) => n + ((Math.floor(a / 2 ** s) % 256) & (Math.floor(b / 2 ** s) % 256)) * 2 ** s, 0);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[rnd(0, arr.length - 1)];
const bits = n => n.toString(2).padStart(32, '0');

function network(ip, p) { return and(ip, maskN(p)); }
function broadcast(ip, p) { return network(ip, p) + 2 ** (32 - p) - 1; }
const usable = p => (p >= 31 ? (p === 31 ? 2 : 1) : 2 ** (32 - p) - 2);

function randomIp() {
  const kind = pick(['10', '172', '192']);
  if (kind === '10') return ip2n(`10.${rnd(0, 255)}.${rnd(0, 255)}.${rnd(1, 254)}`);
  if (kind === '172') return ip2n(`172.${rnd(16, 31)}.${rnd(0, 255)}.${rnd(1, 254)}`);
  return ip2n(`192.168.${rnd(0, 255)}.${rnd(1, 254)}`);
}

// Each kind returns { q, answer, accept?, explain: { ip, prefix, ip2? } }
const KINDS = {
  network: { label: 'Network address', make(level) {
    const p = level === 1 ? pick([8, 16, 24]) : level === 2 ? rnd(20, 30) : rnd(9, 30);
    const ip = randomIp();
    return { q: [`What is the network address of `, h('code', `${n2ip(ip)}/${p}`), '?'], answer: n2ip(network(ip, p)), explain: { ip, p } };
  } },
  broadcast: { label: 'Broadcast address', make(level) {
    const p = level === 1 ? pick([8, 16, 24]) : level === 2 ? rnd(20, 30) : rnd(9, 30);
    const ip = randomIp();
    return { q: [`What is the broadcast address of `, h('code', `${n2ip(ip)}/${p}`), '?'], answer: n2ip(broadcast(ip, p)), explain: { ip, p } };
  } },
  range: { label: 'First and last host', make(level) {
    const p = level === 1 ? pick([24, 25, 26]) : rnd(20, 29);
    const ip = randomIp();
    const first = n2ip(network(ip, p) + 1), last = n2ip(broadcast(ip, p) - 1);
    return { q: [`Usable host range of `, h('code', `${n2ip(ip)}/${p}`), '? Answer as ', h('code', 'first-last'), '.'], answer: `${first}-${last}`,
      normalize: s => s.replace(/\s+/g, '').replace(/–|—|to/g, '-'), explain: { ip, p } };
  } },
  hosts: { label: 'How many hosts', make(level) {
    const p = level === 1 ? pick([24, 25, 26, 27, 28, 30]) : rnd(16, 30);
    return { q: [`How many usable hosts are in a `, h('code', `/${p}`), ' network?'], answer: String(usable(p)),
      explain: { ip: randomIp(), p }, note: `2^${32 - p} addresses = ${2 ** (32 - p)}, minus the network and broadcast addresses = ${usable(p)}.` };
  } },
  mask: { label: 'Prefix ↔ mask', make() {
    const p = rnd(8, 30);
    return Math.random() < 0.5
      ? { q: [`Write `, h('code', `/${p}`), ' as a dotted subnet mask.'], answer: n2ip(maskN(p)), explain: { ip: maskN(p), p, maskOnly: true } }
      : { q: [`Which prefix length is the mask `, h('code', n2ip(maskN(p))), '?'], answer: String(p), display: '/' + p, normalize: s => s.replace('/', ''), explain: { ip: maskN(p), p, maskOnly: true } };
  } },
  same: { label: 'Same subnet?', make(level) {
    const p = level === 1 ? 24 : rnd(20, 29);
    const ip = randomIp();
    const near = Math.random() < 0.5;
    const size = 2 ** (32 - p);
    const ip2 = near ? network(ip, p) + rnd(1, size - 2) : (network(ip, p) + size + rnd(1, Math.max(1, size - 2))) % 2 ** 32;
    return { q: [`Are `, h('code', `${n2ip(ip)}/${p}`), ' and ', h('code', `${n2ip(ip2)}/${p}`), ' in the same subnet? (yes/no)'],
      answer: network(ip, p) === network(ip2, p) ? 'yes' : 'no', normalize: s => s.toLowerCase().startsWith('y') ? 'yes' : s.toLowerCase().startsWith('n') ? 'no' : s, explain: { ip, p, ip2 } };
  } },
  split: { label: 'Split into subnets', make() {
    const base = pick([16, 20, 22, 24]);
    const need = pick([2, 3, 4, 5, 6, 8, 10, 12, 16, 30]);
    const bitsNeeded = Math.ceil(Math.log2(need));
    const p = base + bitsNeeded;
    const ip = network(randomIp(), base);
    return { q: [`You must split `, h('code', `${n2ip(ip)}/${base}`), ` into at least ${need} equal subnets. What is the smallest prefix that gives enough? (e.g. /26)`],
      answer: String(p), display: '/' + p, normalize: s => s.replace('/', ''), explain: { ip, p },
      note: `${need} subnets need ${bitsNeeded} borrowed bit${bitsNeeded === 1 ? '' : 's'} (2^${bitsNeeded} = ${2 ** bitsNeeded} ≥ ${need}), so /${base} + ${bitsNeeded} = /${p}. Each subnet then has ${usable(p)} usable hosts.` };
  } },
  which: { label: 'Which subnet?', make() {
    const p = rnd(25, 29);
    const ip = randomIp();
    return { q: [`The network uses `, h('code', `/${p}`), ` subnets. Which subnet does `, h('code', n2ip(ip)), ' belong to? (answer like 10.1.2.64/27)'],
      answer: `${n2ip(network(ip, p))}/${p}`, normalize: s => s.replace(/\s+/g, '').includes('/') ? s.replace(/\s+/g, '') : `${s.trim()}/${p}`, explain: { ip, p },
      note: `Block size is 2^${32 - p} = ${2 ** (32 - p)}. Subnets start at multiples of ${2 ** (32 - p)} in the last octet.` };
  } },
};

/** The bit-by-bit explanation. */
function explainBits({ ip, p, ip2, maskOnly }) {
  const row = (label, n, mode) => {
    const b = bits(n);
    return h('div.sn-row', h('span.sn-label', label),
      h('span.sn-bits', [0, 1, 2, 3].map(o => h('span.sn-octet', [...b.slice(o * 8, o * 8 + 8)].map((c, i) => {
        const k = o * 8 + i;
        return h(`span.sn-bit${k < p ? '.net' : '.host'}${mode === 'set' && k >= p ? '.set' : ''}${mode === 'clr' && k >= p ? '.clr' : ''}`, c);
      })))),
      h('span.sn-dec', n2ip(n)));
  };
  if (maskOnly) return h('div.sn-explain', row('mask', maskN(p)),
    h('p.small.muted', `/${p} means the first ${p} bits are 1 (network) and the remaining ${32 - p} are 0 (host). Each octet of 8 bits becomes one number: 11111111 = 255, 11100000 = 224, and so on.`));
  return h('div.sn-explain',
    row('address', ip),
    row(`mask /${p}`, maskN(p)),
    row('network', network(ip, p), 'clr'),
    row('broadcast', broadcast(ip, p), 'set'),
    ip2 != null && row('other', ip2),
    ip2 != null && row('its network', network(ip2, p), 'clr'),
    h('p.small.muted', h('span.sn-key.net', 'network bits'), ' ', h('span.sn-key.host', 'host bits'),
      ` · Network = address AND mask (host bits cleared to 0). Broadcast = host bits all set to 1. Usable hosts sit between them: ${usable(p).toLocaleString()} of them.`));
}

export function subnetTrainer(container) {
  const saved = game.state.labs.subnet ||= { level: 1, kinds: Object.keys(KINDS), best: 0, solved: 0 };
  let streak = 0, current = null, answered = false;
  const qEl = h('div.sn-q');
  const input = h('input.sn-input', { spellcheck: false, autocomplete: 'off', placeholder: 'your answer', onkeydown: e => { if (e.key === 'Enter') answered ? next() : check(); } });
  const feedback = h('div.sn-feedback');
  const stats = h('div.sn-stats');
  const checkBtn = h('button.btn.primary.big', { type: 'button', onclick: () => (answered ? next() : check()) }, 'Check');

  function next() {
    const pool = saved.kinds.length ? saved.kinds : Object.keys(KINDS);
    const kind = pick(pool);
    current = { kind, ...KINDS[kind].make(saved.level) };
    answered = false;
    qEl.replaceChildren(h('div.eyebrow', KINDS[kind].label), h('div.sn-qtext', current.q));
    input.value = ''; input.disabled = false; input.focus();
    feedback.replaceChildren();
    checkBtn.textContent = 'Check';
  }

  function check() {
    const raw = input.value.trim();
    if (!raw) return;
    const norm = current.normalize || (s => s.replace(/\s+/g, ''));
    const ok = norm(raw) === norm(current.answer);
    answered = true;
    input.disabled = true;
    if (ok) {
      streak++; saved.solved++; saved.best = Math.max(saved.best, streak);
      if (saved.solved % 5 === 0) game.addXp(5);
      game.sound?.('right');
    } else { streak = 0; game.sound?.('wrong'); }
    game.save();
    feedback.replaceChildren(
      h(`div.sn-verdict.${ok ? 'ok' : 'bad'}`, ok ? 'Correct.' : h('span', 'Not quite. The answer is ', h('code', current.display || current.answer), '.')),
      current.note && h('p', current.note),
      explainBits(current.explain));
    checkBtn.textContent = 'Next question';
    checkBtn.focus();
    paintStats();
  }

  function paintStats() {
    stats.replaceChildren(
      h('span', h('b', streak), ' in a row'),
      h('span', h('b', saved.best), ' best streak'),
      h('span', h('b', saved.solved), ' solved'),
      h('span.muted.small', '+5 XP every 5 correct'));
  }

  const levelSel = h('div.sn-levels', [[1, 'Warm-up: /8, /16, /24'], [2, 'Everyday: /20 to /30'], [3, 'Anything']].map(([v, l]) =>
    h(`button.tab${saved.level === v ? '.active' : ''}`, { type: 'button', onclick: e => {
      saved.level = v; game.save();
      levelSel.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === e.currentTarget));
      next();
    } }, l)));
  const kindSel = h('div.sn-kinds', Object.entries(KINDS).map(([k, d]) => h('label.sn-kind',
    h('input', { type: 'checkbox', checked: saved.kinds.includes(k), onchange: e => {
      saved.kinds = e.target.checked ? [...new Set([...saved.kinds, k])] : saved.kinds.filter(x => x !== k);
      game.save();
    } }), d.label)));

  container.replaceChildren(
    h('div.sn-top', levelSel, stats),
    h('details.sn-choose', h('summary', 'Choose question types'), kindSel),
    h('div.sn-card', qEl, h('div.sn-answer', input, checkBtn), feedback));
  paintStats();
  next();
}
