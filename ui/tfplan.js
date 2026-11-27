// "tfplan" learn cards (tracks/terraform): a plan review tool for a real `terraform show -json plan.tfplan`.
// It draws the plan's resources as a dependency graph (dependencies on the left, what uses them to the right), coloured
// by action: create, update in place, replace (-/+ or +/-), destroy, read, import, move, forget, no change. Clicking a
// resource shows the attribute diff the way a reviewer wants it: changed attributes first, `(known after apply)` and
// `(sensitive value)` as Terraform prints them, and the attributes that **force replacement** flagged. A banner names
// every destructive change before anything else, and the downstream resources of the selected one are highlighted
// (its blast radius). The edges come from the plan's own `configuration` section (references and depends_on).
//
//   "tfplan": { "plan": { ...the JSON of `terraform show -json`, trimmed... }, "title": "optional",
//               "focus": "aws_db_instance.main", "note": "optional Markdown shown above the graph" }
//
// Authors keep format_version, terraform_version, resource_changes, resource_drift, output_changes and configuration
// (tracks/AUTHORING.md, "tfplan"), with sensitive values blanked. server/TfPlan.cs checks the shape in `dojo validate`.
import { h, esc, inline } from './util.js';

const KIND = {
  create: { sym: '+', label: 'create', verb: 'will be created' },
  update: { sym: '~', label: 'update in place', verb: 'will be updated in-place' },
  replace: { sym: '-/+', label: 'replace', verb: 'must be replaced (destroyed, then created)' },
  'replace-cbd': { sym: '+/-', label: 'replace', verb: 'must be replaced (new one created first, then the old one destroyed)' },
  delete: { sym: '-', label: 'destroy', verb: 'will be destroyed' },
  read: { sym: '<=', label: 'read', verb: 'will be read during apply' },
  forget: { sym: '.', label: 'forget', verb: 'will be removed from the state, but not destroyed' },
  import: { sym: '←', label: 'import', verb: 'will be imported' },
  move: { sym: '→', label: 'move', verb: 'has moved' },
  noop: { sym: ' ', label: 'no change', verb: 'has no changes' },
};

const REASON = {
  replace_because_cannot_update: 'The provider cannot change some attributes in place: they are marked **forces replacement** below.',
  replace_because_tainted: 'The object is **tainted**: an earlier create or update failed part way, so Terraform rebuilds it.',
  replace_by_request: 'Someone asked for this with `-replace`.',
  replace_by_triggers: 'A `replace_triggered_by` reference changed.',
  delete_because_no_resource_config: 'Its `resource` block is gone from the configuration. Renamed or moved without a `moved` block?',
  delete_because_no_module: 'Its `module` block is gone from the configuration.',
  delete_because_wrong_repetition: 'The resource switched between `count`, `for_each` and neither, so this instance key no longer exists.',
  delete_because_count_index: '`count` got smaller, so this index no longer exists.',
  delete_because_each_key: '`for_each` no longer has this key.',
  delete_because_no_move_target: 'A `moved` block points it at an address that does not exist.',
  read_because_config_unknown: 'Its arguments depend on values that are only known after apply.',
  read_because_dependency_pending: 'It depends on a resource with pending changes.',
  read_because_check_nested: 'It is in a `check` block and is read on every plan.',
};

const strip = addr => addr.replace(/\[[^\]]*\]/g, '');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function kindOf(rc) {
  const a = rc.change?.actions || [];
  if (a.length === 2) return a[0] === 'create' ? 'replace-cbd' : 'replace';
  const k = a[0] === 'no-op' ? 'noop' : a[0];
  if (k === 'noop' && rc.change?.importing) return 'import';
  if (k === 'noop' && rc.previous_address && rc.previous_address !== rc.address) return 'move';
  return KIND[k] ? k : 'noop';
}
const destructive = k => k === 'replace' || k === 'replace-cbd' || k === 'delete';

/** Every leaf of a value as [path, value], paths written like `tags.env` and `ingress[0].cidr_blocks[1]`. */
function leaves(v, path = '', out = new Map()) {
  if (Array.isArray(v)) { if (!v.length) out.set(path, v); v.forEach((x, i) => leaves(x, `${path}[${i}]`, out)); }
  else if (isObj(v)) { const keys = Object.keys(v); if (!keys.length && path) out.set(path, v); keys.forEach(k => leaves(v[k], path ? `${path}.${k}` : k, out)); }
  else out.set(path, v);
  return out;
}
const pathOf = parts => parts.reduce((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${p}` : String(p)), '');
/** true when a mark structure (after_unknown, *_sensitive) is true at this path or one of its parents. */
function marked(marks, path) {
  if (marks === true) return true;
  if (!marks || typeof marks !== 'object' || !path) return false;
  const m = path.match(/^([^.[]+)|^\[(\d+)\]/);
  if (!m) return false;
  const key = m[1] ?? Number(m[2]);
  const rest = path.slice(m[0].length).replace(/^\./, '');
  return marked(marks[key], rest);
}
function markedPaths(marks, path = '', out = []) {
  if (marks === true) out.push(path);
  else if (Array.isArray(marks)) marks.forEach((m, i) => markedPaths(m, `${path}[${i}]`, out));
  else if (isObj(marks)) Object.entries(marks).forEach(([k, m]) => markedPaths(m, path ? `${path}.${k}` : k, out));
  return out;
}

/** The attribute rows of one change: [{ path, op: '+'|'-'|'~'|'=', before, after, unknown, sensBefore, sensAfter, forces }]. */
function diffRows(rc) {
  const c = rc.change || {};
  const before = leaves(c.before ?? null), after = leaves(c.after ?? null);
  const unknown = markedPaths(c.after_unknown);
  for (const p of unknown) if (!after.has(p)) after.set(p, undefined);
  const forces = (c.replace_paths || []).map(pathOf);
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter(p => p !== '');
  const rows = paths.map(path => {
    const b = before.get(path), a = after.get(path);
    const unk = marked(c.after_unknown, path);
    const sensBefore = marked(c.before_sensitive, path), sensAfter = marked(c.after_sensitive, path);
    const inB = before.has(path) && b !== null, inA = (after.has(path) && a !== null) || unk;
    const same = !unk && JSON.stringify(b) === JSON.stringify(a);
    const op = same ? '=' : !inB && inA ? '+' : inB && !inA ? '-' : '~';
    return { path, op, before: b, after: a, unknown: unk, sensBefore, sensAfter,
      forces: forces.some(f => path === f || path.startsWith(`${f}.`) || path.startsWith(`${f}[`)) };
  });
  const rank = r => (r.forces ? 0 : r.op === '=' ? 2 : 1);
  return rows.sort((x, y) => rank(x) - rank(y) || x.path.localeCompare(y.path, 'en'));
}

/** Dependency edges between resource config addresses, from the plan's configuration section. */
function configEdges(config) {
  const edges = new Set();
  const known = new Set();
  const collect = (expr, out = []) => {
    if (Array.isArray(expr)) expr.forEach(e => collect(e, out));
    else if (isObj(expr)) for (const [k, v] of Object.entries(expr)) k === 'references' && Array.isArray(v) ? out.push(...v) : collect(v, out);
    return out;
  };
  // First pass: every resource address, so references can be matched against them.
  const index = (mod, prefix) => {
    for (const r of mod?.resources || []) known.add(prefix + r.address);
    for (const [name, call] of Object.entries(mod?.module_calls || {})) index(call.module, `${prefix}module.${name}.`);
  };
  index(config?.root_module, '');
  // Resolve one reference written in a module (prefix) to resource addresses. vars: the module's inputs, resolved.
  const resolve = (ref, prefix, vars, mod) => {
    const parts = ref.split('.');
    if (parts[0] === 'var') return vars[parts[1]] || [];
    if (parts[0] === 'module') {
      const call = mod?.module_calls?.[parts[1]];
      const childPrefix = `${prefix}module.${parts[1]}.`;
      const out = parts[2] && call?.module?.outputs?.[parts[2]];
      if (out) return collect(out.expression).flatMap(r => resolve(r, childPrefix, inputsOf(call, prefix, vars, mod), call.module));
      return [...known].filter(a => a.startsWith(childPrefix));
    }
    const addr = prefix + (parts[0] === 'data' ? parts.slice(0, 3) : parts.slice(0, 2)).join('.');
    return known.has(addr) ? [addr] : [];
  };
  const inputsOf = (call, prefix, vars, mod) => Object.fromEntries(Object.entries(call.expressions || {})
    .map(([k, e]) => [k, collect(e).flatMap(r => resolve(r, prefix, vars, mod))]));
  const walk = (mod, prefix, vars) => {
    for (const r of mod?.resources || []) {
      const refs = [...collect(r.expressions), ...collect(r.count_expression), ...collect(r.for_each_expression), ...(r.depends_on || [])];
      for (const ref of refs) for (const dep of resolve(ref, prefix, vars, mod)) if (dep !== prefix + r.address) edges.add(`${dep}\u0000${prefix + r.address}`);
    }
    for (const [name, call] of Object.entries(mod?.module_calls || {})) {
      const inputs = inputsOf(call, prefix, vars, mod);
      const deps = (call.depends_on || []).flatMap(ref => resolve(ref, prefix, vars, mod));
      const childPrefix = `${prefix}module.${name}.`;
      if (deps.length) for (const a of known) if (a.startsWith(childPrefix)) deps.forEach(d => edges.add(`${d}\u0000${a}`));
      walk(call.module, childPrefix, inputs);
    }
  };
  walk(config?.root_module, '', {});
  return [...edges].map(e => e.split('\u0000'));
}

function show(v, sensitive) {
  if (sensitive) return h('span.tfp-v.sens', '(sensitive value)');
  if (v === undefined) return h('span.tfp-v.unk', '(known after apply)');
  if (v === null) return h('span.tfp-v.null', 'null');
  if (Array.isArray(v)) return h('span.tfp-v.null', '[]');
  if (isObj(v)) return h('span.tfp-v.null', '{}');
  if (typeof v === 'string') return h('span.tfp-v.str', v.length > 160 ? `"${v.slice(0, 157)}..."` : `"${v}"`);
  return h('span.tfp-v.num', String(v));
}

export function tfPlan(spec) {
  const plan = spec?.plan;
  const changes = Array.isArray(plan?.resource_changes) ? plan.resource_changes : [];
  if (!changes.length) return null;
  const nodes = changes.map((rc, i) => ({ i, rc, kind: kindOf(rc), addr: rc.address, cfg: strip(rc.address) }));
  const byAddr = new Map(nodes.map(n => [n.addr, n]));
  const drift = (plan.resource_drift || []).filter(d => (d.change?.actions || [])[0] !== 'no-op');

  // Edges between instances: config-level edges fan out to every instance of each side.
  const byCfg = new Map();
  for (const n of nodes) byCfg.set(n.cfg, [...(byCfg.get(n.cfg) || []), n]);
  const edges = [];
  for (const [from, to] of configEdges(plan.configuration))
    for (const a of byCfg.get(from) || []) for (const b of byCfg.get(to) || []) edges.push([a, b]);

  // Layout: a node's column is the length of the longest chain of dependencies under it.
  const deps = new Map(nodes.map(n => [n, []]));
  for (const [a, b] of edges) deps.get(b).push(a);
  const col = new Map();
  const depth = (n, seen = new Set()) => {
    if (col.has(n)) return col.get(n);
    if (seen.has(n)) return 0;
    seen.add(n);
    const d = deps.get(n).length ? 1 + Math.max(...deps.get(n).map(x => depth(x, seen))) : 0;
    col.set(n, d);
    return d;
  };
  nodes.forEach(n => depth(n));

  const counts = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  const add = (counts.create || 0) + (counts.replace || 0) + (counts['replace-cbd'] || 0);
  const change = counts.update || 0;
  const destroy = (counts.delete || 0) + (counts.replace || 0) + (counts['replace-cbd'] || 0);
  const danger = nodes.filter(n => destructive(n.kind));

  let hideNoop = nodes.filter(n => n.kind === 'noop').length > 4;
  let showSame = false;
  let selected = byAddr.get(spec.focus) || danger[0] || nodes.find(n => n.kind !== 'noop') || nodes[0];

  const graphBox = h('div.tfp-graph', { role: 'listbox', 'aria-label': 'Resources in the plan' });
  const detail = h('div.tfp-detail', { 'aria-live': 'polite' });

  const downstream = start => {
    const out = new Set(), todo = [start];
    while (todo.length) { const n = todo.pop(); for (const [a, b] of edges) if (a === n && !out.has(b)) { out.add(b); todo.push(b); } }
    return out;
  };

  function drawGraph() {
    const shown = nodes.filter(n => !hideNoop || n.kind !== 'noop' || n === selected);
    const columns = [];
    for (const n of shown) (columns[col.get(n)] ||= []).push(n);
    const cols = columns.filter(Boolean);
    cols.forEach(c => c.sort((a, b) => a.addr.localeCompare(b.addr, 'en')));
    const W = 226, H = 50, GX = 54, GY = 12, PAD = 10;
    const pos = new Map();
    cols.forEach((c, x) => c.forEach((n, y) => pos.set(n, { x: PAD + x * (W + GX), y: PAD + y * (H + GY) })));
    const width = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * GX;
    const height = PAD * 2 + Math.max(...cols.map(c => c.length)) * (H + GY) - GY;
    const near = downstream(selected);
    const up = new Set(deps.get(selected) || []);
    const lines = edges.filter(([a, b]) => pos.has(a) && pos.has(b)).map(([a, b]) => {
      const p = pos.get(a), q = pos.get(b);
      const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2, mx = (x1 + x2) / 2;
      const hot = a === selected || (near.has(a) && near.has(b)) ? ' hot' : up.has(a) && b === selected ? ' up' : '';
      return `<path class="tfp-edge${hot}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#tfp-arrow)"/>`;
    }).join('');
    const cut = (s, n) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);
    const boxes = shown.map(n => {
      const { x, y } = pos.get(n);
      const k = KIND[n.kind];
      const modPart = n.addr.match(/^(.*\.)?((?:data\.)?[^.]+\.[^.]+(?:\[[^\]]*\])?)$/);
      const mod = modPart?.[1]?.replace(/\.$/, '') || '';
      const own = modPart?.[2] || n.addr;
      const [type, ...rest] = own.replace(/^data\./, '').split('.');
      const forces = (n.rc.change?.replace_paths || []).length;
      const cls = `tfp-node k-${n.kind}${n === selected ? ' sel' : ''}${near.has(n) ? ' blast' : ''}`;
      return `<g class="${cls}" data-i="${n.i}" tabindex="-1" role="option" aria-selected="${n === selected}">
        <title>${esc(n.addr)}: ${esc(k.verb)}</title>
        <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="9"/>
        <rect class="tfp-bar" x="${x}" y="${y}" width="5" height="${H}" rx="2"/>
        <text class="tfp-sym" x="${x + 14}" y="${y + 31}">${esc(k.sym)}</text>
        <text class="tfp-type" x="${x + 46}" y="${y + 19}">${esc(cut((own.startsWith('data.') ? 'data.' : '') + type, 26))}${mod ? `<tspan class="tfp-mod"> ${esc(cut(mod, 14))}</tspan>` : ''}</text>
        <text class="tfp-name" x="${x + 46}" y="${y + 37}">${esc(cut(rest.join('.'), 22))}</text>
        ${forces ? `<text class="tfp-force" x="${x + W - 8}" y="${y + 37}" text-anchor="end">forces</text>` : ''}
      </g>`;
    }).join('');
    graphBox.innerHTML = `<svg class="tfp-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="presentation">
      <defs><marker id="tfp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>
      ${lines}${boxes}</svg>`;
  }

  function drawDetail() {
    const n = selected, rc = n.rc, k = KIND[n.kind];
    const rows = diffRows(rc);
    const changed = rows.filter(r => r.op !== '=');
    const same = rows.length - changed.length;
    const list = showSame || n.kind === 'create' || n.kind === 'delete' ? rows : changed;
    const reason = rc.action_reason && REASON[rc.action_reason];
    const near = downstream(n);
    const extra = [];
    if (rc.previous_address && rc.previous_address !== rc.address) extra.push(h('p.tfp-note', { html: inline(`Moved from \`${rc.previous_address}\` (a \`moved\` block or \`terraform state mv\`).`) }));
    if (rc.change?.importing) extra.push(h('p.tfp-note', { html: inline(`Imported from the real object with ID \`${rc.change.importing.id ?? '(by identity)'}\`.`) }));
    if (destructive(n.kind) && near.size) extra.push(h('p.tfp-note.warn', { html: inline(`Blast radius: ${near.size} resource${near.size === 1 ? '' : 's'} downstream use${near.size === 1 ? 's' : ''} this one (highlighted in the graph): ${[...near].slice(0, 6).map(x => `\`${x.addr}\``).join(', ')}${near.size > 6 ? ', …' : ''}.`) }));
    detail.replaceChildren(
      h(`div.tfp-dhead.k-${n.kind}`, h('span.tfp-dsym', k.sym), h('div', h('code.tfp-daddr', n.addr), h('div.tfp-dverb', `${k.verb}`))),
      reason && h('p.tfp-reason', { html: inline(reason) }),
      ...extra,
      list.length ? h('table.tfp-diff', h('thead', h('tr', h('th', ''), h('th', 'Attribute'), h('th', 'Before'), h('th', ''), h('th', 'After'))),
        h('tbody', list.map(r => h(`tr.op-${r.op === '+' ? 'add' : r.op === '-' ? 'del' : r.op === '~' ? 'chg' : 'same'}${r.forces ? '.forces' : ''}`,
          h('td.tfp-op', r.op === '=' ? '' : r.op),
          h('td.tfp-attr', r.path, r.forces && h('span.tfp-forces', 'forces replacement')),
          h('td', r.op === '+' ? '' : show(r.before, r.sensBefore)),
          h('td.tfp-arrow', r.op === '~' ? '→' : ''),
          h('td', r.op === '-' ? h('span.tfp-v.null', 'null') : show(r.unknown ? undefined : r.after, r.sensAfter && !r.unknown))))))
        : h('p.muted.small', 'No attribute changes.'),
      same && n.kind !== 'create' && n.kind !== 'delete' && h('button.btn.ghost.small', { type: 'button', onclick: () => { showSame = !showSame; drawDetail(); } },
        showSame ? 'Hide unchanged attributes' : `Show ${same} unchanged attribute${same === 1 ? '' : 's'}`),
      h('details.tfp-raw', h('summary.muted.small', 'This change as JSON'),
        h('p.muted.small', { html: inline(`\`terraform show -json plan.tfplan | jq '.resource_changes[] | select(.address == "${n.addr.replace(/"/g, '\\"')}")'\``) }),
        h('pre.tfp-json', JSON.stringify({ address: rc.address, action_reason: rc.action_reason, change: { actions: rc.change?.actions, replace_paths: rc.change?.replace_paths } }, null, 2))));
  }

  function select(n) { if (!n) return; selected = n; drawGraph(); drawDetail(); }
  graphBox.addEventListener('click', e => { const g = e.target.closest('[data-i]'); if (g) select(nodes[Number(g.dataset.i)]); });

  const chip = (kind, n, label) => n ? h(`span.tfp-count.k-${kind}`, h('b', String(n)), ` ${label}`) : null;
  const order = [...nodes].sort((a, b) => col.get(a) - col.get(b) || a.addr.localeCompare(b.addr, 'en'));
  const noops = counts.noop || 0;
  const toggle = noops && h('button.btn.ghost.small', { type: 'button', onclick: () => { hideNoop = !hideNoop; toggle.textContent = hideNoop ? `Show ${noops} unchanged` : 'Hide unchanged'; drawGraph(); } },
    hideNoop ? `Show ${noops} unchanged` : 'Hide unchanged');

  const banner = danger.length
    ? h('div.tfp-banner.bad', h('b', `This plan destroys ${destroy} object${destroy === 1 ? '' : 's'}.`), ' ',
      danger.map((n, i) => [i ? ', ' : '', h('button.tfp-link', { type: 'button', onclick: () => select(n) }, `${KIND[n.kind].sym} ${n.addr}`)]),
      '. Read those first.')
    : h('div.tfp-banner.good', 'Nothing is destroyed or replaced by this plan.');

  const el = h('div.tfp', { tabindex: 0, 'aria-label': 'Terraform plan review' },
    h('div.tfp-head', h('b', spec.title || 'Plan review'), h('span.spacer'),
      plan.terraform_version && h('span.muted.small', `terraform ${plan.terraform_version} · show -json format ${plan.format_version || '?'}`)),
    spec.note && h('p.tfp-intro', { html: inline(spec.note) }),
    h('div.tfp-summary', h('code.tfp-planline', `Plan: ${add} to add, ${change} to change, ${destroy} to destroy.`),
      chip('create', counts.create, 'create'), chip('update', counts.update, 'update'),
      chip('replace', (counts.replace || 0) + (counts['replace-cbd'] || 0), 'replace'), chip('delete', counts.delete, 'destroy'),
      chip('read', counts.read, 'read'), chip('import', counts.import, 'import'), chip('move', counts.move, 'moved'), chip('forget', counts.forget, 'forget'),
      h('span.spacer'), toggle),
    banner,
    drift.length && h('div.tfp-banner.warn', h('b', 'Changed outside of Terraform: '), drift.map((d, i) => [i ? ', ' : '', h('code', d.address)]),
      '. The plan below starts from what is really there now.'),
    h('div.tfp-main', h('div.tfp-graphwrap', graphBox, h('div.tfp-legend', Object.entries(KIND).filter(([k]) => k !== 'replace-cbd' && (counts[k] || (k === 'replace' && counts['replace-cbd']))).map(([k, v]) => h(`span.k-${k}`, h('i'), `${v.sym.trim() || '·'} ${v.label}`)),
      h('span.muted', 'Arrows: dependency → dependent. Click a resource; ← → to step.'))), detail),
    plan.output_changes && Object.keys(plan.output_changes).length ? h('div.tfp-outputs', h('span.muted.small', 'Outputs: '),
      Object.entries(plan.output_changes).map(([name, oc]) => h(`span.tfp-out.k-${kindOf({ change: oc })}`, `${KIND[kindOf({ change: oc })].sym.trim() || '·'} ${name}`))) : null);
  el.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, button, summary')) return;
    const at = order.indexOf(selected);
    const visible = n => !hideNoop || n.kind !== 'noop';
    const step = d => { for (let i = at + d; i >= 0 && i < order.length; i += d) if (visible(order[i])) return order[i]; return null; };
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select(step(1)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); select(step(-1)); }
  });
  drawGraph();
  drawDetail();
  return el;
}
