// Regular expressions without a server: a parser that builds a tree of the pattern, a plain-English explainer,
// a small backtracking engine that records every step (for the debugger), flavour notes and a code generator.
// The .NET server (RegexLab.cs) is the authority on what really matches; this file explains why.
//
// Flavours: 'dotnet' (System.Text.RegularExpressions) and 'js' (ECMAScript, as browsers run it).
// Positions are UTF-16 indexes, the same in .NET and JavaScript.

// ================================================================ parser

const META = new Set([...'\\^$.|?*+()[]{}']);
export const FLAG_INFO = {
  i: { name: 'IgnoreCase', js: 'i', py: 're.IGNORECASE', text: 'case-insensitive: a matches A' },
  m: { name: 'Multiline', js: 'm', py: 're.MULTILINE', text: '^ and $ match at the start and end of every line' },
  s: { name: 'Singleline', js: 's', py: 're.DOTALL', text: '. also matches a newline ("dot all")' },
  x: { name: 'IgnorePatternWhitespace', js: null, py: 're.VERBOSE', text: 'spaces in the pattern are ignored and # starts a comment' },
  n: { name: 'ExplicitCapture', js: null, py: null, text: 'only named groups capture; plain ( ) groups do not' },
};

class ParseError extends Error { constructor(msg, at) { super(msg); this.at = at; } }

/**
 * Parses a pattern into a tree. Every node has start/end offsets into the source.
 * Returns { ast, groups, errors, warnings, features, ignored } and never throws.
 */
export function parse(src, { flavor = 'dotnet', flags = '' } = {}) {
  let i = 0;
  const groups = [];          // capturing groups in left-to-right order: { node, name, lr, start, end }
  const allGroups = [];       // every ( ... ) group, in order (for tools that make every group capture)
  const warnings = [];
  const features = new Set();
  const ignored = [];         // [start, end) spans skipped in x mode (whitespace, # comments)
  const refs = [];            // backreference nodes, resolved at the end
  const fl0 = { i: flags.includes('i'), m: flags.includes('m'), s: flags.includes('s'), x: flavor === 'dotnet' && flags.includes('x'), n: flavor === 'dotnet' && flags.includes('n') };
  const dotnet = flavor === 'dotnet';
  const unicodeJs = flavor === 'js' && /[uv]/.test(flags);

  const peek = (k = 0) => src[i + k];
  const eat = s => (src.startsWith(s, i) ? ((i += s.length), true) : false);
  const fail = (msg, at = i) => { throw new ParseError(msg, at); };

  function skipX(fl) {
    if (!fl.x) return;
    for (;;) {
      const s = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++; }
      if (i > s) ignored.push([s, i]); else break;
    }
  }

  function parseAlt(fl, close) {
    const start = i;
    const alts = [parseSeq(fl)];
    while (peek() === '|') { i++; alts.push(parseSeq(fl)); }
    if (close && peek() !== ')') fail('This group is opened with ( but never closed with ).', close);
    if (alts.length > 1) features.add('alternation');
    return alts.length === 1 ? alts[0] : { type: 'alt', alts, start, end: i };
  }

  function parseSeq(flIn) {
    const fl = { ...flIn };
    const start = i;
    const items = [];
    for (;;) {
      skipX(fl);
      if (i >= src.length || peek() === '|' || peek() === ')') break;
      let atom = parseAtom(fl);
      if (!atom) continue;
      if (atom.type === 'mods') {           // (?i) and friends change the flags for the rest of this group
        Object.assign(fl, atom.set);
        items.push(atom);
        continue;
      }
      skipX(fl);
      atom = parseQuant(atom, fl);
      items.push(atom);
    }
    return { type: 'seq', items, start, end: i };
  }

  function parseQuant(atom, fl) {
    const qs = i;
    let min, max;
    const c = peek();
    if (c === '*') { min = 0; max = Infinity; i++; }
    else if (c === '+') { min = 1; max = Infinity; i++; }
    else if (c === '?') { min = 0; max = 1; i++; }
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!m) return atom;                    // a { that is not a quantifier is a literal {
      min = Number(m[1]); max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
      if (max < min) fail('A {min,max} quantifier has min bigger than max.', qs);
      i += m[0].length;
    } else return atom;
    if (atom.type === 'anchor' || atom.type === 'look') warnings.push({ at: qs, text: 'A quantifier on an anchor or lookaround repeats nothing useful.' });
    if (atom.type === 'mods') fail('A quantifier needs something before it to repeat.', qs);
    let mode = 'greedy';
    if (peek() === '?') { mode = 'lazy'; i++; features.add('lazy'); }
    else if (peek() === '+') { mode = 'possessive'; i++; features.add('possessive'); }
    const q = { type: 'quant', min, max, mode, body: atom, start: atom.start, end: i, qStart: qs };
    skipX(fl);
    if ((peek() !== undefined && '*+?'.includes(peek())) || (peek() === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i))))
      fail('Two quantifiers in a row (like a**). Put the first in a group if you mean to repeat a repetition.', i);
    return q;
  }

  function groupName(endCh) {
    const s = i;
    while (i < src.length && src[i] !== endCh) i++;
    const name = src.slice(s, i);
    if (src[i] !== endCh) fail('A group name is not closed.', s);
    i++;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/.test(name)) fail(`"${name}" is not a valid group name: use letters, digits and _ , starting with a letter.`, s);
    return name;
  }

  function parseGroup(fl) {
    const start = i;
    i++; // (
    let kind = 'cap', name = null;
    if (eat('?')) {
      if (eat(':')) kind = 'non';
      else if (eat('>')) { kind = 'atomic'; features.add('atomic'); }
      else if (eat('=')) { kind = 'la'; features.add('lookahead'); }
      else if (eat('!')) { kind = 'nla'; features.add('lookahead'); }
      else if (eat('<=')) { kind = 'lb'; features.add('lookbehind'); }
      else if (eat('<!')) { kind = 'nlb'; features.add('lookbehind'); }
      else if (eat('P<')) { name = groupName('>'); kind = 'named'; features.add('python-named'); }
      else if (eat('P=')) { const n = groupName(')'); i--; const node = { type: 'backref', name: n, start, end: i + 1 }; refs.push(node); i++; features.add('backref'); features.add('python-named'); return node; }
      else if (eat('<')) { name = groupName('>'); kind = 'named'; }
      else if (dotnet && eat("'")) { name = groupName("'"); kind = 'named'; features.add('quote-named'); }
      else if (eat('#')) {
        while (i < src.length && src[i] !== ')') i++;
        if (src[i] !== ')') fail('A (?# comment ) is never closed.', start);
        i++;
        return { type: 'comment', start, end: i };
      } else if (eat('(')) {
        fail('Conditional groups (?(...)yes|no) are not explained here. They are rare: an alternation or two patterns are clearer.', start);
      } else {
        const m = /^([imnsx]*)(?:-([imnsx]*))?(:|\))/.exec(src.slice(i));
        if (!m) fail('Unknown group construct after (?', start);
        i += m[0].length;
        const set = {};
        for (const f of m[1]) set[f] = true;
        for (const f of m[2] || '') set[f] = false;
        features.add('inline-modifiers');
        if (m[3] === ')') return { type: 'mods', set, on: m[1], off: m[2] || '', start, end: i };
        const inner = { ...fl, ...set };
        const body = parseAlt(inner, start);
        i++;
        return { type: 'group', kind: 'modgroup', set, on: m[1], off: m[2] || '', body, start, end: i };
      }
    }
    if (kind === 'cap' && fl.n) kind = 'non';     // ExplicitCapture
    const node = { type: kind === 'la' || kind === 'nla' || kind === 'lb' || kind === 'nlb' ? 'look' : 'group', kind, name, start, end: -1, body: null };
    allGroups.push(node);
    if (kind === 'cap' || kind === 'named') { node.lr = groups.length + 1; groups.push(node); features.add(kind === 'named' ? 'named' : 'group'); }
    node.body = parseAlt(fl, start);
    i++; // )
    node.end = i;
    return node;
  }

  function parseEscape(inClass) {
    const start = i;
    i++; // backslash
    const c = src[i];
    if (c === undefined) fail('The pattern ends with a lone backslash. Write \\\\ for a literal backslash.', start);
    i++;
    const ch = (v, raw) => ({ type: 'char', ch: v, start, end: i, esc: raw ?? c });
    if ('dDwWsS'.includes(c)) return { type: 'class', cls: c, start, end: i };
    if (c === 'p' || c === 'P') {
      if (src[i] !== '{') fail('\\p needs a category in braces, like \\p{L}.', start);
      const e = src.indexOf('}', i);
      if (e < 0) fail('\\p{ is never closed with }.', start);
      const name = src.slice(i + 1, e);
      i = e + 1;
      features.add('unicode-category');
      return { type: 'prop', name, neg: c === 'P', start, end: i };
    }
    if (!inClass) {
      if (c === 'b' || c === 'B') return { type: 'anchor', kind: c, start, end: i };
      if ('AzZG'.includes(c)) {
        if (flavor === 'js') { warnings.push({ at: start, text: `JavaScript has no \\${c}: without the u flag it just matches the letter ${c}.` }); return ch(c); }
        features.add('anchor-' + c);
        return { type: 'anchor', kind: c, start, end: i };
      }
      if (c === 'k') {
        const open = src[i];
        const close = open === '<' ? '>' : open === "'" ? "'" : open === '{' ? '}' : null;
        if (!close) fail('\\k needs a group name, like \\k<name>.', start);
        i++;
        const name = groupName(close);
        const node = { type: 'backref', name, start, end: i };
        refs.push(node); features.add('backref');
        return node;
      }
      if (/[1-9]/.test(c)) {
        let j = i;
        while (/\d/.test(src[j] ?? '')) j++;
        const node = { type: 'backref', number: Number(src.slice(i - 1, j)), start, end: j };
        i = j;
        refs.push(node); features.add('backref');
        return node;
      }
    } else if (c === 'b') return ch('\b', 'b');
    switch (c) {
      case 'n': return ch('\n');
      case 'r': return ch('\r');
      case 't': return ch('\t');
      case 'f': return ch('\f');
      case 'v': return ch('\v');
      case 'a': if (dotnet) return ch('\x07'); break;
      case 'e': if (dotnet) return ch('\x1b'); break;
      case '0': { let j = i; while (j < i + 2 && /[0-7]/.test(src[j] ?? '')) j++; const v = String.fromCharCode(parseInt(src.slice(i, j) || '0', 8)); i = j; return ch(v, '0'); }
      case 'x': { const m = /^[0-9a-fA-F]{2}/.exec(src.slice(i)); if (!m) fail('\\x needs two hex digits, like \\x41.', start); i += 2; return ch(String.fromCharCode(parseInt(m[0], 16)), 'x'); }
      case 'u': {
        if (src[i] === '{' && flavor === 'js') { const e = src.indexOf('}', i); const cp = parseInt(src.slice(i + 1, e), 16); i = e + 1; return ch(String.fromCodePoint(cp), 'u'); }
        const m = /^[0-9a-fA-F]{4}/.exec(src.slice(i)); if (!m) fail('\\u needs four hex digits, like \\u00e9.', start); i += 4; return ch(String.fromCharCode(parseInt(m[0], 16)), 'u');
      }
      case 'c': { const l = src[i]; if (!/[A-Za-z]/.test(l ?? '')) fail('\\c needs a letter, like \\cM.', start); i++; return ch(String.fromCharCode(l.toUpperCase().charCodeAt(0) - 64), 'c'); }
      default: break;
    }
    if (/[A-Za-z0-9]/.test(c)) {
      if (dotnet) fail(`.NET does not know the escape \\${c}.`, start);
      if (unicodeJs) fail(`With the u flag, \\${c} is not a valid escape.`, start);
      warnings.push({ at: start, text: `\\${c} is not a special escape: it just matches ${c}. In .NET it is an error.` });
    }
    return ch(c, c);
  }

  function parseClass(fl) {
    const start = i;
    i++; // [
    const neg = eat('^');
    const items = [];
    let subtract = null;
    let first = true;
    while (i < src.length && (src[i] !== ']' || (first && flavor !== 'js'))) {
      first = false;
      if (dotnet && src[i] === '-' && src[i + 1] === '[') {   // .NET class subtraction: [a-z-[aeiou]]
        i++;
        subtract = parseClass(fl);
        features.add('subtraction');
        continue;
      }
      const lo = classAtom();
      if (src[i] === '-' && src[i + 1] !== ']' && src[i + 1] !== undefined && !(dotnet && src[i + 1] === '[')) {
        i++;
        const hi = classAtom();
        if (lo.kind !== 'char' || hi.kind !== 'char') {
          if (dotnet) fail('A range in a class cannot start or end with a shorthand like \\d.', lo.start);
          items.push(lo, { kind: 'char', ch: '-', start: lo.end, end: lo.end + 1 }, hi);
          continue;
        }
        if (hi.ch < lo.ch) fail(`The range ${lo.ch}-${hi.ch} goes backwards. Write the smaller character first.`, lo.start);
        items.push({ kind: 'range', from: lo.ch, to: hi.ch, start: lo.start, end: hi.end });
      } else items.push(lo);
    }
    if (src[i] !== ']') fail('This character class [ is never closed with ].', start);
    i++;
    return { type: 'set', neg, items, subtract, start, end: i, fl: { ...fl } };
  }

  function classAtom() {
    const s = i;
    if (src[i] === '\\') {
      const e = parseEscape(true);
      if (e.type === 'class') return { kind: 'class', cls: e.cls, start: s, end: i };
      if (e.type === 'prop') return { kind: 'prop', name: e.name, neg: e.neg, start: s, end: i };
      return { kind: 'char', ch: e.ch, start: s, end: i, esc: true };
    }
    if (src.startsWith('[:', i) && /^\[:\w+:\]/.test(src.slice(i))) {
      warnings.push({ at: i, text: 'POSIX classes like [:digit:] work in grep and sed, not in .NET or JavaScript. Use \\d, \\s or \\w.' });
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    return { kind: 'char', ch, start: s, end: i };
  }

  function parseAtom(fl) {
    const start = i;
    const c = peek();
    if (c === '(') return parseGroup(fl);
    if (c === '[') return parseClass(fl);
    if (c === '\\') { const e = parseEscape(false); e.fl = { ...fl }; return e; }
    if (c === '.') { i++; return { type: 'any', start, end: i, fl: { ...fl } }; }
    if (c === '^') { i++; return { type: 'anchor', kind: '^', start, end: i, fl: { ...fl } }; }
    if (c === '$') { i++; return { type: 'anchor', kind: '$', start, end: i, fl: { ...fl } }; }
    if ('*+?'.includes(c)) fail(`The quantifier ${c} has nothing before it to repeat. Write \\${c} to match the character itself.`, start);
    if (c === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i))) fail('A {n} quantifier has nothing before it to repeat.', start);
    if (c === ']' && flavor === 'js' && unicodeJs) fail('A lone ] must be escaped with the u flag.', start);
    if (c === '{' && unicodeJs) fail('A lone { must be escaped with the u flag.', start);
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    return { type: 'char', ch, start, end: i, fl: { ...fl } };
  }

  let ast = null, error = null;
  try {
    ast = parseAlt(fl0, null);
    if (i < src.length) {
      if (src[i] === ')') fail('There is a ) with no ( to close. Write \\) for a literal bracket.', i);
      fail('Unexpected character.', i);
    }
    // Group numbers. JavaScript, Python, PCRE: left to right. .NET: unnamed groups first, then named ones.
    const byName = new Map();
    if (dotnet) {
      let n = 0;
      for (const g of groups) if (g.kind === 'cap') g.number = ++n;
      for (const g of groups) if (g.kind === 'named') {
        if (/^\d+$/.test(g.name)) { g.number = Number(g.name); continue; }
        if (!byName.has(g.name)) byName.set(g.name, ++n);
        g.number = byName.get(g.name);
      }
    } else {
      for (const g of groups) {
        g.number = g.lr;
        if (g.name) { if (byName.has(g.name)) warnings.push({ at: g.start, text: `Two groups are named "${g.name}". JavaScript only allows that in different alternatives (ES2025).` }); else byName.set(g.name, g.number); }
      }
    }
    const max = Math.max(0, ...groups.map(g => g.number));
    for (const r of refs) {
      if (r.name != null) {
        if (/^\d+$/.test(r.name)) r.number = Number(r.name);
        else if (!byName.has(r.name)) throw new ParseError(`The backreference names a group "${r.name}" that does not exist.`, r.start);
        else r.number = byName.get(r.name);
      } else if (r.number > max) {
        if (dotnet) throw new ParseError(`\\${r.number} refers to group ${r.number}, but the pattern has ${max} group${max === 1 ? '' : 's'}.`, r.start);
        warnings.push({ at: r.start, text: `\\${r.number} refers to a group that does not exist; JavaScript reads it as an octal escape.` });
      }
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    error = { message: e.message, at: e.at };
  }
  return { src, ast, groups, allGroups, error, warnings, features, ignored, flavor, flags };
}

// ================================================================ explainer

const SHORT = {
  d: ['a digit', 'not a digit'], w: ['a word character (letter, digit or _)', 'not a word character'], s: ['a whitespace character (space, tab, newline...)', 'not whitespace'],
};
const SHORT_NOTE = {
  dotnet: { d: 'In .NET this is any Unicode digit (Arabic-Indic and others too), not just 0-9. Use [0-9] or RegexOptions.ECMAScript for ASCII only.', w: 'In .NET this includes letters of every alphabet (é, ß, Ж).' },
  js: { d: 'In JavaScript this is only 0-9.', w: 'In JavaScript this is only A-Z, a-z, 0-9 and _ (no é).' },
};
const PROPS = {
  L: 'any letter in any language', Lu: 'an uppercase letter', Ll: 'a lowercase letter', Lt: 'a titlecase letter', Lm: 'a modifier letter', Lo: 'another letter (e.g. Chinese, Arabic)',
  N: 'any number character', Nd: 'a decimal digit', Nl: 'a letter number (Roman numerals)', No: 'another number (superscripts, fractions)',
  P: 'any punctuation', Pc: 'connector punctuation (_)', Pd: 'a dash', Ps: 'an opening bracket', Pe: 'a closing bracket', Po: 'other punctuation',
  S: 'any symbol', Sm: 'a math symbol', Sc: 'a currency symbol', Sk: 'a modifier symbol', So: 'another symbol (emoji, ©)',
  Z: 'any separator', Zs: 'a space separator', Zl: 'a line separator', Zp: 'a paragraph separator',
  M: 'a combining mark', Mn: 'a non-spacing mark (accents)', C: 'a control or other invisible character', Cc: 'a control character',
};
const printable = ch => ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ch === ' ' ? 'space' : ch;
const quoteText = s => `"${[...s].map(c => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : c)).join('')}"`;
const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function quantText(q) {
  const { min, max, mode } = q;
  let base;
  if (min === 0 && max === Infinity) base = 'zero or more times';
  else if (min === 1 && max === Infinity) base = 'one or more times';
  else if (min === 0 && max === 1) base = 'optionally (zero or one time)';
  else if (max === Infinity) base = `${min} or more times`;
  else if (min === max) base = `exactly ${times(min)}`;
  else base = `between ${min} and ${max} times`;
  if (min === max) return base;
  if (mode === 'lazy') return `${base}, as few as possible (lazy: it takes one more only when the rest fails)`;
  if (mode === 'possessive') return `${base}, as many as possible and never gives any back (possessive)`;
  return `${base}, as many as possible (greedy: it gives back one at a time if the rest fails)`;
}

function setText(node) {
  const parts = node.items.map(it => {
    if (it.kind === 'range') return `${printable(it.from)} to ${printable(it.to)}`;
    if (it.kind === 'class') return SHORT[it.cls.toLowerCase()][it.cls === it.cls.toUpperCase() ? 1 : 0];
    if (it.kind === 'prop') return `${it.neg ? 'not ' : ''}${PROPS[it.name] || `Unicode ${it.name}`}`;
    return `"${printable(it.ch)}"`;
  });
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}` : parts[0] || 'nothing';
  let t = node.neg ? `any one character except ${list}` : `one character: ${list}`;
  if (node.subtract) t += `, minus ${setText(node.subtract).replace(/^one character: /, '')}`;
  return t;
}

function anchorText(n, flavor) {
  const m = n.fl?.m;
  switch (n.kind) {
    case '^': return m ? 'the start of a line (multiline mode)' : 'the start of the text' + (flavor === 'dotnet' ? '' : '');
    case '$': return m ? 'the end of a line (multiline mode)' : flavor === 'dotnet' ? 'the end of the text (or just before a final \\n: use \\z for the very end)' : 'the end of the text';
    case 'A': return 'the very start of the text, even in multiline mode';
    case 'z': return 'the very end of the text';
    case 'Z': return 'the end of the text, or just before a final newline';
    case 'G': return 'where the previous match ended';
    case 'b': return 'a word boundary: between a word character and a non-word character';
    case 'B': return 'a position that is not a word boundary';
    default: return n.kind;
  }
}

/**
 * The pattern as a tree of plain-English lines: [{ depth, start, end, token, text, kind, group? }].
 * Consecutive literal characters are merged into one line.
 */
export function explain(parsed) {
  const out = [];
  const src = parsed.src ?? '';
  const flavor = parsed.flavor;
  const line = (depth, node, text, kind, extra = {}) => out.push({ depth, start: node.start, end: node.end, text, kind, ...extra });

  function walk(node, depth) {
    switch (node.type) {
      case 'seq': {
        let run = null;
        const flush = () => { if (run) { line(depth, run, run.chars.length === 1 ? `Matches the character "${printable(run.chars)}"` : `Matches the text ${quoteText(run.chars)} exactly`, 'literal'); run = null; } };
        for (const it of node.items) {
          if (it.type === 'char') {
            const ci = it.fl?.i ? ' (any case)' : '';
            if (run && !ci) { run.chars += it.ch; run.end = it.end; continue; }
            flush();
            if (ci) { line(depth, it, `Matches "${printable(it.ch)}" in upper or lower case`, 'literal'); continue; }
            run = { start: it.start, end: it.end, chars: it.ch };
            continue;
          }
          flush();
          walk(it, depth);
        }
        flush();
        if (!node.items.length) line(depth, { start: node.start, end: node.end }, 'Matches the empty string (nothing)', 'literal');
        return;
      }
      case 'alt':
        line(depth, node, `Either one of ${node.alts.length} alternatives, tried left to right; the first that leads to a match wins`, 'alt');
        node.alts.forEach((a, k) => { line(depth + 1, a, `Alternative ${k + 1}`, 'alt-branch'); walk(a, depth + 2); });
        return;
      case 'char': line(depth, node, `Matches the character "${printable(node.ch)}"${node.esc && META.has(node.ch) ? ' (escaped, so it is not special)' : ''}`, 'literal'); return;
      case 'any': line(depth, node, node.fl?.s ? 'Any character at all, including a newline (singleline mode)' : 'Any character except a newline', 'class'); return;
      case 'class': {
        const k = node.cls.toLowerCase(), neg = node.cls !== k;
        const note = !neg && SHORT_NOTE[flavor]?.[k];
        line(depth, node, `${SHORT[k][neg ? 1 : 0][0].toUpperCase()}${SHORT[k][neg ? 1 : 0].slice(1)}${note ? '. ' + note : ''}`, 'class');
        return;
      }
      case 'prop': line(depth, node, `${node.neg ? 'A character that is not ' : ''}${PROPS[node.name] ? (node.neg ? PROPS[node.name] : PROPS[node.name][0].toUpperCase() + PROPS[node.name].slice(1)) : `A character in the Unicode category or block "${node.name}"`}`, 'class'); return;
      case 'set': line(depth, node, setText(node)[0].toUpperCase() + setText(node).slice(1), 'class'); return;
      case 'anchor': line(depth, node, `Asserts ${anchorText(node, flavor)}. It matches a position, not a character`, 'anchor'); return;
      case 'quant': {
        const b = node.body;
        line(depth, node, `Repeats the next part ${quantText(node)}`, 'quant', { qStart: node.qStart });
        walk(b, depth + 1);
        return;
      }
      case 'group': {
        const label = {
          cap: `Capturing group ${node.number}: remembers what it matched as $${node.number}`,
          named: `Named group "${node.name}" (number ${node.number}): remembers what it matched as \${${node.name}}`,
          non: 'Non-capturing group: groups the parts without remembering them',
          atomic: 'Atomic group: once it has matched, the engine never backtracks into it',
          modgroup: `Group with ${node.on ? `options ${node.on} on` : ''}${node.on && node.off ? ' and ' : ''}${node.off ? `options ${node.off} off` : ''} inside it`,
        }[node.kind];
        line(depth, node, label, 'group', { group: node.number });
        walk(node.body, depth + 1);
        return;
      }
      case 'look': {
        const label = {
          la: 'Lookahead: the text right after this point must match the following, without consuming it',
          nla: 'Negative lookahead: the text right after this point must NOT match the following',
          lb: 'Lookbehind: the text just before this point must match the following',
          nlb: 'Negative lookbehind: the text just before this point must NOT match the following',
        }[node.kind];
        line(depth, node, label, 'look');
        walk(node.body, depth + 1);
        return;
      }
      case 'backref': line(depth, node, `Matches exactly the same text that group ${node.name ? `"${node.name}"` : node.number} matched (backreference)`, 'backref'); return;
      case 'mods': line(depth, node, `From here on: ${[...node.on].map(f => FLAG_INFO[f]?.text || f).join(', ')}${node.off ? `; off: ${[...node.off].map(f => FLAG_INFO[f]?.name || f).join(', ')}` : ''}`, 'mods'); return;
      case 'comment': line(depth, node, 'A comment: ignored', 'comment'); return;
      default: line(depth, node, node.type, 'other');
    }
  }
  if (parsed.ast) walk(parsed.ast, 0);
  for (const l of out) l.token = src.slice(l.start, l.kind === 'quant' ? l.end : l.end);
  return out;
}

// ================================================================ the teaching engine (with a trace)

const LINE_TERMS = /[\n\r\u2028\u2029]/;
const isWordDotnet = c => c !== undefined && /[\p{L}\p{Mn}\p{Nd}\p{Pc}]/u.test(c);
const isWordJs = c => c !== undefined && /[A-Za-z0-9_]/.test(c);

function classTest(cls, c, flavor) {
  if (c === undefined) return false;
  const k = cls.toLowerCase();
  let r;
  if (k === 'd') r = flavor === 'dotnet' ? /\p{Nd}/u.test(c) : /[0-9]/.test(c);
  else if (k === 'w') r = flavor === 'dotnet' ? isWordDotnet(c) : isWordJs(c);
  else r = /\s/.test(c) || (flavor === 'dotnet' && c === '\x85');
  return cls === k ? r : !r;
}

const propCache = new Map();
function propTest(name, c) {
  if (!propCache.has(name)) {
    let re = null;
    try { re = new RegExp(`^\\p{${name.startsWith('Is') ? 'Script=' + name.slice(2) : name}}$`, 'u'); } catch { re = null; }
    propCache.set(name, re);
  }
  const re = propCache.get(name);
  return re ? re.test(c) : false;
}

function setTest(node, c, flavor, ci) {
  if (c === undefined) return false;
  const cands = ci ? [...new Set([c, c.toLowerCase(), c.toUpperCase()])] : [c];
  const hit = x => node.items.some(it => {
    if (it.kind === 'char') return it.ch === x;
    if (it.kind === 'range') return x >= it.from && x <= it.to;
    if (it.kind === 'class') return classTest(it.cls, x, flavor);
    if (it.kind === 'prop') return propTest(it.name, x) !== it.neg;
    return false;
  });
  let r = cands.some(hit);
  if (r && node.subtract) r = !setTest(node.subtract, c, flavor, ci);
  return node.neg ? !r : r;
}

const ABORT = { abort: true };

/**
 * Runs the parsed pattern like a backtracking engine does and records what it tries.
 * Returns { matches: [{ index, end, groups: [[start,end]|null...] }], steps, trace, aborted, depth }.
 * trace entries: { pos, at: [start,end] of the pattern token, ev: 'try'|'ok'|'fail'|'back'|'start'|'match', from, note }
 */
export function runTrace(parsed, input, { all = false, maxSteps = 200000, maxTrace = 4000, firstOnly = false } = {}) {
  const flavor = parsed.flavor;
  if (!parsed.ast) return { matches: [], steps: 0, trace: [], aborted: false, deep: false, error: parsed.error };
  const ngroups = Math.max(0, ...parsed.groups.map(g => g.number));
  let caps = new Array(ngroups + 1).fill(null);
  let steps = 0, from = 0, searchStart = 0;
  const trace = [];
  const ev = (node, pos, kind, note) => { if (trace.length < maxTrace) trace.push({ s: steps, pos, at: [node.start, node.end], ev: kind, from, note }); };
  const tick = () => { if (++steps > maxSteps) throw ABORT; };
  const snap = () => caps.slice();
  const L = input.length;

  function eqChar(a, b, ci) { return a === b || (ci && a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()); }

  function m(node, pos, k) {
    switch (node.type) {
      case 'seq': return seq(node.items, 0, pos, k);
      case 'alt': {
        tick(); ev(node, pos, 'try', 'alternation');
        for (let a = 0; a < node.alts.length; a++) {
          const saved = snap();
          if (m(node.alts[a], pos, k)) return true;
          caps = saved;
          if (a < node.alts.length - 1) { ev(node.alts[a + 1], pos, 'back', `alternative ${a + 1} failed, trying alternative ${a + 2}`); }
        }
        return false;
      }
      case 'char': {
        tick();
        const ok = pos < L && eqChar(input[pos], node.ch, node.fl?.i);
        ev(node, pos, ok ? 'ok' : 'fail');
        return ok ? k(pos + 1) : false;
      }
      case 'any': {
        tick();
        const c = input[pos];
        const ok = pos < L && (node.fl?.s || (flavor === 'js' ? !LINE_TERMS.test(c) : c !== '\n'));
        ev(node, pos, ok ? 'ok' : 'fail');
        return ok ? k(pos + 1) : false;
      }
      case 'class': { tick(); const ok = pos < L && classTest(node.cls, input[pos], flavor); ev(node, pos, ok ? 'ok' : 'fail'); return ok ? k(pos + 1) : false; }
      case 'prop': { tick(); const ok = pos < L && propTest(node.name, input[pos]) !== node.neg; ev(node, pos, ok ? 'ok' : 'fail'); return ok ? k(pos + 1) : false; }
      case 'set': { tick(); const ok = pos < L && setTest(node, input[pos], flavor, node.fl?.i); ev(node, pos, ok ? 'ok' : 'fail'); return ok ? k(pos + 1) : false; }
      case 'anchor': {
        tick();
        const ok = anchorOk(node, pos);
        ev(node, pos, ok ? 'ok' : 'fail');
        return ok ? k(pos) : false;
      }
      case 'comment': case 'mods': return k(pos);
      case 'backref': {
        tick();
        const c = caps[node.number];
        if (!c) {
          // .NET: a group that has not matched makes the backreference fail. JavaScript: it matches the empty string.
          const ok = flavor === 'js';
          ev(node, pos, ok ? 'ok' : 'fail', ok ? 'the group has not matched, so JavaScript matches nothing here' : 'the group has not matched yet, so .NET fails here');
          return ok ? k(pos) : false;
        }
        const text = input.slice(c[0], c[1]);
        const ci = node.fl?.i;
        const here = input.slice(pos, pos + text.length);
        const ok = here.length === text.length && (ci ? here.toLowerCase() === text.toLowerCase() : here === text);
        ev(node, pos, ok ? 'ok' : 'fail', `needs "${text}"`);
        return ok ? k(pos + text.length) : false;
      }
      case 'group': {
        if (node.kind === 'atomic') {
          tick(); ev(node, pos, 'try', 'atomic group');
          const saved = snap();
          let end = -1;
          if (!m(node.body, pos, p => { end = p; return true; })) { caps = saved; return false; }
          ev(node, end, 'ok', 'atomic group done: its choices are now locked');
          if (k(end)) return true;
          caps = saved;
          ev(node, pos, 'fail', 'the rest failed, and the atomic group gives nothing back');
          return false;
        }
        if (node.kind === 'cap' || node.kind === 'named') {
          return m(node.body, pos, p => {
            const prev = caps[node.number];
            caps[node.number] = [pos, p];
            if (k(p)) return true;
            caps[node.number] = prev;
            return false;
          });
        }
        return m(node.body, pos, k);
      }
      case 'look': {
        tick(); ev(node, pos, 'try', { la: 'lookahead', nla: 'negative lookahead', lb: 'lookbehind', nlb: 'negative lookbehind' }[node.kind]);
        const saved = snap();
        let ok = false;
        if (node.kind === 'la' || node.kind === 'nla') ok = m(node.body, pos, () => true);
        else for (let j = pos; j >= 0 && !ok; j--) ok = m(node.body, j, p => p === pos);
        const neg = node.kind === 'nla' || node.kind === 'nlb';
        if (neg) caps = saved;
        if (ok === neg) { caps = saved; ev(node, pos, 'fail'); return false; }
        ev(node, pos, 'ok');
        if (k(pos)) return true;
        caps = saved;
        return false;
      }
      case 'quant': return quant(node, pos, k);
      default: return k(pos);
    }
  }

  function anchorOk(node, pos) {
    const multi = node.fl?.m;
    const c = input[pos], prev = input[pos - 1];
    switch (node.kind) {
      case '^': return pos === 0 || (multi && (flavor === 'js' ? LINE_TERMS.test(prev) : prev === '\n'));
      case '$':
        if (multi) return pos === L || (flavor === 'js' ? LINE_TERMS.test(c) : c === '\n');
        return pos === L || (flavor === 'dotnet' && pos === L - 1 && c === '\n');
      case 'A': return pos === 0;
      case 'z': return pos === L;
      case 'Z': return pos === L || (pos === L - 1 && c === '\n');
      case 'G': return pos === searchStart;
      case 'b': case 'B': {
        const w = flavor === 'dotnet' ? isWordDotnet : isWordJs;
        const at = w(prev) !== w(c);
        return node.kind === 'b' ? at : !at;
      }
      default: return false;
    }
  }

  function quant(node, pos, k) {
    const { min, max, mode, body } = node;
    if (mode === 'possessive') {
      tick(); ev(node, pos, 'try', 'possessive: take as many as possible, keep them all');
      const saved = snap();
      let p = pos, count = 0;
      while (count < max) {
        let got = -1;
        if (!m(body, p, q => { got = q; return true; }) || got === p) break;
        p = got; count++;
      }
      if (count < min) { caps = saved; ev(node, pos, 'fail'); return false; }
      if (k(p)) return true;
      caps = saved;
      ev(node, pos, 'fail', 'the rest failed, and a possessive quantifier gives nothing back');
      return false;
    }
    const greedy = mode === 'greedy';
    const iter = (count, p) => {
      tick();
      if (greedy) {
        if (count < max) {
          ev(node, p, 'try', count === 0 ? `greedy: try to match ${count < min ? 'the first' : 'one more'} time` : `greedy: try once more (${count} so far)`);
          if (m(body, p, q => (q === p && count >= min ? false : iter(count + 1, q)))) return true;
        }
        if (count < min) return false;
        if (count < max) ev(node, p, 'back', `backtrack: settle for ${count} and try the rest`);
        return k(p);
      }
      if (count >= min) {
        ev(node, p, 'try', `lazy: try the rest after ${count}`);
        if (k(p)) return true;
        if (count < max) ev(node, p, 'back', 'backtrack: the rest failed, so take one more');
      }
      if (count < max) return m(body, p, q => (q === p && count >= min ? false : iter(count + 1, q)));
      return false;
    };
    return iter(0, pos);
  }

  function seq(items, idx, pos, k) {
    if (idx === items.length) return k(pos);
    return m(items[idx], pos, p => seq(items, idx + 1, p, k));
  }

  const matches = [];
  let aborted = false, deep = false;
  try {
    let start = 0;
    while (start <= L) {
      searchStart = start;
      let found = false;
      for (let s = start; s <= L; s++) {
        from = s;
        caps = new Array(ngroups + 1).fill(null);
        if (trace.length < maxTrace) trace.push({ s: steps, pos: s, at: [0, 0], ev: 'start', from: s, note: s === start ? `try a match starting at position ${s}` : `nothing at ${s - 1}: move on to position ${s}` });
        let end = -1;
        if (m(parsed.ast, s, p => { end = p; return true; })) {
          const groups = caps.slice();
          groups[0] = [s, end];
          matches.push({ index: s, end, groups });
          if (trace.length < maxTrace) trace.push({ s: steps, pos: end, at: [0, 0], ev: 'match', from: s, note: `match found: positions ${s} to ${end}` });
          start = end === s ? end + 1 : end;
          found = true;
          break;
        }
      }
      if (!found || !all || firstOnly) break;
    }
  } catch (e) {
    if (e === ABORT) aborted = true;
    else if (e instanceof RangeError) deep = true;
    else throw e;
  }
  return { matches, steps, trace, aborted, deep, truncatedTrace: trace.length >= maxTrace };
}

// ================================================================ the real engines

/** JavaScript, natively, for the 'js' flavour. Returns matches like the server's /api/regex. */
export function runJs(pattern, flags, input, replacement) {
  const f = [...new Set([...flags.replace(/[^imsuvy]/g, ''), 'g', 'd'])].join('');
  let re;
  try { re = new RegExp(pattern, f); } catch (e) { return { error: e.message.replace(/^Invalid regular expression: /, '') }; }
  const t0 = performance.now();
  const matches = [];
  for (const m of input.matchAll(re)) {
    if (matches.length >= 1000) break;
    const groups = [];
    for (let g = 0; g < m.length; g++) {
      const ix = m.indices[g];
      groups.push({ number: g, name: String(g), success: m[g] !== undefined, index: ix ? ix[0] : -1, length: ix ? ix[1] - ix[0] : 0, value: m[g] ?? '' });
    }
    matches.push({ index: m.index, length: m[0].length, value: m[0], groups });
  }
  let replaced = null, split = null;
  if (replacement != null) replaced = input.replace(re, replacement);
  try { split = input.split(new RegExp(pattern, f.replace(/[gdy]/g, ''))); } catch { split = null; }
  return { matches, replaced, split, ms: Math.round((performance.now() - t0) * 1000) / 1000 };
}

/** Names JavaScript's numbered groups from the parsed pattern (left-to-right numbering). */
export function nameJsGroups(result, parsed) {
  const names = new Map(parsed.groups.filter(g => g.name).map(g => [g.lr, g.name]));
  for (const m of result.matches || []) for (const g of m.groups) if (names.has(g.number)) g.name = names.get(g.number);
  return result;
}

/**
 * Runs JavaScript's engine in a worker so a catastrophic pattern can be stopped: the page never freezes.
 * Resolves with the result of runJs, or { timedOut: true } after timeoutMs.
 */
export function runJsGuarded(pattern, flags, input, replacement, timeoutMs = 1000) {
  return new Promise(resolve => {
    const src = `const runJs = ${runJs.toString()}; onmessage = e => postMessage(runJs(...e.data));`;
    let worker;
    try { worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
    catch { resolve(runJs(pattern, flags, input, replacement)); return; }
    const timer = setTimeout(() => { worker.terminate(); resolve({ timedOut: true, matches: [] }); }, timeoutMs);
    worker.onmessage = e => { clearTimeout(timer); worker.terminate(); resolve(e.data); };
    worker.onerror = e => { clearTimeout(timer); worker.terminate(); resolve({ error: e.message || 'The pattern failed to run.' }); };
    worker.postMessage([pattern, flags, input, replacement]);
  });
}

// ================================================================ flavour differences

/** What this particular pattern does differently elsewhere: [{ level: 'warn'|'info', where, text }]. */
export function flavourNotes(parsed, src) {
  const f = parsed.features;
  const notes = [];
  const add = (level, where, text) => notes.push({ level, where, text });
  const shorthands = new Set();
  (function walk(n) {
    if (!n) return;
    if (n.type === 'class') shorthands.add(n.cls.toLowerCase());
    if (n.type === 'set') for (const it of n.items) if (it.kind === 'class') shorthands.add(it.cls.toLowerCase());
    if (n.type === 'look' && (n.kind === 'lb' || n.kind === 'nlb') && !fixedWidth(n.body)) add('warn', 'Python', 'This lookbehind has a variable length. .NET and JavaScript accept it; Python re says "look-behind requires fixed-width pattern".');
    for (const c of [n.body, ...(n.alts || []), ...(n.items || [])]) if (c && typeof c === 'object' && c.type) walk(c);
  })(parsed.ast);
  if (shorthands.has('d')) add('info', '\\d', '.NET and Python: any Unicode digit (٣ too). JavaScript, grep and sed: only 0-9. Write [0-9] when you mean ASCII digits, for example when parsing ids.');
  if (shorthands.has('w')) add('info', '\\w', '.NET and Python: letters of every alphabet. JavaScript: only [A-Za-z0-9_].');
  if (f.has('lookbehind')) add('info', 'Lookbehind', '.NET: any length. JavaScript: any length (ES2018+, every current browser and Node). Python: fixed width only. grep -P / rg -P: bounded length. rg without -P and grep -E: not supported.');
  if (f.has('lookahead')) add('info', 'Lookahead', 'Everywhere except POSIX tools (grep -E, sed -E) and rg without -P.');
  if (f.has('atomic')) add('warn', 'Atomic group', '.NET, Python 3.11+, PCRE (grep -P, rg -P): yes. JavaScript: no atomic groups at all.');
  if (f.has('possessive')) add('warn', 'Possessive', 'a++ works in Java, PCRE and Python 3.11+. .NET and JavaScript reject it: write the atomic group (?>a+) in .NET.');
  if (f.has('named') || f.has('quote-named')) add('info', 'Named groups', '.NET: (?<name>...) or (?\'name\'...), replace with ${name}. JavaScript: (?<name>...), replace with $<name>. Python: (?P<name>...), replace with \\g<name>.');
  if (f.has('named') && parsed.groups.some(g => g.kind === 'cap')) add('warn', 'Group numbers', '.NET numbers unnamed groups first, then named ones. JavaScript and Python count left to right. With both kinds mixed, $2 can mean a different group in each.');
  if (f.has('python-named')) add('info', '(?P<name>)', 'This is Python syntax. .NET does not accept it; JavaScript does not either. Write (?<name>...).');
  if (f.has('inline-modifiers')) add('info', 'Inline options', '.NET: (?i) anywhere, (?i:...) scoped, (?-i) off. JavaScript: only the scoped (?i:...) form (ES2025). Python 3.11+: global (?i) only at the very start.');
  if (f.has('unicode-category')) add('info', '\\p{...}', '.NET: \\p{L}, \\p{Lu}, blocks like \\p{IsGreek}. JavaScript: needs the u or v flag, and uses scripts (\\p{Script=Greek}). Python re: not supported (use the regex package).');
  if (f.has('anchor-z') || f.has('anchor-Z') || f.has('anchor-A')) add('info', '\\A \\z \\Z', '.NET and PCRE: \\A start, \\z very end, \\Z end or before a final newline. Python: \\Z is the very end. JavaScript has none of them.');
  if (f.has('subtraction')) add('warn', 'Class subtraction', '[a-z-[aeiou]] is .NET only. JavaScript needs the v flag: [[a-z]--[aeiou]].');
  if (f.has('backref')) add('info', 'Backreferences', 'Not in rg without -P (Rust regex) and not with RegexOptions.NonBacktracking. A group that has not matched: .NET fails the backreference, JavaScript matches nothing.');
  if (src.includes('$') && !parsed.flags.includes('m')) add('info', '$', '.NET and Python: $ also matches just before a final \\n. JavaScript: only at the very end. To mean the very end in .NET, use \\z.');
  if (f.has('lazy')) add('info', 'Lazy', 'Not in grep -E or sed -E (POSIX has only greedy). Use a negated class like [^"]* instead: it works everywhere and is faster.');
  return notes;
}

function fixedWidth(n) {
  if (!n) return true;
  switch (n.type) {
    case 'seq': return n.items.every(fixedWidth);
    case 'alt': { const w = n.alts.map(width); return w.every(x => x !== null && x === w[0]); }
    case 'quant': return n.min === n.max && fixedWidth(n.body);
    case 'group': case 'look': return n.type === 'look' ? true : fixedWidth(n.body);
    case 'backref': return false;
    default: return true;
  }
}
function width(n) {
  if (!n) return 0;
  switch (n.type) {
    case 'seq': { let t = 0; for (const it of n.items) { const w = width(it); if (w === null) return null; t += w; } return t; }
    case 'alt': { const w = n.alts.map(width); return w.every(x => x !== null && x === w[0]) ? w[0] : null; }
    case 'quant': { if (n.min !== n.max) return null; const w = width(n.body); return w === null ? null : w * n.min; }
    case 'group': return width(n.body);
    case 'look': case 'anchor': case 'comment': case 'mods': return 0;
    case 'backref': return null;
    default: return 1;
  }
}

export const FLAVOUR_TABLE = [
  ['Feature', '.NET', 'JavaScript', 'Python re', 'grep -E / sed -E', 'rg (default) / grep -P'],
  ['\\d matches', 'Unicode digits', '0-9 only', 'Unicode digits', 'not supported: [0-9]', 'Unicode / ASCII (-P)'],
  ['Lookbehind', 'any length', 'any length (ES2018)', 'fixed width', 'no', 'rg: no; -P: bounded'],
  ['Named group', '(?<n>…) (?\'n\'…)', '(?<n>…)', '(?P<n>…)', 'no', '(?<n>…) / (?P<n>…)'],
  ['Backreference', '\\1 \\k<n>', '\\1 \\k<n>', '\\1 (?P=n)', '\\1 (GNU)', 'rg: no; -P: yes'],
  ['Replace with group', '$1 ${n}', '$1 $<n>', '\\1 \\g<n>', '\\1 (sed)', 'rg -r \'$1\''],
  ['Whole match in replace', '$0 or $&', '$&', '\\g<0>', '& (sed)', '$0'],
  ['Atomic / possessive', '(?>…) / no', 'no / no', '3.11+: both', 'no', 'rg: no; -P: both'],
  ['Inline options', '(?imnsx-imnsx)', '(?i:…) scoped (ES2025)', '(?i) at start, (?i:…)', 'no', '(?i)'],
  ['$ before final \\n', 'yes (\\z = very end)', 'no', 'yes (\\Z = very end)', 'line based', 'line based'],
  ['Guaranteed linear time', 'RegexOptions.NonBacktracking', 'no', 'no', 'yes (DFA)', 'rg: yes; -P: no'],
  ['Timeout', 'matchTimeout / AppContext', 'no (use a worker)', 'no', '-', '-'],
];

// ================================================================ substitutions

/** Parses a .NET replacement string: [{ lit } | { ref: number|name } | { whole } | { before } | { after } | { last } | { input }]. */
export function parseReplacement(rep, flavor = 'dotnet') {
  const parts = [];
  let lit = '';
  const push = p => { if (lit) parts.push({ lit }); lit = ''; parts.push(p); };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c !== '$') { lit += c; continue; }
    const n = rep[i + 1];
    if (n === '$') { lit += '$'; i++; continue; }
    if (n === '&') { push({ whole: true }); i++; continue; }
    if (n === '`') { push({ before: true }); i++; continue; }
    if (n === "'") { push({ after: true }); i++; continue; }
    if (flavor === 'dotnet' && n === '+') { push({ last: true }); i++; continue; }
    if (flavor === 'dotnet' && n === '_') { push({ input: true }); i++; continue; }
    if (flavor === 'dotnet' && n === '{') {
      const e = rep.indexOf('}', i);
      if (e > 0) { const name = rep.slice(i + 2, e); push(/^\d+$/.test(name) ? (name === '0' ? { whole: true } : { ref: Number(name) }) : { ref: name }); i = e; continue; }
    }
    if (flavor === 'js' && n === '<') {
      const e = rep.indexOf('>', i);
      if (e > 0) { push({ ref: rep.slice(i + 2, e) }); i = e; continue; }
    }
    if (/\d/.test(n ?? '')) {
      let j = i + 1;
      while (/\d/.test(rep[j] ?? '') && j < i + 3) j++;
      const num = Number(rep.slice(i + 1, j));
      push(num === 0 ? { whole: true } : { ref: num });
      i = j - 1;
      continue;
    }
    lit += '$';
  }
  if (lit) parts.push({ lit });
  return parts;
}

// ================================================================ code generation

const bashQuote = s => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = s => `'${s.replace(/'/g, "''")}'`;

function csString(s) {
  if (!s.includes('"')) return `@"${s}"`;
  if (!s.startsWith('"') && !s.endsWith('"') && !s.includes('"""')) return `"""${s}"""`;
  return `@"${s.replace(/"/g, '""')}"`;
}
function pyString(s) {
  const raw = !/\\$/.test(s);
  const r = raw ? 'r' : '';
  if (!s.includes("'")) return `${r}'${s}'`;
  if (!s.includes('"')) return `${r}"${s}"`;
  return `${r}'''${s}'''`;
}
function jsLiteral(s, flags) {
  let out = '', inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { out += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '[') inClass = true; else if (c === ']') inClass = false;
    if (c === '/' && !inClass) { out += '\\/'; continue; }
    if (c === '\n') { out += '\\n'; continue; }
    out += c;
  }
  return `/${out}/${flags}`;
}

function edit(src, edits) {
  let out = '', at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    out += src.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + src.slice(at);
}

function collect(ast) {
  const nodes = [];
  (function walk(n) {
    if (!n || typeof n !== 'object' || !n.type) return;
    nodes.push(n);
    for (const c of [n.body, ...(n.alts || []), ...(n.items || [])]) walk(c);
  })(ast);
  return nodes;
}

/**
 * The same pattern for every tool, correctly escaped. Input is a .NET pattern (the lab's authoritative flavour).
 * Returns { csharp, generated, javascript, python, rg, grep, sed, powershell, notes: { tool: [text] } }.
 */
export function generateCode(pattern, flags, replacement, { input = 'input', name = 'MyPattern' } = {}) {
  const parsed = parse(pattern, { flavor: 'dotnet', flags });
  const notes = { javascript: [], python: [], cli: [], csharp: [] };
  const opts = [...flags].filter(f => FLAG_INFO[f]).map(f => `RegexOptions.${FLAG_INFO[f].name}`);
  const csOpts = opts.length ? opts.join(' | ') : 'RegexOptions.None';
  const nodes = parsed.ast ? collect(parsed.ast) : [];
  const hasRep = replacement != null && replacement !== '';
  const repParts = hasRep ? parseReplacement(replacement, 'dotnet') : [];
  // .NET group number -> left-to-right number (JavaScript, Python, PCRE) and -> position among all ( ) (POSIX tools make every group capture).
  const lrOf = new Map(parsed.groups.map(g => [g.number, g.lr]));
  const posixOf = new Map(parsed.groups.map(g => [g.number, parsed.allGroups.indexOf(g) + 1]));
  const byName = new Map(parsed.groups.filter(g => g.name).map(g => [g.name, g]));
  const refNum = (r, map) => (typeof r === 'number' ? map.get(r) ?? r : map.get(byName.get(r)?.number) ?? r);

  // ---- C#
  const rx = csString(pattern);
  const csharpLines = [
    'using System.Text.RegularExpressions;',
    '',
    `// Build once and reuse: construction parses the pattern. Always set a timeout on patterns or input you do not control.`,
    `var regex = new Regex(${rx}, ${csOpts}, TimeSpan.FromSeconds(1));`,
    '',
    `foreach (Match m in regex.Matches(${input}))`,
    `    Console.WriteLine($"{m.Index}: {m.Value}${parsed.groups.map(g => ` ${g.name || g.number}={m.Groups[${g.name ? `"${g.name}"` : g.number}].Value}`).join('')}");`,
  ];
  if (hasRep) csharpLines.push('', `string result = regex.Replace(${input}, ${csString(replacement)});`);
  else csharpLines.push('', `bool any = regex.IsMatch(${input});`);
  const generated = [
    'using System.Text.RegularExpressions;',
    '',
    '// .NET 7+: the regex is compiled to C# at build time. No startup cost, trimming friendly, and you can step into it.',
    'public static partial class Patterns',
    '{',
    `    [GeneratedRegex(${rx}, ${csOpts}, matchTimeoutMilliseconds: 1000)]`,
    `    public static partial Regex ${name}();`,
    '}',
    '',
    `// Patterns.${name}().IsMatch(${input})${hasRep ? `\n// Patterns.${name}().Replace(${input}, ${csString(replacement)})` : ''}`,
  ];
  if (parsed.features.has('possessive')) notes.csharp.push('.NET has no possessive quantifiers: this does not compile. Use (?>a+).');

  // ---- JavaScript
  const jsEdits = [];
  let jsFlags = [...flags].filter(f => 'ims'.includes(f)).join('');
  if (flags.includes('x')) {
    for (const [s, e] of parsed.ignored) jsEdits.push({ start: s, end: e, text: '' });
    notes.javascript.push('JavaScript has no x flag: the spaces and comments were removed.');
  }
  if (flags.includes('n')) notes.javascript.push('JavaScript has no ExplicitCapture: use (?:...) for groups you do not need.');
  for (const n of nodes) {
    if (n.type === 'anchor' && n.kind === 'A') jsEdits.push({ start: n.start, end: n.end, text: '(?<![\\s\\S])' });
    if (n.type === 'anchor' && n.kind === 'z') jsEdits.push({ start: n.start, end: n.end, text: '(?![\\s\\S])' });
    if (n.type === 'anchor' && n.kind === 'Z') jsEdits.push({ start: n.start, end: n.end, text: '(?=\\n?(?![\\s\\S]))' });
    if (n.type === 'group' && n.kind === 'named' && pattern[n.start + 2] === "'") jsEdits.push({ start: n.start, end: n.start + 3 + n.name.length + 1, text: `(?<${n.name}>` });
    if (n.type === 'backref' && n.name == null && lrOf.get(n.number) !== n.number) jsEdits.push({ start: n.start, end: n.end, text: `\\${lrOf.get(n.number)}` });
    if (n.type === 'backref' && n.name != null && pattern[n.start + 2] !== '<') jsEdits.push({ start: n.start, end: n.end, text: `\\k<${n.name}>` });
    if (n.type === 'group' && n.kind === 'atomic') notes.javascript.push('JavaScript has no atomic groups. (?=(a+))\\1 emulates (?>a+), but shifts group numbers.');
    if (n.type === 'mods' && n.start === 0 && !n.off) { jsEdits.push({ start: n.start, end: n.end, text: '' }); jsFlags += n.on.replace(/[^ims]/g, ''); }
    else if (n.type === 'mods') notes.javascript.push('JavaScript only has the scoped form (?i:...) (ES2025); a bare (?i) in the middle is a syntax error.');
    if (n.type === 'prop' || (n.type === 'set' && n.items.some(it => it.kind === 'prop'))) { if (!jsFlags.includes('u')) jsFlags += 'u'; }
  }
  if (jsFlags.includes('u')) notes.javascript.push('\\p{...} needs the u flag, which also makes the syntax strict: useless escapes such as \\- outside a class become errors.');
  if (parsed.features.has('subtraction')) notes.javascript.push('Class subtraction [a-z-[aeiou]] is .NET only; with the v flag JavaScript writes [[a-z]--[aeiou]].');
  if (/\\d/.test(pattern)) notes.javascript.push('\\d is ASCII-only here, Unicode digits in .NET.');
  jsFlags = [...new Set(jsFlags)].join('');
  const jsPattern = edit(pattern, jsEdits);
  const jsRep = repParts.map(p => p.lit != null ? p.lit.replace(/\$/g, '$$$$') : p.whole ? '$&' : p.before ? '$`' : p.after ? "$'" : p.ref != null ? (typeof p.ref === 'number' ? `$${refNum(p.ref, lrOf)}` : `$<${p.ref}>`) : (notes.javascript.push('$+ and $_ have no JavaScript equivalent.'), '')).join('');
  const javascript = [
    `const re = ${jsLiteral(jsPattern, jsFlags + 'g')};`,
    '',
    `for (const m of ${input}.matchAll(re)) {`,
    `  console.log(m.index, m[0]${parsed.groups.length ? ', ' + parsed.groups.map(g => g.name ? `m.groups.${g.name}` : `m[${g.lr}]`).join(', ') : ''});`,
    '}',
    hasRep ? `\nconst result = ${input}.replace(re, ${JSON.stringify(jsRep)});` : `\nconst any = ${jsLiteral(jsPattern, jsFlags)}.test(${input});   // no g flag here: a g regex keeps lastIndex between test() calls`,
  ].join('\n');

  // ---- Python
  const pyEdits = [];
  for (const n of nodes) {
    if (n.type === 'group' && n.kind === 'named') pyEdits.push({ start: n.start, end: n.start + 3 + n.name.length + 1, text: `(?P<${n.name}>` });
    if (n.type === 'backref' && n.name != null) pyEdits.push({ start: n.start, end: n.end, text: `(?P=${n.name})` });
    if (n.type === 'backref' && n.name == null && lrOf.get(n.number) !== n.number) pyEdits.push({ start: n.start, end: n.end, text: `\\${lrOf.get(n.number)}` });
    if (n.type === 'anchor' && n.kind === 'z') pyEdits.push({ start: n.start, end: n.end, text: '\\Z' });
    if (n.type === 'anchor' && n.kind === 'Z') pyEdits.push({ start: n.start, end: n.end, text: '(?=\\n?\\Z)' });
    if (n.type === 'anchor' && n.kind === 'G') notes.python.push('Python re has no \\G.');
    if (n.type === 'prop') notes.python.push('Python re has no \\p{...}; install the regex package (import regex) or list the characters.');
    if (n.type === 'mods' && n.start !== 0) notes.python.push('Python 3.11+ only allows a global (?i) at the very start; use the scoped (?i:...) form.');
  }
  if (flags.includes('n')) notes.python.push('Python has no ExplicitCapture flag: use (?:...) for groups you do not need.');
  const pyFlags = [...flags].map(f => FLAG_INFO[f]?.py).filter(Boolean);
  const pyPattern = edit(pattern, pyEdits);
  const pyRep = repParts.map(p => p.lit != null ? p.lit.replace(/\\/g, '\\\\') : p.whole ? '\\g<0>' : p.ref != null ? (typeof p.ref === 'number' ? `\\g<${refNum(p.ref, lrOf)}>` : `\\g<${p.ref}>`) : '').join('');
  const python = [
    'import re',
    '',
    `PATTERN = re.compile(${pyString(pyPattern)}${pyFlags.length ? ', ' + pyFlags.join(' | ') : ''})`,
    '',
    `for m in PATTERN.finditer(${input}):`,
    `    print(m.start(), m.group(0)${parsed.groups.length ? ', ' + parsed.groups.map(g => g.name ? `m.group("${g.name}")` : `m.group(${g.lr})`).join(', ') : ''})`,
    '',
    hasRep ? `result = PATTERN.sub(${pyString(pyRep)}, ${input})` : `whole = PATTERN.fullmatch(${input}) is not None   # match() only anchors the start; search() looks anywhere`,
  ].join('\n');

  // ---- command line
  const needsPcre = ['lookahead', 'lookbehind', 'backref', 'atomic', 'possessive', 'inline-modifiers'].some(x => parsed.features.has(x));
  const posixOk = !needsPcre && !parsed.features.has('lazy') && !parsed.features.has('named') && !parsed.features.has('unicode-category') && !parsed.features.has('quote-named')
    && !nodes.some(n => n.type === 'anchor' && 'AzZG'.includes(n.kind)) && !nodes.some(n => n.type === 'set' && n.items.some(it => it.kind === 'class' && 'dD'.includes(it.cls)));
  const posixEdits = [];
  for (const n of nodes) {
    if (n.type === 'class' && n.cls === 'd') posixEdits.push({ start: n.start, end: n.end, text: '[0-9]' });
    if (n.type === 'class' && n.cls === 'D') posixEdits.push({ start: n.start, end: n.end, text: '[^0-9]' });
    if (n.type === 'group' && n.kind === 'non') posixEdits.push({ start: n.start, end: n.start + 3, text: '(' });
    if (n.type === 'set' && n.items.some(it => it.kind === 'class' && it.cls === 's')) for (const it of n.items) if (it.kind === 'class' && it.cls === 's') posixEdits.push({ start: it.start, end: it.end, text: '[:space:]' });
    if (n.type === 'set' && n.items.some(it => it.kind === 'class' && it.cls === 'w')) for (const it of n.items) if (it.kind === 'class' && it.cls === 'w') posixEdits.push({ start: it.start, end: it.end, text: '[:alnum:]_' });
  }
  const ere = edit(pattern, posixEdits);
  const ci = flags.includes('i') ? ' -i' : '';
  const rgPattern = edit(pattern, parsed.ignored.map(([s, e]) => ({ start: s, end: e, text: '' })));
  const rgP = needsPcre ? ' -P' : '';
  const cli = [
    '# ripgrep: recursive, respects .gitignore, fast. -n line numbers, -o only the match' + (needsPcre ? ', -P for lookaround/backreferences (PCRE2)' : ''),
    `rg -n${ci}${rgP} ${bashQuote(rgPattern)} src/`,
    `rg -o${ci}${rgP} --no-filename ${bashQuote(rgPattern)} app.log | sort | uniq -c | sort -rn   # count each distinct match`,
  ];
  if (hasRep) cli.push(`rg${ci}${rgP} ${bashQuote(rgPattern)} -r ${bashQuote(repParts.map(p => p.lit != null ? p.lit.replace(/\$/g, '$$$$') : p.whole ? '$0' : p.ref != null ? (typeof p.ref === 'number' ? `$${refNum(p.ref, lrOf)}` : `$${p.ref}`) : '').join(''))} file.txt   # preview a replacement (rg never edits files)`);
  cli.push('');
  if (posixOk) cli.push(`grep -nE${ci} ${bashQuote(ere)} file.txt   # POSIX ERE: no \\d, no lazy, no lookaround`);
  else cli.push(`grep -nP${ci} ${bashQuote(rgPattern)} file.txt   # GNU grep's PCRE mode (not on macOS's BSD grep)`);
  if (hasRep) {
    if (posixOk) {
      const sedRep = repParts.map(p => p.lit != null ? p.lit.replace(/[\\&/]/g, m => '\\' + m) : p.whole ? '&' : p.ref != null ? `\\${refNum(p.ref, posixOf)}` : '').join('');
      cli.push(`sed -E${ci ? '' : ''} 's/${ere.replace(/\//g, '\\/')}/${sedRep}/g${flags.includes('i') ? 'I' : ''}' file.txt > out.txt   # add -i to edit in place (GNU); BSD/macOS needs -i ''`);
    } else {
      const plRep = repParts.map(p => p.lit != null ? p.lit.replace(/[\\$@/]/g, m => '\\' + m) : p.whole ? '$&' : p.ref != null ? (typeof p.ref === 'number' ? `$${refNum(p.ref, lrOf)}` : `$+{${p.ref}}`) : '').join('');
      cli.push(`perl -pe 's/${rgPattern.replace(/\//g, '\\/')}/${plRep}/g${flags.includes('i') ? 'i' : ''}' file.txt   # sed -E cannot do this pattern (POSIX ERE); perl can`);
    }
  }
  if (!posixOk) notes.cli.push('This pattern needs PCRE features, so grep -E and sed -E cannot run it: the commands use -P and perl.');
  if (posixEdits.length && posixOk) notes.cli.push('POSIX tools have no \\d or (?:...): the grep/sed lines use [0-9] and plain ( ).');

  // ---- PowerShell (.NET regex underneath, but case-insensitive by default)
  const ps = [
    `# PowerShell uses .NET regex, but -match, -replace and Select-String ignore case unless you say -cmatch, -creplace, -CaseSensitive.`,
    `Select-String -Path .\\*.log -Pattern ${psQuote(pattern)}${flags.includes('i') ? '' : ' -CaseSensitive'} | ForEach-Object { $_.Matches.Value }`,
    `if ($line ${flags.includes('i') ? '-match' : '-cmatch'} ${psQuote(pattern)}) { $Matches[0]${parsed.groups[0] ? `; $Matches[${parsed.groups[0].name ? `'${parsed.groups[0].name}'` : parsed.groups[0].number}]` : ''} }`,
  ];
  if (hasRep) ps.push(`$text ${flags.includes('i') ? '-replace' : '-creplace'} ${psQuote(pattern)}, ${psQuote(replacement)}   # single quotes, or PowerShell eats $1 as a variable`);

  return { csharp: csharpLines.join('\n'), generated: generated.join('\n'), javascript, python, cli: cli.join('\n'), powershell: ps.join('\n'), notes, parsed };
}

/** The replacement written for each flavour, for the side-by-side table. */
export function replacementFlavours(replacement, parsed) {
  const parts = parseReplacement(replacement, 'dotnet');
  const lrOf = new Map(parsed.groups.map(g => [g.number, g.lr]));
  const posixOf = new Map(parsed.groups.map(g => [g.number, parsed.allGroups.indexOf(g) + 1]));
  const byName = new Map(parsed.groups.filter(g => g.name).map(g => [g.name, g]));
  const num = (r, map) => (typeof r === 'number' ? map.get(r) ?? r : map.get(byName.get(r)?.number) ?? '?');
  const render = (fmt) => parts.map(p => p.lit != null ? fmt.lit(p.lit) : p.whole ? fmt.whole : p.before ? fmt.before ?? '' : p.after ? fmt.after ?? '' : p.ref != null ? fmt.ref(p.ref) : '').join('');
  return [
    ['.NET (Regex.Replace, PowerShell -replace)', replacement, '$1 or ${1}, ${name}, $0 = whole match, $$ = a literal $'],
    ['JavaScript (String.replace)', render({ lit: s => s.replace(/\$/g, '$$$$'), whole: '$&', before: '$`', after: "$'", ref: r => (typeof r === 'number' ? `$${num(r, lrOf)}` : `$<${r}>`) }), '$1, $<name>, $& = whole match; ${name} is NOT a group here'],
    ['Python (re.sub)', render({ lit: s => s.replace(/\\/g, '\\\\'), whole: '\\g<0>', ref: r => (typeof r === 'number' ? `\\g<${num(r, lrOf)}>` : `\\g<${r}>`) }), '\\1 or \\g<1>, \\g<name>; use a raw string r"..."'],
    ['sed -E (s/.../.../g)', render({ lit: s => s.replace(/[\\&/]/g, m => '\\' + m), whole: '&', ref: r => `\\${num(r, posixOf)}` }), '\\1 to \\9, & = whole match; no names'],
    ['VS Code / Rider find & replace', render({ lit: s => s.replace(/\$/g, '$$$$'), whole: '$0', ref: r => (typeof r === 'number' ? `$${num(r, lrOf)}` : `$${num(r, lrOf)}`) }), 'VS Code: $1, $0; \\u$1 uppercases. Rider uses .NET syntax: $1, ${name}'],
  ];
}

// ================================================================ quick reference

export const REFERENCE = [
  ['Characters', [['abc', 'the text abc'], ['\\.', 'a literal dot (escape . * + ? ( ) [ ] { } | ^ $ \\)'], ['\\t \\n \\r', 'tab, newline, carriage return'], ['\\x41 \\u00e9', 'a character by code']]],
  ['Classes', [['.', 'any character except newline'], ['[abc]', 'one of a, b, c'], ['[^abc]', 'anything but a, b, c'], ['[a-z0-9]', 'a range'], ['\\d \\D', 'digit / not a digit'], ['\\w \\W', 'word char / not'], ['\\s \\S', 'whitespace / not'], ['\\p{L} \\p{Lu}', 'Unicode letter / uppercase']]],
  ['Anchors', [['^ $', 'start / end (of line with m)'], ['\\A \\z', 'very start / very end (.NET)'], ['\\b \\B', 'word boundary / not']]],
  ['Quantifiers', [['* + ?', '0+, 1+, 0 or 1 (greedy)'], ['{3} {2,5} {2,}', 'exactly, between, at least'], ['*? +? ??', 'lazy: as few as possible'], ['(?>...)', 'atomic: no backtracking in']]],
  ['Groups', [['(...)', 'capture as $1'], ['(?<name>...)', 'named capture ${name}'], ['(?:...)', 'group without capturing'], ['a|b', 'a or b'], ['\\1 \\k<name>', 'the same text again']]],
  ['Lookaround', [['(?=...)', 'followed by'], ['(?!...)', 'not followed by'], ['(?<=...)', 'preceded by'], ['(?<!...)', 'not preceded by']]],
  ['Flags', [['i', 'ignore case'], ['m', '^ $ per line'], ['s', '. matches newline'], ['x', 'ignore spaces, # comments'], ['n', 'only named groups capture'], ['(?i)', 'turn a flag on inline']]],
  ['Replace (.NET)', [['$1 ${1}', 'group 1'], ['${name}', 'named group'], ['$0', 'the whole match'], ['$$', 'a literal $']]],
];
