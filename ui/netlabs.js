// Live network labs: real Docker networks (hosts, routers, servers) you work on from an in-page
// terminal. The server (NetLabs.cs) starts and stops labs, checks tasks by running commands inside
// the containers, and bridges each terminal tab to `docker exec` over a WebSocket.
import { h, api, md, ask, loader } from './util.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) el.append(k);
  return el;
};

/** Lab text is shell, not C#: render every fenced block as plain text. */
const shellMd = text => {
  let open = false;
  return md(String(text || '').split('\n').map(l => {
    if (!/^\s*```/.test(l)) return l;
    open = !open;
    return open ? '```text' : '```';
  }).join('\n'));
};

/** Entry point from the router. Returns a cleanup function. */
export function netLabs(page, id, kind = 'net') {
  const cleanups = [];
  const leave = () => cleanups.splice(0).forEach(f => { try { f(); } catch { } });
  if (id) labPage(page, id, cleanups, kind); else listPage(page, cleanups, kind);
  return leave;
}

// ---------------------------------------------------------------- docker status banner

function dockerBanner(info, refresh) {
  const d = info.docker;
  if (!d.ok) {
    return h('div.nl-banner.bad',
      h('b', d.state === 'missing' ? 'Docker is not installed' : 'Docker is not running'),
      h('p', d.message),
      h('p.muted.small', 'These labs run each host as a small Linux container, so they need Docker Desktop. Everything else in code-dojo works without it.'),
      h('button.btn.primary', { type: 'button', onclick: () => refresh(true) }, 'Retry'));
  }
  if (!info.image) {
    const b = info.build;
    const building = b.state === 'building';
    return h('div.nl-banner.warn',
      h('b', building ? 'Building the lab tools image...' : b.state === 'failed' ? 'The tools image build failed' : 'One-time setup'),
      h('p', building ? 'This takes a few minutes the first time (it downloads Debian and the network tools). You can leave this page open.'
        : 'Every lab node uses one shared image with the networking and security tools. Build it once.'),
      !building && h('button.btn.primary', { type: 'button', onclick: async () => { await api('netlabs/setup', {}); refresh(); } },
        b.state === 'failed' ? 'Try the build again' : 'Build the tools image'),
      b.log?.length > 0 && h('pre.nl-log', b.log.join('\n')));
  }
  return null;
}

// ---------------------------------------------------------------- list

// Linux missions share the engine with the network labs; the list pages show one family each.
const LINUX = 'Linux missions';
const isLinux = l => (l.module || '').startsWith(LINUX);

function listPage(page, cleanups, kind) {
  const linux = kind === 'linux';
  const body = h('div', h('p.muted', 'Asking Docker...'));
  page('labs',
    h('a.back-link', { href: '#/labs' }, '← All labs'),
    linux
      ? h('section.hero', h('div', h('div.eyebrow', 'Lab · Linux'), h('h1', 'Linux missions'),
        h('p.muted', 'Short, story-driven missions on a real Linux server. You are the new sysadmin at Byte & Biscuit: find things, fix things, and work your way from Survival to Boss.')))
      : h('section.hero', h('div', h('div.eyebrow', 'Lab · Networking & security'), h('h1', 'Live network labs'),
        h('p.muted', 'Real networks of Linux hosts on your machine. Open a terminal on any host, break things, fix them, and let the lab check your work.'))),
    body);
  let timer = null;
  cleanups.push(() => clearTimeout(timer));
  const refresh = async (fresh = false) => {
    clearTimeout(timer);
    let info;
    try { info = await api('netlabs' + (fresh ? '?fresh=true' : '')); }
    catch (e) { body.replaceChildren(h('p.bad', String(e.message))); return; }
    const running = info.labs.filter(l => l.running);
    const labs = info.labs.filter(l => isLinux(l) === linux);
    let module = null;
    const cards = [];
    for (const l of labs) {
      if (l.module !== module) { module = l.module; cards.push(h('h2.section-title', linux ? module.replace(`${LINUX} · `, '') : module)); }
      cards.push(h('a.nl-card', { href: `#/labs/${kind}/${l.id}` },
        h('div.nl-num', l.num),
        h('div.nl-card-body',
          h('h3', l.title, l.running && h('span.nl-pill.on', 'running')),
          h('p.muted.small', l.summary),
          h('div.topic-meta', l.minutes && h('span', `about ${l.minutes} min`), h('span', `${l.done}/${l.total} tasks`)),
          h('div.bar', h('div.bar-fill', { style: { width: `${(l.done / Math.max(1, l.total)) * 100}%` } })))));
    }
    const total = labs.reduce((a, l) => a + l.total, 0), done = labs.reduce((a, l) => a + l.done, 0);
    body.replaceChildren(
      dockerBanner(info, refresh) || '',
      h('div.nl-summary', h('span', `${done}/${total} tasks done across ${labs.length} ${linux ? 'missions' : 'labs'}`),
        running.length > 0 && h('button.btn.ghost', { type: 'button', onclick: async e => {
          e.currentTarget.disabled = true; e.currentTarget.textContent = 'Stopping...';
          await api('netlabs/stop-all', {}); refresh();
        } }, `Stop ${running.length} running lab${running.length > 1 ? 's' : ''}`)),
      ...cards);
    if (!info.docker.ok || info.build.state === 'building') timer = setTimeout(() => refresh(!info.docker.ok), info.docker.ok ? 2000 : 5000);
  };
  refresh();
}

// ---------------------------------------------------------------- topology

function topology(topo, running, onPick) {
  const nets = topo.networks.length ? topo.networks : [{ name: 'network', subnet: null }];
  const idx = Object.fromEntries(nets.map((n, i) => [n.name, i]));
  const rows = [];   // each row: { kind: 'nodes', items } or { kind: 'bus', net }
  const placed = new Set();
  const single = i => topo.nodes.filter(n => n.addrs.length === 1 && idx[n.addrs[0].net] === i);
  const multiFrom = i => topo.nodes.filter(n => n.addrs.length > 1 && Math.min(...n.addrs.map(a => idx[a.net] ?? 0)) === i);
  const loose = topo.nodes.filter(n => n.addrs.length === 0 || n.addrs.every(a => idx[a.net] === undefined));
  nets.forEach((net, i) => {
    if (i === 0) rows.push({ kind: 'nodes', items: [...loose, ...single(0)] });
    rows.push({ kind: 'bus', net, i });
    const below = [...(i > 0 ? single(i) : []), ...multiFrom(i)];
    if (below.length) rows.push({ kind: 'nodes', items: below });
  });
  const W = 760, BOX_W = 150, BOX_H = 52, ROW_H = 92, BUS_H = 46;
  let y = 16;
  const busY = {}, nodePos = [];
  for (const r of rows) {
    if (r.kind === 'bus') { busY[r.i] = y + BUS_H / 2; y += BUS_H; continue; }
    if (!r.items.length) continue;
    const gap = W / (r.items.length + 1);
    r.items.forEach((n, k) => { nodePos.push({ n, x: gap * (k + 1), y: y + (ROW_H - BOX_H) / 2 }); placed.add(n.name); });
    y += ROW_H;
  }
  const svg = s('svg', { viewBox: `0 0 ${W} ${y + 10}`, class: 'nl-topo', role: 'img', 'aria-label': 'Lab network diagram' });
  // wires first, so boxes sit on top
  for (const p of nodePos) for (const a of p.n.addrs) {
    const by = busY[idx[a.net]];
    if (by === undefined) continue;
    const from = by < p.y ? p.y : p.y + BOX_H;
    svg.append(s('line', { x1: p.x, y1: from, x2: p.x, y2: by, class: 'nl-wire' }));
    const ly = (from + by) / 2 + 4;
    svg.append(s('text', { x: p.x + 6, y: ly, class: 'nl-ip' }, a.ip));
  }
  nets.forEach((net, i) => {
    const by = busY[i];
    svg.append(s('line', { x1: 20, y1: by, x2: W - 20, y2: by, class: 'nl-bus' }));
    svg.append(s('text', { x: 24, y: by - 7, class: 'nl-net' }, `${net.name}${net.subnet ? '  ' + net.subnet : ''}`));
  });
  for (const p of nodePos) {
    const g = s('g', { class: `nl-host${running ? ' live' : ''}`, transform: `translate(${p.x - BOX_W / 2},${p.y})`, tabindex: 0 });
    g.append(s('title', {}, `${p.n.name}: ${p.n.desc}${running ? ' (click to open a terminal)' : ''}`));
    g.append(s('rect', { width: BOX_W, height: BOX_H, rx: 10 }));
    g.append(s('text', { x: BOX_W / 2, y: 22, class: 'nl-host-name' }, p.n.name));
    g.append(s('text', { x: BOX_W / 2, y: 40, class: 'nl-host-desc' }, p.n.desc.length > 24 ? p.n.desc.slice(0, 23) + '…' : p.n.desc));
    g.addEventListener('click', () => onPick(p.n.name));
    g.addEventListener('keydown', e => { if (e.key === 'Enter') onPick(p.n.name); });
    svg.append(g);
  }
  return svg;
}

// ---------------------------------------------------------------- terminal

const SGR = { 30: '#5c6370', 31: 'var(--bad)', 32: 'var(--good)', 33: 'var(--warn)', 34: 'var(--info)', 35: '#c678dd', 36: '#56b6c2', 37: 'var(--text)',
  90: '#7f848e', 91: '#ff7b8b', 92: '#4fe0a8', 93: '#ffd166', 94: '#6cc5ff', 95: '#d7a0f0', 96: '#7fdbe6', 97: '#ffffff' };

/**
 * A small line-mode terminal: an output area that understands \r, \b and basic SGR colours
 * (other escape sequences are dropped) and an input line with history. The container runs bash
 * under a pty, so the shell echoes what you send and Ctrl+C really interrupts.
 */
function terminal(labId, node, { onStatus } = {}) {
  const out = h('pre.nl-term-out');
  const input = h('input.nl-term-in', { type: 'text', spellcheck: false, autocomplete: 'off', placeholder: `command on ${node}, Enter to run` });
  const el = h('div.nl-term', { onclick: e => { if (e.target === out && !getSelection().toString()) input.focus(); } }, out,
    h('div.nl-term-bar', h('span.nl-term-prompt', '›'), input,
      h('button.btn.ghost.small', { type: 'button', title: 'Send Ctrl+C (interrupt)', onclick: () => send('\x03') }, 'Ctrl+C'),
      h('button.btn.ghost.small', { type: 'button', title: 'Clear the screen', onclick: () => { out.replaceChildren(); line = newLine(); } }, 'Clear'),
      h('span.nl-term-sep'),
      h('button.btn.ghost.small', { type: 'button', title: 'Smaller text', onclick: () => termSize(-1) }, 'A−'),
      h('button.btn.ghost.small', { type: 'button', title: 'Bigger text', onclick: () => termSize(+1) }, 'A+'),
      h('button.btn.ghost.small', { type: 'button', title: 'Fill the screen with this terminal (Esc to come back)', onclick: () => toggleMax() }, '⛶')));
  // Terminal text size is remembered across labs and visits.
  function termSize(delta) {
    const now = Number(localStorage.getItem('termSize') || 16);
    const next = Math.max(12, Math.min(26, now + delta * 2));
    localStorage.setItem('termSize', next);
    document.documentElement.style.setProperty('--term-size', next + 'px');
  }
  function toggleMax(force) {
    const on = force ?? !el.classList.contains('max');
    el.classList.toggle('max', on);
    document.body.classList.toggle('term-max', on);
    if (on) input.focus();
  }
  el.addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('max')) toggleMax(false); });
  const history = [];
  let hpos = 0, ws = null, closed = false, style = {}, line = null, pending = '';

  function newLine() { const d = h('span.nl-line'); out.append(d, '\n'); return d; }
  line = newLine();
  const span = () => {
    const last = line.lastChild;
    const key = JSON.stringify(style);
    if (last && last.dataset.k === key) return last;
    const sp = h('span', { dataset: { k: key } });
    if (style.fg) sp.style.color = style.fg;
    if (style.bold) sp.style.fontWeight = '700';
    line.append(sp);
    return sp;
  };
  function sgr(params) {
    const ps = params === '' ? [0] : params.split(';').map(Number);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === 0) style = {};
      else if (p === 1) style = { ...style, bold: true };
      else if (p === 22) style = { ...style, bold: false };
      else if (p === 39) style = { ...style, fg: null };
      else if (SGR[p]) style = { ...style, fg: SGR[p] };
      else if (p === 38 && ps[i + 1] === 5) { const c = ps[i + 2]; style = { ...style, fg: c < 16 ? SGR[c < 8 ? 30 + c : 82 + c] : null }; i += 2; }
      else if (p === 38 && ps[i + 1] === 2) { style = { ...style, fg: `rgb(${ps[i + 2]},${ps[i + 3]},${ps[i + 4]})` }; i += 4; }
    }
  }
  function write(text) {
    text = pending + text;
    pending = '';
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    let i = 0, buf = '';
    const flush = () => { if (buf) { span().textContent += buf; buf = ''; } };
    let cr = false;
    while (i < text.length) {
      const c = text[i];
      if (c === '\x1b') {
        const rest = text.slice(i);
        const csi = rest.match(/^\x1b\[([0-9;?]*)([ -\/]*)([@-~])/);
        const osc = rest.match(/^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/);
        if (csi) { flush(); if (csi[3] === 'm' && !csi[1].startsWith('?')) sgr(csi[1]); else if (csi[3] === 'K') { /* erase to end of line: nothing to the right in line mode */ } i += csi[0].length; continue; }
        if (osc) { i += osc[0].length; continue; }
        if (/^\x1b[()][0-9A-Za-z]/.test(rest)) { i += 3; continue; }
        if (rest.length < 3 || (/^\x1b[\[\]]/.test(rest) && rest.length < 64)) { pending = rest; break; }   // split sequence: wait for more
        i += 2; continue;
      }
      if (c === '\r') { flush(); cr = true; i++; continue; }
      if (c === '\n') { flush(); line = newLine(); cr = false; i++; continue; }
      if (cr) { line.replaceChildren(); cr = false; }   // a lone \r: the line is being redrawn
      if (c === '\b') { flush(); const t = line.lastChild; if (t) { t.textContent = t.textContent.slice(0, -1); if (!t.textContent) t.remove(); } i++; continue; }
      if (c === '\x07' || (c < ' ' && c !== '\t')) { i++; continue; }
      buf += c; i++;
    }
    flush();
    while (out.childNodes.length > 6000) { out.firstChild.remove(); out.firstChild?.remove(); }
    if (stick) out.scrollTop = out.scrollHeight;
  }
  function send(data) { if (ws?.readyState === 1) ws.send(data); }
  function connect() {
    closed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/netlabs/${encodeURIComponent(labId)}/term/${encodeURIComponent(node)}`);
    onStatus?.('connecting');
    ws.onopen = () => { onStatus?.('open'); input.focus(); };
    ws.onmessage = e => write(String(e.data));
    ws.onclose = () => { onStatus?.('closed'); if (!closed) write('\r\n[disconnected: press Enter to reconnect]\r\n'); ws = null; };
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!ws) { connect(); return; }
      const cmd = input.value;
      if (cmd.trim() && history[history.length - 1] !== cmd) history.push(cmd);
      hpos = history.length;
      send(cmd + '\r');
      input.value = '';
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hpos > 0) input.value = history[--hpos];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hpos < history.length - 1) input.value = history[++hpos]; else { hpos = history.length; input.value = ''; }
    } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && input.selectionStart === input.selectionEnd && !getSelection().toString()) {
      e.preventDefault(); send('\x03'); input.value = '';
    } else if (e.ctrlKey && (e.key === 'd' || e.key === 'D') && !input.value) {
      e.preventDefault(); send('\x04');
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault(); out.replaceChildren(); line = newLine();
    } else if (e.key === 'Tab') {
      e.preventDefault();   // keep focus here; completion needs a full terminal
    }
  });
  connect();
  return {
    el, node,
    focus: () => input.focus(),
    type: text => { input.value = text; input.focus(); },
    close: () => { closed = true; ws?.close(); },
    reconnect: () => { closed = true; ws?.close(); out.replaceChildren(); line = newLine(); connect(); },
  };
}

// ---------------------------------------------------------------- one lab

function labPage(page, id, cleanups, kind) {
  const root = h('div.nl-lab', loader('the lab'));
  const back = kind === 'linux' ? ['#/labs/linux', 'All Linux missions'] : ['#/labs/net', 'All network labs'];
  page('labs', h('a.back-link', { href: back[0] }, '← ' + back[1]), root);
  const terms = new Map();   // node -> terminal
  let active = null, lab = null, busy = false;
  cleanups.push(() => terms.forEach(t => t.close()));

  const termTabs = h('div.nl-tabs');
  const termHost = h('div.nl-term-host');
  const status = h('div.nl-status');
  const topoHost = h('div.nl-topo-host');
  const tasksHost = h('div.nl-tasks');
  const controls = h('div.nl-controls');

  function openTerm(node) {
    if (!lab?.running) { flash('Start the lab first, then open a terminal on any host.'); return; }
    if (!terms.has(node)) terms.set(node, terminal(id, node, { onStatus: () => renderTabs() }));
    active = node;
    renderTabs();
    termHost.replaceChildren(terms.get(node).el);
    terms.get(node).focus();
    termHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function closeTerm(node) {
    terms.get(node)?.close();
    terms.delete(node);
    if (active === node) { active = terms.keys().next().value ?? null; termHost.replaceChildren(active ? terms.get(active).el : emptyTerm()); }
    renderTabs();
  }
  const emptyTerm = () => h('div.nl-term-empty.muted', lab?.running ? 'Pick a host above (or click one in the diagram) to open a terminal on it.' : 'Start the lab to get terminals on its hosts.');
  function renderTabs() {
    const nodes = lab.topology.nodes.map(n => n.name);
    termTabs.replaceChildren(...nodes.map(n => h(`button.nl-tab${n === active ? '.active' : ''}${terms.has(n) ? '.open' : ''}`,
      { type: 'button', disabled: !lab.running, onclick: () => openTerm(n), title: lab.topology.nodes.find(x => x.name === n)?.desc },
      n, terms.has(n) && h('span.nl-tab-x', { title: 'Close this terminal', onclick: e => { e.stopPropagation(); closeTerm(n); } }, '×'))));
  }
  function flash(msg, kind = 'warn') {
    status.replaceChildren(h(`div.nl-flash.${kind}`, msg));
  }

  async function act(action, label) {
    if (busy) return;
    busy = true;
    renderControls(label);
    flash(label + '...', 'info');
    terms.forEach(t => t.close()); terms.clear(); active = null; termHost.replaceChildren();
    try {
      const r = await api(`netlabs/${id}/${action}`, {});
      if (r.ok) status.replaceChildren(); else flash(r.msg, 'bad');
    } catch (e) { flash(e.message, 'bad'); }
    busy = false;
    await load();
    if (action === 'start' && lab.running) openTerm(lab.defaultNode);
  }
  function renderControls(working) {
    controls.replaceChildren(...[
      h(`span.nl-pill${lab.running ? '.on' : ''}`, working || (lab.running ? 'running' : 'stopped')),
      !lab.running && h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => act('start', 'Starting the lab') }, 'Start lab'),
      lab.running && h('button.btn.ghost', { type: 'button', disabled: busy, title: 'Throw everything away and start from scratch (new random values)',
        onclick: async () => { if (await ask('Restart from scratch? Every change you made inside the lab is lost, and random values (flags, ports) change.', { ok: 'Restart' })) act('start', 'Restarting'); } }, 'Restart'),
      lab.running && h('button.btn.ghost', { type: 'button', disabled: busy, onclick: () => act('stop', 'Stopping') }, 'Stop lab')].filter(Boolean));
  }

  function taskCard(t, i) {
    const result = h('div.nl-result');
    const hints = h('div.nl-hints');
    const sol = h('div.nl-sol');
    let shown = 0;
    const answer = t.type === 'answer' && h('input.nl-answer', { type: 'text', placeholder: 'your answer', spellcheck: false,
      onkeydown: e => { if (e.key === 'Enter') check(); } });
    async function check() {
      result.replaceChildren(h('span.muted', 'Checking...'));
      const r = await api(`netlabs/${id}/check`, { task: t.id, value: answer ? answer.value : null });
      result.replaceChildren(h(`span.${r.ok ? 'good' : 'bad'}`, r.ok ? '✓ ' + r.msg : r.msg));
      if (r.ok && !t.done) { t.done = true; card.classList.add('done'); badge.textContent = '✓'; updateProgress(); }
    }
    const badge = h('div.nl-task-num', t.done ? '✓' : i + 1);
    const card = h(`div.nl-task${t.done ? '.done' : ''}`,
      h('div.nl-task-head', badge, h('div', h('div.eyebrow', t.type === 'state' ? 'Do it' : 'Answer'), h('h3', t.title))),
      h('div.nl-task-text', { html: shellMd(t.text) }),
      h('div.nl-task-actions',
        answer,
        h('button.btn.primary.small', { type: 'button', onclick: check }, t.type === 'state' ? 'Check' : 'Submit'),
        t.hints > 0 && h('button.btn.ghost.small', { type: 'button', onclick: async e => {
          shown = Math.min(t.hints, shown + 1);
          const r = await api(`netlabs/${id}/hint`, { task: t.id, n: shown });
          hints.replaceChildren(...r.hints.map((x, k) => h('div.nl-hint', h('b', `Hint ${k + 1}/${r.total}: `), h('span', { html: shellMd(x) }))));
          if (shown >= t.hints) e.currentTarget.disabled = true;
          else e.currentTarget.textContent = `Hint (${shown}/${t.hints})`;
        } }, 'Hint'),
        t.hasSolution && h('button.btn.ghost.small', { type: 'button', onclick: async () => {
          if (!await ask('Show the solution? Try the hints first: you learn far more by finding it yourself.', { ok: 'Show it' })) return;
          const r = await api(`netlabs/${id}/solution`, { task: t.id });
          sol.replaceChildren(...[h('div.eyebrow', 'Solution'),
            r.note && h('div', { html: shellMd(r.note) }),
            r.answer && h('p', 'Answer: ', h('code', r.answer)),
            ...r.steps.map(st => h('div.nl-step', h('span.muted.small', `on ${st.node}:`), h('pre', h('code', st.cmd)),
              lab.running && h('button.btn.ghost.small', { type: 'button', title: 'Put this command in that host\'s terminal (you still press Enter)',
                onclick: () => { openTerm(st.node); terms.get(st.node)?.type(st.cmd); } }, `Type it on ${st.node}`)))].filter(Boolean));
        } }, 'Solution')),
      result, hints, sol);
    return card;
  }
  const progress = h('div.nl-progress');
  function updateProgress() {
    const done = lab.tasks.filter(t => t.done).length;
    progress.replaceChildren(h('span', `${done}/${lab.tasks.length} tasks`),
      h('div.bar', h('div.bar-fill', { style: { width: `${(done / Math.max(1, lab.tasks.length)) * 100}%` } })),
      done > 0 && h('button.btn.ghost.small', { type: 'button', onclick: async () => {
        if (!await ask('Forget your progress on this lab?', { ok: 'Reset', danger: true })) return;
        await api(`netlabs/${id}/reset`, {}); load();
      } }, 'Reset progress'));
  }

  let first = true;
  async function load() {
    let info, overview;
    try { [info, overview] = await Promise.all([api(`netlabs/${id}`), api('netlabs')]); }
    catch (e) { root.replaceChildren(h('div.empty', h('h2', 'No such lab'), h('a.btn.primary', { href: back[0] }, back[1]))); return; }
    lab = info;
    renderControls();
    topoHost.replaceChildren(topology(lab.topology, lab.running, openTerm));
    tasksHost.replaceChildren(...lab.tasks.map(taskCard));
    updateProgress();
    renderTabs();
    if (!active) termHost.replaceChildren(emptyTerm());
    const banner = dockerBanner(overview, () => load());
    if (first) {
      first = false;
      root.replaceChildren(
        h('div.track-head', h('div', h('div.eyebrow', `Lab ${lab.num} · ${lab.module || ''}`), h('h2.track-title', lab.title), h('p.muted', lab.summary))),
        h('div.nl-bannerslot'),
        h('div.nl-grid',
          h('div.nl-left',
            h('details.nl-lesson', { open: true }, h('summary', 'Lesson'), h('div.lesson-md', { html: shellMd(lab.lesson) })),
            h('h3.section-title', 'Tasks'), progress, tasksHost),
          h('div.nl-right',
            h('div.nl-sticky',
              h('div.nl-row', controls),
              status,
              h('div.nl-card-box', h('div.eyebrow', kind === 'linux' ? 'Machines' : 'Network'), topoHost),
              h('div.nl-card-box', h('div.eyebrow', 'Terminals'), termTabs, termHost)))));
    }
    root.querySelector('.nl-bannerslot')?.replaceChildren(banner || '');
    clearTimeout(poll);
    if (banner) poll = setTimeout(watchBanner, 4000);
  }
  // While Docker is down or the image is building, refresh only the banner; reload the lab once it clears.
  async function watchBanner() {
    try {
      const o = await api('netlabs?fresh=true');
      const b = dockerBanner(o, () => load());
      if (!b) return load();
      root.querySelector('.nl-bannerslot')?.replaceChildren(b);
    } catch { }
    poll = setTimeout(watchBanner, 4000);
  }
  let poll = null;
  cleanups.push(() => clearTimeout(poll));
  load();
}
