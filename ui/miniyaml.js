// A small YAML helper for the builders (compose, Kubernetes, pipelines): quoting scalars when writing,
// a parser for the block-style subset those files use, and a highlighter. Pure: no DOM, runs in Node.
//
// The parser understands: maps and sequences by indentation, "- key: value" items that start a map,
// flow lists ["a", "b"], the empty {} and [], quoted strings, numbers, true/false/null and # comments.
// It does not do anchors, multi-line strings (| and >) or several documents: it throws a readable
// error with the line number instead of guessing.

const PLAIN_OK = /^[A-Za-z0-9_./${}()-][A-Za-z0-9_ ./=$@{}()*,+-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|-?\d+(\.\d+)?)$/i;

/** A scalar as YAML text: plain when safe, otherwise double-quoted. */
export function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (PLAIN_OK.test(s) && !RESERVED.test(s) && !s.includes(':') && s === s.trim()) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Always double-quoted (port mappings like "8080:80" must be strings: YAML 1.1 reads 22:22 as a number). */
export const quoted = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// ---------------------------------------------------------------- parse

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw, ln) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === '{}') return {};
  if (s === '[]') return [];
  if (s[0] === '"') {
    if (!s.endsWith('"') || s.length < 2) throw new Error(`line ${ln}: a "quoted string" is not closed`);
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`line ${ln}: a 'quoted string' is not closed`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === '[') {
    if (!s.endsWith(']')) throw new Error(`line ${ln}: a [list] is not closed`);
    return splitFlow(s.slice(1, -1)).map(x => parseScalar(x, ln));
  }
  if (s[0] === '{') {
    if (!s.endsWith('}')) throw new Error(`line ${ln}: a {map} is not closed`);
    const o = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const k = keyOf(part);
      if (!k) throw new Error(`line ${ln}: "${part.trim()}" inside { } needs "key: value"`);
      o[k.key] = parseScalar(k.rest, ln);
    }
    return o;
  }
  if (s === '|' || s === '>' || s.startsWith('|') || s.startsWith('>')) throw new Error(`line ${ln}: multi-line strings (| and >) are not supported here; put it on one line`);
  if (s.startsWith('&') || s.startsWith('*')) throw new Error(`line ${ln}: anchors and aliases are not supported here`);
  if (/^(true|false)$/.test(s)) return s === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitFlow(s) {
  const out = [];
  let q = null, depth = 0, cur = '';
  for (const c of s) {
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** "key: rest" or "key:" -> { key, rest }; null when the text is not a mapping entry. */
function keyOf(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && i === 0) { q = c; continue; }
    if (c === '[' || c === '{') return null;
    if (c === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      let key = text.slice(0, i).trim();
      if (/^".*"$|^'.*'$/.test(key)) key = key.slice(1, -1);
      return key ? { key, rest: text.slice(i + 1) } : null;
    }
  }
  return null;
}

/** Parses the block-style subset described at the top. Throws Error('line N: ...'). */
export function parse(text) {
  const lines = [];
  String(text).replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    if (/^\s*---\s*$/.test(raw) && lines.length) throw new Error(`line ${i + 1}: only one document (no ---) is supported here`);
    if (/^\s*---\s*$/.test(raw)) return;
    if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`line ${i + 1}: use spaces, not tabs, to indent YAML`);
    const body = stripComment(raw).replace(/\s+$/, '');
    if (!body.trim()) return;
    lines.push({ indent: body.length - body.trimStart().length, text: body.trim(), ln: i + 1 });
  });
  if (!lines.length) return null;
  const [value, end] = block(lines, 0, lines[0].indent);
  if (end < lines.length) throw new Error(`line ${lines[end].ln}: unexpected indentation`);
  return value;
}

const isDash = t => t === '-' || t.startsWith('- ');

function block(lines, i, indent) {
  return isDash(lines[i].text) ? seq(lines, i, indent) : map(lines, i, indent);
}

function seq(lines, i, indent) {
  const out = [];
  while (i < lines.length && lines[i].indent === indent && isDash(lines[i].text)) {
    const L = lines[i];
    const rest = L.text === '-' ? '' : L.text.slice(2);
    const restTrim = rest.trimStart();
    if (!restTrim) {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) { const [v, n] = block(lines, i + 1, lines[i + 1].indent); out.push(v); i = n; }
      else { out.push(null); i++; }
      continue;
    }
    const kv = keyOf(restTrim);
    if (kv) {
      // "- key: value" starts a map whose keys line up with "key".
      const col = indent + 2 + (rest.length - restTrim.length);
      const copy = lines.slice();
      copy[i] = { indent: col, text: restTrim, ln: L.ln };
      const [v, n] = map(copy, i, col);
      out.push(v); i = n;
      continue;
    }
    out.push(parseScalar(restTrim, L.ln));
    i++;
  }
  if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].ln}: unexpected indentation`);
  return [out, i];
}

function map(lines, i, indent) {
  const out = {};
  while (i < lines.length && lines[i].indent === indent) {
    const L = lines[i];
    if (isDash(L.text)) throw new Error(`line ${L.ln}: a list item where a "key: value" was expected`);
    const kv = keyOf(L.text);
    if (!kv) throw new Error(`line ${L.ln}: expected "key: value", got "${L.text}"`);
    if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new Error(`line ${L.ln}: "${kv.key}" appears twice`);
    if (kv.rest.trim()) { out[kv.key] = parseScalar(kv.rest, L.ln); i++; }
    else if (i + 1 < lines.length && (lines[i + 1].indent > indent || (lines[i + 1].indent === indent && isDash(lines[i + 1].text)))) {
      const [v, n] = block(lines, i + 1, lines[i + 1].indent); out[kv.key] = v; i = n;
    } else { out[kv.key] = null; i++; }
  }
  if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].ln}: unexpected indentation`);
  return [out, i];
}

// ---------------------------------------------------------------- highlight

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function value(v) {
  const t = v.trim();
  if (!t) return esc(v);
  const lead = v.slice(0, v.length - v.trimStart().length);
  if (/^["'].*["']$/.test(t)) return lead + `<span class="t-str">${esc(t)}</span>`;
  if (/^-?\d+(\.\d+)?$/.test(t)) return lead + `<span class="t-num">${esc(t)}</span>`;
  if (/^(true|false|null|~)$/.test(t)) return lead + `<span class="t-kw">${esc(t)}</span>`;
  if (t.startsWith('${{')) return lead + `<span class="t-fn">${esc(t)}</span>`;
  return lead + `<span class="t-str">${esc(t)}</span>`;
}

/** YAML text -> HTML with t-* token classes (keys, strings, numbers, comments). */
export function highlight(text) {
  return String(text).split('\n').map(line => {
    const body = stripComment(line);
    const comment = line.slice(body.length);
    const m = body.match(/^(\s*)(-\s+)?(.*)$/);
    let out = esc(m[1]) + (m[2] ? `<span class="t-kw">${esc(m[2])}</span>` : '');
    const kv = keyOf(m[3]);
    if (kv && !/^---/.test(m[3])) out += `<span class="t-type">${esc(m[3].slice(0, m[3].length - kv.rest.length - 1))}</span>:` + value(kv.rest);
    else out += m[3] === '---' ? `<span class="t-com">---</span>` : value(m[3]);
    return out + (comment ? `<span class="t-com">${esc(comment)}</span>` : '');
  }).join('\n');
}
