// SQL visuals for lesson steps (server side: server/SqlViz.cs).
//
//   sqlflow     rows flowing through a query, clause by clause in the order the database applies them:
//               FROM, JOIN (which rows pair, which drop, LEFT JOIN NULLs), WHERE (TRUE / FALSE / NULL per row),
//               GROUP BY buckets and their aggregates, HAVING, a window function (partition, order and the frame
//               sliding row by row), SELECT, ORDER BY, LIMIT. Every stage is computed by real SQLite.
//   sqlplan     SQLite's EXPLAIN QUERY PLAN as a tree, before and after an index (or a rewrite), with the work
//               SQLite really did. sqlPlanButton() puts the same view under a SQL code step for the learner's query.
//   pgplan      a PostgreSQL EXPLAIN (ANALYZE, BUFFERS) text, parsed into a tree with estimated vs actual rows,
//               loops, time and buffers called out. Read-only: there is no PostgreSQL engine here.
//   txtimeline  two sessions side by side over time (transactions, locks, isolation anomalies).
import { h, api, esc, inline, highlight } from './util.js';
import { sqlGrid } from './sqlgrid.js';

/** Every SQL visual a step carries, in a fixed order. */
export function sqlVisuals(step) {
  return [
    step.sqlflow && sqlFlow(step.sqlflow),
    step.sqlplan && sqlPlan(step.sqlplan),
    step.pgplan && pgPlan(step.pgplan),
    step.txtimeline && txTimeline(step.txtimeline),
  ].filter(Boolean);
}

/** Non-learn steps (mcq, predict, ...) may carry a visual too: it goes right under the prompt. */
export function withSqlVisuals(rendered, step) {
  if (!rendered?.el || step.type === 'learn') return rendered;
  const vis = sqlVisuals(step);
  if (!vis.length) return rendered;
  const anchor = rendered.el.querySelector(':scope > .prompt') || rendered.el.querySelector('.prompt');
  if (anchor) anchor.after(...vis); else rendered.el.prepend(...vis);
  return rendered;
}

const fmt = n => Number(n).toLocaleString('en-US');
const sqlHtml = text => highlight(text, 'sql');

// ---------------------------------------------------------------- the step player

/**
 * Play / step / back over `count` frames. render(i) draws frame i (0-based). Keyboard on the box:
 * left and right arrows step, Home and End jump, space plays.
 */
function player(box, { count, render, stages = [], stageOf = () => 0, speed = 1100 }) {
  let at = 0, timer = null;
  const pos = h('span.sv-pos.small.muted');
  const playBtn = h('button.btn.primary.small', { type: 'button', onclick: () => (timer ? pause() : play()) }, '▶ Play');
  const backBtn = h('button.btn.ghost.small', { type: 'button', title: 'Back one step (←)', onclick: () => { pause(); go(at - 1); } }, '◀ Back');
  const nextBtn = h('button.btn.ghost.small', { type: 'button', title: 'Next step (→)', onclick: () => { pause(); go(at + 1); } }, 'Next ▶');
  const startBtn = h('button.btn.ghost.small', { type: 'button', title: 'Back to the start (Home)', onclick: () => { pause(); go(0); } }, '⏮');
  const speedIn = h('input', { type: 'range', min: 300, max: 2200, value: 2500 - speed, title: 'Speed', 'aria-label': 'Speed',
    oninput: e => { speed = 2500 - Number(e.target.value); } });
  const chips = h('div.sv-stages', stages.map((s, i) => h('button.sv-stage', { type: 'button', title: s.title || '', onclick: () => { pause(); go(s.first); } },
    h('span.sv-stage-n', String(i + 1)), s.label)));

  function go(i) {
    at = Math.max(0, Math.min(count - 1, i));
    render(at);
    pos.textContent = `step ${at + 1} of ${count}`;
    backBtn.disabled = at === 0; startBtn.disabled = at === 0; nextBtn.disabled = at >= count - 1;
    const cur = stageOf(at);
    [...chips.children].forEach((c, k) => { c.classList.toggle('on', k === cur); c.classList.toggle('past', k < cur); });
    if (!timer) playBtn.textContent = at >= count - 1 ? '↺ Replay' : at > 0 ? '▶ Resume' : '▶ Play';
  }
  function play() {
    if (at >= count - 1) go(0);
    playBtn.textContent = '❚❚ Pause';
    const tick = () => { if (at < count - 1) { go(at + 1); timer = setTimeout(tick, speed); } else pause(); };
    timer = setTimeout(tick, Math.min(speed, 500));
  }
  function pause() { clearTimeout(timer); timer = null; go(at); }

  box.tabIndex = 0;
  box.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); pause(); go(at + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); go(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); pause(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); pause(); go(count - 1); }
    else if (e.key === ' ' && e.target === box) { e.preventDefault(); timer ? pause() : play(); }
  });
  const controls = h('div.sv-controls', startBtn, backBtn, playBtn, nextBtn, pos, h('span.spacer'), h('span.muted.small', 'speed'), speedIn);
  return { controls, chips: stages.length ? chips : null, go, pause };
}

// ---------------------------------------------------------------- grids

/**
 * A compact grid. rows: [{ key, cells: [...], cls?: 'cur hit ...', extra?: Node, stripe?: color }]
 * opts: { extraHead, refCols: Set of column indexes to tint, title }
 */
function grid(columns, rows, { extraHead, refCols, title, empty = 'no rows' } = {}) {
  const num = columns.map((_, i) => rows.length > 0 && rows.every(r => r.cells?.[i] == null || /^-?\d+(\.\d+)?$/.test(r.cells[i])));
  const ref = i => (refCols?.has(i) ? '.ref' : '');
  return h('div.sv-gridbox',
    title && h('div.sv-gridtitle', { html: title }),
    h('table.sv-grid',
      h('thead', h('tr', columns.map((c, i) => h(`th${ref(i)}${num[i] ? '.num' : ''}`, c)), extraHead && h('th.sv-extra', extraHead))),
      h('tbody', rows.length
        ? rows.map(r => h(`tr${r.cls ? '.' + r.cls.trim().split(/\s+/).join('.') : ''}`, r.stripe ? { style: { '--sv-stripe': r.stripe } } : null,
          r.marker ? h('td.sv-marker', { colSpan: columns.length + (extraHead ? 1 : 0) }, r.marker)
            : [r.cells.map((v, i) => v == null ? h(`td.null${ref(i)}`, 'NULL') : h(`td${ref(i)}${num[i] ? '.num' : ''}`, v)),
              extraHead && h('td.sv-extra', r.extra ?? '')]))
        : h('tr', h('td.muted.small', { colSpan: columns.length + (extraHead ? 1 : 0) }, empty)))));
}

const PALETTE = ['var(--rx6)', 'var(--rx2)', 'var(--rx1)', 'var(--rx4)', 'var(--rx5)', 'var(--rx3)', 'var(--rx7)', 'var(--rx8)'];
const colour = i => PALETTE[i % PALETTE.length];

const verdictChip = v => v === true ? h('span.sv-v.t', 'TRUE') : v === false ? h('span.sv-v.f', 'FALSE') : h('span.sv-v.n', 'NULL');

/** Which columns does an expression mention? "o.total > 20" tints o.total (and a bare "total"). */
function mentioned(columns, ...texts) {
  const text = texts.filter(Boolean).join(' ');
  const set = new Set();
  const safe = s => String(s).replace(/[^\w]/g, '');
  columns.forEach((c, i) => {
    const [alias, col] = c.includes('.') ? c.split('.').map(safe) : [null, safe(c)];
    if (!col) return;
    // "o.total" matches o.total, and a bare "total" that is not someone else's column (x.total).
    const qualified = alias && new RegExp(`\\b${alias}\\.${col}\\b`, 'i').test(text);
    const bare = new RegExp(`(?<![\\w.])${col}\\b`, 'i').test(text);
    if (qualified || bare) set.add(i);
  });
  return set;
}

// ---------------------------------------------------------------- sqlflow

export function sqlFlow(spec) {
  const box = h('div.sv.sv-flow');
  const head = h('div.sv-head', h('b', 'Rows through the query'), h('span.muted.small', ' every step below is computed by SQLite, in the order the database applies the clauses'));
  box.append(head, h('div.muted.small', 'Running the query…'));
  api('sqlflow', spec).then(r => {
    if (r.error || !r.data) { box.replaceChildren(head, h('div.callout.warn', 'This visual could not run: ' + (r.error || 'no data'))); return; }
    mountFlow(box, head, r.data, spec);
  }).catch(() => box.replaceChildren(head, h('div.callout.warn', 'Could not reach the dojo server.')));
  return box;
}

function mountFlow(box, head, d, spec) {
  const T = d.tables;
  const prefixCols = d.prefixes.map(p => p.columns);
  const lastCols = prefixCols[prefixCols.length - 1];
  const lastRows = d.prefixes[d.prefixes.length - 1].rows;
  const leftOrders = [T[0].rows.map(r => r.id)];
  d.joins.forEach(j => leftOrders.push([...j.steps.flatMap(s => s.outs), ...j.unmatched.map(u => u.key)]));
  const label = (cols, cells) => {
    const parts = cells.map((v, i) => [cols[i], v]).filter(([c, v]) => v != null && !/\.(id|.*_id)$/.test(c)).slice(0, 2);
    return parts.length ? parts.map(([, v]) => v).join(', ') : cells.filter(v => v != null).slice(0, 2).join(', ');
  };

  // Window rows in the order they are computed: partition by partition, by position.
  let winOrder = [];
  if (d.window) {
    const parts = [];
    for (const k of d.survivors) { const w = d.window.rows[k]; if (w && !parts.includes(w.p)) parts.push(w.p); }
    winOrder = d.survivors.slice().sort((a, b) => parts.indexOf(d.window.rows[a].p) - parts.indexOf(d.window.rows[b].p) || d.window.rows[a].pos - d.window.rows[b].pos);
  }

  // ---- frames, and the stage strip above them (in logical order)
  const frames = [];
  const stages = [];
  const stage = (label, key, title) => { stages.push({ label, key, first: frames.length, title }); return stages.length - 1; };
  let s = stage('FROM', 'from', 'Start from every row of the first table');
  frames.push({ s, kind: 'from' });
  d.joins.forEach((j, k) => {
    s = stage(j.kind === 'INNER' ? 'JOIN' : `${j.kind} JOIN`, `join${k}`, j.text);
    j.steps.forEach((_, i) => frames.push({ s, kind: 'join', k, i }));
    if (j.unmatched.length) frames.push({ s, kind: 'join', k, i: j.steps.length, orphans: true });
  });
  if (d.where) { s = stage('WHERE', 'where', 'Keep rows where the condition is TRUE'); d.order.forEach((_, i) => frames.push({ s, kind: 'where', i })); }
  if (d.groups) {
    s = stage('GROUP BY', 'group', 'Put rows with the same key into one bucket');
    d.survivors.forEach((_, i) => frames.push({ s, kind: 'group', i }));
    frames.push({ s, kind: 'agg' });
    if (d.having) { s = stage('HAVING', 'having', 'Keep buckets where the condition is TRUE'); d.groups.buckets.forEach((_, i) => frames.push({ s, kind: 'having', i })); }
  }
  if (d.window) { s = stage('OVER (…)', 'select', 'The window function, row by row'); winOrder.forEach((_, i) => frames.push({ s, kind: 'window', i })); }
  s = stage('SELECT', 'select', 'Compute and name the output columns');
  frames.push({ s, kind: 'select' });
  if (d.sorted) { s = stage('ORDER BY', 'order', 'Sort the finished rows'); frames.push({ s, kind: 'order' }); }
  if (d.limit != null) { s = stage(d.offset ? 'LIMIT / OFFSET' : 'LIMIT', 'limit', 'Keep only the first rows'); frames.push({ s, kind: 'limit' }); }
  s = stage('Result', 'result', 'The real result from SQLite');
  frames.push({ s, kind: 'result' });

  // ---- the query, in written order, with the logical step number beside each clause
  const stepNo = key => stages.findIndex(st => st.key === key) + 1;
  const lines = d.clauses.map(c => {
    const n = c.key === 'select' ? stages.findIndex(st => st.label === 'SELECT') + 1 : stepNo(c.key);
    return { key: c.key, el: h('div.sv-qline', h('span.sv-qn', { title: 'The order the database applies it' }, n > 0 ? String(n) : ''), h('code', { html: sqlHtml(c.text) })) };
  });
  const query = h('div.sv-query', lines.map(l => l.el));
  const stageArea = h('div.sv-stage-area');
  const caption = h('div.sv-caption');

  const rowsOf = (keys, cols, rows, decorate) => keys.map((key, i) => ({ key, cells: rows[key] ?? cols.map(() => null), ...decorate?.(key, i) }));
  const whereRefs = d.where ? mentioned(lastCols, d.where.text) : null;

  function render(fi) {
    const f = frames[fi];
    const st = stages[f.s];
    for (const l of lines) l.el.classList.toggle('on', st.key === 'result' || l.key === st.key || (f.kind === 'window' && l.key === 'select'));
    let body, say;
    switch (f.kind) {
      case 'from': {
        const t = T[0];
        body = grid(prefixCols[0], t.rows.map(r => ({ key: r.id, cells: r.v })), { title: `<code>${esc(t.name)} ${t.alias !== t.name ? esc(t.alias) : ''}</code> · ${t.rows.length} rows` });
        say = `<b>FROM</b> comes first, even though it is written second. The database starts with every row of <code>${esc(t.name)}</code> (${t.rows.length} rows). Nothing is filtered yet.`;
        break;
      }
      case 'join': {
        const j = d.joins[f.k];
        const leftKeys = leftOrders[f.k];
        const leftCols = prefixCols[f.k];
        const leftRows = d.prefixes[f.k].rows;
        const right = T[f.k + 1];
        const outCols = prefixCols[f.k + 1];
        const outRows = d.prefixes[f.k + 1].rows;
        const cur = f.orphans ? null : j.steps[f.i];
        const doneSteps = j.steps.slice(0, f.orphans ? j.steps.length : f.i + 1);
        const outKeys = [...doneSteps.flatMap(x => x.outs), ...(f.orphans ? j.unmatched.map(u => u.key) : [])];
        const fresh = new Set(f.orphans ? j.unmatched.map(u => u.key) : cur.outs);
        const hits = new Set(f.orphans ? j.unmatched.map(u => u.right) : cur.matches);
        const everHit = new Set(doneSteps.flatMap(x => x.matches));
        const isNullRow = key => key.split(',').includes('~');
        const stepIndex = new Map(j.steps.map((x, i) => [x.left, i]));
        const left = grid(leftCols, rowsOf(leftKeys, leftCols, leftRows, key => {
          const i = stepIndex.get(key);
          const dropped = i < (f.orphans ? j.steps.length : f.i) && j.steps[i].outs.length === 0;
          return { cls: (cur && key === cur.left ? 'cur ' : '') + (i < (f.orphans ? j.steps.length : f.i) ? 'done ' : '') + (dropped ? 'drop' : '') };
        }), { title: f.k === 0 ? `<code>${esc(T[0].name)}</code>` : 'Rows so far' });
        const rightGrid = grid(right.columns.map(c => `${right.alias}.${c}`), right.rows.map(r => ({
          key: r.id, cells: r.v, cls: hits.has(r.id) ? (f.orphans ? 'orphan' : 'hit') : everHit.has(r.id) ? 'used' : '',
        })), { title: `<code>${esc(right.name)} ${esc(right.alias)}</code>`, refCols: mentioned(right.columns.map(c => `${right.alias}.${c}`), j.on) });
        const out = grid(outCols, rowsOf(outKeys, outCols, outRows, key => ({ cls: (fresh.has(key) ? 'fresh ' : '') + (isNullRow(key) ? 'nullrow' : '') })),
          { title: `Joined rows · ${outKeys.length}`, empty: 'none yet' });
        body = h('div.sv-join', h('div.sv-pane', left), h('div.sv-join-mid', h('code.sv-on', { html: sqlHtml(j.kind === 'CROSS' ? 'CROSS JOIN' : 'ON ' + j.on) }), h('span.sv-arrow', '→')), h('div.sv-pane', rightGrid), h('div.sv-pane.sv-out', out));
        if (f.orphans) say = `<b>${j.kind} JOIN</b> also keeps rows of <code>${esc(right.name)}</code> that matched nothing on the left: ${j.unmatched.length} of them, with <span class="sv-nullword">NULL</span> in every left-hand column.`;
        else {
          const who = `<b>${esc(label(leftCols, leftRows[cur.left] || []))}</b>`;
          const n = cur.matches.length;
          if (j.kind === 'CROSS') say = `${who} pairs with every one of the ${n} rows of <code>${esc(right.name)}</code>: a CROSS JOIN has no condition.`;
          else if (n > 0) say = `${who}: <code>${esc(j.on)}</code> is true for ${n} row${n === 1 ? '' : 's'} of <code>${esc(right.name)}</code>, so it comes out ${n === 1 ? 'once' : `${n} times`}${n > 1 ? ', once per match' : ''}.`;
          else if (cur.kept) say = `${who} matches nothing. <b>${j.kind} JOIN keeps it anyway</b> and fills the <code>${esc(right.alias)}</code> columns with <span class="sv-nullword">NULL</span>.`;
          else say = `${who} matches nothing, so the <b>inner join drops it</b>. It is gone from every later step.`;
          if (fi === frames.findIndex(x => x.kind === 'join' && x.k === f.k) + j.steps.length - 1 && !j.unmatched.length)
            say += ` <span class="muted">${leftKeys.length} rows in, ${outKeys.length} rows out.</span>`;
        }
        break;
      }
      case 'where': {
        const v = d.where.verdict;
        const rows = rowsOf(d.order, lastCols, lastRows, (key, i) => ({
          cls: (i === f.i ? 'cur ' : '') + (i <= f.i && v[key] !== true ? 'drop' : ''),
          extra: i <= f.i ? verdictChip(v[key]) : '',
        }));
        body = grid(lastCols, rows, { extraHead: 'WHERE', refCols: whereRefs, title: `<code>${esc('WHERE ' + d.where.text)}</code>` });
        const key = d.order[f.i];
        const what = `Row ${f.i + 1} (<b>${esc(label(lastCols, lastRows[key] || []))}</b>): <code>${esc(d.where.text)}</code> is`;
        say = v[key] === true ? `${what} <span class="sv-v t">TRUE</span>, so the row stays.`
          : v[key] === false ? `${what} <span class="sv-v f">FALSE</span>, so the row goes.`
          : `${what} <span class="sv-v n">NULL</span>: unknown, because a value it compares is NULL. WHERE keeps only TRUE, so the row goes, exactly like FALSE.`;
        if (f.i === d.order.length - 1) say += ` <span class="muted">${d.survivors.length} of ${d.order.length} rows survive.</span>`;
        break;
      }
      case 'group': case 'agg': case 'having': {
        const g = d.groups;
        const upto = f.kind === 'group' ? f.i : d.survivors.length - 1;
        const seen = d.survivors.slice(0, upto + 1);
        const bucketIndex = new Map(g.buckets.map((b, i) => [b.key, i]));
        const refs = mentioned(lastCols, ...g.by);
        const left = grid(lastCols, rowsOf(d.survivors, lastCols, lastRows, (key, i) => ({
          cls: (f.kind === 'group' && i === f.i ? 'cur ' : '') + (i <= upto ? 'done' : ''),
          stripe: i <= upto ? colour(bucketIndex.get(g.assign[key])) : null,
        })), { title: d.where ? 'Rows after WHERE' : 'Rows', refCols: refs });
        const cards = g.buckets.map((b, bi) => {
          const members = b.members.filter(m => seen.includes(m));
          if (!members.length) return null;
          const dropped = f.kind === 'having' && bi <= f.i && b.keep !== true;
          const showAgg = f.kind !== 'group';
          return h(`div.sv-bucket${dropped ? '.drop' : ''}${f.kind === 'having' && bi === f.i ? '.cur' : ''}${f.kind === 'group' && g.assign[d.survivors[f.i]] === b.key ? '.cur' : ''}`, { style: { '--sv-stripe': colour(bi) } },
            h('div.sv-bucket-head', g.by.map((expr, i) => h('span.sv-bucket-key', h('code', expr), ' = ', b.label?.[i] == null ? h('span.sv-nullword', 'NULL') : h('b', b.label[i]))),
              h('span.muted.small', `${members.length} row${members.length === 1 ? '' : 's'}`),
              f.kind === 'having' && bi <= f.i ? verdictChip(b.keep) : null),
            h('div.sv-bucket-rows', members.map(m => h('div.sv-chiprow', (lastRows[m] || []).map((v, i) => refs.has(i) ? null : h(`span${v == null ? '.null' : ''}`, v ?? 'NULL'))))),
            showAgg && b.values && h('div.sv-agg', g.columns.map((c, i) => h('span.sv-aggcell', h('span.muted.small', c), h('b', b.values[i] ?? 'NULL')))));
        });
        body = h('div.sv-group', h('div.sv-pane', left), h('div.sv-buckets', cards));
        if (f.kind === 'group') {
          const key = d.survivors[f.i];
          const b = g.buckets[bucketIndex.get(g.assign[key])];
          const first = b.members[0] === key;
          say = `Row ${f.i + 1} has ${g.by.map((e, i) => `<code>${esc(e)}</code> = <b>${esc(b.label?.[i] ?? 'NULL')}</b>`).join(', ')}, so it goes into ${first ? '<b>a new bucket</b>' : 'that bucket'}.`;
          if (b.label?.some(v => v == null)) say += ' All the NULLs share one bucket: GROUP BY treats NULL as one group.';
        } else if (f.kind === 'agg') say = `Each bucket collapses to <b>one row</b>. The aggregates (${g.columns.filter(c => /\(/.test(c)).map(c => `<code>${esc(c)}</code>`).join(', ') || 'COUNT, SUM, ...'}) are computed over the rows inside it. From here on there are ${g.buckets.length} rows, not ${d.survivors.length}.`;
        else {
          const b = g.buckets[f.i];
          say = `Bucket <b>${esc((b.label || []).join(', '))}</b>: <code>${esc(d.having)}</code> is ${b.keep === true ? '<span class="sv-v t">TRUE</span>, kept.' : b.keep === false ? '<span class="sv-v f">FALSE</span>, dropped.' : '<span class="sv-v n">NULL</span>, dropped.'} HAVING filters whole buckets, after the aggregates exist, which is why it can say <code>COUNT(*)</code> and WHERE cannot.`;
        }
        break;
      }
      case 'window': {
        const w = d.window;
        const cols = d.projected.columns;
        const vcol = cols.length - 1;
        const curKey = winOrder[f.i];
        const cw = w.rows[curKey];
        const done = new Set(winOrder.slice(0, f.i + 1));
        const parts = [];
        for (const k of winOrder) { const p = w.rows[k].p; if (!parts.includes(p)) parts.push(p); }
        const blocks = parts.map((p, pi) => {
          const keys = winOrder.filter(k => w.rows[k].p === p);
          const sample = w.rows[keys[0]];
          return grid(cols, keys.map(k => {
            const r = w.rows[k];
            const inFrame = w.kind === 'frame' && r.p === cw.p && r.pos >= cw.lo && r.pos <= cw.hi;
            const source = w.kind === 'offset' && r.p === cw.p && r.pos === cw.pos + w.offset;
            const cells = (d.projected.rows[k] || []).slice();
            if (!done.has(k)) cells[vcol] = '';
            return { key: k, cells, cls: (k === curKey ? 'cur ' : '') + (inFrame ? 'inframe ' : '') + (source ? 'hit ' : '') + (done.has(k) ? '' : 'todo'), stripe: colour(pi) };
          }), { title: w.partitionBy.length ? `Partition ${w.partitionBy.map((e, i) => `<code>${esc(e)}</code> = <b>${esc(sample.plabel[i] ?? 'NULL')}</b>`).join(', ')}` : 'One window: the whole result' });
        });
        body = h('div.sv-window', h('div.sv-over', h('code', { html: sqlHtml(w.sql) })), h('div.sv-parts', blocks));
        const who = `Row ${cw.pos}${w.partitionBy.length ? ' of its partition' : ''}`;
        if (w.kind === 'frame') {
          const frameText = w.frame ? `<code>${esc(w.frame)}</code>` : w.orderBy.length ? 'the default frame (with ORDER BY: from the first row of the partition up to this row and any ties with it)' : 'the whole partition (no ORDER BY means no frame to slide)';
          say = `${who}: the frame is ${cw.lo === cw.hi ? `row ${cw.lo} only` : `rows ${cw.lo} to ${cw.hi}`}, from ${frameText}. <code>${esc(w.fn)}</code> over those rows = <b>${esc(cw.val ?? 'NULL')}</b>.`;
        } else if (w.kind === 'offset') {
          const target = cw.pos + w.offset;
          say = `${who}: <code>${esc(w.fn)}</code> looks ${Math.abs(w.offset)} row${Math.abs(w.offset) === 1 ? '' : 's'} ${w.offset < 0 ? 'back' : 'ahead'} in the partition, at row ${target}. ${cw.val == null ? 'There is no row there (or its value is NULL), so the result is <span class="sv-nullword">NULL</span>.' : `That gives <b>${esc(cw.val)}</b>.`}`;
        } else say = `${who}: <code>${esc(w.fn)}</code> = <b>${esc(cw.val ?? 'NULL')}</b>, its place in the order <code>${esc(w.orderBy.join(', '))}</code>${w.partitionBy.length ? ', counted again from 1 in every partition' : ''}. Ties share a rank with RANK and DENSE_RANK, never with ROW_NUMBER.`;
        if (f.i === 0) say += ' <span class="muted">Unlike GROUP BY, a window keeps every row and adds a column.</span>';
        break;
      }
      case 'select': {
        if (d.groups) {
          const kept = d.groups.buckets.filter(b => b.keep === true);
          body = grid(d.groups.columns, kept.map(b => ({ key: b.key, cells: b.values })), { title: 'One row per bucket' });
        } else body = grid(d.projected.columns, d.survivors.map(k => ({ key: k, cells: d.projected.rows[k] })), { title: 'The output columns' });
        say = '<b>SELECT</b> runs late: only now are the output columns computed and given their names. That is why WHERE cannot use an alias defined in SELECT, but ORDER BY can.';
        if (d.groups) say += ' After GROUP BY, every column must be a group key or an aggregate.';
        break;
      }
      case 'order': case 'limit': {
        const cols = d.groups ? d.groups.columns : d.projected.columns;
        const values = d.groups ? Object.fromEntries(d.groups.buckets.map(b => [b.key, b.values])) : d.projected.rows;
        const before = d.groups ? d.groups.buckets.filter(b => b.keep === true).map(b => b.key) : d.survivors;
        const keys = (d.sorted || before).filter(k => before.includes(k));
        const from = d.offset || 0, to = d.limit == null ? keys.length : from + d.limit;
        const rows = [];
        keys.forEach((k, i) => {
          if (f.kind === 'limit' && i === to && to < keys.length) rows.push({ key: 'cut', marker: `LIMIT ${d.limit}: the ${keys.length - to} row${keys.length - to === 1 ? '' : 's'} below ${keys.length - to === 1 ? 'is' : 'are'} thrown away` });
          rows.push({ key: k, cells: values[k], cls: f.kind === 'limit' && (i < from || i >= to) ? 'drop' : '', extra: d.sorted ? `#${before.indexOf(k) + 1}` : '' });
        });
        body = grid(cols, rows, { extraHead: d.sorted ? 'was' : null, refCols: d.sorted ? mentioned(cols, ...(spec.orderBy ? [].concat(spec.orderBy) : [])) : null, title: f.kind === 'order' ? `<code>ORDER BY ${esc([].concat(spec.orderBy).join(', '))}</code>` : `<code>LIMIT ${d.limit}${d.offset ? ' OFFSET ' + d.offset : ''}</code>` });
        say = f.kind === 'order'
          ? '<b>ORDER BY</b> sorts the finished rows. Without it, SQL promises no order at all, even if the rows often come out in a tidy-looking one.'
          : `<b>LIMIT</b> keeps the first ${d.limit} row${d.limit === 1 ? '' : 's'}${d.offset ? ` after skipping ${d.offset}` : ''}. It runs last, so “top 3” only means something after ORDER BY.`;
        break;
      }
      case 'result':
        body = h('div', sqlGrid(d.result, { cap: 50 }));
        say = 'The real result of the whole query, run by SQLite in one go. It matches the step-by-step story above.' + (d.note ? ' ' + inline(d.note) : '');
        break;
    }
    stageArea.replaceChildren(body);
    caption.innerHTML = say;
  }

  const p = player(box, { count: frames.length, render, stages, stageOf: i => frames[i].s });
  box.replaceChildren(head, query, p.chips, p.controls, caption, stageArea);
  p.go(0);
}

// ---------------------------------------------------------------- sqlplan (SQLite EXPLAIN QUERY PLAN)

/** What one SQLite plan line means, in plain words, and how good it is. */
export function explainPlanLine(detail) {
  let m;
  if ((m = detail.match(/^SEARCH (\S+)(?: AS \S+)? USING (COVERING INDEX|INDEX|INTEGER PRIMARY KEY|PRIMARY KEY)\s*(\S*)\s*(?:\((.*)\))?/)))
    return { tone: 'good', badge: m[2] === 'COVERING INDEX' ? 'covering' : 'search',
      say: m[2] === 'COVERING INDEX' ? `Looks up ${m[1]} in index ${m[3]} for ${m[4] || 'the condition'} and answers from the index alone: the table itself is never read.`
        : /PRIMARY KEY/.test(m[2]) ? `Jumps straight to the matching ${m[1]} rows by their primary key (${m[4] || 'rowid'}).`
        : `Jumps to the matching ${m[1]} rows through index ${m[3]} (${m[4] || ''}), then reads only those rows.` };
  if ((m = detail.match(/^SCAN (\S+)(?: AS \S+)? USING (COVERING )?INDEX (\S+)/)))
    return { tone: m[2] ? 'ok' : 'warn', badge: 'index scan', say: `Reads all of index ${m[3]} from start to end${m[2] ? ', without touching the table' : ', visiting the table for every entry'}. Often chosen because the index is already in the order the query needs.` };
  if ((m = detail.match(/^SCAN (CONSTANT ROW|\S+)/)))
    return m[1] === 'CONSTANT' || m[1] === 'CONSTANT ROW' ? { tone: 'ok', badge: 'constant', say: 'No table to read: the values are constants.' }
      : { tone: 'bad', badge: 'full scan', say: `Reads every row of ${m[1]}. Fine for a tiny table; on a big one, this is the line to fix.` };
  if ((m = detail.match(/^USE TEMP B-TREE FOR (.+)/)))
    return { tone: 'warn', badge: 'sort', say: `Builds a temporary sorted structure for ${m[1]}: an extra sort of the rows. An index in the same order can remove it.` };
  if (/AUTOMATIC (PARTIAL )?(COVERING )?INDEX/.test(detail))
    return { tone: 'warn', badge: 'auto index', say: 'SQLite builds a throwaway index just for this query because none exists. A strong hint that a real index is missing.' };
  if (/^(CORRELATED )?SCALAR SUBQUERY/.test(detail))
    return { tone: /^CORRELATED/.test(detail) ? 'warn' : 'info', badge: 'subquery', say: /^CORRELATED/.test(detail) ? 'A subquery that runs again for every outer row.' : 'A subquery that runs once.' };
  if (/^LIST SUBQUERY|^CO-ROUTINE|^MATERIALIZE|^COMPOUND QUERY|^LEFT-MOST SUBQUERY|^UNION|^MERGE/.test(detail))
    return { tone: 'info', badge: detail.split(' ')[0].toLowerCase(), say: /^MATERIALIZE/.test(detail) ? 'Runs the subquery or CTE once and stores its rows in a temporary table.' : /^CO-ROUTINE/.test(detail) ? 'Runs the subquery or CTE lazily, handing rows over as they are needed.' : 'Part of a compound or nested query.' };
  if (/BLOOM FILTER/.test(detail)) return { tone: 'info', badge: 'bloom', say: 'A quick pre-check that skips rows that cannot match the join.' };
  return { tone: 'info', badge: '', say: '' };
}

function planTree(nodes) {
  const kids = new Map();
  for (const n of nodes) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
  const draw = parent => h('ul.sv-tree', (kids.get(parent) || []).map(n => {
    const e = explainPlanLine(n.detail);
    return h('li', h(`div.sv-node.${e.tone}`, h('div.sv-node-line', e.badge && h(`span.sv-badge.${e.tone}`, e.badge), h('code', n.detail)), e.say && h('div.sv-node-say.small', e.say)),
      kids.has(n.id) && draw(n.id));
  }));
  return nodes.length ? draw(0) : h('div.muted.small', 'No plan lines.');
}

function planSides(sides) {
  const max = key => Math.max(1, ...sides.map(s => s[key]));
  const meter = (s, key, label, hint) => h('div.sv-meter', { title: hint },
    h('span.sv-meter-label.small', label), h('span.sv-meter-bar', h('span', { style: { width: `${(s[key] / max(key)) * 100}%` } })), h('b.small', fmt(s[key])));
  const sameQuery = sides.every(s => s.sql === sides[0].sql);
  const cols = sides.map(s => h('div.sv-side',
    h('div.sv-side-head', h('b', s.label), s.change && h('code.sv-change', { html: sqlHtml(s.change) })),
    !sameQuery && h('pre.code.sv-side-sql', h('code', { html: sqlHtml(s.sql) })),
    planTree(s.plan),
    h('div.sv-meters',
      meter(s, 'fullScanSteps', 'rows stepped by full scans', 'sqlite3_stmt_status FULLSCAN_STEP: how many times a full table scan moved to the next row'),
      meter(s, 'vmSteps', 'virtual machine steps', 'sqlite3_stmt_status VM_STEP: total work the statement did'),
      h('div.small.muted', `${fmt(s.rows)} row${s.rows === 1 ? '' : 's'} returned · ${s.sorts} sort${s.sorts === 1 ? '' : 's'}${s.autoIndexes ? ` · ${s.autoIndexes} automatic index rows` : ''}`))));
  let verdict = null;
  if (sides.length === 2 && sides[0].vmSteps > 0 && sides[1].vmSteps > 0) {
    const r = sides[0].vmSteps / sides[1].vmSteps;
    verdict = h('div.sv-verdict.small', r >= 1.5 ? `${sides[1].label} does about ${r >= 10 ? fmt(Math.round(r)) : r.toFixed(1)}× less work for the same ${fmt(sides[1].rows)} rows.`
      : r <= 0.67 ? `${sides[1].label} does about ${(1 / r).toFixed(1)}× more work. Not every change helps: measure.` : 'About the same amount of work either way.');
  }
  return { sameQuery, el: h('div', h(`div.sv-sides${sides.length > 1 ? '.two' : ''}`, cols), verdict) };
}

export function sqlPlan(spec) {
  const head = h('div.sv-head', h('b', 'Query plan'), h('span.muted.small', ' real EXPLAIN QUERY PLAN from SQLite, and the work the query really did'));
  const box = h('div.sv.sv-plan', head, h('div.muted.small', 'Asking SQLite for the plan…'));
  api('sqlplan', spec).then(r => {
    if (r.error) { box.replaceChildren(head, h('div.callout.warn', 'The plan could not be read: ' + r.error)); return; }
    const { sameQuery, el } = planSides(r.sides);
    box.replaceChildren(head, sameQuery && h('pre.code.sv-plan-sql', h('code', { html: sqlHtml(r.sides[0].sql) })), el,
      spec.note && h('div.small.muted.sv-note', { html: inline(spec.note) }));
  }).catch(() => box.replaceChildren(head, h('div.callout.warn', 'Could not reach the dojo server.')));
  return box;
}

/** A "Query plan" button for a SQL code step: the plan of the learner's own last statement, on the step's data. */
export function sqlPlanButton(step, getCode, panel) {
  return h('button.btn.ghost', { type: 'button', title: 'EXPLAIN QUERY PLAN for your last statement, on this exercise\'s data', onclick: async () => {
    panel.hidden = false;
    panel.replaceChildren(h('span.muted.small', 'Asking SQLite for the plan…'));
    try {
      const r = await api('sqlplan', { setup: step.setup, query: getCode() });
      if (r.error) { panel.replaceChildren(h('div.diag.error', 'No plan: ' + r.error)); return; }
      panel.replaceChildren(h('div.out-section', h('div.out-title', 'Query plan for your last statement'), planSides(r.sides).el));
    } catch { panel.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?')); }
  } }, '▤ Query plan');
}

// ---------------------------------------------------------------- pgplan (PostgreSQL EXPLAIN ANALYZE text)

const PG_NODE = /^(\s*)(?:->\s+)?(.+?)\s+\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+) width=(\d+)\)(?:\s+\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\)|\s+\((never executed)\))?\s*$/;

/** Parse EXPLAIN (ANALYZE, BUFFERS) text into a tree of nodes with their detail lines. */
export function parsePgPlan(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim() && !/^\s*QUERY PLAN\s*$|^-+$/.test(l));
  const roots = [], stack = [], summary = [];
  let planning = false;
  for (const line of lines) {
    const m = line.match(PG_NODE);
    if (m) {
      planning = false;
      const indent = line.indexOf('->') >= 0 && line.trim().startsWith('->') ? line.indexOf('->') : m[1].length;
      const node = { indent, name: m[2].trim(), cost: [Number(m[3]), Number(m[4])], est: Number(m[5]), width: Number(m[6]),
        time: m[7] ? [Number(m[7]), Number(m[8])] : null, rows: m[9] != null ? Number(m[9]) : null, loops: m[10] ? Number(m[10]) : null,
        never: m[11] === 'never executed', details: [], kids: [] };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      (stack.length ? stack[stack.length - 1].kids : roots).push(node);
      stack.push(node);
      continue;
    }
    const t = line.trim();
    if (/^Planning:?$/.test(t)) { planning = true; summary.push(t); continue; }
    if (/^(Planning Time|Execution Time|Trigger|JIT|Planning Buffers):?/.test(t) || planning || !stack.length) { summary.push(t); continue; }
    stack[stack.length - 1].details.push(t);
  }
  return { roots, summary, total: Number(summary.find(s => /^Execution Time/.test(s))?.match(/([\d.]+)/)?.[1] || 0) };
}

function pgTone(name) {
  if (/^(Parallel )?Seq Scan/.test(name)) return 'bad';
  if (/Index Only Scan/.test(name)) return 'good';
  if (/Index Scan|Bitmap (Index|Heap) Scan/.test(name)) return 'good';
  if (/^(Sort|Incremental Sort|Hash|Materialize|Memoize)/.test(name)) return 'warn';
  return 'info';
}

function pgNode(n, total) {
  const est = n.est, act = n.rows;
  let ratio = null;
  if (act != null && !n.never) { const a = Math.max(act, 1), e = Math.max(est, 1); ratio = a >= e ? a / e : -(e / a); }
  const off = ratio != null && Math.abs(ratio) >= 10;
  const inclusive = n.time ? n.time[1] * (n.loops || 1) : null;
  const share = total && inclusive != null ? Math.min(100, (inclusive / total) * 100) : null;
  const buffers = n.details.find(d => /^Buffers:/.test(d));
  const hit = Number(buffers?.match(/hit=(\d+)/)?.[1] || 0), read = Number(buffers?.match(/read=(\d+)/)?.[1] || 0);
  const removed = n.details.find(d => /^Rows Removed by (Filter|Join Filter|Index Recheck)/.test(d));
  const disk = n.details.find(d => /Sort Method: external|Disk:/.test(d));
  const notes = [];
  if (off) notes.push(h('span.sv-flag.bad', ratio > 0
    ? `estimate ${fmt(est)} vs actual ${fmt(act)}: ${fmt(Math.round(ratio))}× more rows than planned`
    : `estimate ${fmt(est)} vs actual ${fmt(act)}: ${fmt(Math.round(-ratio))}× fewer rows than planned`));
  if (removed) { const k = Number(removed.match(/(\d+)\s*$/)?.[1] || 0); if (act != null && k > act * 10) notes.push(h('span.sv-flag.warn', `read ${fmt(k + act * (n.loops || 1))} rows to keep ${fmt(act * (n.loops || 1))}`)); }
  if (disk) notes.push(h('span.sv-flag.warn', 'sort spilled to disk'));
  if (n.loops > 1) notes.push(h('span.sv-flag.info', `ran ${fmt(n.loops)} times: per-loop rows and time, multiply by loops`));
  return h('li', h(`div.sv-node.pg.${pgTone(n.name)}${n.never ? '.never' : ''}`,
    h('div.sv-node-line', h(`span.sv-badge.${pgTone(n.name)}`, n.name.split(' on ')[0].split(' using ')[0]), h('code', n.name)),
    h('div.sv-pgrows',
      h('span', h('span.muted.small', 'estimated rows '), h('b', fmt(est))),
      h(`span${off ? '.bad' : ''}`, h('span.muted.small', 'actual rows '), h('b', n.never ? 'never executed' : act != null ? fmt(act) : '?'), n.loops > 1 ? h('span.muted.small', ` × ${fmt(n.loops)} loops`) : null),
      inclusive != null && h('span', h('span.muted.small', 'time '), h('b', `${inclusive.toFixed(inclusive < 10 ? 3 : 1)} ms`)),
      h('span.muted.small', `cost ${n.cost[0]}..${n.cost[1]}`)),
    share != null && h('div.sv-meter', { title: 'Share of the total execution time, including the nodes below it' },
      h('span.sv-meter-label.small', 'share of time'), h('span.sv-meter-bar', h('span', { style: { width: `${share}%` } })), h('b.small', `${share.toFixed(0)}%`)),
    (hit || read) ? h('div.sv-buffers.small', { title: 'shared hit = found in PostgreSQL\'s memory; read = fetched from the OS or disk' },
      h('span.muted', 'buffers '), h('span.sv-buf', h('span.hit', { style: { flex: hit } }), h('span.read', { style: { flex: read } })),
      h('span', `${fmt(hit)} hit · ${fmt(read)} read (${fmt(Math.round((hit + read) * 8 / 1024))} MB)`)) : null,
    notes.length ? h('div.sv-flags', notes) : null,
    n.details.filter(d => !/^Buffers:/.test(d)).length ? h('div.sv-pgdetails', n.details.filter(d => !/^Buffers:/.test(d)).map(d => h('code.small', d))) : null),
  n.kids.length ? h('ul.sv-tree', n.kids.map(k => pgNode(k, total))) : null);
}

function pgOne(text, label) {
  const plan = parsePgPlan(text);
  return h('div.sv-side', label && h('div.sv-side-head', h('b', label)),
    h('ul.sv-tree.pg', plan.roots.map(n => pgNode(n, plan.total))),
    plan.summary.length ? h('div.sv-pgsummary.small', plan.summary.map(s => h('code', s))) : null,
    h('details.sv-raw', h('summary.small.muted', 'The text as psql prints it'), h('pre.code', String(text))));
}

export function pgPlan(spec) {
  const text = [].concat(spec.text).join('\n');
  const after = spec.after ? [].concat(spec.after).join('\n') : null;
  const labels = spec.labels || ['Before', 'After'];
  return h('div.sv.sv-pg',
    h('div.sv-head', h('b', spec.title || 'PostgreSQL plan'), h('span.muted.small', ' EXPLAIN (ANALYZE, BUFFERS) output, read node by node: each node feeds its parent, the innermost runs first')),
    spec.query && h('pre.code.sv-plan-sql', h('code', { html: sqlHtml([].concat(spec.query).join('\n')) })),
    h(`div.sv-sides${after ? '.two' : ''}`, pgOne(text, after ? labels[0] : null), after && pgOne(after, labels[1])),
    spec.note && h('div.small.muted.sv-note', { html: inline(spec.note) }));
}

// ---------------------------------------------------------------- txtimeline (two sessions over time)

export function txTimeline(spec) {
  const rows = spec.rows || [];
  const box = h('div.sv.sv-tl');
  const head = h('div.sv-head', h('b', spec.title || 'Two sessions, one table'), spec.isolation && h('span.sv-iso', spec.isolation));
  const table = h('div.sv-tl-grid');
  const caption = h('div.sv-caption');
  const hd = h('div.sv-tl-row.head', h('div.sv-tl-t', 't'), h('div', spec.a || 'Session A'), h('div', spec.b || 'Session B'), h('div', spec.db || 'In the database (committed)'));
  const cell = (text, on, mark, waiting) => h(`div.sv-tl-cell${on && text ? '.on' : ''}${mark ? '.' + mark : ''}${waiting ? '.waiting' : ''}`,
    text ? h('code', { html: /^[A-Z]{3,}|^--|^\(/.test(text) || /;\s*$/.test(text) ? sqlHtml(text) : esc(text) }) : waiting ? h('span.sv-wait', 'waiting…') : '');
  function render(at) {
    const waits = { a: false, b: false };
    table.replaceChildren(hd, ...rows.slice(0, at + 1).map((r, i) => {
      const cur = i === at;
      const el = h(`div.sv-tl-row${cur ? '.cur' : ''}${r.mark ? '.' + r.mark : ''}`,
        h('div.sv-tl-t', String(i + 1)),
        cell(r.a, cur, r.mark && r.a ? r.mark : null, !r.a && waits.a),
        cell(r.b, cur, r.mark && r.b ? r.mark : null, !r.b && waits.b),
        h(`div.sv-tl-db${r.db ? '.changed' : ''}`, r.db ? h('code', r.db) : ''));
      if (r.wait) waits[r.wait] = true;
      if (r.resume) waits[r.resume] = false;
      return el;
    }));
    const r = rows[at];
    caption.innerHTML = (r.note ? inline(r.note) : '') + (at === rows.length - 1 && spec.verdict ? ` <span class="sv-verdict-inline">${inline(spec.verdict)}</span>` : '');
  }
  const p = player(box, { count: rows.length, render, speed: 1600 });
  box.append(head, p.controls, table, caption, spec.note ? h('div.small.muted.sv-note', { html: inline(spec.note) }) : '');
  p.go(0);
  return box;
}
