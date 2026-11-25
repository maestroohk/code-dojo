// The project blueprint: the finished application's architecture, drawn in layers, with each part
// lit up as the stage that builds it is finished. It shows how the program is being pieced together.
//
// module.json "blueprint": {
//   "layers": ["Client", "Pipeline", ...],                      top to bottom
//   "parts":  [{ "id", "label", "layer", "stage": 1, "note"? }],  stage = which stage builds it (1-based)
//   "flow":   [["from-id", "to-id"], ...]                       arrows between parts
// }
import { h } from './util.js';

/**
 * @param bp      the blueprint
 * @param stages  [{ title, done }] in stage order
 * @param focus   1-based stage to highlight (the next one to build), or 0
 */
export function blueprint(bp, stages, focus = 0) {
  const doneCount = stages.filter(s => s.done).length;
  const stateOf = p => stages[p.stage - 1]?.done ? 'built' : p.stage === focus ? 'next' : 'future';
  const parts = new Map(bp.parts.map(p => [p.id, p]));
  const box = new Map();

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('bp-wires');
  svg.setAttribute('aria-hidden', 'true');

  const legendStage = h('div.bp-caption');
  const showStage = n => {
    const s = stages[n - 1];
    legendStage.replaceChildren(s
      ? h('span', h('b', `Stage ${n}`), ` · ${s.title.replace(/^(Stage \d+|Boss):\s*/, '')}`, s.done ? h('span.bp-chip.built', 'built') : n === focus ? h('span.bp-chip.next', 'next up') : h('span.bp-chip', 'later'))
      : h('span.muted', 'Hover a part to see which stage builds it.'));
    grid.querySelectorAll('.bp-part').forEach(el => el.classList.toggle('dim', !!s && Number(el.dataset.stage) !== n));
  };

  const grid = h('div.bp-grid',
    bp.layers.map(layer => h('div.bp-layer',
      h('div.bp-layer-name', layer),
      h('div.bp-row', bp.parts.filter(p => p.layer === layer).map(p => {
        const el = h(`div.bp-part.${stateOf(p)}`, {
          'data-stage': p.stage, tabindex: 0,
          title: p.note || '',
          onmouseenter: () => showStage(p.stage), onfocus: () => showStage(p.stage),
          onmouseleave: () => showStage(0), onblur: () => showStage(0),
        }, h('span.bp-stage', `S${p.stage}`), h('span.bp-label', p.label), p.note && h('span.bp-note', p.note));
        box.set(p.id, el);
        return el;
      })))));

  const wrap = h('div.bp', h('div.bp-canvas', svg, grid));

  // Wires are drawn once the boxes have a layout, and again when the size changes.
  const draw = () => {
    const origin = wrap.querySelector('.bp-canvas').getBoundingClientRect();
    if (!origin.width) return;
    svg.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`);
    svg.setAttribute('width', origin.width); svg.setAttribute('height', origin.height);
    svg.replaceChildren();
    const defs = document.createElementNS(svg.namespaceURI, 'defs');
    defs.innerHTML = '<marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>';
    svg.append(defs);
    for (const [from, to] of bp.flow || []) {
      const a = box.get(from)?.getBoundingClientRect(), b = box.get(to)?.getBoundingClientRect();
      if (!a || !b) continue;
      const lit = stateOf(parts.get(from)) === 'built' && stateOf(parts.get(to)) === 'built';
      let x1, y1, x2, y2;
      if (Math.abs(a.top - b.top) < 4) {            // same row: side to side
        const ltr = a.left < b.left;
        x1 = (ltr ? a.right : a.left) - origin.left; x2 = (ltr ? b.left : b.right) - origin.left;
        y1 = a.top + a.height / 2 - origin.top; y2 = b.top + b.height / 2 - origin.top;
      } else {                                       // between rows: bottom to top
        const down = a.top < b.top;
        x1 = a.left + a.width / 2 - origin.left; x2 = b.left + b.width / 2 - origin.left;
        y1 = (down ? a.bottom : a.top) - origin.top; y2 = (down ? b.top : b.bottom) - origin.top;
      }
      const path = document.createElementNS(svg.namespaceURI, 'path');
      const my = (y1 + y2) / 2;
      path.setAttribute('d', Math.abs(y1 - y2) < 4 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`);
      path.setAttribute('marker-end', 'url(#bp-arrow)');
      path.setAttribute('class', lit ? 'lit' : '');
      svg.append(path);
    }
  };
  new ResizeObserver(() => requestAnimationFrame(draw)).observe(grid);

  const pct = Math.round((doneCount / Math.max(1, stages.length)) * 100);
  const built = bp.parts.filter(p => stateOf(p) === 'built').length;
  showStage(0);
  return h('div.bp-panel',
    h('div.bp-head',
      h('div', h('div.eyebrow', 'Blueprint'), h('div.muted.small', `${built} of ${bp.parts.length} parts built · ${pct}% of the application`)),
      h('div.bp-legend', h('span.bp-chip.built', 'built'), h('span.bp-chip.next', 'next stage'), h('span.bp-chip', 'later'))),
    wrap, legendStage);
}
