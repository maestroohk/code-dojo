// code-dojo TypeScript / JavaScript intelligence: TypeScript's own LanguageService.
//
// Run by the dojo server (server/TsIntel.cs) with Node as a long-lived process that reads one JSON request
// per line on stdin and writes one JSON answer per line on stdout:
//
//   {"id", "action": "complete"|"definition"|"references"|"hover", "files": [{"path", "code"}], "path",
//    "position", "ts": "<folder of the typescript package>", "root": "<code space folder>" | null}
//   -> {"id", "items", "definition", "external", "references", "hover"}  or  {"id", "error"}
//
// The learner's files live in memory (the editor's text, saved or not); everything else (lib.d.ts, a code
// space's node_modules and tsconfig.json) is read from disk. The code is analysed, never run.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const engines = new Map();    // typescript folder -> the loaded module
const projects = new Map();   // typescript folder | root -> Project

function loadTs(dir) {
  let ts = engines.get(dir);
  if (!ts) { ts = require(dir); engines.set(dir, ts); }
  return ts;
}

const slash = p => p.replace(/\\/g, '/');

class Project {
  constructor(ts, root) {
    this.ts = ts;
    this.real = !!root;
    // Lessons have no folder: their files sit in a folder that does not exist, so nothing on disk is picked up.
    this.root = slash(root || path.join(os.tmpdir(), 'code-dojo', 'ts-lesson'));
    this.caseSensitive = ts.sys.useCaseSensitiveFileNames;
    this.files = new Map();    // key -> { abs, rel, text, version }
    this.dirs = new Set();
    this.modulesStamp = this.stamp();
    this.options = this.compilerOptions();
    const self = this;
    const host = {
      getScriptFileNames: () => [...self.files.values()].map(f => f.abs),
      getScriptVersion: f => { const e = self.files.get(self.key(f)); return e ? String(e.version) : '0'; },
      getScriptSnapshot: f => {
        const e = self.files.get(self.key(f));
        if (e) return ts.ScriptSnapshot.fromString(e.text);
        const text = ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => self.root,
      getCompilationSettings: () => self.options,
      getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
      fileExists: f => self.files.has(self.key(f)) || ts.sys.fileExists(f),
      readFile: (f, enc) => { const e = self.files.get(self.key(f)); return e ? e.text : ts.sys.readFile(f, enc); },
      directoryExists: d => self.dirs.has(self.key(d)) || ts.sys.directoryExists(d),
      getDirectories: d => ts.sys.getDirectories(d),
      readDirectory: (...a) => ts.sys.readDirectory(...a),
      realpath: ts.sys.realpath && (p => (self.files.has(self.key(p)) ? p : ts.sys.realpath(p))),
      useCaseSensitiveFileNames: () => self.caseSensitive,
    };
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry(this.caseSensitive, this.root));
  }

  key(f) { const k = slash(f); return this.caseSensitive ? k : k.toLowerCase(); }

  /** When npm installs or removes packages, node_modules changes: start over so new types are seen. */
  stamp() {
    if (!this.real) return 0;
    try { return fs.statSync(path.join(this.root, 'node_modules')).mtimeMs; } catch { return -1; }
  }

  compilerOptions() {
    const ts = this.ts;
    let options = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX, strict: true, esModuleInterop: true, allowSyntheticDefaultImports: true,
      allowImportingTsExtensions: true, resolveJsonModule: true, skipLibCheck: true,
    };
    if (this.real) {
      // The space's own tsconfig.json (or jsconfig.json) decides, as it does for tsc and the editor in VS Code.
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const file = path.join(this.root, name);
        if (!fs.existsSync(file)) continue;
        const read = ts.readConfigFile(file, ts.sys.readFile);
        if (read.error) break;
        options = ts.parseJsonConfigFileContent(read.config, ts.sys, this.root, undefined, file).options;
        if (name === 'jsconfig.json') options.allowJs = true;
        break;
      }
    } else {
      options.types = [];   // no folder, so no @types to find: do not go looking
    }
    return Object.assign(options, { allowJs: true, noEmit: true, allowNonTsExtensions: true });
  }

  update(files) {
    const seen = new Set();
    for (const f of files) {
      const rel = slash(f.path).replace(/^\.\//, '');
      const abs = this.root + '/' + rel;
      const k = this.key(abs);
      seen.add(k);
      const text = (f.code || '').replace(/\r\n/g, '\n');
      const e = this.files.get(k);
      if (!e) this.files.set(k, { abs, rel, text, version: 1 });
      else if (e.text !== text) { e.text = text; e.version++; }
    }
    for (const k of [...this.files.keys()]) if (!seen.has(k)) this.files.delete(k);
    this.dirs.clear();
    for (const e of this.files.values())
      for (let d = path.posix.dirname(e.abs); d.length > this.root.length; d = path.posix.dirname(d)) this.dirs.add(this.key(d));
    this.dirs.add(this.key(this.root));
  }

  entry(fileName) { return this.files.get(this.key(fileName)); }
}

function project(tsDir, root) {
  const id = tsDir + '|' + (root || '');
  let p = projects.get(id);
  if (p && p.real && p.stamp() !== p.modulesStamp) { p.ls.dispose(); p = undefined; }
  if (!p) {
    p = new Project(loadTs(tsDir), root);
    projects.set(id, p);
    // Learners switch between a few spaces and lessons; keep the most recent ones warm.
    if (projects.size > 4) { const [oldId, old] = projects.entries().next().value; old.ls.dispose(); projects.delete(oldId); }
  } else { projects.delete(id); projects.set(id, p); }
  return p;
}

// ---------------------------------------------------------------- answers

const KIND = {
  method: 'method', constructor: 'method', property: 'property', getter: 'property', setter: 'property', accessor: 'property',
  function: 'function', 'local function': 'function', var: 'variable', let: 'variable', const: 'variable', 'local var': 'variable',
  using: 'variable', 'await using': 'variable', parameter: 'parameter', class: 'class', 'local class': 'class',
  interface: 'interface', type: 'interface', 'type parameter': 'interface', enum: 'enum', 'enum member': 'constant',
  module: 'module', 'external module name': 'module', alias: 'module', directory: 'module', script: 'module',
  keyword: 'keyword', 'primitive type': 'keyword', 'JSX attribute': 'attribute', string: 'value', label: 'variable',
};

// sortText: "10" locals, "11" members and scope, "12" optional members ... "15" globals and keywords; "z…" deprecated.
const rank = e => (/^\d/.test(e.sortText) ? Math.max(0, parseInt(e.sortText.slice(0, 2), 10) - 10) : 9);

function text(ts, parts) { return parts ? ts.displayPartsToString(parts) : ''; }

function complete(p, file, pos) {
  const ts = p.ts;
  const info = p.ls.getCompletionsAtPosition(file.abs, pos, {
    includeCompletionsWithInsertText: true, includeAutomaticOptionalChainCompletions: true,
    includeCompletionsForModuleExports: false, includeCompletionsForImportStatements: false,
  });
  if (!info) return { items: [] };
  const typed = (/[\w$]*$/.exec(file.text.slice(0, pos))[0] || '').toLowerCase();
  const entries = info.entries
    .filter(e => e.kind !== 'warning' && e.name.toLowerCase().startsWith(typed))
    .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, 300);
  // Details (signatures, types) cost a lookup each: only for the ones the popup will show first.
  const items = entries.map((e, i) => {
    let detail = null;
    if (i < 50) {
      try {
        const d = p.ls.getCompletionEntryDetails(file.abs, pos, e.name, undefined, e.source, undefined, e.data);
        detail = text(ts, d && d.displayParts).replace(/^\([\w ]+\) /, '') || null;
        if (detail && detail.length > 200) detail = detail.slice(0, 200) + '…';
      } catch { /* an entry TypeScript cannot describe still completes */ }
    }
    return { label: e.name, kind: KIND[e.kind] || 'variable', detail, sort: rank(e) };
  });
  return { items };
}

function quickInfo(p, file, pos) {
  const ts = p.ts;
  const q = p.ls.getQuickInfoAtPosition(file.abs, pos) || (pos > 0 ? p.ls.getQuickInfoAtPosition(file.abs, pos - 1) : undefined);
  if (!q) return null;
  let s = text(ts, q.displayParts);
  const doc = text(ts, q.documentation).trim();
  if (doc) s += '\n' + doc;
  return s || null;
}

function location(p, fileName, span) {
  const sf = p.ls.getProgram().getSourceFile(fileName);
  const e = p.entry(fileName);
  if (!sf || !e) return null;
  const lc = sf.getLineAndCharacterOfPosition(span.start);
  const line = (e.text.split('\n')[lc.line] || '').trim();
  return { path: e.rel, line: lc.line + 1, column: lc.character + 1, length: span.length, preview: line.length > 120 ? line.slice(0, 120) + '…' : line };
}

/** Where a declaration outside the learner's files lives: a package in node_modules, or the built-in types. */
function where(p, fileName) {
  const f = slash(fileName);
  // TypeScript itself sits in a node_modules folder too; its lib files are the built-in types, not a package.
  const libDir = slash(path.dirname(p.ts.getDefaultLibFilePath(p.options))) + '/';
  if (f.toLowerCase().startsWith(libDir.toLowerCase())) return 'the built-in types (' + path.posix.basename(f) + ')';
  const nm = f.lastIndexOf('/node_modules/');
  if (nm >= 0) {
    const parts = f.slice(nm + 14).split('/');
    return parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
  }
  return path.posix.basename(f);
}

function definition(p, file, pos) {
  const defs = p.ls.getDefinitionAtPosition(file.abs, pos) || (pos > 0 && p.ls.getDefinitionAtPosition(file.abs, pos - 1)) || [];
  if (!defs.length) return {};
  const hover = quickInfo(p, file, pos);
  const mine = defs.find(d => p.entry(d.fileName));
  if (mine) return { definition: location(p, mine.fileName, mine.textSpan), hover };
  const d = defs[0];
  const what = hover || ((d.containerName ? d.containerName + '.' : '') + d.name);
  return { external: what + '\n\nDeclared in ' + where(p, d.fileName) + ' (no source to open).' };
}

function references(p, file, pos) {
  const refs = p.ls.getReferencesAtPosition(file.abs, pos) || (pos > 0 && p.ls.getReferencesAtPosition(file.abs, pos - 1)) || [];
  const out = [];
  for (const r of refs) {
    if (!p.entry(r.fileName)) continue;
    const l = location(p, r.fileName, r.textSpan);
    if (l) out.push(l);
  }
  out.sort((a, b) => (a.path !== file.rel) - (b.path !== file.rel) || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  return { references: out };
}

function handle(req) {
  const p = project(req.ts, req.root || null);
  p.update(req.files || []);
  const file = p.files.get(p.key(p.root + '/' + slash(req.path || '').replace(/^\.\//, '')));
  if (!file) return {};
  const pos = Math.max(0, Math.min(req.position | 0, file.text.length));
  switch (req.action) {
    case 'complete': return complete(p, file, pos);
    case 'hover': return { hover: quickInfo(p, file, pos) };
    case 'definition': return definition(p, file, pos);
    case 'references': return references(p, file, pos);
    default: return {};
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let id = null, res;
  try {
    const req = JSON.parse(line);
    id = req.id;
    res = handle(req);
  } catch (e) {
    res = { error: String((e && e.message) || e) };   // never die on one bad request
  }
  process.stdout.write(JSON.stringify(Object.assign({ id }, res)) + '\n');
});
// The server went away (or closed the pipe to restart this helper): stop too.
rl.on('close', () => process.exit(0));
