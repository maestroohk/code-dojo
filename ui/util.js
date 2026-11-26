// Small shared helpers: DOM building, markdown, C# highlighting, API calls.

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** h('div.card', {onclick}, child, 'text', [more]) */
export function h(tag, ...rest) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const item of rest.flat(Infinity)) {
    if (item == null || item === false) continue;
    if (item instanceof Node) el.append(item);
    else if (typeof item === 'object') {
      for (const [k, v] of Object.entries(item)) {
        if (v == null) continue;
        if (v === false && !(k in el)) continue;
        if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') {
          // Custom properties (--name) need setProperty; Object.assign silently drops them.
          for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val);
        }
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v);
      }
    } else el.append(String(item));
  }
  return el;
}

/**
 * An in-page yes/no dialog. Used instead of window.confirm, which embedded browsers
 * may silently block (the answer then is always "no" and nothing can be left or reset).
 */
export function ask(message, { ok = 'Yes', cancel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const done = answer => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(answer); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    const okBtn = h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', onclick: () => done(true) }, ok);
    const overlay = h('div.modal-back', { onclick: e => { if (e.target === overlay) done(false); } },
      h('div.modal', { role: 'dialog', 'aria-modal': 'true' },
        h('p', message),
        h('div.modal-actions', h('button.btn.ghost', { type: 'button', onclick: () => done(false) }, cancel), okBtn)));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    okBtn.focus();
  });
}

export const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Compare text the way a person would: ignore trailing spaces and blank lines at the end. */
export const tidy = s => String(s ?? '').replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '');

export async function api(path, body, method) {
  const res = await fetch('/api/' + path, body === undefined ? {} : {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------- highlighting

const CS_KEYWORDS = new Set(('abstract as async await base bool break byte case catch char checked class const continue ' +
  'decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get global ' +
  'goto if implicit in init int interface internal is lock long namespace new null object operator out override params ' +
  'private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string ' +
  'struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where ' +
  'while with yield nameof not and or dynamic nint').split(' '));

const CS_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|([$@]{0,3}"(?:\\.|""|[^"\\\n])*"?|'(?:\\.|[^'\\\n])+')|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDmMuUlL]*\b)|([A-Za-z_]\w*)|([\s\S])/g;

// Other languages: their own keywords, comments and string forms. Editors follow the language of the
// current lesson or playground tab (set on <html data-code-lang>); fenced blocks use their own tag.
const PY_KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except finally for from ' +
  'global if import in is lambda nonlocal not or pass raise return try while with yield match case self print len range').split(' '));
const JS_KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if ' +
  'import in instanceof let new return super switch this throw try typeof var void while with yield async await of null undefined true false ' +
  'interface type enum implements private protected public readonly abstract as is keyof infer never unknown any number string boolean ' +
  'declare namespace satisfies static get set').split(' '));
const PY_TOKEN = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|[rRbBfFuU]{0,2}"(?:\\.|[^"\\\n])*"?|[rRbBfFuU]{0,2}'(?:\\.|[^'\\\n])*'?)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?j?\b)|([A-Za-z_]\w*)|([\s\S])/g;
const JS_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
// SQL: keywords in any case, -- and /* */ comments, 'strings' with '' escapes.
export const SQL_KEYWORD_LIST = ('SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL USING ' +
  'GROUP BY ORDER HAVING LIMIT OFFSET DISTINCT ALL UNION INTERSECT EXCEPT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW ' +
  'INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES DEFAULT CHECK CONSTRAINT DROP ALTER ADD COLUMN RENAME TO IF EXISTS CASE WHEN THEN ' +
  'ELSE END BETWEEN LIKE GLOB ESCAPE ASC DESC WITH RECURSIVE BEGIN COMMIT ROLLBACK TRANSACTION SAVEPOINT RELEASE TRIGGER AFTER BEFORE ' +
  'INSTEAD OF FOR EACH ROW CAST COLLATE NOCASE AUTOINCREMENT INTEGER TEXT REAL BLOB NUMERIC VARCHAR CHAR INT BIGINT BOOLEAN DATE ' +
  'TIMESTAMP DECIMAL SERIAL TRUE FALSE OVER PARTITION WINDOW ROWS RANGE PRECEDING FOLLOWING CURRENT UNBOUNDED FILTER RETURNING ' +
  'CONFLICT REPLACE IGNORE ABORT EXPLAIN QUERY PLAN PRAGMA VACUUM ANALYZE TOP IDENTITY GO SCHEMA DATABASE TRUNCATE MERGE MATCHED OUTPUT ' +
  'COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROUND LENGTH UPPER LOWER SUBSTR TRIM ABS STRFTIME DATE DATETIME JULIANDAY ' +
  'GROUP_CONCAT ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTILE IIF INSTR PRINTF TOTAL').split(' ');
const SQL_KEYWORDS = new Set(SQL_KEYWORD_LIST.flatMap(k => [k, k.toLowerCase()]));
const SQL_TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'?)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)|([\s\S])/g;
const LANGS = {
  sql: [SQL_TOKEN, SQL_KEYWORDS], sqlite: [SQL_TOKEN, SQL_KEYWORDS], postgres: [SQL_TOKEN, SQL_KEYWORDS], tsql: [SQL_TOKEN, SQL_KEYWORDS], mysql: [SQL_TOKEN, SQL_KEYWORDS],
  python: [PY_TOKEN, PY_KEYWORDS], py: [PY_TOKEN, PY_KEYWORDS],
  javascript: [JS_TOKEN, JS_KEYWORDS], js: [JS_TOKEN, JS_KEYWORDS], typescript: [JS_TOKEN, JS_KEYWORDS], ts: [JS_TOKEN, JS_KEYWORDS],
  tsx: [JS_TOKEN, JS_KEYWORDS], jsx: [JS_TOKEN, JS_KEYWORDS], html: [JS_TOKEN, JS_KEYWORDS], java: [CS_TOKEN, CS_KEYWORDS],
  json: [JS_TOKEN, new Set(['true', 'false', 'null'])], css: [JS_TOKEN, new Set(['important', 'inherit', 'initial', 'none', 'auto'])],
};

const MARKUP_LANGS = new Set(['html', 'htm', 'xml', 'svg', 'cshtml', 'razor']);
const JSX_LANGS = new Set(['javascript', 'js', 'typescript', 'ts', 'tsx', 'jsx']);
const BRACKET_OPEN = '([{', BRACKET_CLOSE = ')]}';

export function highlight(code, lang) {
  const L = lang || document.documentElement.dataset.codeLang;
  if (MARKUP_LANGS.has(L)) return highlightMarkup(code);
  if (L === 'css') return highlightCss(code);
  if (SHELL_LANGS.has(L)) return highlightShell(code);
  const [TOKEN, KEYWORDS] = LANGS[L] || [CS_TOKEN, CS_KEYWORDS];
  const ctx = { depth: 0 };
  if (JSX_LANGS.has(L)) return highlightJs(code, 0, false, ctx)[0];
  return highlightTokens(code, TOKEN, KEYWORDS, ctx);
}

/** Rainbow brackets: ( [ { take a colour by nesting depth, so matching pairs share one. */
function bracket(ch, ctx) {
  if (BRACKET_OPEN.includes(ch)) return `<span class="t-b${ctx.depth++ % 3}">${ch}</span>`;
  ctx.depth = Math.max(0, ctx.depth - 1);
  return `<span class="t-b${ctx.depth % 3}">${ch}</span>`;
}

function identClass(text, code, after, KEYWORDS) {
  if (KEYWORDS.has(text)) return 't-kw';
  if (/^\s*\(/.test(code.slice(after, after + 8))) return 't-fn';
  if (/^[A-Z]/.test(text)) return 't-type';
  return '';
}

function highlightTokens(code, TOKEN, KEYWORDS, ctx) {
  let out = '';
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(code))) {
    const [text, comment, string, number, ident] = m;
    if (comment) out += `<span class="t-com">${esc(text)}</span>`;
    else if (string) out += `<span class="t-str">${esc(text)}</span>`;
    else if (number) out += `<span class="t-num">${text}</span>`;
    else if (ident) {
      if (/^__\d+__$/.test(text)) { out += text; continue; }              // a blank slot, replaced later
      const cls = identClass(text, code, TOKEN.lastIndex, KEYWORDS);
      out += cls ? `<span class="${cls}">${text}</span>` : text;
    } else if (BRACKET_OPEN.includes(text) || BRACKET_CLOSE.includes(text)) out += bracket(text, ctx);
    else out += esc(text);
  }
  return out;
}

// ---------------------------------------------------------------- JavaScript / TypeScript with JSX

// Where an expression can start, `<` opens JSX rather than meaning "less than" (or a generic after a name).
const JSX_AFTER = new Set(['(', '[', '{', ',', ';', ':', '?', '=', '&', '|', '!', 'return', 'yield', 'default', '=>']);

/**
 * Highlights JS/TS from i. With stopAtBrace, returns at the `}` that closes the expression it was
 * called for (a JSX `{...}`), without consuming it. Returns [html, index].
 */
function highlightJs(code, i, stopAtBrace, ctx) {
  const TOKEN = new RegExp(JS_TOKEN.source, 'gy');
  let out = '', depth = 0, prev = '', prev2 = '';
  while (i < code.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(code);
    if (!m) break;
    const [text, comment, string, number, ident] = m;
    const next = TOKEN.lastIndex;
    if (comment) { out += `<span class="t-com">${esc(text)}</span>`; i = next; continue; }
    if (/^\s+$/.test(text)) { out += text; i = next; continue; }
    if (text === '<' && /[A-Za-z>]/.test(code[next] || '') && (JSX_AFTER.has(prev) || (prev === '>' && prev2 === '=') || prev === '')) {
      const el = jsxElement(code, i, ctx);
      if (el) { out += el[0]; i = el[1]; prev = '>'; prev2 = ''; continue; }
    }
    if (string) out += `<span class="t-str">${esc(text)}</span>`;
    else if (number) out += `<span class="t-num">${text}</span>`;
    else if (ident) {
      const cls = /^__\d+__$/.test(text) ? '' : identClass(text, code, next, JS_KEYWORDS);
      out += cls ? `<span class="${cls}">${text}</span>` : text;
    } else if (text === '{') { depth++; out += bracket(text, ctx); }
    else if (text === '}') {
      if (depth === 0 && stopAtBrace) return [out, i];
      depth--; out += bracket(text, ctx);
    } else if (BRACKET_OPEN.includes(text) || BRACKET_CLOSE.includes(text)) out += bracket(text, ctx);
    else out += esc(text);
    prev2 = prev;
    prev = ident && !JS_KEYWORDS.has(text) ? 'name' : text === '>' && prev === '=' ? '=>' : text;
    i = next;
  }
  return [out, i];
}

const P = s => `<span class="t-punct">${esc(s)}</span>`;

/** A JSX `{expression}` at i (code[i] === '{'). Returns [html, index after the closing brace]. */
function jsxExpression(code, i, ctx) {
  let out = bracket('{', ctx);
  const [inner, end] = highlightJs(code, i + 1, true, ctx);
  out += inner;
  if (code[end] === '}') return [out + bracket('}', ctx), end + 1];
  return [out, end];
}

/**
 * A JSX element at i (code[i] === '<'): tag or component name, attributes, children, closing tag.
 * Lenient, because the code is often half-typed: it never fails once the name is read, and stops at
 * the end of the text. Returns [html, index] or null when this `<` is not JSX after all.
 */
function jsxElement(code, i, ctx) {
  let out = P('<');
  let j = i + 1;
  let name = '';
  if (code[j] !== '>') {
    const nm = /[A-Za-z_$][\w$.:-]*/y;
    nm.lastIndex = j;
    const m = nm.exec(code);
    if (!m) return null;
    name = m[0];
    // `a <b` in plain code: a JSX tag name is followed by a space, `>`, `/` or a newline.
    if (!/[\s>/]/.test(code[nm.lastIndex] || ' ')) return null;
    out += `<span class="${/^[A-Z]|\./.test(name) ? 't-comp' : 't-tag'}">${esc(name)}</span>`;
    j = nm.lastIndex;
    // Attributes.
    while (j < code.length) {
      const c = code[j];
      if (/\s/.test(c)) { out += c; j++; continue; }
      if (c === '/' && code[j + 1] === '>') return [out + P('/>'), j + 2];
      if (c === '>') { out += P('>'); j++; break; }
      if (c === '{') { const [x, e] = jsxExpression(code, j, ctx); out += x; j = e; continue; }
      const an = /[A-Za-z_$][\w$:.-]*/y;
      an.lastIndex = j;
      const a = an.exec(code);
      if (!a) { out += esc(c); j++; continue; }
      out += `<span class="t-attr">${esc(a[0])}</span>`;
      j = an.lastIndex;
      const eq = /\s*=\s*/y;
      eq.lastIndex = j;
      const e = eq.exec(code);
      if (!e) continue;
      out += e[0].replace('=', P('='));
      j = eq.lastIndex;
      if (code[j] === '"' || code[j] === "'") {
        const close = code.indexOf(code[j], j + 1);
        const end = close < 0 ? code.length : close + 1;
        out += `<span class="t-aval">${esc(code.slice(j, end))}</span>`;
        j = end;
      } else if (code[j] === '{') { const [x, e2] = jsxExpression(code, j, ctx); out += x; j = e2; }
    }
  } else { out += P('>'); j++; }                                          // a fragment: <>...</>
  // Children: text, {expressions}, nested elements, then the closing tag.
  while (j < code.length) {
    const c = code[j];
    if (c === '<' && code[j + 1] === '/') {
      const cl = /<\/\s*([A-Za-z_$][\w$.:-]*)?\s*>/y;
      cl.lastIndex = j;
      const m = cl.exec(code);
      if (m) {
        const n = m[1] || '';
        return [out + P('</') + (n ? `<span class="${/^[A-Z]|\./.test(n) ? 't-comp' : 't-tag'}">${esc(n)}</span>` : '') + P('>'), cl.lastIndex];
      }
      out += P('</'); j += 2; continue;
    }
    if (c === '<') {
      const el = jsxElement(code, j, ctx);
      if (el) { out += el[0]; j = el[1]; continue; }
      out += esc(c); j++; continue;
    }
    if (c === '{') { const [x, e] = jsxExpression(code, j, ctx); out += x; j = e; continue; }
    let k = j;
    while (k < code.length && code[k] !== '<' && code[k] !== '{') k++;
    out += `<span class="t-text">${esc(code.slice(j, k))}</span>`;
    j = k;
  }
  return [out, j];
}

// ---------------------------------------------------------------- HTML (and XML-like files)

function highlightMarkup(code) {
  const ctx = { depth: 0 };
  let out = '', i = 0;
  const tagCls = n => (/^[A-Z]/.test(n) && !/^[A-Z]+$/.test(n) ? 't-comp' : 't-tag');
  while (i < code.length) {
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      const stop = end < 0 ? code.length : end + 3;
      out += `<span class="t-com">${esc(code.slice(i, stop))}</span>`;
      i = stop; continue;
    }
    if (/^<![A-Za-z]/.test(code.slice(i, i + 3))) {                        // <!DOCTYPE html>
      const end = code.indexOf('>', i);
      const stop = end < 0 ? code.length : end + 1;
      out += `<span class="t-kw">${esc(code.slice(i, stop))}</span>`;
      i = stop; continue;
    }
    if (code[i] === '<' && /[A-Za-z/?]/.test(code[i + 1] || '')) {
      const closing = code[i + 1] === '/';
      const nm = /<\/?\??([A-Za-z][\w.:-]*)/y;
      nm.lastIndex = i;
      const m = nm.exec(code);
      if (!m) { out += esc(code[i++]); continue; }
      const name = m[1];
      out += P(m[0].slice(0, m[0].length - name.length)) + `<span class="${tagCls(name)}">${esc(name)}</span>`;
      i = nm.lastIndex;
      // Attributes until > or />.
      while (i < code.length && code[i] !== '>' && !(code[i] === '/' && code[i + 1] === '>') && !(code[i] === '?' && code[i + 1] === '>')) {
        const c = code[i];
        if (/\s/.test(c)) { out += c; i++; continue; }
        const an = /[^\s=>/"']+/y;
        an.lastIndex = i;
        const a = an.exec(code);
        if (!a) {
          if (c === '"' || c === "'") { const e = code.indexOf(c, i + 1); const s = e < 0 ? code.length : e + 1; out += `<span class="t-aval">${esc(code.slice(i, s))}</span>`; i = s; }
          else { out += P(c); i++; }
          continue;
        }
        out += `<span class="t-attr">${esc(a[0])}</span>`;
        i = an.lastIndex;
        const eq = /\s*=\s*/y;
        eq.lastIndex = i;
        const e = eq.exec(code);
        if (!e) continue;
        out += e[0].replace('=', P('='));
        i = eq.lastIndex;
        const q = code[i];
        if (q === '"' || q === "'") {
          const close = code.indexOf(q, i + 1);
          const stop = close < 0 ? code.length : close + 1;
          out += `<span class="t-aval">${esc(code.slice(i, stop))}</span>`;
          i = stop;
        } else {
          const uv = /[^\s>]+/y;
          uv.lastIndex = i;
          const u = uv.exec(code);
          if (u) { out += `<span class="t-aval">${esc(u[0])}</span>`; i = uv.lastIndex; }
        }
      }
      if (code[i] === '/' || code[i] === '?') { out += P(code[i] + '>'); i += 2; }
      else if (code[i] === '>') { out += P('>'); i++; }
      // The body of <style> and <script> is CSS and JavaScript.
      const lower = name.toLowerCase();
      if (!closing && (lower === 'style' || lower === 'script')) {
        const end = code.toLowerCase().indexOf(`</${lower}`, i);
        const stop = end < 0 ? code.length : end;
        const body = code.slice(i, stop);
        out += lower === 'style' ? highlightCss(body) : highlightJs(body, 0, false, ctx)[0];
        i = stop;
      }
      continue;
    }
    if (code[i] === '&') {
      const ent = /&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/iy;
      ent.lastIndex = i;
      const m = ent.exec(code);
      if (m) { out += `<span class="t-ent">${esc(m[0])}</span>`; i = ent.lastIndex; continue; }
    }
    let k = i + 1;
    while (k < code.length && code[k] !== '<' && code[k] !== '&') k++;
    out += `<span class="t-text">${esc(code.slice(i, k))}</span>`;
    i = k;
  }
  return out;
}

// ---------------------------------------------------------------- shell (bash, PowerShell, CLI one-liners)

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps', 'ps1', 'pwsh', 'cmd']);
const SHELL_KW = new Set('if then else elif fi for in do done while until case esac function return export local sudo foreach param'.split(' '));
const SHELL_TOKEN = /(#[^\n]*)|("(?:\\.|[^"\\])*"?|'[^']*'?)|(\$\{?[A-Za-z_][\w]*\}?|\$\(|%[A-Za-z_]+%)|(--?[A-Za-z][\w-]*(?:=[^\s|;&]*)?)|(\|\||&&|[|;&<>]+)|([A-Za-z_][\w.+:/-]*)|(\d+)|(\s+)|([\s\S])/g;

/** Commands: the program at the start of each command (after |, ;, && or a newline) is a function,
 *  options are attributes, variables are types, strings and comments as everywhere else. */
function highlightShell(code) {
  let out = '', start = true, m;
  SHELL_TOKEN.lastIndex = 0;
  while ((m = SHELL_TOKEN.exec(code))) {
    const [text, comment, string, variable, flag, op, word, num, space] = m;
    if (comment && (start || /\s$/.test(out.replace(/<[^>]+>/g, '').slice(-1)) || !out)) { out += `<span class="t-com">${esc(text)}</span>`; continue; }
    if (space) { out += text; if (text.includes('\n')) start = true; continue; }
    if (string) out += `<span class="t-str">${esc(text)}</span>`;
    else if (variable) out += `<span class="t-type">${esc(text)}</span>`;
    else if (flag && !start) out += `<span class="t-attr">${esc(text)}</span>`;
    else if (op) { out += `<span class="t-punct">${esc(text)}</span>`; if (/[|;&]/.test(text)) { start = true; continue; } }
    else if (word) out += start ? `<span class="${SHELL_KW.has(text) ? 't-kw' : 't-fn'}">${esc(text)}</span>` : esc(text);
    else if (num) out += `<span class="t-num">${text}</span>`;
    else out += esc(text);
    // After do/then/else/sudo the next word is a command again; after for/case/function it is a name.
    if (!(word && /^(do|then|else|elif|while|until|if|sudo|!)$/.test(text))) start = false;
  }
  return out;
}

// ---------------------------------------------------------------- CSS

const CSS_TOKEN = /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(@[\w-]+)|(#[\da-fA-F]{3,8}\b)|(-?\d*\.?\d+(?:%|[a-zA-Z]+)?)|(!important)|(--[\w-]+|-?[A-Za-z_][\w-]*)|([\s\S])/g;

function highlightCss(code) {
  const ctx = { depth: 0 };
  let out = '', block = 0, inValue = false, m;
  CSS_TOKEN.lastIndex = 0;
  while ((m = CSS_TOKEN.exec(code))) {
    const [text, comment, string, at, hex, num, important, ident] = m;
    const after = code.slice(CSS_TOKEN.lastIndex, CSS_TOKEN.lastIndex + 40);
    if (comment) out += `<span class="t-com">${esc(text)}</span>`;
    else if (string) out += `<span class="t-str">${esc(text)}</span>`;
    else if (at) out += `<span class="t-kw">${esc(text)}</span>`;
    else if (hex && inValue) out += `<span class="t-num t-color" style="--sw:${text}">${text}</span>`;
    else if (num && (inValue || block > 0)) out += `<span class="t-num">${esc(text)}</span>`;
    else if (important) out += `<span class="t-kw">${text}</span>`;
    else if (ident) {
      if (block > 0 && !inValue && /^\s*:/.test(after) && !/^\s*:\s*[a-z-]+\s*[({,]/i.test(after)) out += `<span class="t-prop">${esc(text)}</span>`;
      else if (inValue) out += `<span class="${/^\s*\(/.test(after) ? 't-fn' : 't-aval'}">${esc(text)}</span>`;
      else {
        // A selector: .class, #id, :pseudo or a tag name.
        const prevCh = code[m.index - 1];
        out += `<span class="${prevCh === '.' ? 't-type' : prevCh === '#' ? 't-comp' : prevCh === ':' ? 't-fn' : 't-tag'}">${esc(text)}</span>`;
      }
    } else if (hex) out += `<span class="t-comp">${esc(text)}</span>`;    // #id in a selector
    else if (num) out += esc(text);
    else if (text === '{') { block++; inValue = false; out += bracket(text, ctx); }
    else if (text === '}') { block = Math.max(0, block - 1); inValue = false; out += bracket(text, ctx); }
    else if (text === ':' && block > 0 && !inValue) { inValue = true; out += P(':'); }
    else if (text === ';') { inValue = false; out += P(';'); }
    else if (text === '(' || text === ')') out += bracket(text, ctx);
    else out += esc(text);
  }
  return out;
}

// ---------------------------------------------------------------- markdown

export function inline(s) {
  return String(s).split(/(`[^`\n]+`)/).map(part => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }).join('');
}

export function codeBlock(code, lang = 'csharp', { fragment = false, continues = false } = {}) {
  const plain = lang === 'text' || lang === 'output' || lang === 'txt';
  return `<pre class="code${plain ? ' plain' : ''}"${plain ? '' : ` data-code="${esc(code)}" data-lang="${esc(lang)}"${fragment ? ' data-fragment="1"' : ''}${continues ? ' data-continues="1"' : ''}`}><code>${plain ? esc(code) : highlight(code, lang === 'csharp' || lang === 'cs' ? 'csharp' : lang)}</code></pre>`;
}

/** The language id a fence tag means, for deciding what can run where. */
export function langId(tag) {
  const t = String(tag || '').toLowerCase();
  return ({ cs: 'csharp', 'c#': 'csharp', py: 'python', ts: 'typescript', js: 'javascript', sqlite: 'sql' })[t] || t;
}

export function md(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ```lang fragment: a piece of a program, shown and typed but not offered to run on its own.
    // ```lang continues: runs together with the earlier samples on the same card (like notebook cells).
    const fence = line.match(/^\s*```([\w+-]*)(?:\s+(fragment|continues))?\s*$/);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i]);
      out.push(codeBlock(body.join('\n'), fence[1] || document.documentElement.dataset.codeLang || 'csharp', { fragment: fence[2] === 'fragment', continues: fence[2] === 'continues' }));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) { flush(); out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`); continue; }

    if (/^>\s?/.test(line)) {
      flush();
      const body = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) body.push(lines[i].replace(/^>\s?/, ''));
      i--;
      const joined = body.join(' ');
      const kind = /^\*\*(warning|careful|gotcha|pitfall)/i.test(joined) ? ' warn' : '';
      out.push(`<div class="callout${kind}">${inline(joined)}</div>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flush();
      const row = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => inline(c.trim().replace(/\\\|/g, '|')));
      const head = row(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(row(lines[i]));
      i--;
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/);
    if (bullet) {
      flush();
      const ordered = bullet[1] !== undefined;
      const items = [];
      for (; i < lines.length; i++) {
        const b = lines[i].match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/);
        if (b) items.push(b[2]);
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += ' ' + lines[i].trim();
        else break;
      }
      i--;
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

// ---------------------------------------------------------------- loading

/** The in-app loader: the dojo mark, what is loading, and a fact to read while you wait. */
export function loader(what = 'Loading') {
  const tips = window.DOJO_TIPS || [];
  return h('div.loader',
    h('div.boot-mark.small', { 'aria-hidden': 'true' }, h('span', '{'), h('span.boot-cursor'), h('span', '}')),
    h('div.loader-what', `Opening ${what}…`),
    h('div.loader-bar', h('div.loader-run')),
    tips.length > 0 && h('div.boot-tip', h('div.boot-tip-head', 'Did you know?'), h('div', { html: tips[Math.floor(Math.random() * tips.length)] })));
}
