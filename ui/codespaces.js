// Code spaces: real multi-file .NET projects on this machine (%USERPROFILE%\code-dojo\spaces\<name>),
// edited, built, run and tested right here, with NuGet packages. The server drives the real dotnet CLI
// (server/CodeSpaces.cs); the editor's C# intelligence sees every file of the project plus the
// assemblies its packages restored, so completion and F12 work across files and into packages.
//   #/spaces          the list, with a create dialog
//   #/spaces/<name>   the IDE: explorer, editor tabs, problems, output, NuGet, request panel for web apps
import { h, ask } from './util.js';
import { createEditor } from './editor.js';
import { createDebugger, breakpointStore, DEBUG_KEYS } from './debugger.js';

const enc = encodeURIComponent;
async function call(path, body, method) {
  const res = await fetch('/api/' + path, body === undefined ? {} : {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const TEMPLATE_ICON = {
  console: '>_', web: '{ }', solution: '▦', empty: '∅',
  'py-script': 'py', 'py-package': 'py✓', 'py-api': 'py{}',
  'node-script': 'JS', 'node-ts': 'TS', 'node-express': 'ex{}', 'node-next': 'N▲',
};
const KIND_ICON = { dotnet: '▤', python: 'py', node: 'JS' };
const KIND_NAME = { dotnet: '.NET', python: 'Python', node: 'Node.js' };
/** What each kind's packages are called, where they come from, and how to search them. */
const REGISTRY = {
  dotnet: { title: 'NuGet packages', site: 'nuget.org', search: 'nuget/search', versions: 'nuget/versions', placeholder: 'Search nuget.org (e.g. Humanizer, Serilog, Dapper)' },
  python: { title: 'PyPI packages', site: 'PyPI', search: 'pypi/search', versions: 'pypi/versions', placeholder: 'Search PyPI (e.g. requests, rich, tabulate)' },
  node: { title: 'npm packages', site: 'npm', search: 'npm/search', versions: 'npm/versions', placeholder: 'Search npm (e.g. express, zod, dayjs)' },
};
/** Editor language from a file name (the editor's highlighting and the intelligence service follow it). */
export const langOfPath = p =>
  /\.cs$/i.test(p) ? 'csharp'
    : /\.py[iw]?$/i.test(p) ? 'python'
      : /\.([cm]?ts|tsx)$/i.test(p) ? 'typescript'
        : /\.([cm]?js|jsx)$/i.test(p) ? 'javascript'
          : /\.json$/i.test(p) || /(^|\/)\.?(babelrc|eslintrc|prettierrc)$/i.test(p) ? 'json'
            : /\.(s?css|less)$/i.test(p) ? 'css'
              : /\.(html?|cshtml|razor|csproj|props|targets|xml|slnx|config|svg)$/i.test(p) ? 'html'
                : 'text';
/** The source files of a kind of space (what the intelligence service sees together). */
const SOURCE_RX = { dotnet: /\.cs$/i, python: /\.pyi?$/i, node: /\.([cm]?[jt]s|[jt]sx)$/i };

/** An in-page text prompt (window.prompt may be blocked in embedded browsers). */
function promptBox(message, value = '', ok = 'OK') {
  return new Promise(resolve => {
    const input = h('input.cs-prompt-input', { value, spellcheck: false, autocomplete: 'off' });
    const done = v => { overlay.remove(); resolve(v); };
    const overlay = h('div.modal-back', { onclick: e => { if (e.target === overlay) done(null); } },
      h('div.modal', { role: 'dialog', 'aria-modal': 'true' }, h('p', message), input,
        h('div.modal-actions', h('button.btn.ghost', { type: 'button', onclick: () => done(null) }, 'Cancel'),
          h('button.btn.primary', { type: 'button', onclick: () => done(input.value.trim()) }, ok))));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    document.body.append(overlay);
    input.focus();
    const slash = value.lastIndexOf('/') + 1, dot = value.lastIndexOf('.');
    input.setSelectionRange(slash, dot > slash ? dot : value.length);
  });
}

export function codeSpaces(page, name) {
  return name ? ide(page, decodeURIComponent(name)) : spacesList(page);
}

// ================================================================ the list

function spacesList(page) {
  let data = null;
  const grid = h('div.cs-cards');
  const where = h('span.muted.small');

  async function load() {
    try { data = await call('spaces'); } catch { put(grid, h('p.muted', 'Could not reach the dojo server.')); return; }
    where.textContent = `Stored in ${data.root}`;
    put(grid,
      h('button.cs-card.cs-new', { type: 'button', onclick: createDialog }, h('div.cs-card-icon', '+'), h('b', 'New space'), h('span.muted.small', '.NET, Python or Node.js: console apps, web APIs, libraries with tests, Next.js')),
      data.spaces.map(s => h('div.cs-card',
        h('a.cs-card-main', { href: `#/spaces/${enc(s.name)}` },
          h('div.cs-card-icon', { title: KIND_NAME[s.kind] || '' }, TEMPLATE_ICON[s.template] || KIND_ICON[s.kind] || '▤'),
          h('b', s.name, s.running && h('span.cs-dot.on', { title: 'Running' })),
          h('span.muted.small', s.projects.length ? s.projects.join(' · ') : 'no projects yet'),
          h('span.muted.small', `Changed ${new Date(s.modified).toLocaleString()}`)),
        h('div.cs-card-actions',
          h('a.btn.primary.small', { href: `#/spaces/${enc(s.name)}` }, 'Open'),
          h('button.btn.ghost.small', { type: 'button', onclick: async () => {
            if (!await ask(`Move "${s.name}" to the trash? It goes to ${data.root}\\.trash, so you can still get it back.`, { ok: 'Move to trash', danger: true })) return;
            const r = await call(`spaces/${enc(s.name)}/delete`, {});
            if (r.error) alertBox(r.error); else load();
          } }, 'Delete')))),
      data.spaces.length === 0 && h('p.muted.cs-empty-note', 'No spaces yet. A space is a real project folder (.NET, Python or Node.js): build it, run it, test it and add packages from NuGet, PyPI or npm, all from here.'));
  }

  function createDialog() {
    let template = 'console';
    const nameInput = h('input.cs-prompt-input', { placeholder: 'my-app', spellcheck: false, autocomplete: 'off' });
    const status = h('div.small.muted');
    const out = h('pre.cs-create-out', { hidden: true });
    const tpls = h('div.cs-templates');
    const kinds = [...new Set(data.templates.map(t => t.kind || 'dotnet'))];
    const paintTemplates = () => put(tpls, kinds.map(k => [
      kinds.length > 1 && h('div.cs-template-group.small.muted', KIND_NAME[k] || k),
      data.templates.filter(t => (t.kind || 'dotnet') === k).map(t => h(`button.cs-template${t.id === template ? '.active' : ''}`, { type: 'button', onclick: () => { template = t.id; paintTemplates(); } },
        h('span.cs-template-icon', TEMPLATE_ICON[t.id] || '▤'), h('b', t.name), h('span.small.muted', t.description)))]));
    paintTemplates();
    const createBtn = h('button.btn.primary', { type: 'button', onclick: create }, 'Create');
    const overlay = h('div.modal-back', { onclick: e => { if (e.target === overlay && !createBtn.disabled) overlay.remove(); } },
      h('div.modal.cs-create', { role: 'dialog', 'aria-modal': 'true' },
        h('h3', 'New code space'),
        h('label.small.muted', 'Name (letters, digits, - and _)'), nameInput,
        h('label.small.muted', 'Template'), tpls, status, out,
        h('div.modal-actions', h('button.btn.ghost', { type: 'button', onclick: () => overlay.remove() }, 'Cancel'), createBtn)));
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') create(); if (e.key === 'Escape') overlay.remove(); });
    document.body.append(overlay);
    nameInput.focus();

    async function create() {
      const name = nameInput.value.trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)) { status.textContent = 'Use 1–40 letters, digits, - or _, starting with a letter.'; return; }
      createBtn.disabled = true;
      const tk = data.templates.find(t => t.id === template)?.kind || 'dotnet';
      status.textContent = template === 'empty' ? 'Creating…'
        : tk === 'python' ? 'Writing the files and creating the virtual environment (.venv)… (installing pytest can take a little longer)'
          : tk === 'node' ? 'Writing the files… (npm packages install in the background once the space opens)'
            : 'Running dotnet new and restoring packages… (the first time can take a minute)';
      status.scrollIntoView({ block: 'nearest' });       // the template list can push it below the fold
      try {
        const r = await call('spaces', { name, template });
        if (r.error) {
          status.textContent = r.error;
          if (r.output) { out.hidden = false; out.textContent = r.output; }
          createBtn.disabled = false;
          return;
        }
        overlay.remove();
        location.hash = `#/spaces/${enc(name)}`;
      } catch { status.textContent = 'Could not reach the dojo server.'; createBtn.disabled = false; }
    }
  }

  page('spaces',
    h('div.cs-list',
      h('div.track-head',
        h('div', h('h2.track-title', 'Code spaces'),
          h('p.muted', 'Real projects on your machine (.NET, Python, Node.js): many files, packages from NuGet, PyPI or npm, build, run and test, with code intelligence across the whole project.')),
        where),
      grid));
  load();
  return () => { };
}

function alertBox(message) { return ask(message, { ok: 'OK', cancel: 'Close' }); }

// ================================================================ the IDE

function ide(page, space) {
  const base = `spaces/${enc(space)}`;
  let detail = null;                 // { projects, tree, solution, job }
  const sources = new Map();         // every .cs file: path -> text (what the intelligence service sees)
  const tabs = [];                   // { path, saved, editor, dirty, binary, el }
  let active = null;
  let since = 0, job = null, problems = [], problemsKey = '';
  let stopped = false, pollTimer = null;
  let target = localStorage.getItem(`dojo-space-target:${space}`) || '';
  let pkgProject = '';
  const expanded = new Set(JSON.parse(localStorage.getItem(`dojo-space-open:${space}`) || '[]'));
  let autosave = localStorage.getItem('dojo-space-autosave') === 'on';
  let bottomTab = 'output';
  let nugetTouched = false;     // the learner picked the NuGet project by hand: stop following the open file
  // Debugger: breakpoints per file (saved per space), and a recorded run to move through (ui/debugger.js).
  const bps = breakpointStore(`dojo-space-bps:${space}`);
  let debugging = false, dbgBusy = false, dbgLoc = null;
  const pendingOpen = new Map();
  // Python and Node spaces (detail.kind): no .csproj projects; Run takes a file or an npm script instead.
  const kind = () => detail?.kind || 'dotnet';
  const poly = () => kind() !== 'dotnet';
  const reg = () => REGISTRY[kind()] || REGISTRY.dotnet;
  const isSource = p => (SOURCE_RX[kind()] || SOURCE_RX.dotnet).test(p) && !/(^|\/)(node_modules|\.venv|\.next|bin|obj)\//.test(p);
  const runExt = p => kind() === 'python' ? /\.py$/i.test(p) : /\.([cm]?[jt]s)$/i.test(p) && !/\.d\.ts$/i.test(p);
  let npmDev = false;           // npm: install as a devDependency

  // ------------------------------------------------------------ project helpers

  const projects = () => detail?.projects || [];
  const projectOf = path => projects().filter(p => p.dir === '' || path.startsWith(p.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
  const byPath = p => projects().find(x => x.path === p);
  /** The project and everything it references, transitively. */
  function closure(project) {
    const seen = new Set(), out = [];
    const walk = p => { if (!p || seen.has(p.path)) return; seen.add(p.path); out.push(p); p.projectRefs.forEach(r => walk(byPath(r))); };
    walk(project);
    return out;
  }
  const isBuildOutput = p => /(^|\/)(bin|obj)\//.test(p);
  /** What the intelligence service needs for a file: its project's sources, its references' sources, its global usings. */
  function intelFiles(path) {
    // Python / Node: every source file of the space's language (the editor sends its language with them).
    if (poly()) return [...sources].filter(([p]) => isSource(p)).map(([p, code]) => ({ path: p, code }));
    const proj = projectOf(path);
    if (!proj) return [...sources].map(([p, code]) => ({ path: p, code }));
    const set = closure(proj);
    const others = projects().filter(p => !set.includes(p) && p.dir.length > proj.dir.length);
    const files = [];
    for (const [p, code] of sources) {
      if (isBuildOutput(p)) continue;
      const owner = projectOf(p);
      if (owner && set.includes(owner) && !others.includes(owner)) files.push({ path: p, code });
    }
    for (const p of set) if (p.globalUsings) files.push({ path: `${p.dir ? p.dir + '/' : ''}obj/GlobalUsings.g.cs`, code: p.globalUsings });
    return files;
  }
  const intelRefs = path => {
    if (poly()) return [];
    const proj = projectOf(path);
    return proj ? [...new Set(closure(proj).flatMap(p => p.references))] : [];
  };

  // ------------------------------------------------------------ loading

  async function loadDetail() {
    const d = await call(base);
    if (d.error) { put(root, h('div.empty', h('h2', d.error), h('a.btn.primary', { href: '#/spaces' }, 'All spaces'))); stopped = true; return false; }
    detail = d;
    if (!pkgProject || !byPath(pkgProject)) pkgProject = (projects().find(p => p.kind !== 'test') || projects()[0])?.path || '';
    const validTarget = poly()
      ? target === '@current' || (detail.entries || []).includes(target) || (target.startsWith('script:') && detail.scripts && target.slice(7) in detail.scripts)
      : target === detail.solution || byPath(target);
    if (target && !validTarget) target = '';
    paintTree(); paintToolbar(); paintPkgHead(); paintInstalled();
    return true;
  }
  async function loadSources() {
    const lang = kind() === 'python' ? 'python' : kind() === 'node' ? 'typescript' : '';
    const r = await call(`${base}/sources${lang ? `?lang=${lang}` : ''}`);
    if (r.files) {
      const open = new Set(tabs.map(t => t.path));
      for (const f of r.files) if (!open.has(f.path)) sources.set(f.path, f.code);
      for (const p of [...sources.keys()]) if (!r.files.some(f => f.path === p) && !open.has(p)) sources.delete(p);
    }
  }

  // ------------------------------------------------------------ tabs + editors

  const tabBar = h('div.cs-tabs');
  const dbgHost = h('div.cs-dbghost', { hidden: true });
  const edHost = h('div.cs-edhost');
  const emptyEd = h('div.cs-noeditor.muted', 'Open a file from the explorer.');

  const langOf = langOfPath;

  async function openFile(path, at) {
    let tab = tabs.find(t => t.path === path);
    if (!tab) {
      const r = await call(`${base}/file?path=${enc(path)}`);
      if (r.error && !r.binary) { alertBox(r.error); return; }
      tab = { path, saved: r.code ?? '', dirty: false, binary: !!r.binary };
      if (tab.binary) tab.el = h('div.cs-noeditor.muted', `${path} is a binary or very large file (${(r.size || 0).toLocaleString()} bytes) and cannot be edited here.`);
      else {
        const lang = langOf(path);
        tab.editor = createEditor({
          value: tab.saved, minLines: 30, language: lang, path,
          assist: true,
          files: () => intelFiles(tab.path),
          references: () => intelRefs(tab.path),
          onNavigate: (p, line, col, len) => { if (!/\/?obj\//.test(p)) openFile(p, { line, col, len }); },
          onChange: v => {
            if (isSource(tab.path)) sources.set(tab.path, v);
            const dirty = v !== tab.saved;
            if (dirty !== tab.dirty) { tab.dirty = dirty; paintTabs(); paintTree(); }
            if (autosave) { clearTimeout(tab.timer); tab.timer = setTimeout(() => save(tab), 900); }
          },
          onRun: () => run(),
          onGutterClick: line => toggleBreakpoint(tab, line),
        });
        tab.el = tab.editor.el;
        tab.editor.setBreakpoints(bps.lines(path));
        if (dbgLoc?.file === path) tab.editor.setCurrent(dbgLoc.line, dbgLoc.kind);
        markTab(tab);
      }
      tabs.push(tab);
      edHost.append(tab.el);
      saveTabs();
    }
    activate(tab);
    if (at && tab.editor) requestAnimationFrame(() => tab.editor.select(at.line, at.col || 1, at.len || 0));
  }

  function activate(tab) {
    active = tab;
    for (const t of tabs) t.el.hidden = t !== tab;
    emptyEd.hidden = !!tab;
    paintTabs(); paintTree();
    if (tab?.editor) tab.editor.focus();
    if (tab) { const proj = projectOf(tab.path); if (proj && proj.path !== pkgProject && !nugetTouched) { pkgProject = proj.path; paintInstalled(); } }
    saveTabs();
  }

  async function closeTab(tab) {
    if (tab.dirty && !await ask(`${tab.path} has unsaved changes. Close it anyway?`, { ok: 'Discard changes', danger: true })) return;
    if (tab.dirty) sources.set(tab.path, tab.saved);
    tabs.splice(tabs.indexOf(tab), 1);
    tab.el.remove();
    if (active === tab) activate(tabs.at(-1) || null);
    else paintTabs();
    saveTabs();
  }

  function saveTabs() {
    try { localStorage.setItem(`dojo-space-tabs:${space}`, JSON.stringify({ open: tabs.map(t => t.path), active: active?.path })); } catch { }
  }

  function paintTabs() {
    put(tabBar, tabs.map(t => h(`div.cs-tab${t === active ? '.active' : ''}`, { title: t.path, onmousedown: e => { if (e.button === 1) { e.preventDefault(); closeTab(t); } } },
      h('button.cs-tab-name', { type: 'button', onclick: () => activate(t) }, t.path.split('/').pop(), t.dirty && h('span.cs-dirty', { title: 'Unsaved' }, '●')),
      h('button.cs-tab-x', { type: 'button', title: 'Close', onclick: () => closeTab(t) }, '×'))),
      h('span.spacer'),
      h('label.cs-autosave.small.muted', { title: 'Save a file a moment after you stop typing' },
        h('input', { type: 'checkbox', checked: autosave, onchange: e => { autosave = e.target.checked; localStorage.setItem('dojo-space-autosave', autosave ? 'on' : 'off'); if (autosave) tabs.filter(t => t.dirty).forEach(save); } }),
        'Auto-save'));
  }

  async function save(tab = active) {
    if (!tab?.editor || !tab.dirty) return true;
    const code = tab.editor.value;
    const r = await call(`${base}/file`, { path: tab.path, code }).catch(() => ({ error: 'Could not reach the dojo server.' }));
    if (r.error) { setStatus(r.error); return false; }
    tab.saved = code;
    tab.dirty = tab.editor.value !== code;
    paintTabs(); paintTree();
    return true;
  }
  const saveAll = async () => { for (const t of tabs.filter(t => t.dirty)) if (!await save(t)) return false; return true; };

  function markTab(tab) {
    if (!tab.editor) return;
    tab.editor.mark(problems.filter(p => p.file === tab.path && p.line > 0).map(p => ({ severity: p.severity, line: p.line })));
  }

  // ------------------------------------------------------------ explorer

  const treeEl = h('div.cs-tree', { tabindex: 0 });
  const menu = h('div.cs-menu', { hidden: true });
  document.addEventListener('mousedown', closeMenu, true);
  function closeMenu(e) { if (!menu.hidden && !menu.contains(e?.target)) menu.hidden = true; }

  function buildTree() {
    const rootNode = { path: '', dir: true, children: [] };
    const index = new Map([['', rootNode]]);
    for (const e of detail?.tree || []) {
      const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
      const node = { path: e.path, name: e.path.split('/').pop(), dir: e.dir, children: [] };
      index.set(e.path, node);
      (index.get(parent) || rootNode).children.push(node);
    }
    const sort = n => { n.children.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })); n.children.forEach(sort); };
    sort(rootNode);
    return rootNode;
  }

  const fileIcon = name => /\.cs$/i.test(name) ? 'C#' : /\.csproj$/i.test(name) ? '⚙' : /\.slnx?$/i.test(name) ? '▦'
    : /\.py$/i.test(name) ? 'py' : /\.tsx?$/i.test(name) ? 'TS' : /\.[cm]?jsx?$/i.test(name) ? 'JS' : /\.css$/i.test(name) ? '#'
      : /^(package\.json|requirements\.txt|pyproject\.toml|tsconfig\.json)$/i.test(name) ? '⚙'
        : /\.json$/i.test(name) ? '{}' : /\.md$/i.test(name) ? '¶' : /\.html?$/i.test(name) ? '<>' : '·';

  function paintTree() {
    if (!detail) return;
    const rows = [];
    const dirty = new Set(tabs.filter(t => t.dirty).map(t => t.path));
    const errFiles = new Set(problems.filter(p => p.severity === 'error' && p.file).map(p => p.file));
    const walk = (node, depth) => {
      for (const c of node.children) {
        const open = expanded.has(c.path);
        rows.push(h(`div.cs-node${c.dir ? '.dir' : ''}${active?.path === c.path ? '.active' : ''}`, {
          style: { paddingLeft: `${8 + depth * 14}px` }, title: c.path,
          onclick: () => { if (c.dir) { open ? expanded.delete(c.path) : expanded.add(c.path); saveExpanded(); paintTree(); } else openFile(c.path); },
          oncontextmenu: e => { e.preventDefault(); showMenu(e, c); },
        },
        h('span.cs-node-icon', c.dir ? (open ? '▾' : '▸') : fileIcon(c.name)),
        h(`span.cs-node-name${errFiles.has(c.path) ? '.err' : ''}`, c.name),
        dirty.has(c.path) && h('span.cs-dirty', '●')));
        if (c.dir && open) walk(c, depth + 1);
      }
    };
    walk(buildTree(), 0);
    put(treeEl, rows.length ? rows : h('div.muted.small.cs-pad', 'Empty. Right-click here or use + to add a file.'));
  }
  const saveExpanded = () => { try { localStorage.setItem(`dojo-space-open:${space}`, JSON.stringify([...expanded])); } catch { } };
  treeEl.addEventListener('contextmenu', e => { if (e.target === treeEl || e.target.classList.contains('cs-pad')) { e.preventDefault(); showMenu(e, { path: '', dir: true }); } });

  function showMenu(e, node) {
    const folder = node.dir ? node.path : node.path.split('/').slice(0, -1).join('/');
    const item = (label, fn) => h('button.cs-menu-item', { type: 'button', onclick: () => { menu.hidden = true; fn(); } }, label);
    put(menu,
      item('New file…', () => newEntry('newfile', folder)),
      item('New folder…', () => newEntry('mkdir', folder)),
      node.path && item('Rename / move…', () => rename(node)),
      node.path && item('Delete', () => remove(node)));
    menu.hidden = false;
    menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 160)}px`;
  }

  async function fs(op, path, to) {
    const r = await call(`${base}/fs`, { op, path, to }).catch(() => ({ error: 'Could not reach the dojo server.' }));
    if (r.error) { alertBox(r.error); return null; }
    await Promise.all([loadDetail(), loadSources()]);
    return r;
  }

  async function newEntry(op, folder) {
    const label = op === 'mkdir' ? 'New folder' : poly() ? `New file (e.g. ${kind() === 'python' ? 'utils.py or tests/test_utils.py' : 'utils.ts or lib/math.js'})` : 'New file (for C#, a class named after the file is started for you)';
    const name = await promptBox(label, folder ? `${folder}/` : '', 'Create');
    if (!name || name.endsWith('/')) return;
    const r = await fs(op, name);
    if (!r) return;
    let p = r.path; while (p.includes('/')) { p = p.slice(0, p.lastIndexOf('/')); expanded.add(p); }
    saveExpanded(); paintTree();
    if (op === 'newfile') openFile(r.path);
  }

  async function rename(node) {
    const to = await promptBox(`Rename or move ${node.path}`, node.path, 'Rename');
    if (!to || to === node.path) return;
    const dirtyHere = tabs.filter(t => t.dirty && (t.path === node.path || t.path.startsWith(node.path + '/')));
    for (const t of dirtyHere) await save(t);
    const r = await fs('rename', node.path, to);
    if (!r) return;
    for (const t of tabs) {
      if (t.path === node.path || t.path.startsWith(node.path + '/')) {
        const np = r.path + t.path.slice(node.path.length);
        if (sources.has(t.path)) { sources.set(np, sources.get(t.path)); sources.delete(t.path); }
        bps.rename(t.path, np);
        t.path = np;
      }
    }
    paintTabs(); paintTree(); saveTabs();
  }

  async function remove(node) {
    if (!await ask(`Move ${node.path} to the trash?`, { ok: 'Move to trash', danger: true })) return;
    const r = await fs('delete', node.path);
    if (!r) return;
    for (const t of [...tabs]) if (t.path === node.path || t.path.startsWith(node.path + '/')) { t.dirty = false; await closeTab(t); }
  }

  // ------------------------------------------------------------ toolbar: build, run, test

  const targetSel = h('select.cs-target', { title: 'What Build, Run and Test act on', onchange: e => { target = e.target.value; localStorage.setItem(`dojo-space-target:${space}`, target); paintToolbar(); } });
  const buildBtn = h('button.btn.ghost', { type: 'button', title: 'Build (Ctrl+Shift+B)', onclick: () => runJob('build') }, '⚒ Build');
  const runBtn = h('button.btn.primary', { type: 'button', title: `Run without debugging (${DEBUG_KEYS.run} or Ctrl+Enter)`, onclick: () => run() }, '▶ Run');
  const debugBtn = h('button.btn.ghost.cs-debug-btn', { type: 'button', title: `Debug: record the run, then step through it, backwards too (${DEBUG_KEYS.start}). A web app keeps running and every request it answers is recorded. Click a line number to set a breakpoint (${DEBUG_KEYS.toggle}).`, onclick: () => startDebug() }, '● Debug');
  const stopBtn = h('button.btn.ghost', { type: 'button', title: 'Stop', onclick: stop }, '■ Stop');
  const testBtn = h('button.btn.ghost', { type: 'button', title: 'Run the tests', onclick: () => runJob('test') }, '✓ Test');
  const installBtn = h('button.btn.ghost', { type: 'button', onclick: () => restore() }, '⇩ Install packages');
  const statusEl = h('span.cs-status.small');
  const urlEl = h('span.cs-url');
  let statusNote = '';
  const setStatus = text => { statusNote = text; paintStatus(); };

  /** Python / Node: what Run starts (a file path, "script:name", or null for the space's default). */
  function polyRunTarget() {
    if (target === '@current') return active && runExt(active.path) ? active.path : null;
    return target || null;
  }
  const npmTestScript = () => { const t = detail?.scripts?.test; return t && !/no test specified/i.test(t) ? t : null; };
  /** Python / Node: packages listed in the manifest that are not installed (or no environment yet). */
  const missingPackages = () => poly() && ((detail?.packages || []).some(p => !p.installed) || (kind() === 'python' && detail?.env && !detail.env.venv));

  function runnable() {
    if (poly()) return detail?.defaultEntry || polyRunTarget() ? { kind: 'console', path: polyRunTarget() } : null;
    const t = target && byPath(target);
    if (t && (t.kind === 'console' || t.kind === 'web')) return t;
    return projects().find(p => p.kind === 'console' || p.kind === 'web');
  }

  function paintToolbar() {
    let opts;
    if (poly()) {
      const def = detail?.defaultEntry;
      const label = e => e.startsWith('script:') ? `npm run ${e.slice(7)}` : e;
      opts = [h('option', { value: '' }, def ? `Default: ${label(def)}` : 'Default'),
        h('option', { value: '@current' }, 'The file in the editor'),
        (detail?.entries || []).map(e => h('option', { value: e }, e)),
        Object.keys(detail?.scripts || {}).filter(s => kind() === 'node').map(s => h('option', { value: `script:${s}`, title: detail.scripts[s] }, `npm run ${s}`))];
    } else {
      opts = [h('option', { value: '' }, detail?.solution ? `Whole solution (${detail.solution})` : 'Default project')];
      if (detail?.solution) opts.push(h('option', { value: detail.solution, selected: target === detail.solution }, detail.solution));
      for (const p of projects()) opts.push(h('option', { value: p.path, selected: target === p.path }, `${p.name}  ·  ${p.kind}`));
    }
    put(targetSel, opts);
    targetSel.value = target;
    targetSel.title = poly() ? 'What Run starts: a file, or an npm script' : 'What Build, Run and Test act on';
    const busy = job?.status === 'running';
    buildBtn.disabled = testBtn.disabled = installBtn.disabled = busy && job.kind !== 'run';
    runBtn.disabled = (busy && job.kind !== 'run') || !runnable();
    debugBtn.hidden = poly();
    debugBtn.disabled = dbgBusy || !debuggable();
    debugBtn.textContent = dbgBusy ? '● Recording…' : debugging ? '● Debugging' : '● Debug';
    if (poly()) {
      const check = kind() === 'python' || !detail?.scripts?.build;
      buildBtn.textContent = check ? '✓ Check' : '⚒ Build';
      buildBtn.title = kind() === 'python' ? 'Check every .py file for syntax errors (Ctrl+Shift+B)'
        : check ? 'Check the scripts for syntax errors (type-checks with tsc when typescript is installed) (Ctrl+Shift+B)' : 'npm run build (Ctrl+Shift+B)';
      testBtn.hidden = !(detail?.hasTests || npmTestScript());
      testBtn.title = kind() === 'python' ? 'Run the tests with pytest' : npmTestScript() && npmTestScript() !== 'node --test' ? 'npm test' : 'Run the tests with node --test';
      installBtn.hidden = false;
      installBtn.className = `btn ${missingPackages() ? 'primary' : 'ghost'}`;
      installBtn.title = kind() === 'python' ? 'pip install -r requirements.txt into this space\'s .venv' : 'npm install (needs the npm registry)';
    } else {
      buildBtn.textContent = '⚒ Build'; buildBtn.title = 'Build (Ctrl+Shift+B)';
      testBtn.hidden = !projects().some(p => p.kind === 'test');
      installBtn.hidden = true;
    }
    stopBtn.disabled = !busy && !(webDebugging() && dbgLive.alive);
    runBtn.textContent = busy && job.kind === 'run' ? '↻ Restart' : '▶ Run';
    paintStatus();
    paintRequestTab();
  }

  function paintStatus() {
    if (job) {
      const secs = (job.ms / 1000).toFixed(1);
      const what = `${job.kind}${job.project ? ' ' + job.project.split('/').pop() : ''}`;
      const state = job.status === 'running' ? (job.kind === 'run' && job.listening ? 'running' : `${job.kind === 'run' ? 'starting' : 'running'} · ${secs}s`) : `${job.status} · ${secs}s`;
      statusEl.className = `cs-status small ${job.status}`;
      statusEl.textContent = `${what}: ${state}${statusNote ? ' · ' + statusNote : ''}`;
    } else { statusEl.className = 'cs-status small'; statusEl.textContent = statusNote; }
    put(urlEl, job?.status === 'running' && job.url && job.listening && [
      h('a.mono.small', { href: job.url, target: '_blank', rel: 'noopener', title: 'Open in a new browser tab' }, job.url + ' ↗'),
    ]);
  }

  async function runJob(kind, project) {
    if (!await saveAll()) return;
    statusNote = '';
    const projectArg = poly() ? null : project ?? (target || null);
    const runArg = poly() ? polyRunTarget() : runnable()?.path || null;
    const r = await call(`${base}/${kind}`, { project: kind === 'run' ? runArg : projectArg }).catch(() => ({ error: 'Could not reach the dojo server.' }));
    if (r.error) {
      setStatus(r.error);
      // Python / Node: offer the missing piece.
      if (r.needs === 'pytest' && await ask(`${r.error}\n\nInstall pytest into this space now?`, { ok: 'Install pytest' })) packageOp('pytest', null, false, true);
      else if (r.needs === 'install' && await ask(`${r.error}\n\nRun npm install now?`, { ok: 'Install packages' })) restore();
      return;
    }
    job = r.job;
    if (kind !== 'run' || bottomTab !== 'request') showBottom('output');
    paintToolbar();
    pollSoon(150);
  }
  const run = () => runJob('run');

  async function restore() {
    if (!await saveAll()) return;
    statusNote = '';
    const r = await call(`${base}/restore`, {}).catch(() => ({ error: 'Could not reach the dojo server.' }));
    if (r.error) { setStatus(r.error); return; }
    job = r.job; showBottom('output'); paintToolbar(); pollSoon(150);
  }

  async function stop() {
    if (webDebugging() && !(job?.status === 'running')) { stopDebug(); return; }     // Stop ends the debugged app
    await call(`${base}/stop`, {}).catch(() => null); pollSoon(100);
  }

  // ------------------------------------------------------------ bottom panel: problems, output, request

  const problemsEl = h('div.cs-problems');
  const outEl = h('pre.cs-output');
  const stdin = h('input.cs-stdin.mono', { placeholder: 'Type input for the running program and press Enter', spellcheck: false,
    onkeydown: async e => {
      if (e.key !== 'Enter') return;
      const text = stdin.value; stdin.value = '';
      await call(`${base}/stdin`, { text }).catch(() => null);
      pollSoon(100);
    } });
  const requestEl = h('div.cs-request');
  const bottomTabs = h('div.cs-bottom-tabs');
  const bottomBody = h('div.cs-bottom-body');
  let outLines = [];

  function showBottom(tab) { bottomTab = tab; paintBottom(); }
  function paintBottom() {
    const errs = problems.filter(p => p.severity === 'error').length, warns = problems.length - errs;
    const web = runnable()?.kind === 'web' || !!job?.url || webDebugging();
    put(bottomTabs,
      h(`button.tab.small${bottomTab === 'problems' ? '.active' : ''}`, { type: 'button', onclick: () => showBottom('problems') }, `Problems${problems.length ? ` (${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'})` : ''}`),
      h(`button.tab.small${bottomTab === 'output' ? '.active' : ''}`, { type: 'button', onclick: () => showBottom('output') }, 'Output'),
      web && h(`button.tab.small${bottomTab === 'request' ? '.active' : ''}`, { type: 'button', onclick: () => showBottom('request') }, 'Request'),
      debugging && h(`button.tab.small${bottomTab === 'debug' ? '.active' : ''}`, { type: 'button', onclick: () => showBottom('debug') }, 'Debug output'),
      h('span.spacer'),
      bottomTab === 'output' && h('button.btn.ghost.small', { type: 'button', onclick: () => { outLines = []; outEl.textContent = ''; } }, 'Clear'));
    put(bottomBody,
      bottomTab === 'problems' && problemsEl,
      bottomTab === 'output' && [outEl, job?.status === 'running' && job.kind === 'run' && stdin],
      bottomTab === 'request' && requestEl,
      bottomTab === 'debug' && debugging && (webDebugging()
        ? [h('div.small.muted.dbg-logl', 'The app\'s output, live (this request\'s own output is in its steps)'), appLog]
        : [dbg.output, dbgLive?.waiting && h('div.dbg-prompt', h('span.small.warn', 'Waiting for input ▸'), dbgIn)]));
    if (bottomTab === 'output') outEl.scrollTop = outEl.scrollHeight;
  }

  function paintProblems() {
    put(problemsEl, problems.length ? problems.map(p => h(`button.cs-problem.${p.severity}`, { type: 'button', disabled: !p.file, onclick: () => p.file && openFile(p.file, { line: p.line || 1, col: p.column || 1 }) },
      h('span.cs-sev', p.severity === 'error' ? '✕' : '!'),
      h('span.cs-code.mono', p.code),
      h('span.cs-msg', p.message),
      p.file && h('span.cs-where.mono', `${p.file}${p.line ? `:${p.line}` : ''}`)))
      : h('div.muted.small.cs-pad', job ? 'No problems.' : poly() ? 'Run, Check or Test: errors (tracebacks, failed tests, syntax errors) show up here.' : 'Build to see errors and warnings here.'));
  }

  function appendOutput(lines) {
    if (!lines.length) return;
    const nearBottom = outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 40;
    const text = lines.map(l => (l.stream === 'in' ? '< ' : '') + l.text);
    outLines.push(...text);
    if (outLines.length > 4000) { outLines = outLines.slice(-3000); outEl.textContent = outLines.join('\n') + '\n'; }
    else outEl.append(document.createTextNode(text.join('\n') + '\n'));
    if (nearBottom) outEl.scrollTop = outEl.scrollHeight;
  }

  // A small request client for web projects (the Workbench's tracer only sees apps it compiled itself).
  const req = JSON.parse(sessionStorage.getItem(`dojo-space-req:${space}`) || 'null') || { method: 'GET', path: '/', body: '' };
  let reply = null;
  function paintRequestTab() {
    const saveReq = () => sessionStorage.setItem(`dojo-space-req:${space}`, JSON.stringify(req));
    // While a web app is being debugged, requests go to it (and show up in the debugger's Requests list).
    const dbgUrl = webDebugging() && dbgLive.alive && dbgLive.listening ? dbgLive.url : null;
    const live = !!dbgUrl || (job?.status === 'running' && job.url && job.listening);
    const baseUrl = dbgUrl || job?.url;
    const send = async () => {
      reply = { pending: true }; paintRequestTab();
      reply = await call(`${base}/send`, { method: req.method, path: req.path, body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? null : req.body, contentType: 'application/json' })
        .catch(() => ({ error: 'Could not reach the dojo server.' }));
      paintRequestTab();
      // Debugging: open the recording of the request just sent.
      const id = Number(reply?.headers?.find(([k]) => /^x-dojo-request$/i.test(k))?.[1]);
      if (webDebugging() && id > 0) { await pollLive(); await loadRequest(id); }
    };
    let body = reply?.body || '';
    try { if (reply?.headers?.some(([k, v]) => /content-type/i.test(k) && /json/.test(v))) body = JSON.stringify(JSON.parse(body), null, 2); } catch { }
    put(requestEl,
      h('div.wb-line',
        h('select.wb-method', { onchange: e => { req.method = e.target.value; saveReq(); paintRequestTab(); } }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => h('option', { selected: req.method === m }, m))),
        h('span.wb-base.mono.small', live ? baseUrl : '(not running)'),
        h('input.wb-path.mono', { value: req.path, oninput: e => { req.path = e.target.value; saveReq(); }, onkeydown: e => { if (e.key === 'Enter') send(); } }),
        h('button.btn.primary.small', { type: 'button', disabled: !live, onclick: send }, 'Send')),
      !['GET', 'HEAD', 'DELETE'].includes(req.method) && h('textarea.answer.mono.cs-req-body', { rows: 4, spellcheck: false, placeholder: '{ "json": "body" }', value: req.body, oninput: e => { req.body = e.target.value; saveReq(); } }),
      !live && h('p.muted.small', webDebugging() ? 'The debugged app is not listening (yet).' : 'Run (or Debug) the web project, then send it requests from here, or open its URL in your browser.'),
      dbgUrl && h('p.muted.small', 'Debugging: each request is recorded; it opens in the debugger when the answer comes back.'),
      reply?.pending && h('p.muted.small', 'Sending…'),
      reply?.error && h('div.wb-problem', reply.error),
      reply?.status && h('div.wb-line', h(`span.wb-status.${reply.status < 400 ? 'ok' : reply.status < 500 ? 'warn' : 'bad'}`, `${reply.status} ${reply.reason || ''}`), h('span.muted.small', `${reply.ms} ms · ${reply.size.toLocaleString()} bytes`)),
      reply?.status && h('pre.code.plain.cs-req-out', body || '(empty body)'));
    if (bottomTab === 'request') paintBottom();
  }

  // ------------------------------------------------------------ packages: NuGet, PyPI or npm (follows the space's kind)

  const nugetEl = h('div.cs-nuget');
  const pkgSel = h('select.cs-pkg-project', { onchange: e => { pkgProject = e.target.value; nugetTouched = true; paintInstalled(); } });
  const searchInput = h('input.cs-search', { type: 'search', placeholder: REGISTRY.dotnet.placeholder, spellcheck: false });
  const resultsEl = h('div.cs-results');
  const installedEl = h('div.cs-installed');
  const pkgHead = h('div.cs-panel-head');
  const pkgNote = h('div.small.muted.cs-pkg-note', { hidden: true });
  const installedHead = h('div.cs-panel-sub', 'Installed');
  let searchTimer = null, searchTicket = 0, showAllPy = false;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 350); });
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); search(); } });
  searchInput.addEventListener('focus', () => { if (kind() === 'python' && !searchInput.value.trim() && !resultsEl.childElementCount) search(); });

  function paintPkgHead() {
    const r = reg();
    searchInput.placeholder = r.placeholder;
    put(pkgHead, h('b', r.title), h('span.spacer'),
      !poly() && [h('span.small.muted', 'for'), pkgSel],
      kind() === 'node' && h('label.small.muted.cs-dev', { title: 'Install as a devDependency (tools and types you only need while developing)' },
        h('input', { type: 'checkbox', checked: npmDev, onchange: e => { npmDev = e.target.checked; } }), 'dev'));
    installedHead.textContent = kind() === 'python' ? 'In requirements.txt' : kind() === 'node' ? 'In package.json' : 'Installed';
  }

  async function search() {
    const q = searchInput.value.trim();
    const ticket = ++searchTicket;
    if (!q && kind() !== 'python') { put(resultsEl); pkgNote.hidden = true; return; }
    put(resultsEl, h('div.muted.small.cs-pad', `Searching ${reg().site}…`));
    const r = await call(`${reg().search}?q=${enc(q)}&take=20`).catch(() => ({ error: 'Could not reach the dojo server.' }));
    if (ticket !== searchTicket) return;
    pkgNote.hidden = !(r.note || r.warning);
    pkgNote.textContent = [r.note, r.warning].filter(Boolean).join(' ');
    if (r.error) { put(resultsEl, h('div.wb-problem.small', r.error)); return; }
    put(resultsEl, r.packages.length ? r.packages.map(resultCard) : h('div.muted.small.cs-pad', 'No packages found.'));
  }

  const fmt = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
  const normPy = id => id.split('[')[0].replace(/[-_.]+/g, '-').toLowerCase();

  /** The installed entry for a package id, in the selected project (.NET) or the space's manifest. */
  function installedOf(id) {
    if (!poly()) return byPath(pkgProject)?.packages.find(x => x.id.toLowerCase() === id.toLowerCase());
    const same = kind() === 'python' ? (a, b) => normPy(a) === normPy(b) : (a, b) => a === b;
    const listed = (detail?.packages || []).find(x => same(x.id, id));
    if (listed) return { id: listed.id, version: listed.installed || listed.version };
    const any = kind() === 'python' && (detail?.env?.all || []).find(x => same(x.id, id));
    return any ? { id: any.id, version: any.version } : null;
  }

  function resultCard(p) {
    const installed = installedOf(p.id);
    const opts = p.versions?.length ? p.versions.map(v => h('option', { value: v, selected: v === p.version }, v)) : [h('option', { value: p.version || '' }, p.version || 'latest')];
    if (poly() && p.versions?.length) opts.unshift(h('option', { value: '' }, 'latest'));
    const versions = h('select.cs-version', opts);
    if (poly()) versions.value = '';
    let loadedAll = false;
    versions.addEventListener('focus', async () => {
      if (loadedAll) return; loadedAll = true;
      const r = await call(`${reg().versions}?id=${enc(p.id)}`).catch(() => null);
      if (r?.versions?.length) {
        const cur = versions.value;
        put(versions, poly() && h('option', { value: '' }, 'latest'), r.versions.map(v => h('option', { value: v }, v)));
        versions.value = cur;
      }
    });
    return h('div.cs-result',
      h('div.cs-result-head', h('b', p.id),
        p.verified && h('span.cs-badge', { title: 'The owner of this id prefix is verified by nuget.org' }, '✓ verified'),
        p.popular && h('span.cs-badge', { title: 'From the dojo\'s list of popular PyPI packages' }, 'popular'),
        p.downloads > 0 && h('span.muted.small', `${fmt(p.downloads)} downloads`)),
      p.description && h('div.small.cs-desc', p.description),
      p.authors?.length > 0 && h('div.small.muted', `by ${p.authors.join(', ')}`),
      h('div.cs-result-actions', versions,
        installed ? h('span.small.muted', `installed ${installed.version || ''}`) : null,
        h('button.btn.primary.small', { type: 'button', disabled: !poly() && !pkgProject, onclick: () => packageOp(p.id, versions.value || null, false) }, installed ? 'Update' : 'Install')));
  }

  function removeBtn(id, where) {
    return h('button.btn.ghost.small', { type: 'button', onclick: async () => { if (await ask(`Remove ${id} from ${where}?`, { ok: 'Remove' })) packageOp(id, null, true); } }, 'Remove');
  }

  function paintInstalled() {
    if (poly()) {
      const list = detail?.packages || [];
      const env = detail?.env || {};
      const manifest = env.manifest || '';
      const envNote = kind() === 'python'
        ? (env.venv ? `.venv: ${env.installedCount ?? 0} distribution${env.installedCount === 1 ? '' : 's'} installed` : 'No .venv yet: it is created the first time you run, test or install.')
        : (!env.node ? 'Node.js was not found on this machine.' : env.nodeModules ? 'node_modules is installed.' : list.length ? 'node_modules is missing: press Install packages.' : '');
      const all = kind() === 'python' ? env.all || [] : [];
      put(installedEl,
        list.length ? list.map(p => h('div.cs-installed-row',
          h('b.mono.small', p.id), p.dev && h('span.cs-badge', 'dev'),
          h('span.muted.small.mono', { title: `${manifest}: ${p.version || '(any version)'}` }, p.installed ? p.installed : p.version ? `${p.version} · not installed` : 'not installed'),
          h('span.spacer'), removeBtn(p.id, manifest)))
          : h('div.muted.small.cs-pad', `No packages in ${manifest || 'the manifest'} yet.`),
        envNote && h('div.small.muted.cs-pad', envNote),
        all.length > 0 && h('button.btn.ghost.small.cs-showall', { type: 'button', onclick: () => { showAllPy = !showAllPy; paintInstalled(); } }, showAllPy ? 'Hide the full list' : `Everything in .venv (${all.length})`),
        showAllPy && all.map(p => h('div.cs-installed-row.small', h('span.mono.small', p.id), h('span.spacer'), h('span.muted.small.mono', p.version))));
      return;
    }
    put(pkgSel, projects().map(p => h('option', { value: p.path, selected: p.path === pkgProject }, p.name)));
    const proj = byPath(pkgProject);
    put(installedEl, !proj ? h('div.muted.small.cs-pad', 'Create a project first.')
      : proj.packages.length ? proj.packages.map(p => h('div.cs-installed-row', h('b.mono.small', p.id), h('span.muted.small.mono', p.version || '(central)'), h('span.spacer'), removeBtn(p.id, proj.name)))
        : h('div.muted.small.cs-pad', 'No packages yet.'));
  }

  async function packageOp(id, version, remove, quiet) {
    if (!poly() && !pkgProject) return;
    if (!await saveAll()) return;
    const r = await call(`${base}/package`, { project: poly() ? null : pkgProject, id, version, remove, dev: kind() === 'node' && npmDev && !remove })
      .catch(() => ({ error: 'Could not reach the dojo server.' }));
    if (r.error) { setStatus(r.error); if (!quiet) alertBox(r.error); return; }
    job = r.job; showBottom('output'); paintToolbar(); pollSoon(150);
  }

  put(nugetEl, pkgHead, searchInput, pkgNote, resultsEl, installedHead, installedEl);
  paintPkgHead();

  // ------------------------------------------------------------ debugger (record the run, then move through it)

  /** The project the debugger records: the selected one if it is a console or web app, else the first console app, else the web app. */
  function debuggable() {
    const t = target && byPath(target);
    if (t && (t.kind === 'console' || t.kind === 'web')) return t;
    return projects().find(p => p.kind === 'console') || projects().find(p => p.kind === 'web');
  }
  // A live session (server/CodeDebugger.Live.cs): a web app recorded per request, or a console program that asks for input.
  let dbgLive = null, dbgReq = 0, liveTimer = null, logSeen = -1, reqTabKey = '';
  const webDebugging = () => debugging && !!dbgLive?.web;
  const reqsEl = h('div.dbg-reqs');
  const appLog = h('pre.dbg-out.cs-applog');
  const dbgIn = h('input.cs-stdin.mono.dbg-in', { placeholder: 'The program waits in Console.ReadLine: type a line and press Enter', spellcheck: false,
    onkeydown: e => { if (e.key === 'Enter') sendInput(dbgIn.value); } });
  const sideEl = h('aside.cs-side', nugetEl);     // NuGet normally; the debugger's panels while debugging
  const dbgStdin = h('textarea.dbg-stdin.mono', { rows: 3, spellcheck: false, placeholder: 'Optional: lines for Console.ReadLine up front, one per read. Otherwise the debugger asks when the program reads.',
    value: localStorage.getItem(`dojo-space-dbg-stdin:${space}`) || '',
    oninput: e => { try { localStorage.setItem(`dojo-space-dbg-stdin:${space}`, e.target.value); } catch { } } });
  const dbg = createDebugger({
    show: (file, line, kind) => showDebugLoc(file, line, kind),
    breakpoints: bps,
    onRestart: () => startDebug(),
    onStop: () => stopDebug(),
    watchKey: `dojo-space-watch:${space}`,
  });

  function toggleBreakpoint(tab, line) {
    if (!tab?.editor || !line) return;
    bps.toggle(tab.path, line);
    tab.editor.setBreakpoints(bps.lines(tab.path));
    dbg.breakpointsChanged();
    if (webDebugging()) pollLive();       // re-mark the requests that hit a breakpoint
  }

  async function showDebugLoc(file, line, kind) {
    dbgLoc = file ? { file, line, kind } : null;
    for (const t of tabs) if (t.editor && t.path !== file) t.editor.setCurrent(0);
    if (!file) return;
    let tab = tabs.find(t => t.path === file);
    if (!tab) {
      if (!pendingOpen.has(file)) pendingOpen.set(file, openFile(file).finally(() => pendingOpen.delete(file)));
      await pendingOpen.get(file);
      if (dbgLoc?.file !== file) return;     // stepped on meanwhile
      tab = tabs.find(t => t.path === file);
    } else if (active !== tab) activate(tab);
    tab?.editor?.setCurrent(dbgLoc.line, dbgLoc.kind);
  }

  function paintDebugLayout() {
    dbgHost.hidden = !debugging;
    put(dbgHost, debugging && dbg.bar);
    put(sideEl, !debugging ? nugetEl
      : webDebugging()
        ? [h('section.dbg-panel.dbg-requests', h('div.dbg-head', h('b', 'Requests'), h('span.small.muted', 'click one to step through it')), reqsEl), dbg.side]
        : [dbg.side, h('section.dbg-panel.dbg-input', h('div.dbg-head', h('b', 'Program input'), h('span.small.muted', 'stdin, before the debugger asks')), dbgStdin)]);
    if (!debugging && bottomTab === 'debug') bottomTab = 'output';
    paintRequests();
    paintBottom(); paintToolbar();
  }

  // ---- web: the request list, the app's live output, loading one request's recording

  function paintRequests() {
    if (!webDebugging()) return;
    const L = dbgLive;
    const row = (q, label) => h(`button.dbg-req${q.id === dbgReq ? '.active' : ''}${q.failed ? '.failed' : ''}`, {
      type: 'button', title: `${q.steps.toLocaleString()} steps${q.throws ? ` · ${q.throws} exception${q.throws === 1 ? '' : 's'} thrown` : ''}${q.truncated ? ' · stopped at the step cap' : ''}`,
      onclick: () => loadRequest(q.id),
    },
    h('span.dbg-req-mark', q.hit ? h('span.dbg-bp-dot', { title: 'Hit a breakpoint' }) : q.failed ? h('span.bad', { title: 'An exception' }, '✕') : ''),
    label || [h('span.dbg-req-m.mono.small', q.method), h('span.dbg-req-p.mono.small', q.path)],
    h('span.spacer'),
    q.id > 0 && h(`span.dbg-req-st.small.${!q.done ? 'muted' : q.status < 400 ? 'ok' : q.status < 500 ? 'warn' : 'bad'}`, q.done ? String(q.status) : '…'),
    q.id > 0 && h('span.dbg-req-ms.small.muted', q.done ? `${q.ms} ms` : ''));
    put(reqsEl,
      L.startup && row(L.startup, h('span.dbg-req-p.small', 'Startup')),
      L.requests.length ? L.requests.map(q => row(q))
        : h('div.muted.small.dbg-pad', L.alive ? (L.listening ? `Send it a request: the Request tab below, or ${L.url} in your browser.` : 'Starting the app…') : ''),
      L.dropped > 0 && h('div.muted.small.dbg-pad', `${L.dropped} older request${L.dropped === 1 ? '' : 's'} dropped to save memory.`),
      !L.alive && h('div.small.dbg-pad.bad', L.stopped || `The app has stopped${L.exitCode != null ? ` (exit code ${L.exitCode})` : ''}. The recorded requests are still here; Restart to run it again.`));
  }

  function paintLog() {
    if (!dbgLive) return;
    if (dbgLive.logTotal === logSeen) return;
    logSeen = dbgLive.logTotal;
    const near = appLog.scrollHeight - appLog.scrollTop - appLog.clientHeight < 40;
    appLog.textContent = dbgLive.log || '';
    if (near) appLog.scrollTop = appLog.scrollHeight;
  }

  async function pollLive() {
    clearTimeout(liveTimer);
    if (!webDebugging() || stopped) return;
    const r = await call(`${base}/debug/session`, { breakpoints: bps.list() }).catch(() => null);
    if (!webDebugging()) return;
    if (r && !r.error) dbgLive = r;
    else if (r?.error) dbgLive = { ...dbgLive, alive: false, stopped: r.error };
    paintRequests(); paintLog(); paintStatus();
    const key = `${dbgLive.alive}|${dbgLive.listening}|${dbgLive.url}`;
    if (key !== reqTabKey) { reqTabKey = key; paintRequestTab(); }
    if (dbgLive.alive) liveTimer = setTimeout(pollLive, 800);
  }

  async function loadRequest(id) {
    const r = await call(`${base}/debug/request`, { id, breakpoints: bps.list() }).catch(() => ({ error: 'Could not reach the dojo server.' }));
    if (!webDebugging()) return;
    if (r.error && !r.events?.length) { setStatus(r.error); return; }
    dbgReq = id;
    if (r.live) dbgLive = r.live;
    dbg.load(r);
    paintRequests();
    const q = id === 0 ? null : dbgLive.requests.find(x => x.id === id);
    setStatus(q ? `debug: ${q.method} ${q.path} · ${q.steps.toLocaleString()} steps` : `debug: startup · ${(r.events || []).filter(e => !e.k).length.toLocaleString()} steps`);
  }

  // ---- console: a line for the program waiting in Console.ReadLine

  async function sendInput(text) {
    if (!dbgLive?.waiting || dbgBusy) return;
    dbgIn.value = '';
    dbgBusy = true; dbgIn.disabled = true; paintToolbar();
    const from = (dbg.data?.events?.length || 1) - 1;
    const r = await call(`${base}/debug/input`, { text, breakpoints: bps.list() }).catch(() => ({ error: 'Could not reach the dojo server.' }));
    dbgBusy = false; dbgIn.disabled = false;
    if (!debugging) return;
    if (r.error && !r.events?.length) { setStatus(r.error); dbgLive = { ...dbgLive, waiting: false }; paintBottom(); paintToolbar(); return; }
    dbgLive = r.live;
    dbg.load(r, { from });
    paintBottom(); paintToolbar();
    setStatus(dbgLive?.waiting ? 'debug: the program waits for input' : `debug: ${(r.events || []).filter(e => !e.k).length.toLocaleString()} steps recorded${r.exception ? ' · it threw' : ''}`);
    if (dbgLive?.waiting) requestAnimationFrame(() => dbgIn.focus());
  }

  async function startDebug() {
    const proj = debuggable();
    if (dbgBusy || !proj) return;
    if (!await saveAll()) return;
    const web = proj.kind === 'web';
    clearTimeout(liveTimer);
    dbgBusy = true; statusNote = ''; setStatus(web ? `Starting ${proj.name} with the step recorder…` : `Recording ${proj.name} for the debugger…`); paintToolbar();
    const r = await call(`${base}/debug`, { project: proj.path, stdin: web ? null : dbgStdin.value, breakpoints: bps.list(), interactive: !web })
      .catch(() => ({ error: 'Could not reach the dojo server.' }));
    dbgBusy = false;
    dbgLive = r.live || null; dbgReq = 0; logSeen = -1; reqTabKey = '';
    if (r.error && !r.events?.length) {
      setStatus(r.error);
      if (r.diagnostics?.length) {
        problems = r.diagnostics.map(d => ({ severity: d.severity, code: d.id, message: d.message, file: d.file, line: d.line, column: d.col }));
        paintProblems(); tabs.forEach(markTab); paintTree(); showBottom('problems');
      }
      paintToolbar();
      return;
    }
    const steps = (r.events || []).filter(e => !e.k).length;
    setStatus(web ? `debug: ${proj.name} runs at ${r.live?.url || '?'} · startup recorded (${steps.toLocaleString()} steps); send it requests`
      : r.live?.waiting ? 'debug: the program waits for input'
        : `debug: ${steps.toLocaleString()} steps recorded in ${((r.ms || 0) / 1000).toFixed(1)}s${r.exception ? ' · it threw' : ''}`);
    debugging = true;
    paintDebugLayout();
    showBottom(web ? 'request' : 'debug');
    dbg.load(r);
    if (web) { paintRequestTab(); pollLive(); }
    else if (dbgLive?.waiting) requestAnimationFrame(() => dbgIn.focus());
  }

  function stopDebug() {
    const hadLive = !!dbgLive;
    debugging = false;
    clearTimeout(liveTimer);
    dbgLive = null;
    if (hadLive) call(`${base}/debug/stop`, {}).catch(() => null);
    dbg.close();
    setStatus('');
    paintDebugLayout();
    paintRequestTab();
  }

  // ------------------------------------------------------------ polling

  function pollSoon(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
  async function poll() {
    if (stopped) return;
    const was = job?.status;
    try {
      const r = await call(`${base}/events?since=${since}`);
      if (!r.error) {
        appendOutput(r.lines);
        since = r.seq || since;
        const before = job;
        job = r.job;
        const key = JSON.stringify(r.problems);
        if (key !== problemsKey) {
          problemsKey = key; problems = r.problems;
          paintProblems(); tabs.forEach(markTab); paintTree();
          if (problems.some(p => p.severity === 'error') && job?.status !== 'running') showBottom('problems');
        }
        paintToolbar();
        if (bottomTab === 'output' || before?.status !== job?.status) paintBottom();
        if (was === 'running' && job && job.status !== 'running') {
          // A build, restore or package change rewrites obj/: refresh references, usings and packages.
          await loadDetail().catch(() => { });
          if (job.status === 'succeeded' && (job.kind === 'build' || job.kind === 'run')) setStatus('');
        }
      }
    } catch { /* server restarting */ }
    if (!stopped) pollSoon(job?.status === 'running' ? 500 : 2500);
  }

  // ------------------------------------------------------------ layout

  const root = h('div.cs-ide',
    h('div.cs-toolbar',
      h('a.back-link.cs-back', { href: '#/spaces' }, '← Spaces'),
      h('b.cs-title', space),
      targetSel, buildBtn, runBtn, debugBtn, stopBtn, testBtn, installBtn, statusEl, h('span.spacer'), urlEl),
    h('aside.cs-explorer',
      h('div.cs-panel-head', h('b', 'Explorer'), h('span.spacer'),
        h('button.icon-btn.small', { type: 'button', title: 'New file', onclick: () => newEntry('newfile', '') }, '+'),
        h('button.icon-btn.small', { type: 'button', title: 'New folder', onclick: () => newEntry('mkdir', '') }, '▱'),
        h('button.icon-btn.small', { type: 'button', title: 'Refresh', onclick: () => Promise.all([loadDetail(), loadSources()]) }, '↻')),
      treeEl),
    h('section.cs-center', tabBar, dbgHost, h('div.cs-edwrap', edHost)),
    h('section.cs-bottom', bottomTabs, bottomBody),
    sideEl,
    menu);
  edHost.append(emptyEd);

  // Keyboard: Ctrl+S save, Ctrl+Shift+B build, F5 run.
  const onKey = e => {
    if (debugging && dbg.key(e)) return;
    if (e.key === 'F9') { e.preventDefault(); if (active?.editor) toggleBreakpoint(active, active.editor.caretLine()); return; }
    if (e.key === 'F5' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); if (!runBtn.disabled) run(); return; }
    if (e.key === 'F5' && !e.shiftKey && !e.altKey && debuggable()) { e.preventDefault(); startDebug(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.shiftKey ? saveAll() : save(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); runJob('build'); }
    else if (e.key === 'F5') { e.preventDefault(); if (!runBtn.disabled) run(); }
  };
  document.addEventListener('keydown', onKey, true);
  const onUnload = e => { if (tabs.some(t => t.dirty)) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);

  page('spaces', root);
  paintTabs(); paintBottom(); paintProblems(); paintRequestTab();

  (async () => {
    try {
      const ok = await loadDetail();       // first: the kind decides which sources to load
      if (!ok) return;
      await loadSources();
      const remembered = JSON.parse(localStorage.getItem(`dojo-space-tabs:${space}`) || 'null');
      const exists = p => detail.tree.some(e => e.path === p && !e.dir);
      const toOpen = (remembered?.open || []).filter(exists);
      if (!toOpen.length && poly()) {
        const def = detail.defaultEntry;
        const first = def && !def.startsWith('script:') && exists(def) ? def
          : ['app/page.tsx', 'src/app/page.tsx', 'pages/index.tsx', 'index.js', 'main.py', 'package.json', 'requirements.txt'].find(exists)
            || detail.tree.find(e => !e.dir && isSource(e.path))?.path;
        if (first) toOpen.push(first);
      }
      if (!toOpen.length) {
        const main = runnable() || projects()[0];
        const guess = main ? `${main.dir ? main.dir + '/' : ''}Program.cs` : null;
        const first = guess && exists(guess) ? guess : detail.tree.find(e => !e.dir && /\.cs$/i.test(e.path))?.path;
        if (first) toOpen.push(first);
      }
      for (const p of toOpen) {
        await openFile(p);
        let d = p; while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); expanded.add(d); }
      }
      if (remembered?.active && tabs.some(t => t.path === remembered.active)) activate(tabs.find(t => t.path === remembered.active));
      paintTree();
    } catch { put(root, h('div.empty', h('h2', 'Could not reach the dojo server'), h('a.btn.primary', { href: '#/spaces' }, 'All spaces'))); }
    poll();
  })();

  return () => {
    stopped = true;
    clearTimeout(pollTimer);
    clearTimeout(liveTimer);
    if (dbgLive) call(`${base}/debug/stop`, {}).catch(() => { });     // a debugged app or waiting program ends with the page
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', closeMenu, true);
    window.removeEventListener('beforeunload', onUnload);
    // Leaving the page keeps your work: unsaved files are written to disk.
    tabs.filter(t => t.dirty).forEach(t => call(`${base}/file`, { path: t.path, code: t.editor.value }).catch(() => { }));
  };
}
