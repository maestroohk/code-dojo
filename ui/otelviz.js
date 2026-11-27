// Visuals for the observability topic (tracks/observability), on learn cards as "otelviz" (checked by server/OtelViz.cs),
// and under the results of an OpenTelemetry code step (the spans and logs the learner's own code exported):
//   trace     a trace waterfall like Jaeger's: the span tree with timings, services in colour, errors in red, the span
//             with the most self time marked; click a span for its attributes, events, status, links and log lines
//   metrics   a time-series panel like Grafana's: lines, threshold lines, a crosshair with every value, exemplars
//             (click one for the trace it points to), click the legend to hide a series
//   pipeline  an OpenTelemetry Collector config drawn as its pipelines: receivers -> processors -> exporters, with
//             components that are configured but used by no pipeline shown apart (they do nothing)
//   sampling  head vs tail sampling on a thousand traces: drag the ratio, switch the tail rules, see which errors and
//             slow traces survive and what it costs
import { h, esc } from './util.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== ''));

export function otelViz(spec) {
  switch (spec?.kind) {
    case 'trace': return traceView(spec, { caption: spec.caption });
    case 'metrics': return metricsView(spec);
    case 'pipeline': return pipelineView(spec);
    case 'sampling': return samplingView(spec);
    default: return h('div.muted.small', `Unknown otelviz kind: ${spec?.kind}`);
  }
}

/** Under a check result: what the learner's code exported, as waterfalls (one per trace) and log lines. */
export function otelResult(t) {
  const traces = (t?.traces || []).filter(x => x.spans?.length);
  if (!traces.length && !(t?.logs || []).length) return null;
  const pick = h('div.ov-tabs');
  const slot = h('div');
  const show = i => {
    [...pick.children].forEach((b, j) => b.classList.toggle('on', i === j));
    put(slot, traceView({ ...traces[i], logs: (t.logs || []).filter(l => l.traceId === traces[i].traceId) }, { compact: true }));
  };
  traces.forEach((tr, i) => {
    const root = rootOf(tr.spans);
    const failed = tr.spans.some(x => x.status === 'error');
    pick.append(h('button.mini', { type: 'button', onclick: () => show(i) },
      `${i + 1}. ${root?.name || 'trace'} · ${tr.spans.length} span${tr.spans.length > 1 ? 's' : ''}${failed ? ' · error' : ''}`));
  });
  const loose = (t.logs || []).filter(l => !l.traceId);
  const wrap = h('div.out-section.ov-result',
    h('div.out-title', 'What your code exported'),
    h('p.muted.small', 'The real OpenTelemetry SDK ran your code; these are the spans and log records it exported, drawn like Jaeger draws them.'),
    traces.length > 1 && pick, slot,
    loose.length > 0 && h('div.ov-logs', h('div.ov-sub', 'Log records with no trace id (logged outside any span)'), loose.slice(0, 12).map(l => logRow(l))));
  if (traces.length) show(0);
  return wrap;
}

// ------------------------------------------------------------------ trace waterfall

const PALETTE = ['#4f8cff', '#2bb39b', '#c07cf0', '#f0a035', '#e5677a', '#5cc8e6', '#9bb83a', '#d98a5f'];

function rootOf(spans) {
  const ids = new Set(spans.map(x => x.id));
  return spans.filter(x => !x.parent || !ids.has(x.parent)).sort((a, b) => a.start - b.start)[0];
}

const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${(+ms).toFixed(ms >= 1 ? 1 : 2)} ms`);

function traceView(spec, { compact = false, caption } = {}) {
  const spans = (spec.spans || []).map(x => ({ ...x, start: +x.start || 0, dur: Math.max(+x.dur || 0, 0) }));
  if (!spans.length) return h('div.muted.small', 'No spans.');
  const byId = new Map(spans.map(x => [x.id, x]));
  const kids = new Map();
  for (const x of spans) if (x.parent && byId.has(x.parent)) (kids.get(x.parent) || kids.set(x.parent, []).get(x.parent)).push(x);
  for (const list of kids.values()) list.sort((a, b) => a.start - b.start);
  const roots = spans.filter(x => !x.parent || !byId.has(x.parent)).sort((a, b) => a.start - b.start);
  const t0 = Math.min(...spans.map(x => x.start));
  const t1 = Math.max(...spans.map(x => x.start + x.dur));
  const total = Math.max(t1 - t0, 0.001);
  const services = [...new Set(spans.map(x => x.service || 'unknown'))];
  const color = svc => PALETTE[services.indexOf(svc || 'unknown') % PALETTE.length];

  // Self time: a span's duration minus the time covered by its children (what it spent itself).
  for (const x of spans) {
    const ch = (kids.get(x.id) || []).map(c => [Math.max(c.start, x.start), Math.min(c.start + c.dur, x.start + x.dur)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = -Infinity;
    for (const [a, b] of ch) { if (a > end) { covered += b - a; end = b; } else if (b > end) { covered += b - end; end = b; } }
    x.self = Math.max(x.dur - covered, 0);
  }
  const slowest = spans.length > 1 ? spans.reduce((a, b) => (b.self > a.self ? b : a)) : null;
  const errors = spans.filter(x => x.status === 'error').length;
  const logs = spec.logs || [];
  const collapsed = new Set();
  let openId = null;

  const rows = h('div.ov-rows');
  const order = [];
  const walk = (x, depth) => { order.push([x, depth]); if (!collapsed.has(x.id)) for (const c of kids.get(x.id) || []) walk(c, depth + 1); };
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const detail = x => {
    const attrs = Object.entries(x.attrs || {});
    const mine = logs.filter(l => l.spanId === x.id);
    return h('div.ov-detail',
      h('div.ov-detail-head',
        h('b', x.name), h('span.muted', ` ${x.service || ''} · ${x.kind || 'internal'} · ${fmtMs(x.dur)} (self ${fmtMs(x.self)}) · starts at ${fmtMs(x.start - t0)}`)),
      h('dl.ov-kv',
        h('dt', 'span id'), h('dd.mono', x.id || ''),
        x.parent && [h('dt', 'parent'), h('dd.mono', x.parent + (byId.has(x.parent) ? '' : '  (not in this trace: that span was never exported)'))],
        x.scope && [h('dt', 'instrumentation scope'), h('dd.mono', x.scope)],
        h('dt', 'status'), h(`dd.ov-status.${x.status || 'unset'}`, (x.status || 'unset').toUpperCase() + (x.statusMsg ? `: ${x.statusMsg}` : ''))),
      attrs.length > 0 && h('table.ov-attrs', h('tbody', attrs.map(([k, v]) => h('tr', h('td.mono', k), h('td.mono', String(v)))))),
      attrs.length === 0 && h('p.muted.small', 'No attributes.'),
      (x.events || []).length > 0 && h('div', h('div.ov-sub', 'Events'), x.events.map(e => h('div.ov-event', h('span.mono.muted', `+${fmtMs(e.t - x.start)}`), h('b', ` ${e.name}`),
        Object.keys(e.attrs || {}).length > 0 && h('span.mono.small', '  ' + Object.entries(e.attrs).map(([k, v]) => `${k}=${v}`).join('  '))))),
      (x.links || []).length > 0 && h('div', h('div.ov-sub', 'Links'), x.links.map(l => h('div.mono.small', `trace ${l.traceId}  span ${l.spanId}`))),
      mine.length > 0 && h('div', h('div.ov-sub', 'Log records in this span'), mine.map(l => logRow(l))));
  };

  const draw = () => {
    order.length = 0;
    roots.forEach(r => walk(r, 0));
    put(rows, order.map(([x, depth]) => {
      const left = ((x.start - t0) / total) * 100;
      const width = Math.max((x.dur / total) * 100, 0.4);
      const has = (kids.get(x.id) || []).length > 0;
      const orphan = x.parent && !byId.has(x.parent);
      const row = h(`div.ov-row${x.status === 'error' ? '.err' : ''}${openId === x.id ? '.open' : ''}`,
        { tabindex: 0, role: 'button', 'aria-expanded': String(openId === x.id) },
        h('div.ov-name', { style: `padding-left:${depth * 14 + 4}px` },
          has ? h('span.ov-twisty', { onclick: e => { e.stopPropagation(); collapsed.has(x.id) ? collapsed.delete(x.id) : collapsed.add(x.id); draw(); } }, collapsed.has(x.id) ? '▸' : '▾') : h('span.ov-twisty.leaf', '·'),
          h('span.ov-chip', { style: `background:${color(x.service)}` }),
          h('span.ov-svc', x.service || ''), h('span.ov-op', x.name),
          x.status === 'error' && h('span.ov-badge.bad', 'error'),
          slowest && x.id === slowest.id && x.self > 0 && h('span.ov-badge.warn', { title: 'The span with the most time spent in itself, not in its children: look here first.' }, 'most self time'),
          orphan && h('span.ov-badge', { title: 'Its parent span is not in this trace: it was dropped, sampled out or never exported.' }, 'parent missing')),
        h('div.ov-lane',
          ticks.slice(1, -1).map(t => h('span.ov-grid', { style: `left:${t * 100}%` })),
          h('span.ov-bar', { style: `left:${left}%;width:${width}%;background:${x.status === 'error' ? 'var(--bad)' : color(x.service)}` }),
          // Near the right edge the label goes inside the end of the bar (a long bar) or just before it (a short one).
          left + width > 78
            ? h(`span.ov-dur${width > 14 ? '.in' : ''}`, { style: width > 14 ? `right:${100 - left - width + 0.6}%` : `right:${100 - left + 0.8}%` }, fmtMs(x.dur))
            : h('span.ov-dur', { style: `left:${left + width + 0.8}%` }, fmtMs(x.dur))));
      const toggle = () => { openId = openId === x.id ? null : x.id; draw(); };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      return openId === x.id ? [row, detail(x)] : row;
    }));
  };
  draw();

  const root = roots[0];
  const head = h('div.ov-head',
    h('div.ov-title', h('b', `${root.service ? root.service + ': ' : ''}${root.name}`), spec.traceId && h('span.mono.muted.small', ` ${spec.traceId}`)),
    h('div.ov-stats',
      h('span', h('b', fmtMs(total)), ' duration'), h('span', h('b', spans.length), ' spans'),
      h('span', h('b', services.length), services.length === 1 ? ' service' : ' services'),
      h('span', { class: errors ? 'bad' : '' }, h('b', errors), errors === 1 ? ' error' : ' errors')),
    h('div.ov-legend', services.map(svc => h('span', h('span.ov-chip', { style: `background:${color(svc)}` }), svc))));
  const ruler = h('div.ov-ruler', h('div.ov-name.muted.small', 'Service · operation'),
    h('div.ov-lane', ticks.map(t => h('span.ov-tick', { style: t === 1 ? 'right:0' : `left:${t * 100}%` }, fmtMs(total * t)))));
  const traceLogs = logs.length > 0 && !compact ? h('div.ov-logs', h('div.ov-sub', 'Log lines of this trace (matched by trace id)'), logs.map(l => logRow(l))) : null;
  const compactLogs = logs.length > 0 && compact ? h('div.ov-logs', h('div.ov-sub', `Log records in this trace (${logs.length})`), logs.slice(0, 12).map(l => logRow(l))) : null;
  return h(`div.otelviz.ov-trace${compact ? '.compact' : ''}`, head, ruler, rows, traceLogs, compactLogs,
    (caption || spec.caption) && h('p.muted.small.ov-caption', caption || spec.caption),
    !compact && h('p.muted.small.ov-caption', 'Click a span for its attributes. ▾ folds a subtree.'));
}

function logRow(l) {
  const level = String(l.level || '').toLowerCase();
  const cls = /err|crit|fatal/.test(level) ? 'bad' : /warn/.test(level) ? 'warn' : '';
  return h(`div.ov-log.${cls || 'info'}`,
    l.t != null && h('span.mono.muted', fmtMs(+l.t)),
    h('span.ov-level', (l.level || 'info').toString().slice(0, 5).toUpperCase()),
    l.service && h('span.ov-svc', l.service),
    h('span.ov-body', l.body || l.template || ''),
    l.traceId && h('span.mono.muted.small.ov-ids', `trace_id=${l.traceId.slice(0, 12)}…${l.spanId ? ` span_id=${l.spanId.slice(0, 8)}…` : ''}`),
    l.attrs && Object.keys(l.attrs).length > 0 && h('span.mono.small.ov-lattrs', Object.entries(l.attrs).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('  ')));
}

// ------------------------------------------------------------------ metrics panel

const SERIES_COLORS = ['#4f8cff', '#f0a035', '#e5677a', '#2bb39b', '#c07cf0', '#5cc8e6', '#9bb83a'];

function fmtVal(v, unit) {
  if (v == null || Number.isNaN(v)) return '–';
  switch (unit) {
    case 's': return v >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms`;
    case 'ms': return `${v.toFixed(v < 10 ? 1 : 0)} ms`;
    case '%': return `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
    case 'x': return `${v.toFixed(v < 10 ? 1 : 0)}×`;
    case 'reqps': return `${v.toFixed(v < 10 ? 2 : 0)} req/s`;
    default: return Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : (+v.toFixed(3)).toString();
  }
}

function fmtTime(sec, spec) {
  if (spec.clock) {
    const [hh, mm] = spec.clock.split(':').map(Number);
    const m = hh * 60 + mm + Math.floor(sec / 60);
    return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
  const m = Math.round(sec / 60);
  return sec % 60 === 0 || m >= 2 ? `${m}m` : `${sec}s`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function metricsView(spec) {
  const W = 680, H = 260, L = 58, R = 16, T = 14, B = 34;
  const series = (spec.series || []).map((x, i) => ({ ...x, color: x.color || SERIES_COLORS[i % SERIES_COLORS.length], on: x.hidden !== true }));
  const hidden = new Set();
  const svgWrap = h('div.ov-chart');
  const tip = h('div.ov-tip', { hidden: true });
  const note = h('div.ov-note.muted.small', spec.note || '');
  const legend = h('div.ov-mlegend');

  const draw = () => {
    const live = series.filter(x => !hidden.has(x.name));
    const all = live.flatMap(x => x.points || []);
    const xs = (series.flatMap(x => x.points || [])).map(p => p[0]);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymaxData = Math.max(...all.map(p => p[1]), ...(spec.thresholds || []).map(t => t.value), spec.yMax || 0);
    const ymax = spec.yMax || niceMax(ymaxData * 1.08);
    const X = t => L + ((t - xmin) / Math.max(xmax - xmin, 1)) * (W - L - R);
    const Y = v => T + (1 - v / ymax) * (H - T - B);
    const g = s('g');
    for (let i = 0; i <= 4; i++) {
      const v = (ymax * i) / 4;
      g.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'ov-gridline' }), s('text', { x: L - 6, y: Y(v) + 4, class: 'ov-axis', 'text-anchor': 'end' }, fmtVal(v, spec.unit)));
    }
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const t = xmin + ((xmax - xmin) * i) / steps;
      g.append(s('text', { x: X(t), y: H - B + 18, class: 'ov-axis', 'text-anchor': i === 0 ? 'start' : i === steps ? 'end' : 'middle' }, fmtTime(Math.round(t), spec)));
    }
    for (const a of spec.annotations || []) {
      g.append(s('line', { x1: X(a.t), x2: X(a.t), y1: T, y2: H - B, class: 'ov-annot' }), s('text', { x: X(a.t) + 4, y: T + 11, class: 'ov-annot-label' }, a.label));
    }
    // Threshold labels sit above their line; when two lines are close, the lower one's label goes under its line,
    // and when they are still too close, labels step left so they never overprint.
    const used = [];
    for (const t of [...(spec.thresholds || [])].sort((a, b) => b.value - a.value)) {
      const ly = Y(t.value);
      let y = ly - 5, x = W - R - 4;
      if (used.some(u => Math.abs(u.y - y) < 13)) y = ly + 13;
      while (used.some(u => Math.abs(u.y - y) < 13 && u.x === x)) x -= 230;
      used.push({ y, x });
      g.append(s('line', { x1: L, x2: W - R, y1: ly, y2: ly, class: `ov-threshold ${t.kind || 'bad'}` }),
        s('text', { x, y, class: `ov-threshold-label ${t.kind || 'bad'}`, 'text-anchor': 'end' }, t.label || fmtVal(t.value, spec.unit)));
    }
    for (const x of live) {
      const pts = (x.points || []).filter(p => p[1] != null);
      if (!pts.length) continue;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(Math.min(p[1], ymax)).toFixed(1)}`).join(' ');
      if (spec.fill !== false && live.length <= 2) g.append(s('path', { d: `${d} L${X(pts.at(-1)[0]).toFixed(1)},${Y(0)} L${X(pts[0][0]).toFixed(1)},${Y(0)} Z`, fill: x.color, opacity: 0.08 }));
      g.append(s('path', { d, fill: 'none', stroke: x.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    }
    for (const e of spec.exemplars || []) {
      const cx = X(e.t), cy = Y(Math.min(e.v, ymax));
      const dot = s('path', { d: `M${cx},${cy - 6} L${cx + 6},${cy} L${cx},${cy + 6} L${cx - 6},${cy} Z`, class: 'ov-exemplar', tabindex: 0, role: 'button' });
      const showEx = () => { note.innerHTML = `<b>Exemplar</b> at ${esc(fmtTime(e.t, spec))}: ${esc(fmtVal(e.v, spec.unit))} · trace <span class="mono">${esc(e.traceId || '')}</span>${e.label ? ` · ${esc(e.label)}` : ''}`; };
      dot.addEventListener('click', showEx);
      dot.addEventListener('keydown', ev => { if (ev.key === 'Enter') showEx(); });
      g.append(dot);
    }
    const cross = s('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'ov-cross', visibility: 'hidden' });
    const hit = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
    hit.addEventListener('mousemove', ev => {
      const box = svg.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      const t = xmin + ((px - L) / (W - L - R)) * (xmax - xmin);
      const rowsAt = live.map(x => {
        const p = (x.points || []).reduce((best, q) => (Math.abs(q[0] - t) < Math.abs(best[0] - t) ? q : best), (x.points || [[Infinity, null]])[0]);
        return { x, p };
      });
      const at = rowsAt[0]?.p?.[0] ?? t;
      cross.setAttribute('x1', X(at)); cross.setAttribute('x2', X(at)); cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      put(tip, h('div.ov-tip-time', fmtTime(Math.round(at), spec)), rowsAt.map(({ x, p }) => h('div', h('span.ov-chip', { style: `background:${x.color}` }), ` ${x.name}: `, h('b', fmtVal(p?.[1], spec.unit)))));
      const left = ((X(at)) / W) * 100;
      tip.style.left = left > 60 ? '' : `calc(${left}% + 12px)`;
      tip.style.right = left > 60 ? `calc(${100 - left}% + 12px)` : '';
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ov-svg', role: 'img', 'aria-label': spec.title || 'metrics chart' }, g, cross, hit);
    // Exemplars sit above the hover layer so they stay clickable.
    for (const el of [...g.querySelectorAll('.ov-exemplar')]) svg.append(el);
    put(svgWrap, svg, tip);
    put(legend, series.map(x => h(`button.ov-lg${hidden.has(x.name) ? '.off' : ''}`, { type: 'button', onclick: () => { hidden.has(x.name) ? hidden.delete(x.name) : hidden.add(x.name); draw(); } },
      h('span.ov-chip', { style: `background:${x.color}` }), ' ', x.name,
      h('span.muted', `  last ${fmtVal((x.points || []).at(-1)?.[1], spec.unit)}  max ${fmtVal(Math.max(...(x.points || []).map(p => p[1])), spec.unit)}`))));
  };
  draw();
  return h('div.otelviz.ov-metrics',
    h('div.ov-head', h('div.ov-title', h('b', spec.title || 'Metric')), spec.query && h('code.ov-query', spec.query)),
    svgWrap, legend, note, spec.caption && h('p.muted.small.ov-caption', spec.caption));
}

// ------------------------------------------------------------------ collector pipeline

function pipelineView(spec) {
  const pipelines = Object.entries(spec.pipelines || {});
  const used = new Set(pipelines.flatMap(([, p]) => [...(p.receivers || []), ...(p.processors || []), ...(p.exporters || [])]));
  const declared = [...(spec.receivers || []).map(n => ['receiver', n]), ...(spec.processors || []).map(n => ['processor', n]), ...(spec.exporters || []).map(n => ['exporter', n])];
  const unused = declared.filter(([, n]) => !used.has(n));
  const notes = spec.notes || {};
  const detail = h('div.ov-note.small', spec.note || 'Pick a component for what it does.');
  const boxes = [];
  const box = (kind, name) => {
    const b = h(`button.ov-comp.${kind}${spec.bug === name ? '.bug' : ''}`, { type: 'button' }, h('span.ov-kind', kind), h('span.mono', name));
    b.dataset.name = name;
    b.addEventListener('mouseenter', () => boxes.forEach(x => x.classList.toggle('same', x.dataset.name === name)));
    b.addEventListener('mouseleave', () => boxes.forEach(x => x.classList.remove('same')));
    b.addEventListener('click', () => { detail.innerHTML = `<b class="mono">${esc(name)}</b> · ${esc(kind)}<br>${esc(notes[name] || defaultNote(kind, name))}`; });
    boxes.push(b);
    return b;
  };
  const arrow = () => h('span.ov-arrow', '→');
  const lane = ([name, p]) => h('div.ov-pipe',
    h('div.ov-pipe-name.mono', name),
    h('div.ov-stage', (p.receivers || []).map(r => box('receiver', r))), arrow(),
    (p.processors || []).length ? [(p.processors || []).flatMap((x, i) => (i ? [h('span.ov-arrow.small', '→'), box('processor', x)] : [box('processor', x)])), arrow()] : [h('span.muted.small.ov-none', 'no processors'), arrow()],
    h('div.ov-stage', (p.exporters || []).map(e => box('exporter', e))));
  return h('div.otelviz.ov-pipeline',
    h('div.ov-head', h('div.ov-title', h('b', spec.title || 'Collector pipelines')), h('span.muted.small', 'Data flows left to right; a component only runs if a pipeline lists it.')),
    pipelines.map(lane),
    unused.length > 0 && h('div.ov-unused', h('div.ov-sub', 'Configured but in no pipeline: these do nothing'), h('div.ov-stage', unused.map(([k, n]) => box(k, n)))),
    detail, spec.caption && h('p.muted.small.ov-caption', spec.caption));
}

function defaultNote(kind, name) {
  const base = name.split('/')[0];
  const known = {
    otlp: kind === 'receiver' ? 'Accepts OTLP over gRPC (4317) and HTTP (4318) from SDKs and other Collectors.' : 'Sends OTLP over gRPC to the next hop (a backend or a gateway Collector).',
    otlphttp: 'Sends OTLP over HTTP/protobuf (paths /v1/traces, /v1/metrics, /v1/logs are added to the endpoint).',
    memory_limiter: 'Refuses data when the Collector nears its memory limit, so it slows down instead of being OOM-killed. Put it first.',
    batch: 'Groups data before export. Being replaced by batching in the exporter (sending_queue.batch).',
    tail_sampling: 'Waits until a trace is complete, then keeps it by policy (errors, latency, a ratio of the rest).',
    attributes: 'Inserts, updates, hashes or deletes attributes: the place to redact personal data before it is stored.',
    transform: 'OTTL statements that rewrite telemetry (rename, truncate, drop attributes, set status).',
    filter: 'Drops telemetry that matches OTTL conditions (health checks, noisy debug logs).',
    resource: 'Changes resource attributes (service.name, deployment.environment.name) on everything that passes.',
    prometheus: 'Serves the metrics on an HTTP endpoint for Prometheus to scrape.',
    prometheusremotewrite: 'Pushes metrics to Prometheus (or Mimir, Thanos) with remote write.',
    debug: 'Prints telemetry to the Collector\'s own log. For debugging only.',
    hostmetrics: 'Scrapes the host\'s CPU, memory, disk and network.',
    filelog: 'Tails log files and turns lines into log records.',
    k8sattributes: 'Adds pod, namespace and node names to telemetry from Kubernetes.',
  };
  return known[base] || `${kind} ${name}.`;
}

// ------------------------------------------------------------------ head vs tail sampling

function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

function samplingView(spec) {
  const N = Math.min(Math.max(spec.traces || 1000, 100), 2000);
  const rand = rng(spec.seed || 7);
  const traces = Array.from({ length: N }, () => {
    const r = rand();
    const error = r < (spec.errorRate ?? 0.01);
    const slow = !error && rand() < (spec.slowRate ?? 0.02);
    return { error, slow, id: rand() };
  });
  const st = { mode: spec.mode || 'head', ratio: spec.ratio ?? 0.1, keepErrors: true, keepSlow: true, rest: spec.rest ?? 0.05 };
  const grid = h('div.ov-dots');
  const stats = h('div.ov-sstats');
  const ratioIn = h('input', { type: 'range', min: 0, max: 100, value: Math.round(st.ratio * 100) });
  const ratioLabel = h('b');
  const restIn = h('input', { type: 'range', min: 0, max: 100, value: Math.round(st.rest * 100) });
  const restLabel = h('b');
  const tb = (label, key) => { const i = h('input', { type: 'checkbox', checked: st[key] }); i.addEventListener('change', () => { st[key] = i.checked; draw(); }); return h('label.ov-check', i, ' ', label); };
  const modeBtn = (m, label) => h('button.mini', { type: 'button', onclick: () => { st.mode = m; draw(); } }, label);
  const headBtn = modeBtn('head', 'Head sampling'), tailBtn = modeBtn('tail', 'Tail sampling');
  const headCtl = h('div.ov-ctl', h('label', 'Keep ', ratioLabel, ' of traces, decided at the first span (TraceIdRatioBased)'), ratioIn);
  const tailCtl = h('div.ov-ctl', tb('keep every trace with an error', 'keepErrors'), tb('keep every trace slower than 1 s', 'keepSlow'),
    h('label', 'and ', restLabel, ' of the rest'), restIn);
  ratioIn.addEventListener('input', () => { st.ratio = ratioIn.value / 100; draw(); });
  restIn.addEventListener('input', () => { st.rest = restIn.value / 100; draw(); });
  const kept = t => (st.mode === 'head' ? t.id < st.ratio : (st.keepErrors && t.error) || (st.keepSlow && t.slow) || t.id < st.rest);
  const draw = () => {
    headBtn.classList.toggle('on', st.mode === 'head'); tailBtn.classList.toggle('on', st.mode === 'tail');
    headCtl.hidden = st.mode !== 'head'; tailCtl.hidden = st.mode !== 'tail';
    ratioLabel.textContent = `${Math.round(st.ratio * 100)}%`; restLabel.textContent = `${Math.round(st.rest * 100)}%`;
    put(grid, traces.map(t => h(`span.ov-dot${kept(t) ? '.kept' : ''}${t.error ? '.error' : t.slow ? '.slow' : ''}`)));
    const k = traces.filter(kept), errs = traces.filter(t => t.error), slows = traces.filter(t => t.slow);
    put(stats,
      h('div', h('b', `${k.length}`), ` of ${N} traces stored (${Math.round((k.length / N) * 100)}% of the storage bill)`),
      h('div', { class: k.filter(t => t.error).length < errs.length ? 'bad' : 'good' }, h('b', `${k.filter(t => t.error).length} of ${errs.length}`), ' error traces kept'),
      h('div', { class: k.filter(t => t.slow).length < slows.length ? 'bad' : 'good' }, h('b', `${k.filter(t => t.slow).length} of ${slows.length}`), ' slow traces kept'),
      h('div.muted.small', st.mode === 'head'
        ? 'Head sampling decides before anything happened, so it keeps errors at the same rate as everything else. Cheap: the SDK drops spans before they are even exported.'
        : 'Tail sampling decides after the trace is complete (in a Collector that sees every span of it), so it can keep what matters. It costs memory: the Collector buffers every trace for decision_wait.'));
  };
  draw();
  return h('div.otelviz.ov-sampling',
    h('div.ov-head', h('div.ov-title', h('b', spec.title || 'Head vs tail sampling')), h('div.ov-tabs', headBtn, tailBtn)),
    headCtl, tailCtl,
    h('div.ov-legend', h('span', h('span.ov-dot.kept'), ' stored'), h('span', h('span.ov-dot'), ' dropped'), h('span', h('span.ov-dot.kept.error'), ' error'), h('span', h('span.ov-dot.kept.slow'), ' slow')),
    grid, stats, spec.caption && h('p.muted.small.ov-caption', spec.caption));
}
