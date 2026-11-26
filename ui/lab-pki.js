// The certificate lab: build a small PKI out of blocks, connect who signs whom, choose what the
// client trusts and what the server sends, and watch real chain validation (X509Chain on the
// server) decide. Two ways to edit the same model: a visual board (drag blocks, draw "signed by"
// wires) and a plain form. Challenges start from a broken setup; fix it to earn XP.
import { h, api, md } from './util.js';
import * as game from './game.js';

const LAB = 'pki';
const DAY = 864e5;
const BASE = Date.UTC(2030, 0, 1);
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const AT = iso(BASE + 540 * DAY);   // the "today" of every scenario, so results never depend on the real clock

const KINDS = {
  root: { label: 'Root CA', icon: '🏛', ca: true, eku: '', years: 20 },
  inter: { label: 'Intermediate CA', icon: '🏢', ca: true, eku: '', years: 8 },
  server: { label: 'Server cert', icon: '🖥', ca: false, eku: 'server', years: 2 },
  client: { label: 'Client cert', icon: '👤', ca: false, eku: 'client', years: 2 },
};

// A rosette seal for the certificate face, and a small document icon for the palette (drawn here, no images).
const SEAL = '<svg viewBox="0 0 40 40" width="34" height="34"><g fill="var(--brick)"><path d="M20 2l3.2 3.6 4.7-1.2 1.4 4.6 4.6 1.4-1.2 4.7L36.3 18.4l-3.6 3.2 1.2 4.7-4.6 1.4-1.4 4.6-4.7-1.2L20 34.8l-3.2-3.6-4.7 1.2-1.4-4.6-4.6-1.4 1.2-4.7L3.7 18.4l3.6-3.2-1.2-4.7 4.6-1.4 1.4-4.6 4.7 1.2z"/></g>'
  + '<circle cx="20" cy="18.4" r="8.5" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.4"/><path d="M15.5 18.6l3 3 6-6.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M14 31l-3 7 4-1.5 2 3.5 2.5-7M26 31l3 7-4-1.5-2 3.5-2.5-7" fill="var(--brick)" opacity=".85"/></svg>';
const DOC = '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="3.5" y="3" width="17" height="18" rx="2" fill="#f4efe1" stroke="var(--brick)" stroke-width="1.5"/>'
  + '<rect x="3.5" y="3" width="17" height="4" rx="1.5" fill="var(--brick)"/><path d="M7 11h10M7 14h7" stroke="#8a8270" stroke-width="1.4" stroke-linecap="round"/><circle cx="16.5" cy="17" r="2.4" fill="var(--brick)"/></svg>';

let seq = 0;
const newId = () => 'c' + Date.now().toString(36) + (seq++);

function cert(kind, name, issuer, x, y, extra = {}) {
  const k = KINDS[kind];
  return { id: extra.id || newId(), kind, name, issuer, ca: k.ca, pathLength: null, eku: k.eku,
    notBefore: iso(BASE), notAfter: iso(BASE + k.years * 365 * DAY), san: kind === 'server' ? ['shop.example', 'www.shop.example'] : [],
    forged: false, x, y, ...extra };
}

/** A healthy three-level PKI: root → intermediate → server. */
function healthy() {
  const root = cert('root', 'Dojo Root CA', null, 60, 40, { id: 'root' });
  const int = cert('inter', 'Dojo Issuing CA 1', 'root', 60, 190, { id: 'int' });
  const leaf = cert('server', 'shop.example', 'int', 60, 340, { id: 'leaf' });
  return { certs: [root, int, leaf], trusted: ['root'], sent: ['int'], leaf: 'leaf', host: 'shop.example', at: AT };
}

const CHALLENGES = [
  { id: 'explore', title: 'A healthy chain', xp: 0, setup: m => m,
    brief: 'Everything works: the server sends its certificate **and** the intermediate, and the client trusts the root. Click each block to read it, then break things on purpose and watch what the validator says.' },
  { id: 'missing-int', title: 'The missing intermediate', xp: 25, setup: m => ({ ...m, sent: [] }),
    brief: 'Users report **"unable to get local issuer certificate"**, but it works in *some* browsers. The server only sends its own certificate. Fix the server so every client can build the chain.' },
  { id: 'untrusted', title: 'Nobody trusts this root', xp: 25, setup: m => ({ ...m, trusted: [] }),
    brief: 'A brand-new internal root. The chain is complete but the client says **untrusted root**. Make the client trust the right certificate (and only that one: never trust an intermediate or a leaf as a shortcut).',
    extra: m => m.trusted.length === 1 && m.certs.find(c => c.id === m.trusted[0])?.issuer == null || 'Trust exactly one self-signed root.' },
  { id: 'expired', title: 'Expired', xp: 25,
    setup: m => ({ ...m, certs: m.certs.map(c => c.id === 'leaf' ? { ...c, notAfter: iso(BASE + 365 * DAY) } : c) }),
    brief: 'The site broke overnight. Read the dates on every certificate (the lab\'s "today" is ' + AT + ') and renew what expired.' },
  { id: 'hostname', title: 'Wrong name', xp: 25, setup: m => ({ ...m, host: 'api.shop.example' }),
    brief: 'A new subdomain `api.shop.example` points at the same server. The chain is fine but the browser says **name mismatch**. Fix the certificate, not the host. Hint: a wildcard covers exactly one label.' },
  { id: 'forged', title: 'The impostor', xp: 35,
    setup: m => ({ ...m, certs: m.certs.map(c => c.id === 'int' ? { ...c, forged: true } : c) }),
    brief: 'The intermediate has the right *name* and the right issuer field, yet validation fails with a bad signature. Find out why and make the chain honest again.' },
  { id: 'leaf-ca', title: 'A leaf that signs', xp: 35,
    setup: m => ({ ...m, certs: [...m.certs, cert('server', 'pay.shop.example', 'leaf', 330, 490, { id: 'pay', san: ['pay.shop.example'] })], leaf: 'pay', host: 'pay.shop.example', sent: ['int', 'leaf'] }),
    brief: 'Someone used the `shop.example` server certificate to sign a new one for `pay.shop.example`. Validation refuses. Re-issue `pay.shop.example` from the right authority.' },
  { id: 'client-eku', title: 'Wrong kind of certificate', xp: 25,
    setup: m => ({ ...m, certs: m.certs.map(c => c.id === 'leaf' ? { ...c, eku: 'client' } : c) }),
    brief: 'The server was given a certificate meant for *clients* (mutual TLS). Make it fit for serving HTTPS.' },
  { id: 'build', title: 'Build your own PKI', xp: 50,
    setup: () => ({ certs: [], trusted: [], sent: [], leaf: null, host: 'portal.corp.example', at: AT }),
    brief: 'From an empty board: build a **root**, an **intermediate** signed by it, and a **server certificate** for `portal.corp.example` signed by the intermediate. Then make the client trust the root and the server send the intermediate.',
    extra: m => {
      const leaf = m.certs.find(c => c.id === m.leaf), int = leaf && m.certs.find(c => c.id === leaf.issuer);
      return (int && int.ca && int.issuer && int.issuer !== int.id) || 'The server certificate must be signed by an intermediate, not straight by the root.';
    } },
];

export function pkiLab(container, onXp) {
  const saved = game.state.labs[LAB] ||= { solved: {}, challenge: 'explore', model: null, view: 'board' };
  let challenge = CHALLENGES.find(c => c.id === saved.challenge) || CHALLENGES[0];
  let model = saved.model || challenge.setup(healthy());
  let selected = model.leaf;
  let result = null;
  let timer = null;
  let busy = 0;

  const persist = () => { saved.model = model; saved.challenge = challenge.id; game.save(); };
  const byId = id => model.certs.find(c => c.id === id);
  const issuable = c => model.certs.filter(o => o.id !== c.id);

  function update(fn, { relayout = true } = {}) {
    fn();
    persist();
    if (relayout) render(); else paintResult();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(validate, 220);
  }

  async function validate() {
    const mine = ++busy;
    if (!model.certs.length || !byId(model.leaf)) { result = null; render(); return; }
    const body = {
      certs: model.certs.map(c => ({ id: c.id, name: c.name, issuer: c.issuer, ca: c.ca, pathLength: c.pathLength,
        notBefore: c.notBefore + 'T00:00:00Z', notAfter: c.notAfter + 'T00:00:00Z',
        san: c.san, eku: c.eku || null, forged: c.forged })),
      validate: { leaf: model.leaf, trusted: model.trusted, sent: model.sent, host: model.host, at: model.at + 'T12:00:00Z' },
    };
    let r;
    try { r = await api('pki', body); } catch { r = { error: 'Could not reach the dojo server.' }; }
    if (mine !== busy) return;
    result = r;
    const v = r.validation;
    const extra = v?.valid && challenge.extra ? challenge.extra(model) : true;
    if (v?.valid && extra === true && challenge.xp && !saved.solved[challenge.id]) {
      saved.solved[challenge.id] = game.dayKey();
      game.addXp(challenge.xp);
      game.save(true);
      onXp?.(challenge.xp, challenge.title);
    }
    result.extraHint = v?.valid && extra !== true ? extra : null;
    render();
  }

  // ------------------------------------------------------------ the board (visual mode)

  function board() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('pk-wires');
    const surface = h('div.pk-board', svg);
    const status = new Map((result?.validation?.chain || []).map((e, i) => [e.id, { i, bad: e.problems.length > 0 }]));
    const inChain = id => status.has(id);
    let linking = null;        // { from, line } while drawing a "signed by" wire

    const drawWires = () => {
      svg.replaceChildren();
      const defs = document.createElementNS(svg.namespaceURI, 'defs');
      defs.innerHTML = '<marker id="pk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>';
      svg.append(defs);
      for (const c of model.certs) {
        if (!c.issuer || c.issuer === c.id) continue;
        const p = byId(c.issuer);
        if (!p) continue;
        // The cable leaves the top of this certificate and arrives at the bottom of its signer (measured, not assumed).
        const signerHeight = surface.querySelector(`.pk-node[data-id="${p.id}"]`)?.offsetHeight || 92;
        const a = { x: c.x + 95, y: c.y }, b = { x: p.x + 95, y: p.y + signerHeight };
        const path = document.createElementNS(svg.namespaceURI, 'path');
        const my = (a.y + b.y) / 2;
        path.setAttribute('d', `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`);
        path.setAttribute('marker-end', 'url(#pk-arrow)');
        const both = inChain(c.id) && inChain(p.id);
        path.setAttribute('class', c.forged ? 'forged' : both ? (status.get(c.id).bad ? 'bad' : 'ok') : '');
        svg.append(path);
        const label = document.createElementNS(svg.namespaceURI, 'text');
        label.setAttribute('x', (a.x + b.x) / 2 + 8); label.setAttribute('y', my);
        label.textContent = c.forged ? 'forged signature' : 'signed by';
        svg.append(label);
      }
    };

    for (const c of model.certs) {
      const k = KINDS[c.kind] || KINDS.server;
      const st = status.get(c.id);
      const tags = [
        model.trusted.includes(c.id) && h('span.pk-tag.trust', '★ trusted'),
        model.sent.includes(c.id) && h('span.pk-tag.sent', '⇢ sent'),
        model.leaf === c.id && h('span.pk-tag.leaf', '◎ presented'),
        c.forged && h('span.pk-tag.bad', 'forged'),
      ];
      const node = h(`div.pk-node.k-${c.kind}${selected === c.id ? '.sel' : ''}${st ? (st.bad ? '.bad' : '.ok') : ''}`, {
        style: { left: c.x + 'px', top: c.y + 'px' },
        onpointerdown: e => {
          if (e.target.closest('.pk-port')) return;
          e.preventDefault();
          selected = c.id;
          const sx = e.clientX - c.x, sy = e.clientY - c.y;
          node.setPointerCapture(e.pointerId);
          node.classList.add('dragging');
          surface.querySelectorAll('.pk-node.sel').forEach(n => n.classList.remove('sel'));
          node.classList.add('sel');
          inspectorSlot.replaceChildren(inspector());
          const move = ev => { c.x = Math.max(0, ev.clientX - sx); c.y = Math.max(0, ev.clientY - sy); node.style.left = c.x + 'px'; node.style.top = c.y + 'px'; drawWires(); };
          const up = () => { node.removeEventListener('pointermove', move); node.classList.remove('dragging'); persist(); };
          node.addEventListener('pointermove', move);
          node.addEventListener('pointerup', up, { once: true });
        },
      },
        // Drawn as a certificate: a band in the kind's colour, a seal, then the fields a certificate viewer shows.
        h('div.pk-node-head', h('span.pk-kind', k.label), h('span.pk-seal', { html: SEAL, 'aria-hidden': 'true', title: 'X.509 certificate' })),
        h('div.pk-name', { title: c.name }, c.name),
        h('div.pk-fv', h('span.pk-fl', 'issued by '), c.issuer && c.issuer !== c.id ? (byId(c.issuer)?.name || '?') : 'itself (self-signed)'),
        h('div.pk-dates', `${c.notBefore} → ${c.notAfter}`),
        h('div.pk-tags', tags),
        c.issuer !== c.id && h('button.pk-port', {
          type: 'button', title: 'Drag onto the block that signs this one',
          onpointerdown: e => {
            e.preventDefault(); e.stopPropagation();
            const origin = surface.getBoundingClientRect();
            const line = document.createElementNS(svg.namespaceURI, 'line');
            line.setAttribute('class', 'linking');
            line.setAttribute('x1', c.x + 95); line.setAttribute('y1', c.y);
            svg.append(line);
            linking = { from: c, line };
            const move = ev => { line.setAttribute('x2', ev.clientX - origin.left + surface.scrollLeft); line.setAttribute('y2', ev.clientY - origin.top + surface.scrollTop); };
            const up = ev => {
              document.removeEventListener('pointermove', move);
              const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pk-node');
              const to = target && model.certs.find(x => x.id === target.dataset.id);
              line.remove(); linking = null;
              if (to && to.id !== c.id) update(() => { c.issuer = to.id; });
              else if (!to) update(() => { c.issuer = null; });   // dropped on empty board: make it self-signed
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up, { once: true });
          },
        }, '⬆'));
      node.dataset.id = c.id;
      surface.append(node);
    }
    requestAnimationFrame(drawWires);

    const palette = h('div.pk-palette',
      h('div.muted.small', 'Add a certificate'),
      Object.entries(KINDS).map(([kind, k]) => h(`button.pk-brick.k-${kind}`, {
        type: 'button', title: `Add a ${k.label}`,
        onclick: () => update(() => {
          const ys = model.certs.map(c => c.y);
          const n = model.certs.length;
          const c = cert(kind, kind === 'root' ? 'New Root CA' : kind === 'inter' ? 'New Issuing CA' : kind === 'server' ? 'portal.corp.example' : 'alice', null,
            40 + (n % 3) * 240, 40 + Math.floor(n / 3) * 150);
          if (kind === 'server') c.san = ['portal.corp.example'];
          if (!ys.length) c.y = 40;
          model.certs.push(c);
          selected = c.id;
          if (kind === 'server' && !byId(model.leaf)) model.leaf = c.id;
        }),
      }, h('span.pk-pal-doc', { html: DOC, 'aria-hidden': 'true' }), k.label)),
      h('p.muted.small.pk-howto', 'Drag a certificate to move it. Drag its ⬆ handle onto the certificate that signs it. Drop the handle on empty board to make it self-signed.'));

    return h('div.pk-board-wrap', palette, surface);
  }

  // ------------------------------------------------------------ form mode

  function form() {
    return h('div.pk-form', model.certs.map(c => h(`div.pk-form-row${selected === c.id ? '.sel' : ''}`, { onclick: () => { selected = c.id; inspectorSlot.replaceChildren(inspector()); } },
      h('b', `${KINDS[c.kind]?.icon || ''} ${c.name}`),
      h('span.muted.small', c.issuer && c.issuer !== c.id ? `signed by ${byId(c.issuer)?.name || '?'}` : 'self-signed'),
      h('span.muted.small', `${c.notBefore} → ${c.notAfter}`))),
      !model.certs.length && h('p.muted', 'No certificates yet. Switch to the board to add certificates, or start a challenge.'));
  }

  // ------------------------------------------------------------ inspector: edit one certificate

  function inspector() {
    const c = byId(selected);
    if (!c) return h('div.pk-inspect.muted', 'Select a block to edit it.');
    const field = (label, control, help) => h('label.pk-field', h('span', label), control, help && h('span.muted.small', help));
    const text = (key, opts = {}) => h('input', { value: c[key] ?? '', ...opts, onchange: e => update(() => { c[key] = e.target.value; }) });
    const view = result?.certs?.find(v => v.id === c.id);
    return h('div.pk-inspect',
      h('div.pk-inspect-head', h('b', `${KINDS[c.kind]?.icon} ${KINDS[c.kind]?.label}`),
        h('button.btn.ghost.small', { type: 'button', onclick: () => update(() => {
          model.certs = model.certs.filter(x => x.id !== c.id);
          model.certs.forEach(x => { if (x.issuer === c.id) x.issuer = null; });
          model.trusted = model.trusted.filter(x => x !== c.id); model.sent = model.sent.filter(x => x !== c.id);
          if (model.leaf === c.id) model.leaf = null;
          selected = null;
        }) }, 'Delete')),
      field('Subject (CN)', text('name')),
      field('Signed by', h('select', { onchange: e => update(() => { c.issuer = e.target.value || null; }) },
        h('option', { value: '', selected: !c.issuer }, '— itself (self-signed) —'),
        issuable(c).map(o => h('option', { value: o.id, selected: c.issuer === o.id }, o.name)))),
      h('div.pk-two', field('Not before', text('notBefore', { type: 'date' })), field('Not after', text('notAfter', { type: 'date' }))),
      field('Subject Alternative Names', h('input', { value: (c.san || []).join(', '), placeholder: 'shop.example, *.shop.example',
        onchange: e => update(() => { c.san = e.target.value.split(',').map(s => s.trim()).filter(Boolean); }) }), 'The names clients check. Comma separated.'),
      h('div.pk-two',
        field('CA certificate', h('input', { type: 'checkbox', checked: c.ca, onchange: e => update(() => { c.ca = e.target.checked; }) }), 'Basic Constraints CA:TRUE'),
        field('Purpose (EKU)', h('select', { onchange: e => update(() => { c.eku = e.target.value; }) },
          [['', 'any'], ['server', 'TLS server'], ['client', 'TLS client']].map(([v, l]) => h('option', { value: v, selected: (c.eku || '') === v }, l))))),
      h('div.pk-two',
        field('Trusted by the client', h('input', { type: 'checkbox', checked: model.trusted.includes(c.id), onchange: e => update(() => { model.trusted = e.target.checked ? [...model.trusted, c.id] : model.trusted.filter(x => x !== c.id); }) })),
        field('Sent by the server', h('input', { type: 'checkbox', checked: model.sent.includes(c.id), onchange: e => update(() => { model.sent = e.target.checked ? [...model.sent, c.id] : model.sent.filter(x => x !== c.id); }) }))),
      field('Forged signature', h('input', { type: 'checkbox', checked: !!c.forged, onchange: e => update(() => { c.forged = e.target.checked; }) }), 'Signed by an impostor key that copies the issuer\'s name.'),
      h('button.btn.ghost', { type: 'button', disabled: model.leaf === c.id, onclick: () => update(() => { model.leaf = c.id; }) },
        model.leaf === c.id ? '◎ This is the certificate the server presents' : 'Make the server present this one'),
      view && h('details.pk-decoded', h('summary', 'Decoded (like openssl x509 -text)'), h('pre.code.plain', view.text)),
      view && h('details.pk-decoded', h('summary', 'PEM'), h('pre.code.plain', view.pem)));
  }

  // ------------------------------------------------------------ the verdict

  function verdict() {
    if (!result) return h('div.pk-verdict.muted', model.certs.length ? 'Choose which certificate the server presents.' : 'Add some certificates.');
    if (result.error) return h('div.pk-verdict.bad', h('b', 'Cannot build this'), h('p', result.error));
    const v = result.validation;
    const role = (e, i) => {
      const c = byId(e.id);
      if (i === 0) return 'presented by the server';
      if (c && (!c.issuer || c.issuer === c.id)) return model.trusted.includes(c.id) ? 'root · in the trust store' : 'root · not trusted';
      return 'intermediate';
    };
    return h('div.pk-verdict',
      h('div.pk-verdict-head',
        h(`span.pk-status.${v.valid ? 'ok' : 'bad'}`, v.valid ? 'Valid' : 'Fails'),
        h('b', v.valid ? 'The connection would succeed.' : 'The connection would fail.'),
        h('span.muted.small', `${model.host || '(no host)'} · checked on ${model.at}`)),
      h('ol.pk-chain', v.chain.map((e, i) => h(`li.pk-link${e.problems.length ? '.bad' : '.ok'}`,
        h('span.pk-mark', e.problems.length ? '✕' : '✓'),
        h('div.pk-link-body', h('span.pk-role', role(e, i)), h('b', e.subject),
          i < v.chain.length - 1 && h('span.pk-signed', 'signed by ↓')),
        e.problems.map(p => h('div.pk-link-why', p))))),
      v.problems.length > 0 && h('ul.pk-problems', v.problems.map(p => h('li', p))),
      v.notes.length > 0 && h('ul.pk-notes', v.notes.map(n => h('li.muted.small', n))),
      result.extraHint && h('p.pk-extra', '✓ Valid, but the challenge wants more: ' + result.extraHint));
  }

  function paintResult() { verdictSlot.replaceChildren(verdict()); }

  // ------------------------------------------------------------ layout

  const inspectorSlot = h('div');
  const verdictSlot = h('div');

  function render() {
    const solvedCount = CHALLENGES.filter(c => saved.solved[c.id]).length;
    container.replaceChildren(
      h('div.pk-top',
        h('div.pk-challenges', CHALLENGES.map(c => h(`button.pk-ch${c.id === challenge.id ? '.active' : ''}${saved.solved[c.id] ? '.solved' : ''}`, {
          type: 'button',
          onclick: () => { challenge = c; model = c.setup(healthy()); selected = model.leaf; result = null; persist(); render(); schedule(); },
        }, saved.solved[c.id] ? '✓ ' : '', c.title, c.xp ? h('span.muted.small', ` +${c.xp}`) : ''))),
        h('div.muted.small', `${solvedCount} / ${CHALLENGES.filter(c => c.xp).length} solved`)),
      h('div.pk-brief', h('div', { html: md(challenge.brief) }),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { model = challenge.setup(healthy()); selected = model.leaf; persist(); render(); schedule(); } }, 'Reset scenario')),
      h('div.pk-client',
        h('label', 'Client connects to ', h('input', { value: model.host || '', onchange: e => update(() => { model.host = e.target.value; }) })),
        h('label', 'on ', h('input', { type: 'date', value: model.at, onchange: e => update(() => { model.at = e.target.value; }) })),
        h('div.pk-viewtoggle',
          ['board', 'form'].map(v => h(`button.tab${saved.view === v ? '.active' : ''}`, { type: 'button', onclick: () => { saved.view = v; persist(); render(); } },
            v === 'board' ? '⊞ Visual board' : '☰ Form')))),
      h('div.pk-main',
        h('div.pk-left', saved.view === 'form' ? form() : board()),
        h('div.pk-right', inspectorSlot, verdictSlot)));
    inspectorSlot.replaceChildren(inspector());
    paintResult();
  }

  render();
  schedule();
  return () => clearTimeout(timer);
}
