// A reusable topology board: devices drawn like a network diagram (a laptop, a switch with its port sockets,
// a router, a server, a database...) that you drag around, real ports whose cables you drag onto another
// device to wire them, a palette to add devices, selection with an inspector slot, zoom and pan
// for big diagrams, Delete to remove, an optional form view of the same model, and an animation helper
// that sends a token along a path of wires (to show packets or requests flowing).
//
// The board does not own the model. The lab passes getters and callbacks:
//   kinds        { kind: { label, icon, color, width?, art?, panel? } }   art: a devices.js drawing; panel: ports sit on the device face (a switch)
//   wireKinds    { kind: { label, color } }                 (optional)
//   blocks()     -> [{ id, kind, x, y, ... }]
//   wires()      -> [{ id, kind?, from: { block, port }, to: { block, port? } }]
//   ports(b)     -> [{ id, label, on?, title? }]             ports a wire can be dragged from
//   body(b)      -> Node | [Node]                           what is printed under the device
//   canConnect(fromBlock, portId, toBlock) -> bool          to highlight valid drop targets
//   connect(fromBlock, portId, toBlock, toPortId|null) -> bool|string   lab mutates its model; a string is an error to show
//   onDropEmpty(fromBlock, portId)                          a port dropped on empty board (e.g. unplug)
//   palette      [{ kind, label, title, add({ x, y }) -> block | null }]
//   inspector(sel) -> Node                                  sel = { type: 'block'|'wire', id } | null
//   onSelect(sel), onDelete(sel), onMove(block)
//   blockClass(b) -> 'ok bad fixed ...'   wireState(w) -> 'ok'|'bad'|'active'|''   wireLabel(w) -> string
//   form()       -> Node                                    enables the Board / Form toggle
//   view, onView(view)                                      'board' | 'form'
//   portSide     'bottom' (ports along the bottom, wires port to port) | 'right' (one output on the right, wires into the left side)
//   arrows       draw arrowheads at the target end
//   howto        a short hint under the palette
//   zones()      -> [{ id, label, members: [blockId], tone? }]   tinted, labelled areas (subnets, networks, clusters) drawn behind devices
import { h } from './util.js';
import { deviceSvg } from './devices.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
let boards = 0;

export function createBoard(opt) {
  const o = { portSide: 'bottom', grid: 20, width: 3000, height: 2000, wireKinds: {}, ...opt };
  const uid = 'bk' + (++boards);
  let zoom = 1, panX = 0, panY = 0;
  let sel = null;
  let view = o.view === 'form' && o.form ? 'form' : 'board';
  let epoch = 0;
  let flashMsg = null;
  const blockEls = new Map();
  const wirePaths = new Map();

  const zonesSvg = svgEl('svg', { class: 'bk-zones', width: o.width, height: o.height });
  const wiresSvg = svgEl('svg', { class: 'bk-wires', width: o.width, height: o.height });
  const tokensSvg = svgEl('svg', { class: 'bk-tokens', width: o.width, height: o.height });
  const world = h('div.bk-world', { style: { width: o.width + 'px', height: o.height + 'px' } });
  const message = h('div.bk-message', { hidden: true });
  const zoomLabel = h('span.bk-zoom-label', '100%');
  const surface = h('div.bk-surface', { tabindex: 0 }, world, message);
  const formSlot = h('div.bk-form', { hidden: true });
  const inspectorEl = h('div.bk-inspector');

  const blocks = () => o.blocks();
  const wires = () => o.wires();
  const blockById = id => blocks().find(b => b.id === id);

  // ------------------------------------------------------------ zoom and pan

  function applyTransform() {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    surface.style.backgroundPosition = `${panX}px ${panY}px`;
    surface.style.backgroundSize = `${22 * zoom}px ${22 * zoom}px`;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  }
  // The page itself may be CSS-zoomed (Profile > Text size): k converts viewport pixels to the surface's own pixels.
  const pageK = () => { const r = surface.getBoundingClientRect(); return { r, k: r.width && surface.offsetWidth ? r.width / surface.offsetWidth : 1 }; };
  function zoomTo(z, cx, cy) {
    cx ??= surface.clientWidth / 2; cy ??= surface.clientHeight / 2;
    const nz = Math.max(0.35, Math.min(2, z));
    panX = cx - (cx - panX) * (nz / zoom);
    panY = cy - (cy - panY) * (nz / zoom);
    zoom = nz;
    applyTransform();
  }
  function fit() {
    const list = blocks();
    if (!list.length) { zoom = 1; panX = panY = 0; applyTransform(); return; }
    const r = { width: surface.clientWidth, height: surface.clientHeight };
    if (!r.width) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of list) {
      const el = blockEls.get(b.id);
      const w = el?.offsetWidth || 200, hh = el?.offsetHeight || 120;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + w); y1 = Math.max(y1, b.y + hh);
    }
    const pad = 40;
    zoom = Math.max(0.35, Math.min(1.2, Math.min(r.width / (x1 - x0 + pad * 2), r.height / (y1 - y0 + pad * 2))));
    panX = (r.width - (x1 - x0) * zoom) / 2 - x0 * zoom;
    panY = (r.height - (y1 - y0) * zoom) / 2 - y0 * zoom;
    applyTransform();
  }
  const toWorld = (cx, cy) => {
    const { r, k } = pageK();
    return { x: ((cx - r.left) / k - panX) / zoom, y: ((cy - r.top) / k - panY) / zoom };
  };
  const snap = v => Math.max(0, Math.round(v / o.grid) * o.grid);

  surface.addEventListener('wheel', e => {
    if (view !== 'board') return;
    e.preventDefault();
    const { r, k } = pageK();
    zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), (e.clientX - r.left) / k, (e.clientY - r.top) / k);
  }, { passive: false });

  surface.addEventListener('pointerdown', e => {
    if (e.target.closest('.bk-block, .bk-hit, .bk-zoombar')) return;
    surface.focus({ preventScroll: true });
    const sx = e.clientX, sy = e.clientY, px = panX, py = panY, { k } = pageK();
    let moved = false;
    surface.setPointerCapture(e.pointerId);
    surface.classList.add('panning');
    const move = ev => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
      panX = px + (ev.clientX - sx) / k; panY = py + (ev.clientY - sy) / k; applyTransform();
    };
    const up = () => {
      surface.removeEventListener('pointermove', move);
      surface.classList.remove('panning');
      if (!moved) select(null);
    };
    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', up, { once: true });
  });

  surface.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); o.onDelete?.(sel); sel = null; render(); }
    else if (e.key === 'Escape') select(null);
    else if (e.key === '+' || e.key === '=') zoomTo(zoom * 1.15);
    else if (e.key === '-') zoomTo(zoom / 1.15);
    else if (e.key === '0') fit();
  });

  // ------------------------------------------------------------ geometry

  function anchor(blockId, portId, role) {
    const b = blockById(blockId), el = blockEls.get(blockId);
    if (!b || !el) return null;
    if (portId) {
      const portBtn = el.querySelector(`[data-port="${CSS.escape(portId)}"]`);
      const jack = portBtn?.querySelector('.bk-jack');
      const pe = jack && jack.getClientRects().length ? jack : portBtn;   // the jack is hidden on right-side ports
      if (pe) {
        const br = el.getBoundingClientRect(), pr = pe.getBoundingClientRect();
        const s = br.width / (el.offsetWidth || br.width);   // board zoom times any page zoom
        if (br.width) return { x: b.x + (pr.left + pr.width / 2 - br.left) / s, y: b.y + (pr.top + pr.height / 2 - br.top) / s, port: true };
      }
    }
    const dev = el.querySelector('.bk-dev');
    const dx = dev ? dev.offsetLeft + dev.offsetWidth / 2 : el.offsetWidth / 2, dy = dev ? dev.offsetTop + dev.offsetHeight / 2 : el.offsetHeight / 2;
    if (role === 'center') return { x: b.x + dx, y: b.y + dy };
    return o.portSide === 'right' ? { x: b.x + (dev ? dev.offsetLeft : 0), y: b.y + dy } : { x: b.x + dx, y: b.y + (dev ? dev.offsetTop : 0) };
  }

  function curve(a, b, toPort) {
    if (o.portSide === 'right') {
      const d = Math.max(40, Math.abs(b.x - a.x) * 0.45);
      return `M${a.x},${a.y} C${a.x + d},${a.y} ${b.x - d},${b.y} ${b.x},${b.y}`;
    }
    const d = Math.max(50, Math.abs(b.y - a.y) * 0.4);
    return `M${a.x},${a.y} C${a.x},${a.y + d} ${b.x},${toPort ? b.y + d : b.y - d} ${b.x},${b.y}`;
  }

  // ------------------------------------------------------------ drawing

  /** Tinted, labelled areas behind the devices: subnets, Docker networks, a cluster, a workflow. */
  function drawZones() {
    zonesSvg.replaceChildren();
    (o.zones?.() || []).forEach((z, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of z.members) {
        const b = blockById(id), el = blockEls.get(id);
        if (!b || !el || !el.offsetWidth) continue;
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + el.offsetWidth); y1 = Math.max(y1, b.y + el.offsetHeight);
      }
      if (x0 === Infinity) return;
      const pad = 22, top = 30;
      const tone = z.tone ?? i % 5;
      const g = svgEl('g', { class: `bk-zone tone-${tone}` });
      g.append(svgEl('rect', { x: x0 - pad, y: y0 - pad - top, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 + top, rx: 14 }));
      const t = svgEl('text', { x: x0 - pad + 14, y: y0 - pad - top + 20, class: 'bk-zone-label' });
      t.textContent = z.label;
      g.append(t);
      zonesSvg.append(g);
    });
  }

  /** A small cable tag: text on a rounded label, placed at the middle of the cable. */
  function cableTag(text, at, state) {
    const g = svgEl('g', { class: `bk-tag-g ${state}` });
    const t = svgEl('text', { x: at.x, y: at.y + 4, 'text-anchor': 'middle', class: 'bk-wire-label' });
    t.textContent = text;
    const r = svgEl('rect', { rx: 4, class: 'bk-tag-bg' });
    g.append(r, t);
    wiresSvg.append(g);
    const bb = t.getBBox?.();
    if (bb && bb.width) { r.setAttribute('x', bb.x - 6); r.setAttribute('y', bb.y - 2); r.setAttribute('width', bb.width + 12); r.setAttribute('height', bb.height + 4); }
  }

  function drawWires() {
    drawZones();
    wiresSvg.replaceChildren();
    wirePaths.clear();
    const defs = svgEl('defs');
    // One arrowhead per wire state: a marker cannot inherit the colour of the path that uses it everywhere.
    defs.innerHTML = ['', 'ok', 'bad', 'active'].map(st => `<marker id="${uid}-arrow-${st || 'plain'}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path class="bk-arrow ${st}" d="M0,0 L10,5 L0,10 z"/></marker>`).join('');
    wiresSvg.append(defs);
    const tags = [];
    for (const w of wires()) {
      const a = anchor(w.from.block, w.from.port, 'out'), b = anchor(w.to.block, w.to.port, 'in');
      if (!a || !b) continue;
      const d = curve(a, b, !!b.port);
      const state = o.wireState?.(w) || '';
      const kind = o.wireKinds[w.kind] || {};
      const selected = sel?.type === 'wire' && sel.id === w.id;
      // A cable: a dark jacket, a coloured core, a plug at each end and a link light near the far end.
      const jacket = svgEl('path', { d, class: `bk-cable${selected ? ' sel' : ''}` });
      const path = svgEl('path', { d, class: `bk-wire ${state}${selected ? ' sel' : ''}` });
      if (kind.color) path.style.setProperty('--wire', kind.color);
      if (o.arrows) path.setAttribute('marker-end', `url(#${uid}-arrow-${['ok', 'bad', 'active'].includes(state) ? state : 'plain'})`);
      const hit = svgEl('path', { d, class: 'bk-hit' });
      hit.addEventListener('pointerdown', e => { e.stopPropagation(); surface.focus({ preventScroll: true }); select({ type: 'wire', id: w.id }); });
      wiresSvg.append(jacket, path);
      const len = path.getTotalLength?.() || 0;
      const at = f => (len ? path.getPointAtLength(len * f) : { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      wiresSvg.append(svgEl('circle', { cx: a.x, cy: a.y, r: 4.5, class: 'bk-plug' }));
      if (!o.arrows) wiresSvg.append(svgEl('circle', { cx: b.x, cy: b.y, r: 4.5, class: 'bk-plug' }));
      const lp = len > 40 ? path.getPointAtLength(len - (o.arrows ? 22 : 16)) : at(0.8);
      const light = svgEl('circle', { cx: lp.x, cy: lp.y, r: 3.6, class: `bk-link ${state}` });
      wiresSvg.append(light, hit);
      wirePaths.set(w.id, { path, wire: w, light });
      const label = o.wireLabel ? o.wireLabel(w) : kind.label;
      if (label) tags.push([label, at(0.5), state]);
    }
    for (const [label, mid, state] of tags) cableTag(label, mid, state);
  }

  function brick(b) {
    const k = o.kinds[b.kind] || { label: b.kind, color: '#6b7388' };
    const ports = o.ports ? o.ports(b) : [];
    const extra = (o.blockClass?.(b) || '').split(/\s+/).filter(Boolean).map(c => '.' + c).join('');
    const selected = sel?.type === 'block' && sel.id === b.id;
    const right = o.portSide === 'right';
    const jacks = ports.map(p => portEl(b, p, k.panel));
    // The device itself: a drawing, or (for a switch) a front panel with the port sockets on it.
    const face = k.panel
      ? h('div.bk-dev.bk-panel', h('div.bk-panel-head', h('span.bk-panel-brand', k.label), h('span.bk-panel-leds', h('span.bk-led'), h('span.bk-led.pwr'))),
        h('div.bk-panel-ports', jacks))
      : h('div.bk-dev', h('span.bk-art', { html: deviceSvg(k.art || 'box') }), h('span.bk-led'), right && jacks);
    const el = h(`div.bk-block.bk-device.k-${b.kind}${extra}${selected ? '.sel' : ''}${right ? '.side-right' : ''}${k.panel ? '.has-panel' : ''}`, {
      style: { left: b.x + 'px', top: b.y + 'px', '--dev': k.color || '#6b7388', width: (k.width || 200) + 'px' },
      dataset: { id: b.id },
    },
    face,
    !k.panel && !right && ports.length > 0 && h('div.bk-ports.bk-sockets', jacks),
    h('div.bk-label', h('div.bk-head', h('span.bk-kind', k.label)), h('div.bk-body', o.body ? o.body(b) : b.name)));

    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('.bk-port, input, select, textarea, button, a')) return;
      e.preventDefault();
      e.stopPropagation();
      surface.focus({ preventScroll: true });
      const start = toWorld(e.clientX, e.clientY);
      const ox = start.x - b.x, oy = start.y - b.y;
      let moved = false;
      el.setPointerCapture(e.pointerId);
      if (!(sel?.type === 'block' && sel.id === b.id)) select({ type: 'block', id: b.id });
      const move = ev => {
        const p = toWorld(ev.clientX, ev.clientY);
        const nx = snap(p.x - ox), ny = snap(p.y - oy);
        if (nx === b.x && ny === b.y) return;
        moved = true;
        el.classList.add('dragging');
        b.x = nx; b.y = ny;
        el.style.left = b.x + 'px'; el.style.top = b.y + 'px';
        drawWires();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.classList.remove('dragging');
        if (moved) o.onMove?.(b);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
    });
    return el;
  }

  function portEl(b, p, onPanel) {
    // A socket with a link LED (lit when something is plugged in) and its name printed next to it.
    return h(`button.bk-port${p.on ? '.on' : ''}${onPanel ? '.on-panel' : ''}`, {
      type: 'button', title: p.title || `Drag ${p.label} onto another device to connect it`, dataset: { port: p.id },
      onpointerdown: e => startLink(e, b, p),
    }, h('span.bk-port-led'), h('span.bk-jack'), p.label && h('span.bk-port-label', p.label));
  }

  function startLink(e, b, p) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    surface.focus({ preventScroll: true });
    const a = anchor(b.id, p.id, 'out');
    const temp = svgEl('path', { class: 'bk-wire linking' });
    wiresSvg.append(temp);
    for (const other of blocks()) {
      if (other.id === b.id) continue;
      const ok = o.canConnect ? o.canConnect(b, p.id, other) : true;
      blockEls.get(other.id)?.classList.add(ok ? 'drop-ok' : 'drop-no');
    }
    const move = ev => {
      const w = toWorld(ev.clientX, ev.clientY);
      temp.setAttribute('d', curve(a, w, o.portSide !== 'right'));
    };
    const up = ev => {
      document.removeEventListener('pointermove', move);
      temp.remove();
      blockEls.forEach(el => el.classList.remove('drop-ok', 'drop-no'));
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetEl = under?.closest('.bk-block');
      const to = targetEl && blockById(targetEl.dataset.id);
      if (to && to.id !== b.id) {
        const toPort = under.closest('.bk-port')?.dataset.port || null;
        const r = o.connect?.(b, p.id, to, toPort);
        if (typeof r === 'string') say(r);
        else if (r !== false) render();
      } else if (!to && under?.closest('.bk-surface') === surface) {
        if (o.onDropEmpty?.(b, p.id) !== false) render();
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  }

  function say(text) {
    message.textContent = text;
    message.hidden = false;
    clearTimeout(flashMsg);
    flashMsg = setTimeout(() => { message.hidden = true; }, 3200);
  }

  // ------------------------------------------------------------ palette and toolbar

  const palette = h('div.bk-palette',
    h('div.eyebrow', 'Add'),
    (o.palette || []).map(item => {
      const k = o.kinds[item.kind] || {};
      const btn = h(`button.bk-brick.k-${item.kind}`, { type: 'button', title: item.title || `Add a ${k.label}`, style: { '--dev': k.color || '#6b7388' } },
        h('span.bk-pal-art', { html: deviceSvg(k.art || 'box') }), h('span.bk-pal-label', item.label || k.label));
      btn.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY;
        const up = ev => {
          const far = Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8;
          const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bk-surface') === surface;
          let at;
          if (far && over) { const w = toWorld(ev.clientX, ev.clientY); at = { x: snap(w.x - 90), y: snap(w.y - 30) }; }
          else {
            const { r } = pageK();
            const c = toWorld(r.left + r.width / 2, r.top + r.height / 3);
            const n = blocks().length;
            at = { x: snap(c.x - 100 + (n % 4) * 30), y: snap(c.y - 40 + (n % 4) * 30) };
          }
          const nb = item.add(at);
          if (typeof nb === 'string') { say(nb); return; }
          if (nb) { sel = { type: 'block', id: nb.id }; render(); select(sel); }
        };
        document.addEventListener('pointerup', up, { once: true });
      });
      return btn;
    }),
    o.howto && h('p.muted.small.bk-howto', o.howto));

  const viewBtns = o.form ? ['board', 'form'].map(v => h(`button.tab${view === v ? '.active' : ''}`, { type: 'button', onclick: () => setView(v) },
    v === 'board' ? '🧱 Board' : '☰ Form')) : [];
  const zoomBar = h('div.bk-zoombar',
    h('button.btn.ghost.small', { type: 'button', title: 'Zoom out (-)', onclick: () => zoomTo(zoom / 1.2) }, '−'),
    zoomLabel,
    h('button.btn.ghost.small', { type: 'button', title: 'Zoom in (+)', onclick: () => zoomTo(zoom * 1.2) }, '+'),
    h('button.btn.ghost.small', { type: 'button', title: 'Fit everything (0)', onclick: fit }, 'Fit'));
  surface.append(zoomBar);
  const toolbar = h('div.bk-toolbar', viewBtns.length > 0 && h('div.bk-viewtoggle', viewBtns), o.toolbar);

  function setView(v) {
    view = v;
    viewBtns.forEach((b, i) => b.classList.toggle('active', ['board', 'form'][i] === v));
    o.onView?.(v);
    render();
  }

  const el = h('div.bk', toolbar, h('div.bk-wrap', palette, surface, formSlot));
  world.append(zonesSvg, wiresSvg);

  // ------------------------------------------------------------ public

  function render() {
    stop();
    const isForm = view === 'form';
    surface.hidden = isForm; palette.hidden = isForm; formSlot.hidden = !isForm;
    el.classList.toggle('form-view', isForm);
    if (isForm) formSlot.replaceChildren(o.form());
    blockEls.forEach(e => e.remove());
    blockEls.clear();
    for (const b of blocks()) {
      const e = brick(b);
      blockEls.set(b.id, e);
      world.append(e);
    }
    world.append(tokensSvg);
    if (sel && !(sel.type === 'block' ? blockById(sel.id) : wires().some(w => w.id === sel.id))) sel = null;
    applyTransform();
    if (isForm) drawWires(); else requestAnimationFrame(drawWires);
    inspectorEl.replaceChildren(o.inspector ? o.inspector(sel) || '' : '');
  }

  function select(s) {
    sel = s;
    blockEls.forEach((e, id) => e.classList.toggle('sel', s?.type === 'block' && s.id === id));
    wirePaths.forEach(({ path }, id) => path.classList.toggle('sel', s?.type === 'wire' && s.id === id));
    inspectorEl.replaceChildren(o.inspector ? o.inspector(s) || '' : '');
    o.onSelect?.(s);
  }

  /** Stops every running animation and removes its tokens. */
  function stop() { epoch++; tokensSvg.replaceChildren(); }

  const wireBetween = (a, b) => [...wirePaths.values()].find(({ wire }) => (wire.from.block === a && wire.to.block === b) || (wire.from.block === b && wire.to.block === a));

  /**
   * Sends a token along hops: [{ from, to, wire?, cls?, ms?, onStart? }]. Resolves when it arrives
   * (or when stop() / render() interrupts it). opts: { cls, ms, label, linger }.
   */
  function animate(hops, opts = {}) {
    const my = epoch;
    const g = svgEl('g', { class: `bk-token ${opts.cls || ''}` });
    // A packet: a small envelope travelling along the cable.
    g.append(svgEl('rect', { x: -10, y: -7, width: 20, height: 14, rx: 2.5, class: 'bk-packet' }), svgEl('path', { d: 'M-9,-6 L0,1 L9,-6', class: 'bk-packet-flap' }));
    if (opts.label) { const t = svgEl('text', { y: -13 }); t.textContent = opts.label; g.append(t); }
    let placed = false;
    return (async () => {
      for (const hop of hops) {
        if (my !== epoch) break;
        hop.onStart?.();
        if (hop.cls != null) g.setAttribute('class', `bk-token ${hop.cls}`);
        const found = (hop.wire && wirePaths.get(hop.wire)) || wireBetween(hop.from, hop.to);
        let at;
        if (found) {
          const len = found.path.getTotalLength();
          const fwd = found.wire.from.block === hop.from;
          at = t => found.path.getPointAtLength(fwd ? t * len : (1 - t) * len);
        } else {
          const a = anchor(hop.from, null, 'center'), b = anchor(hop.to, null, 'center');
          if (!a || !b) continue;
          at = t => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
        if (!placed) { tokensSvg.append(g); placed = true; }
        const ms = hop.ms ?? opts.ms ?? 450;
        await new Promise(res => {
          const t0 = performance.now();
          const tick = now => {
            if (my !== epoch) return res();
            const t = Math.min(1, (now - t0) / ms);
            const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
            const p = at(e);
            g.setAttribute('transform', `translate(${p.x},${p.y})`);
            if (t < 1) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
      }
      if (opts.endCls && my === epoch) g.setAttribute('class', `bk-token ${opts.endCls}`);
      if (my === epoch && opts.linger) await new Promise(r => setTimeout(r, opts.linger));
      g.remove();
    })();
  }

  /** Briefly highlights a block: tone 'ok' | 'bad' | 'active'. */
  function pulse(id, tone = 'active', ms = 900) {
    const e = blockEls.get(id);
    if (!e) return;
    e.classList.remove('pulse-ok', 'pulse-bad', 'pulse-active');
    void e.offsetWidth;
    e.classList.add('pulse-' + tone);
    setTimeout(() => e.classList.remove('pulse-' + tone), ms);
  }

  function setWireState(id, state) {
    const w = wirePaths.get(id);
    if (!w) return;
    w.path.classList.remove('ok', 'bad', 'active');
    w.light?.classList.remove('ok', 'bad', 'active');
    if (state) { w.path.classList.add(state); w.light?.classList.add(state); }
    if (o.arrows) w.path.setAttribute('marker-end', `url(#${uid}-arrow-${['ok', 'bad', 'active'].includes(state) ? state : 'plain'})`);
  }

  return {
    el, inspectorEl, render, select, fit, animate, stop, pulse, say, setWireState, drawWires,
    get selected() { return sel; },
    get view() { return view; },
    refreshInspector: () => inspectorEl.replaceChildren(o.inspector ? o.inspector(sel) || '' : ''),
  };
}
