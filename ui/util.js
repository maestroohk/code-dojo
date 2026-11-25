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

export function highlight(code, lang) {
  const [TOKEN, KEYWORDS] = LANGS[lang || document.documentElement.dataset.codeLang] || [CS_TOKEN, CS_KEYWORDS];
  let out = '';
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(code))) {
    const [text, comment, string, number, ident] = m;
    if (comment) out += `<span class="t-com">${esc(text)}</span>`;
    else if (string) out += `<span class="t-str">${esc(text)}</span>`;
    else if (number) out += `<span class="t-num">${text}</span>`;
    else if (ident) {
      if (KEYWORDS.has(text)) out += `<span class="t-kw">${text}</span>`;
      else if (/^__\d+__$/.test(text)) out += text;                       // a blank slot, replaced later
      else if (/^\s*\(/.test(code.slice(TOKEN.lastIndex, TOKEN.lastIndex + 8))) out += `<span class="t-fn">${text}</span>`;
      else if (/^[A-Z]/.test(text)) out += `<span class="t-type">${text}</span>`;
      else out += text;
    } else out += esc(text);
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

export function codeBlock(code, lang = 'csharp') {
  const plain = lang === 'text' || lang === 'output' || lang === 'txt';
  return `<pre class="code${plain ? ' plain' : ''}"${plain ? '' : ` data-code="${esc(code)}"`}><code>${plain ? esc(code) : highlight(code, lang === 'csharp' || lang === 'cs' ? 'csharp' : lang)}</code></pre>`;
}

export function md(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i]);
      out.push(codeBlock(body.join('\n'), fence[1] || 'csharp'));
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
