// The Database studio (#/db): real databases on this machine. SQLite files you can create, rename and
// delete, sample databases to explore, and PostgreSQL / SQL Server / MySQL in Docker containers.
// One query editor for all of them, a results grid, the schema, an ER diagram, EXPLAIN and CSV import.
import { h, ask } from './util.js';
import * as game from './game.js';
import { createEditor } from './editor.js';
import { sqlGrid, toCsv } from './sqlgrid.js';

const ENGINE_NAMES = { sqlite: 'SQLite', postgres: 'PostgreSQL', sqlserver: 'SQL Server', mysql: 'MySQL' };

const STARTERS = {
  bookshop: '-- The bookshop: authors, books, customers, orders, order_items, reviews.\n-- Best-selling books by copies sold:\nSELECT b.title, a.name AS author, SUM(oi.quantity) AS copies\nFROM order_items oi\nJOIN books b ON b.id = oi.book_id\nJOIN authors a ON a.id = b.author_id\nGROUP BY b.id\nORDER BY copies DESC\nLIMIT 10;',
  company: '-- A small company: departments, jobs, employees (with managers), salary_history, projects, assignments.\n-- Who reports to whom:\nSELECT e.first_name || \' \' || e.last_name AS employee, m.first_name || \' \' || m.last_name AS manager, d.name AS department\nFROM employees e\nLEFT JOIN employees m ON m.id = e.manager_id\nLEFT JOIN departments d ON d.id = e.department_id\nORDER BY department, manager;',
  movies: '-- Movies: movies, people, genres, movie_genres, cast_members, users, ratings.\n-- Highest rated films with at least 5 ratings:\nSELECT m.title, m.year, ROUND(AVG(r.score), 2) AS average, COUNT(*) AS ratings\nFROM movies m\nJOIN ratings r ON r.movie_id = m.id\nGROUP BY m.id\nHAVING COUNT(*) >= 5\nORDER BY average DESC;',
};

/** fetch that returns the server's own error message. */
async function call(path, body) {
  const res = await fetch('/api/db/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `${path}: ${res.status}`);
  return data;
}

const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const keyOf = t => `${t.engine}:${t.db}`;

/** Days in a row (ending today, or yesterday if today has none yet) with at least one query run. */
function queryStreak(days) {
  let n = 0;
  const d = new Date();
  const k = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (!days[k(d)]) d.setDate(d.getDate() - 1);
  while (days[k(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function dbStudio(page) {
  const st = game.state.dbStudio ||= {};
  st.history ||= []; st.snippets ||= []; st.days ||= {}; st.drafts ||= {}; st.layout ||= {}; st.queries ||= 0;
  st.target ||= { engine: 'sqlite', db: 'bookshop' };
  const save = () => game.save();
  document.documentElement.dataset.codeLang = 'sql';

  let dbs = [], dir = '', engines = null, serverDbs = {}, schema = [], schemaError = '';
  let results = null, resultTab = 0, view = 'query', busy = false, stopped = false, pollTimer = null;

  // ------------------------------------------------------------ elements
  const sideEl = h('aside.db-side');
  const schemaEl = h('div.db-schema');
  const resultEl = h('div.db-results');
  const statusEl = h('span.muted.small');
  const streakEl = h('div.db-streak');
  const viewEl = h('div.db-view');
  const tabsEl = h('div.db-tabs');
  const targetEl = h('div.db-target');
  const libEl = h('div.db-lib');

  const tableNames = () => schema.map(t => t.name);
  const editor = createEditor({
    language: 'sql', minLines: 12,
    value: st.drafts[keyOf(st.target)] ?? STARTERS[st.target.db] ?? 'SELECT 1;',
    onChange: v => { st.drafts[keyOf(st.target)] = v; save(); },
    onRun: () => run(false),
    vocab: () => ({
      words: [...tableNames(), ...new Set(schema.flatMap(t => t.columns.map(c => c.name)))],
      members(name, text) {
        const lower = name.toLowerCase();
        let table = schema.find(t => t.name.toLowerCase() === lower || t.name.toLowerCase().endsWith('.' + lower));
        if (!table) {
          // An alias: FROM books b / JOIN authors AS a
          for (const m of text.matchAll(/\b(?:from|join)\s+([\w.]+)\s+(?:as\s+)?(\w+)/gi))
            if (m[2].toLowerCase() === lower) table = schema.find(t => t.name.toLowerCase() === m[1].toLowerCase());
        }
        return table ? table.columns.map(c => c.name) : [];
      },
    }),
  });

  // ------------------------------------------------------------ data

  async function loadList() {
    try { const r = await call('list'); dbs = r.databases; dir = r.dir; }
    catch (e) { dbs = []; dir = e.message; }
    if (st.target.engine === 'sqlite' && !dbs.some(d => d.name === st.target.db) && dbs.length) st.target = { engine: 'sqlite', db: dbs[0].name };
    paintSide();
  }

  async function loadEngines() {
    try { engines = await call('engines'); } catch (e) { engines = { docker: false, message: e.message, engines: [] }; }
    for (const e of engines.engines) if (e.status === 'running' && !serverDbs[e.id]) loadServerDbs(e.id);
    paintSide();
    clearTimeout(pollTimer);
    if (!stopped && engines.engines.some(e => e.status === 'starting')) pollTimer = setTimeout(loadEngines, 2000);
  }

  async function loadServerDbs(id) {
    try { serverDbs[id] = (await call(`engines/${id}/databases`)).databases; } catch (e) { serverDbs[id] = []; }
    paintSide();
  }

  async function loadSchema() {
    schemaError = '';
    try { schema = (await call('schema', st.target)).tables; }
    catch (e) { schema = []; schemaError = e.message; }
    paintSchema();
    if (view === 'er') paintView();
  }

  function select(target) {
    st.drafts[keyOf(st.target)] = editor.value;
    st.target = target; save();
    editor.value = st.drafts[keyOf(target)] ?? STARTERS[target.db] ?? (target.engine === 'sqlite' ? 'SELECT name, type FROM sqlite_schema;' : 'SELECT 1;');
    results = null; paintResults(); paintSide(); paintTarget(); loadSchema();
  }

  // ------------------------------------------------------------ running

  function record(ok, rows) {
    st.queries++;
    if (ok) st.days[today()] = (st.days[today()] || 0) + 1;
    st.history.unshift({ sql: editor.value, at: Date.now(), target: { ...st.target }, ok, rows });
    st.history = st.history.filter((x, i) => i === 0 || x.sql !== st.history[0].sql || keyOf(x.target) !== keyOf(st.target)).slice(0, 60);
    save();
    game.emit('db-query', { ok, engine: st.target.engine, streak: queryStreak(st.days) });
    paintStreak(); paintLib();
  }

  async function run(explain) {
    if (busy) return;
    const sql = editor.value;
    busy = true; statusEl.textContent = explain ? 'Explaining…' : 'Running…';
    try {
      results = { ...(await call('query', { ...st.target, sql, explain })), explain };
      resultTab = Math.max(0, (results.results?.length || 1) - 1);
      editor.mark(results.error ? [{ severity: 'error', line: results.errorLine }] : []);
      if (!explain) record(!results.error, results.results?.at(-1)?.rows.length ?? 0);
      // DDL changes the schema: refresh it after anything that is not a plain SELECT.
      if (!explain && /\b(create|drop|alter|rename)\b/i.test(sql)) loadSchema();
    } catch (e) { results = { error: e.message }; }
    busy = false; statusEl.textContent = '';
    paintResults();
  }

  // ------------------------------------------------------------ painting: side

  function paintSide() {
    const t = st.target;
    const sqliteItems = dbs.map(d => h(`button.db-item${t.engine === 'sqlite' && t.db === d.name ? '.active' : ''}`, { type: 'button', onclick: () => select({ engine: 'sqlite', db: d.name }) },
      h('span.db-item-name', d.name), d.sample && h('span.db-badge', 'sample'), h('span.muted.small', size(d.size))));
    put(sideEl,
      h('div.db-side-head', h('h3', 'SQLite'), h('span.spacer'),
        h('button.mini', { type: 'button', title: 'Create an empty database', onclick: createDb }, '+ New')),
      h('div.db-list', sqliteItems.length ? sqliteItems : h('p.muted.small', 'No databases yet.')),
      t.engine === 'sqlite' && dbs.some(d => d.name === t.db) && h('div.db-actions',
        h('button.mini', { type: 'button', onclick: renameDb }, 'Rename'),
        h('button.mini', { type: 'button', onclick: deleteDb }, 'Delete'),
        h('button.mini', { type: 'button', title: 'Make any missing sample database again', onclick: async () => { await call('samples', {}); loadList(); } }, 'Restore samples')),
      h('p.muted.small.db-dir', { title: 'Each SQLite database is one file here. Open them with any SQLite tool.' }, dir),
      h('div.db-side-head', h('h3', 'Server engines')),
      engineList());
  }

  function engineList() {
    if (!engines) return h('p.muted.small', 'Checking Docker…');
    if (!engines.docker) return h('div.db-note', h('p.small', engines.message), h('button.mini', { type: 'button', onclick: loadEngines }, 'Check again'));
    return engines.engines.map(e => {
      const on = e.status === 'running';
      const t = st.target;
      return h('div.db-engine',
        h('div.db-engine-head', h('b', e.name), h(`span.db-pill.${e.status}`, { failed: 'failed', running: 'running', starting: 'starting…', stopped: 'stopped', absent: 'not created' }[e.status] || e.status), h('span.spacer'),
          on ? h('button.mini', { type: 'button', onclick: async () => { await call(`engines/${e.id}/stop`, {}); delete serverDbs[e.id]; if (t.engine === e.id) select({ engine: 'sqlite', db: dbs[0]?.name || 'bookshop' }); loadEngines(); } }, 'Stop')
            : e.status === 'starting' ? null
            : h('button.mini', { type: 'button', onclick: () => startEngine(e) }, e.imagePresent ? 'Start' : 'Download & start')),
        h('div.muted.small', `${e.image} · 127.0.0.1:${e.port} · user ${e.user}`),
        !e.imagePresent && e.status !== 'starting' && h('div.muted.small', `First start downloads the image (${e.size}).`),
        (e.status === 'starting' || e.status === 'failed') && e.log?.length > 0 && h('pre.db-log', e.log.join('\n')),
        on && h('div.db-list',
          (serverDbs[e.id] || []).map(name => h(`button.db-item${t.engine === e.id && t.db === name ? '.active' : ''}`, { type: 'button', onclick: () => select({ engine: e.id, db: name }) }, h('span.db-item-name', name))),
          h('button.mini', { type: 'button', onclick: () => createServerDb(e) }, '+ New database')));
    });
  }

  async function startEngine(e) {
    const msg = e.imagePresent
      ? `Start ${e.name}? It runs as the Docker container ${e.container}, reachable only from this machine (127.0.0.1:${e.port}). Data is kept in the volume ${e.volume}.`
      : `Start ${e.name}? This first downloads the ${e.image} image (${e.size}) from the internet, which can take several minutes. It then runs as ${e.container} on 127.0.0.1:${e.port} only, with its data in the volume ${e.volume}.`;
    if (!await ask(e.id === 'sqlserver' ? `${msg} ${e.note}` : msg, { ok: e.imagePresent ? 'Start it' : 'Download and start' })) return;
    try { await call(`engines/${e.id}/start`, {}); } catch (err) { toastErr(err); }
    loadEngines();
  }

  async function createDb() {
    const name = await prompt('Name the new SQLite database (letters, digits, - and _):', 'playground');
    if (!name) return;
    try { await call('create', { name }); await loadList(); select({ engine: 'sqlite', db: name }); } catch (e) { toastErr(e); }
  }
  async function renameDb() {
    const to = await prompt(`Rename ${st.target.db} to:`, st.target.db);
    if (!to || to === st.target.db) return;
    try {
      await call('rename', { name: st.target.db, to });
      st.drafts[`sqlite:${to}`] = st.drafts[keyOf(st.target)];
      await loadList(); select({ engine: 'sqlite', db: to });
    } catch (e) { toastErr(e); }
  }
  async function deleteDb() {
    if (!await ask(`Delete ${st.target.db}? The file is moved to the .trash folder next to your databases, so you can get it back from there.`, { ok: 'Move to trash', danger: true })) return;
    try { await call('delete', { name: st.target.db }); await loadList(); select({ engine: 'sqlite', db: dbs[0]?.name || '' }); } catch (e) { toastErr(e); }
  }
  async function createServerDb(e) {
    const name = await prompt(`Name the new ${e.name} database:`, 'shop');
    if (!name) return;
    try { serverDbs[e.id] = (await call(`engines/${e.id}/create`, { name })).databases; select({ engine: e.id, db: name }); } catch (err) { toastErr(err); }
  }

  // ------------------------------------------------------------ painting: schema

  function paintSchema() {
    if (schemaError) return put(schemaEl, h('div.db-note.bad.small', schemaError));
    if (!schema.length) return put(schemaEl, h('p.muted.small', 'No tables yet. CREATE TABLE one, or import a CSV.'));
    put(schemaEl, schema.map(t => h('details.db-table', { open: schema.length <= 4 },
      h('summary', h('span.db-table-name', t.name), t.kind === 'view' && h('span.db-badge', 'view'), t.rows != null && h('span.muted.small', ` ${t.rows} rows`),
        h('button.mini.db-peek', { type: 'button', title: 'Show its rows', onclick: ev => { ev.preventDefault(); editor.value = `SELECT * FROM ${quoteName(t.name)} LIMIT 100;`; run(false); } }, '▶')),
      h('ul.db-cols', t.columns.map(c => {
        const fk = t.foreignKeys.find(f => f.from === c.name);
        return h('li', h('span.db-key', c.pk ? 'PK' : fk ? 'FK' : ''), h('span.db-col', c.name), h('span.db-ctype', (c.type || '').toLowerCase()),
          c.notNull && !c.pk && h('span.muted.small', ' not null'), fk && h('span.db-fk', ` → ${fk.table}.${fk.to || 'id'}`));
      })),
      t.indexes.length > 0 && h('div.db-indexes', t.indexes.map(i => h('div.small.muted', `${i.unique ? 'unique ' : ''}index ${i.name} (${i.columns})`))))));
  }
  const quoteName = n => /^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)?$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`;

  // ------------------------------------------------------------ painting: results

  function paintResults() {
    if (!results) return put(resultEl, h('p.muted.small.db-hint', 'Ctrl + Enter runs everything in the editor. Several statements are fine: each SELECT gets its own result tab.'));
    if (results.explain) return put(resultEl, explainView(results));
    const sets = results.results || [];
    const cur = sets[resultTab];
    put(resultEl,
      results.error && h('div.db-error', h('b', results.timedOut ? 'Stopped' : 'Error'), ' ', results.error),
      sets.length > 1 && h('div.db-result-tabs', sets.map((s, i) => h(`button.tab.small${i === resultTab ? '.active' : ''}`, { type: 'button', onclick: () => { resultTab = i; paintResults(); } }, s.line ? `Result ${i + 1} · line ${s.line}` : `Result ${i + 1}`))),
      cur && h('div.db-result-bar', h('span', `${cur.rows.length}${cur.truncated ? '+' : ''} row${cur.rows.length === 1 ? '' : 's'}`), h('span.muted', ` · ${cur.ms} ms`), h('span.spacer'),
        h('button.mini', { type: 'button', onclick: () => download(`${st.target.db}-result.csv`, toCsv(cur)) }, 'Export CSV')),
      cur && sqlGrid(cur, { cap: 2000, caption: false }),
      cur?.truncated && h('p.muted.small', 'Only the first 2000 rows are shown. Add a LIMIT or a WHERE to narrow it down.'),
      results.messages?.length > 0 && h('pre.db-messages', results.messages.join('\n')),
      !results.error && h('div.muted.small', `${results.statements ?? sets.length} statement${(results.statements ?? sets.length) === 1 ? '' : 's'} in ${results.ms} ms`));
  }

  function explainView(r) {
    if (r.error) return h('div.db-error', h('b', 'Error'), ' ', r.error);
    if (r.plan) {
      // SQLite: rows with id/parent, drawn as a tree.
      const kids = id => r.plan.filter(p => p.parent === id);
      const node = p => h('li', h('span.db-plan-step', { className: /SCAN/.test(p.detail) ? 'db-plan-step scan' : 'db-plan-step' }, p.detail), kids(p.id).length > 0 && h('ul', kids(p.id).map(node)));
      return h('div.db-plan',
        h('div.db-result-bar', h('b', 'Query plan'), h('span.muted.small', ` for the statement on line ${r.line}`)),
        h('ul.db-plan-tree', kids(0).map(node)),
        h('p.muted.small', 'SCAN reads every row of a table. SEARCH uses an index to jump straight to the rows it needs. A SCAN on a big table inside a join is the usual reason a query is slow: an index on the join or filter column turns it into a SEARCH.'));
    }
    const sets = r.results || [];
    return h('div.db-plan', h('div.db-result-bar', h('b', 'Query plan')), sets.map(s => sqlGrid(s, { caption: false })));
  }

  // ------------------------------------------------------------ painting: views

  function paintTabs() {
    const tab = (id, label) => h(`button.tab.small${view === id ? '.active' : ''}`, { type: 'button', onclick: () => { view = id; paintTabs(); paintView(); } }, label);
    put(tabsEl, tab('query', 'Query'), tab('er', 'ER diagram'), tab('import', 'Import CSV'));
  }

  function paintTarget() {
    const t = st.target;
    put(targetEl, h('span.db-engine-tag', ENGINE_NAMES[t.engine] || t.engine), h('b', t.db || '(none)'));
  }

  function paintView() {
    if (view === 'query') {
      put(viewEl,
        h('div.db-editor', editor.el),
        h('div.db-toolbar',
          h('button.btn.primary', { type: 'button', onclick: () => run(false), title: 'Ctrl + Enter' }, '▶ Run'),
          h('button.btn.ghost', { type: 'button', onclick: () => run(true), title: 'How the database plans to run the last statement' }, 'Explain'),
          h('button.btn.ghost', { type: 'button', onclick: saveSnippet }, 'Save snippet'),
          statusEl, h('span.spacer'), h('span.muted.small', 'Ctrl + Space suggests tables and columns · Ctrl + / comments lines')),
        resultEl);
      paintResults();
    } else if (view === 'er') put(viewEl, erDiagram());
    else put(viewEl, importView());
  }

  // ------------------------------------------------------------ ER diagram

  function erDiagram() {
    if (!schema.length) return h('p.muted', 'No tables to draw yet.');
    const W = 230, ROW = 20, HEAD = 30;
    const layout = st.layout[keyOf(st.target)] ||= {};
    const tables = schema.filter(t => t.kind !== 'view');
    // Default places: the most referenced tables first, three to a row.
    const refs = name => tables.filter(t => t.foreignKeys.some(f => f.table === name)).length;
    [...tables].sort((a, b) => refs(b.name) - refs(a.name)).forEach((t, i) => {
      layout[t.name] ||= [24 + (i % 3) * (W + 80), 24 + Math.floor(i / 3) * 270];
    });
    const heightOf = t => HEAD + t.columns.length * ROW + 8;
    const svgNS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids.filter(Boolean)); return n; };
    const svg = el('svg', { class: 'db-er' });
    svg.append(el('defs', {}, el('marker', { id: 'db-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'db-er-arrowhead' }))));
    const lines = el('g');
    const boxes = el('g');
    svg.append(lines, boxes);

    function drawLines() {
      lines.replaceChildren();
      for (const t of tables) for (const f of t.foreignKeys) {
        const target = tables.find(x => x.name === f.table);
        if (!target) continue;
        const [x1, y1] = layout[t.name], [x2, y2] = layout[target.name];
        const row = t.columns.findIndex(c => c.name === f.from);
        const sy = y1 + HEAD + row * ROW + ROW / 2 + 2;
        const toRow = Math.max(0, target.columns.findIndex(c => c.name === (f.to || 'id')));
        const ty = y2 + HEAD + toRow * ROW + ROW / 2 + 2;
        const rightward = x2 > x1 + W / 2;
        const sx = rightward ? x1 + W : x1, tx = rightward ? x2 : x2 + W;
        const bend = target === t ? 60 : Math.max(40, Math.abs(tx - sx) / 2);
        const d = target === t
          ? `M${x1 + W},${sy} C${x1 + W + bend},${sy} ${x1 + W + bend},${ty} ${x1 + W},${ty}`
          : `M${sx},${sy} C${sx + (rightward ? bend : -bend)},${sy} ${tx + (rightward ? -bend : bend)},${ty} ${tx},${ty}`;
        lines.append(el('path', { d, class: 'db-er-line', 'marker-end': 'url(#db-arrow)' }, el('title', {}, `${t.name}.${f.from} → ${f.table}.${f.to || 'id'}`)));
      }
    }
    function size() {
      const maxX = Math.max(...tables.map(t => layout[t.name][0] + W)) + 40;
      const maxY = Math.max(...tables.map(t => layout[t.name][1] + heightOf(t))) + 40;
      svg.setAttribute('width', maxX); svg.setAttribute('height', maxY);
    }
    for (const t of tables) {
      const g = el('g', { class: 'db-er-box', transform: `translate(${layout[t.name][0]},${layout[t.name][1]})` });
      g.append(el('rect', { width: W, height: heightOf(t), rx: 10, class: 'db-er-rect' }),
        el('rect', { width: W, height: HEAD, rx: 10, class: 'db-er-head' }),
        el('text', { x: 12, y: 20, class: 'db-er-title' }, t.name),
        t.rows != null ? el('text', { x: W - 10, y: 20, class: 'db-er-count', 'text-anchor': 'end' }, `${t.rows}`) : null);
      t.columns.forEach((c, i) => {
        const fk = t.foreignKeys.some(f => f.from === c.name);
        g.append(el('text', { x: 12, y: HEAD + i * ROW + 16, class: c.pk ? 'db-er-col pk' : fk ? 'db-er-col fk' : 'db-er-col' }, `${c.pk ? '🔑 ' : fk ? '↗ ' : ''}${c.name}`),
          el('text', { x: W - 10, y: HEAD + i * ROW + 16, class: 'db-er-type', 'text-anchor': 'end' }, (c.type || '').toLowerCase().slice(0, 16)));
      });
      // Drag a box by any part of it; the arrows follow.
      g.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        g.setPointerCapture(ev.pointerId);
        const [ox, oy] = layout[t.name];
        const sx = ev.clientX, sy = ev.clientY;
        const move = m => {
          layout[t.name] = [Math.max(0, Math.round(ox + m.clientX - sx)), Math.max(0, Math.round(oy + m.clientY - sy))];
          g.setAttribute('transform', `translate(${layout[t.name][0]},${layout[t.name][1]})`);
          drawLines(); size();
        };
        const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); save(); };
        g.addEventListener('pointermove', move); g.addEventListener('pointerup', up);
      });
      boxes.append(g);
    }
    drawLines(); size();
    return h('div.db-er-wrap',
      h('div.db-result-bar', h('span.muted.small', 'Each box is a table; arrows point from a foreign key to the table it references. Drag boxes to arrange them.'), h('span.spacer'),
        h('button.mini', { type: 'button', onclick: () => { delete st.layout[keyOf(st.target)]; save(); paintView(); } }, 'Reset layout')),
      h('div.db-er-scroll', svg));
  }

  // ------------------------------------------------------------ CSV import

  function importView() {
    if (st.target.engine !== 'sqlite') return h('p.muted', 'CSV import creates a table in a SQLite database. Pick one on the left.');
    const text = h('textarea.answer.mono.db-csv', { rows: 10, spellcheck: false, placeholder: 'name,price,stock\nPencil,0.5,120\nNotebook,2.25,40' });
    const name = h('input.answer.mono', { placeholder: 'table name', style: { maxWidth: '260px' } });
    const out = h('div');
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', onchange: async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 1_800_000) { put(out, h('div.db-error', 'That file is over 1.8 MB. Import a smaller piece of it.')); return; }
      text.value = await f.text();
      if (!name.value) name.value = f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    } });
    return h('div.db-import',
      h('p', 'Paste CSV or pick a file. The first row names the columns; each column becomes INTEGER, REAL or TEXT depending on what it holds (empty cells become NULL, and numbers with a leading zero stay text).'),
      h('label.db-file', file),
      text,
      h('div.db-toolbar', name, h('button.btn.primary', { type: 'button', onclick: async () => {
        try {
          const r = await call('import', { db: st.target.db, table: name.value.trim(), csv: text.value });
          put(out, h('div.callout', `Created ${r.table} with ${r.rows} rows: `, r.columns.map(c => `${c.name} ${c.type}`).join(', '), '.'));
          await loadSchema();
          editor.value = `SELECT * FROM ${r.table} LIMIT 100;`;
        } catch (e) { put(out, h('div.db-error', e.message)); }
      } }, 'Import into ' + st.target.db)),
      out);
  }

  // ------------------------------------------------------------ history, snippets, streak

  async function saveSnippet() {
    const name = await prompt('Name this snippet:', editor.value.split('\n').find(l => l.trim() && !l.startsWith('--'))?.slice(0, 40) || 'query');
    if (!name) return;
    st.snippets.unshift({ name, sql: editor.value });
    st.snippets = st.snippets.slice(0, 80); save(); paintLib();
  }

  function paintLib() {
    const when = at => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    put(libEl,
      h('details.db-lib-part', { open: true }, h('summary', `Saved snippets (${st.snippets.length})`),
        st.snippets.length ? st.snippets.map((s, i) => h('div.db-lib-row',
          h('button.db-lib-item', { type: 'button', title: s.sql, onclick: () => { editor.value = s.sql; } }, s.name),
          h('button.icon-btn.small', { type: 'button', title: 'Remove', onclick: () => { st.snippets.splice(i, 1); save(); paintLib(); } }, '×')))
          : h('p.muted.small', 'Save a query you want to keep.')),
      h('details.db-lib-part', h('summary', `History (${st.history.length})`),
        st.history.slice(0, 30).map(x => h('button.db-lib-item.db-hist', { type: 'button', title: x.sql, onclick: () => { editor.value = x.sql; } },
          h('span', { className: x.ok ? 'db-ok' : 'db-bad' }, x.ok ? '✓' : '✗'), h('span.db-hist-sql', x.sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().slice(0, 70)),
          h('span.muted.small', `${x.target.db} · ${when(x.at)}`)))));
  }

  function paintStreak() {
    const n = queryStreak(st.days);
    const lit = !!st.days[today()];
    put(streakEl, h(`div.db-streak-chip${lit ? '.lit' : ''}`, { title: 'Days in a row with at least one query that ran without errors' },
      h('span', '🔥'), h('b', n), h('span', ` day${n === 1 ? '' : 's'} query streak`)),
      h('span.muted.small', `${st.queries} quer${st.queries === 1 ? 'y' : 'ies'} run`));
  }

  // ------------------------------------------------------------ helpers

  function download(name, text) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function toastErr(e) { results = { error: e.message }; view = 'query'; paintTabs(); paintView(); }
  const size = n => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

  /** An in-page text prompt (window.prompt can be blocked in embedded browsers). */
  function prompt(message, value = '') {
    return new Promise(resolve => {
      const input = h('input.answer.mono', { value });
      const done = v => { overlay.remove(); resolve(v); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
      const overlay = h('div.modal-back', { onclick: e => { if (e.target === overlay) done(null); } },
        h('div.modal', { role: 'dialog', 'aria-modal': 'true' }, h('p', message), input,
          h('div.modal-actions', h('button.btn.ghost', { type: 'button', onclick: () => done(null) }, 'Cancel'),
            h('button.btn.primary', { type: 'button', onclick: () => done(input.value.trim()) }, 'OK'))));
      document.body.append(overlay);
      input.focus(); input.select();
    });
  }

  // ------------------------------------------------------------ page

  page('db',
    h('div.track-head',
      h('div', h('h2.track-title', 'Databases'), h('p.muted', 'Real databases on your machine. Explore the samples, make your own, and run PostgreSQL, SQL Server or MySQL next to SQLite.')),
      streakEl),
    h('div.db-studio',
      sideEl,
      h('section.db-main', h('div.db-main-head', targetEl, h('span.spacer'), tabsEl), viewEl),
      h('aside.db-right', h('h3', 'Schema'), schemaEl, h('h3', 'Library'), libEl)));
  paintTarget(); paintTabs(); paintView(); paintStreak(); paintLib(); paintSchema();
  loadList().then(loadSchema);
  loadEngines();
  return () => { stopped = true; clearTimeout(pollTimer); st.drafts[keyOf(st.target)] = editor.value; save(); };
}
