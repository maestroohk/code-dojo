// DOM-free editor cores for the Vim & nano trainer. Everything here is pure state + key handling,
// so it can be driven from the browser (lab-vim.js) or from Node to test the challenges.
// Keys are tokens: single characters ('a', 'G', ':'), DOM key names ('Escape', 'Enter', 'Backspace',
// 'ArrowUp', ...), and '<C-r>' / '<M-u>' for Ctrl / Alt (Meta) combinations.

const MORE = 'more', BAD = 'bad', OK = 'ok';

/** Turn "ihello<Esc>:wq<CR>" into key tokens. */
export function tokenize(s) {
  const named = { Esc: 'Escape', CR: 'Enter', Enter: 'Enter', BS: 'Backspace', Tab: 'Tab', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown',
    Left: 'ArrowLeft', Right: 'ArrowRight', Home: 'Home', End: 'End', Space: ' ', lt: '<', F6: 'F6' };
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') {
      const m = /^<([A-Za-z0-9]+|[CM]-.)>/.exec(s.slice(i));
      if (m && (named[m[1]] || /^[CM]-/.test(m[1]))) { out.push(named[m[1]] || `<${m[1].replace(/^([CM]-)(.)$/, (_, p, c) => p + c.toLowerCase())}>`); i += m[0].length - 1; continue; }
    }
    out.push(s[i]);
  }
  return out;
}

/** Display a token the way cheat sheets write it. */
export const keyLabel = k => ({ Escape: 'Esc', Enter: '⏎', Backspace: '⌫', Tab: 'Tab', Delete: 'Del', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': '␣' }[k]
  || (/^<C-(.)>$/.test(k) ? '^' + k[3].toUpperCase() : /^<M-(.)>$/.test(k) ? 'M-' + k[3].toUpperCase() : k));

const escRe = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const cls = (ch, big) => (ch === undefined || /\s/.test(ch) ? 0 : big ? 1 : /\w/.test(ch) ? 1 : 2);
const cmp = (a, b) => a.r - b.r || a.c - b.c;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Vim's "magic" regex syntax to a JavaScript RegExp. */
export function vimRegex(p, flags = '') {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\' && i + 1 < p.length) {
      const n = p[++i];
      if ('()|+?{}'.includes(n)) out += n;
      else if (n === '<' || n === '>') out += '\\b';
      else if ('sSdDwW.*[]\\^$'.includes(n)) out += '\\' + n;
      else if (n === 't') out += '\\t';
      else out += escRe(n);
    } else if ('()|+?{}'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  try { return new RegExp(out, 'g' + flags); } catch { return new RegExp(escRe(p), 'g' + flags); }
}

function vimReplacement(rep) {
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const ch = rep[i];
    if (ch === '\\' && i + 1 < rep.length) { const n = rep[++i]; out += /\d/.test(n) ? '$' + n : n === '&' ? '&' : n === '$' ? '$$' : n; }
    else if (ch === '&') out += '$&';
    else if (ch === '$') out += '$$';
    else out += ch;
  }
  return out;
}

/** Split "s/a\/b/c/g" style text on an unescaped delimiter. */
function splitDelim(s, d) {
  const parts = [''];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === d) { parts[parts.length - 1] += d; i++; }
    else if (s[i] === '\\' && i + 1 < s.length) { parts[parts.length - 1] += s[i] + s[i + 1]; i++; }
    else if (s[i] === d) parts.push('');
    else parts[parts.length - 1] += s[i];
  }
  return parts;
}

// ===================================================================== Vim

export class Vim {
  constructor(text = '', { row = 0, col = 0, disk, file = 'file.txt', pre } = {}) {
    this.lines = String(text).split('\n');
    this.row = clamp(row, 0, this.lines.length - 1);
    this.col = clamp(col, 0, Math.max(0, this.lines[this.row].length - 1));
    this.want = this.col;
    this.mode = 'normal';           // normal | insert | visual | vline | command
    this.pending = [];
    this.cmd = null;                // { type: ':' | '/' | '?', text, from }
    this.reg = { text: '', linewise: false };
    this.undoStack = []; this.redoStack = []; this.snap = null;
    this.lastChange = null; this.recording = null; this.replaying = false;
    this.search = null; this.lastFind = null; this.anchor = null; this.vmarks = null;
    this.insert = null;
    this.message = ''; this.error = false;
    this.keys = 0; this.log = [];
    this.quit = false; this.number = true;
    this.disk = disk ?? this.text; this.file = file;
    // A level can start mid-mistake (say, stuck in Insert mode): these keys are played first and not counted.
    if (pre) { this.feedAll(pre); this.keys = 0; this.log = []; }
  }
  get text() { return this.lines.join('\n'); }
  get modified() { return this.text !== this.disk; }
  get last() { return this.lines.length - 1; }
  len(r = this.row) { return this.lines[r].length; }
  fnb(r = this.row) { const m = /\S/.exec(this.lines[r]); return m ? m.index : Math.max(0, this.len(r) - 1); }
  ch(p) { return this.lines[p.r][p.c]; }
  nextPos(p) { if (p.c < this.len(p.r)) return { r: p.r, c: p.c + 1 }; return p.r < this.last ? { r: p.r + 1, c: 0 } : null; }
  prevPos(p) { if (p.c > 0) return { r: p.r, c: p.c - 1 }; return p.r > 0 ? { r: p.r - 1, c: this.len(p.r - 1) } : null; }
  get cur() { return { r: this.row, c: this.col }; }
  clampCol() { this.col = clamp(this.col, 0, Math.max(0, this.len() - (this.mode === 'insert' ? 0 : 1))); }
  msg(text, error = false) { this.message = text; this.error = error; }

  /** Feed one key token. */
  feed(key) {
    if (this.quit) return;
    if (!this.replaying) { this.keys++; this.log.push(key); if (this.recording) this.recording.push(key); if (this.macro) this.macro.keys.push(key); }
    if (key === '<C-[>') key = 'Escape';
    if (this.mode === 'insert') return this.insertKey(key);
    if (this.mode === 'command') return this.cmdKey(key);
    if (!this.replaying && this.pending.length === 0) this.msg('');
    this.pending.push(key);
    const keys = this.pending;
    const r = this.mode === 'normal' ? this.parseNormal(keys) : this.parseVisual(keys);
    if (r === MORE) return;
    if (this.pending === keys) this.pending = [];
  }
  feedAll(keys) { for (const k of (typeof keys === 'string' ? tokenize(keys) : keys)) this.feed(k); return this; }

  // --------------------------------------------------------------- undo
  begin() { this.snap = { lines: [...this.lines], row: this.row, col: this.col }; }
  commit() {
    if (this.snap && this.snap.lines.join('\n') !== this.text) { this.undoStack.push(this.snap); this.redoStack = []; }
    this.snap = null;
  }
  undo(redo) {
    const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack;
    if (!from.length) { this.msg(redo ? 'Already at newest change' : 'Already at oldest change'); return; }
    const s = from.pop();
    to.push({ lines: [...this.lines], row: this.row, col: this.col });
    this.lines = [...s.lines]; this.row = clamp(s.row, 0, this.last); this.col = s.col; this.clampCol();
    this.msg(redo ? '1 change; after' : '1 change; before');
  }
  /** Called after a change command: remember it for "." and close the undo step (unless in insert). */
  finish(keys) {
    if (this.mode === 'insert') { if (!this.replaying) this.recording = [...keys]; return; }
    if (!this.replaying) this.lastChange = [...keys];
    this.commit();
  }

  count(keys, i) {
    let s = '';
    while (i < keys.length && /^[0-9]$/.test(keys[i]) && !(keys[i] === '0' && s === '')) s += keys[i++];
    return [s ? Number(s) : 0, i];
  }

  // --------------------------------------------------------------- normal mode
  parseNormal(keys, rec = keys) {
    if (keys[keys.length - 1] === 'Escape') return OK;
    const [c1, i] = this.count(keys, 0);
    const k = keys[i];
    if (k === undefined) return MORE;
    const n = c1 || 1;

    let op = null, j = i + 1;
    if ('dcy'.includes(k) && k.length === 1) op = k;
    else if (k === 'g' && keys[i + 1] !== undefined && 'uU~'.includes(keys[i + 1])) { op = 'g' + keys[i + 1]; j = i + 2; }
    else if (k === 'g' && keys[i + 1] === undefined) return MORE;
    if (op) {
      const [c2, m] = this.count(keys, j);
      const mk = keys[m];
      if (mk === undefined) return MORE;
      const cnt = (c1 || 1) * (c2 || 1), hasCount = !!(c1 || c2);
      const done = () => { if (op === 'y') this.commit(); else this.finish(rec); return OK; };
      if (mk === op[op.length - 1] || (op.length === 2 && mk === 'g' && keys[m + 1] === op[1])) {
        if (op.length === 2 && mk === 'g' && keys[m + 1] === undefined) return MORE;
        this.begin(); this.opLines(op, this.row, Math.min(this.row + cnt - 1, this.last)); return done();
      }
      if (mk === 'i' || mk === 'a') {
        const o = keys[m + 1];
        if (o === undefined) return MORE;
        const rng = this.textObject(mk, o);
        if (!rng) return BAD;
        this.begin(); this.applyRange(op, rng); return done();
      }
      const mo = this.parseMotion(keys, m);
      if (mo === MORE) return MORE;
      if (!mo) return BAD;
      let t;
      if (op === 'c' && (mo.m === 'w' || mo.m === 'W') && cls(this.ch(this.cur)) !== 0) t = this.changeWord(cnt, mo.m === 'W');
      else t = this.motion(mo.m, hasCount ? cnt : 0, mo.arg, op);
      if (!t) return BAD;
      this.begin(); this.applyMotionOp(op, t, mo.m); return done();
    }

    const alias = { x: ['d', 'l'], X: ['d', 'h'], D: ['d', '$'], C: ['c', '$'], s: ['c', 'l'], S: ['c', 'c'], Y: ['y', 'y'] }[k];
    if (alias && k.length === 1) {
      if (k === 'x' && this.len() === 0) return BAD;
      return this.parseNormal([...(c1 ? String(c1).split('') : []), ...alias], rec);
    }

    switch (k) {
      case 'i': case 'a': case 'I': case 'A': case 'o': case 'O': {
        this.begin();
        if (k === 'a') this.col = Math.min(this.col + 1, this.len());
        if (k === 'I') this.col = /\S/.test(this.lines[this.row]) ? this.fnb() : this.len();
        if (k === 'A') this.col = this.len();
        if (k === 'o') { this.lines.splice(this.row + 1, 0, ''); this.row++; this.col = 0; }
        if (k === 'O') { this.lines.splice(this.row, 0, ''); this.col = 0; }
        this.enterInsert(k, n);
        this.finish(rec); return OK;
      }
      case 'r': {
        const ch = keys[i + 1];
        if (ch === undefined) return MORE;
        if (ch.length !== 1 || this.col + n > this.len()) return BAD;
        this.begin();
        const l = this.lines[this.row];
        this.lines[this.row] = l.slice(0, this.col) + ch.repeat(n) + l.slice(this.col + n);
        this.col += n - 1;
        this.finish(rec); return OK;
      }
      case 'J': {
        if (this.row >= this.last) return BAD;
        this.begin();
        for (let t = 0; t < Math.max(1, n - 1) && this.row < this.last; t++) this.joinLine(this.row);
        this.finish(rec); return OK;
      }
      case '~': {
        if (!this.len()) return BAD;
        this.begin();
        const l = this.lines[this.row], end = Math.min(this.len(), this.col + n);
        const flip = s => [...s].map(c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
        this.lines[this.row] = l.slice(0, this.col) + flip(l.slice(this.col, end)) + l.slice(end);
        this.col = Math.min(end, this.len() - 1);
        this.finish(rec); return OK;
      }
      case 'p': case 'P':
        if (!this.reg.text && !this.reg.linewise) { this.msg('E353: Nothing in register "', true); return BAD; }
        this.begin(); this.paste(k === 'p', n); this.finish(rec); return OK;
      case 'u': for (let t = 0; t < n; t++) this.undo(false); return OK;
      case '<C-r>': for (let t = 0; t < n; t++) this.undo(true); return OK;
      case '.': {
        if (!this.lastChange) return BAD;
        let ks = [...this.lastChange];
        if (c1) { const [, at] = this.count(ks, 0); ks = [...String(c1).split(''), ...ks.slice(at)]; }
        this.pending = [];
        const was = this.replaying; this.replaying = true;
        for (const key of ks) this.feed(key);
        this.replaying = was;
        return OK;
      }
      case 'q': {   // macros: q{a-z} starts recording, q stops; @{a-z} replays, @@ repeats the last one
        if (this.macro) {
          const m = this.macro; this.macro = null; m.keys.pop();
          (this.macros ||= {})[m.reg] = m.keys; this.msg(''); return OK;
        }
        const reg = keys[i + 1];
        if (reg === undefined) return MORE;
        if (!/^[a-z]$/.test(reg)) return BAD;
        this.macro = { reg, keys: [] }; this.msg(`recording @${reg}`); return OK;
      }
      case '@': {
        let reg = keys[i + 1];
        if (reg === undefined) return MORE;
        if (reg === '@') reg = this.lastMacro;
        const ks = this.macros?.[reg];
        if (!ks) return BAD;
        this.lastMacro = reg; this.pending = [];
        const was = this.replaying; this.replaying = true;
        for (let t = 0; t < n; t++) for (const key of ks) this.feed(key);
        this.replaying = was;
        return OK;
      }
      case 'v': case 'V':
        this.mode = k === 'v' ? 'visual' : 'vline'; this.anchor = this.cur; return OK;
      case ':': case '/': case '?':
        this.mode = 'command'; this.cmd = { type: k, text: c1 ? `.,.+${c1 - 1}` : '', from: 'normal' }; return OK;
      case 'Z': {
        const k2 = keys[i + 1];
        if (k2 === undefined) return MORE;
        if (k2 === 'Z') { this.ex('x'); return OK; }
        if (k2 === 'Q') { this.ex('q!'); return OK; }
        return BAD;
      }
    }

    const mo = this.parseMotion(keys, i);
    if (mo === MORE) return MORE;
    if (!mo) return BAD;
    const t = this.motion(mo.m, c1, mo.arg, null);
    if (!t) return BAD;
    this.moveTo(t, mo.m);
    return OK;
  }

  moveTo(t, m) {
    this.row = t.r; this.col = t.c; this.clampCol();
    if (m !== 'j' && m !== 'k') this.want = t.want ?? this.col;
  }

  parseMotion(keys, i) {
    let k = keys[i];
    if (k === undefined) return MORE;
    const map = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j', Home: '0', End: '$', Backspace: 'h', ' ': 'l', Enter: '+', '-': '-', '+': '+' };
    if (map[k]) k = map[k];
    if (k.length === 1 && 'hjklwbeWBE0^$G{}%nN*#;,+-HL'.includes(k)) return { m: k };
    if (k === 'g') {
      const k2 = keys[i + 1];
      if (k2 === undefined) return MORE;
      if (k2 === 'g' || k2 === '_' || k2 === 'e') return { m: 'g' + k2 };
      return null;
    }
    if (k.length === 1 && 'fFtT'.includes(k)) {
      const ch = keys[i + 1];
      if (ch === undefined) return MORE;
      return ch.length === 1 ? { m: k, arg: ch } : null;
    }
    return null;
  }

  /** Where a motion lands. Returns { r, c, linewise?, inclusive?, want? } or null if it cannot move. */
  motion(m, cnt, arg, op) {
    const n = cnt || 1, r = this.row, c = this.col;
    switch (m) {
      case 'h': return c === 0 ? null : { r, c: Math.max(0, c - n) };
      case 'l': { const t = Math.min(c + n, op ? this.len() : Math.max(0, this.len() - 1)); return t === c && !op ? null : { r, c: t }; }
      case 'j': case 'k': case '+': case '-': {
        const nr = clamp(r + (m === 'j' || m === '+' ? n : -n), 0, this.last);
        if (nr === r) return null;
        return { r: nr, c: m === '+' || m === '-' ? this.fnb(nr) : Math.min(this.want, Math.max(0, this.len(nr) - 1)), linewise: true };
      }
      case 'H': return { r: 0, c: this.fnb(0), linewise: true };
      case 'L': return { r: this.last, c: this.fnb(this.last), linewise: true };
      case '0': return { r, c: 0 };
      case '^': return { r, c: this.fnb() };
      case '$': { const nr = Math.min(this.last, r + n - 1); return { r: nr, c: Math.max(0, this.len(nr) - 1), inclusive: true, want: Infinity }; }
      case 'g_': { const nr = Math.min(this.last, r + n - 1); const t = this.lines[nr].trimEnd().length; return { r: nr, c: Math.max(0, t - 1), inclusive: true }; }
      case 'G': case 'gg': { const nr = cnt ? clamp(cnt - 1, 0, this.last) : m === 'G' ? this.last : 0; return { r: nr, c: this.fnb(nr), linewise: true }; }
      case 'w': case 'W': {
        let p = this.cur, end = false;
        for (let t = 0; t < n && !end; t++) ({ p, end } = this.wordFwd(p, m === 'W'));
        return { r: p.r, c: p.c, end };
      }
      case 'e': case 'E': {
        let p = this.cur;
        for (let t = 0; t < n; t++) { const q = this.wordEnd(p, m === 'E'); if (!q) break; p = q; }
        return cmp(p, this.cur) === 0 ? null : { r: p.r, c: p.c, inclusive: true };
      }
      case 'b': case 'B': {
        let p = this.cur;
        for (let t = 0; t < n; t++) { const q = this.wordBack(p, m === 'B'); if (!q) break; p = q; }
        return cmp(p, this.cur) === 0 ? null : { r: p.r, c: p.c };
      }
      case 'ge': {
        let p = this.cur;
        for (let t = 0; t < n; t++) {
          let q = this.prevPos(p); if (!q) break;
          const c0 = cls(this.ch(p));
          while (q && c0 !== 0 && cls(this.ch(q)) === c0) q = this.prevPos(q);
          while (q && cls(this.ch(q)) === 0 && this.len(q.r) > 0) q = this.prevPos(q);
          if (!q) break; p = q;
        }
        return { r: p.r, c: p.c, inclusive: true };
      }
      case 'f': case 't': case 'F': case 'T': this.lastFind = { m, arg }; return this.find(m, arg, n, false);
      case ';': case ',': {
        if (!this.lastFind) return null;
        let fm = this.lastFind.m;
        if (m === ',') fm = { f: 'F', F: 'f', t: 'T', T: 't' }[fm];
        return this.find(fm, this.lastFind.arg, n, true);
      }
      case '%': return this.matchBracket();
      case '}': case '{': {
        let nr = r;
        const down = m === '}', blank = x => this.len(x) === 0;
        for (let t = 0; t < n; t++) {
          while (nr !== (down ? this.last : 0) && blank(nr)) nr += down ? 1 : -1;
          while (nr !== (down ? this.last : 0) && !blank(nr)) nr += down ? 1 : -1;
        }
        if (nr === r) return null;
        if (!blank(nr)) return down ? { r: nr, c: Math.max(0, this.len(nr) - (op ? 0 : 1)) } : { r: 0, c: 0 };
        return { r: nr, c: 0 };
      }
      case 'n': case 'N': case '*': case '#': {
        if (m === '*' || m === '#') {
          const l = this.lines[r];
          let s = c; while (s < l.length && !/\w/.test(l[s])) s++;
          if (s >= l.length) { this.msg('E348: No string under cursor', true); return null; }
          let e = s; while (s > 0 && /\w/.test(l[s - 1])) s--; while (e < l.length && /\w/.test(l[e])) e++;
          this.search = { pat: `\\<${l.slice(s, e)}\\>`, dir: m === '*' ? 1 : -1 };
          this.col = s;
        }
        if (!this.search) { this.msg('E35: No previous regular expression', true); return null; }
        let p = this.cur;
        for (let t = 0; t < n; t++) { const q = this.doSearch(this.search.pat, m === 'N' ? -this.search.dir : this.search.dir, p); if (!q) return null; p = q; }
        if (m === '*' || m === '#') this.msg((m === '*' ? '/' : '?') + this.search.pat);
        return p;
      }
    }
    return null;
  }

  wordFwd(p, big) {
    const c0 = cls(this.ch(p), big);
    let q = p;
    if (c0 !== 0) {
      for (;;) { const nx = this.nextPos(q); if (!nx) return { p: q, end: true }; q = nx; if (cls(this.ch(q), big) !== c0) break; }
    }
    while (cls(this.ch(q), big) === 0) {
      if (this.len(q.r) === 0 && q.r !== p.r) break;
      const nx = this.nextPos(q); if (!nx) return { p: q, end: true }; q = nx;
    }
    return { p: q, end: false };
  }
  wordEnd(p, big) {
    let q = this.nextPos(p);
    if (!q) return null;
    while (cls(this.ch(q), big) === 0) { const nx = this.nextPos(q); if (!nx) return null; q = nx; }
    const c0 = cls(this.ch(q), big);
    for (;;) { const nx = this.nextPos(q); if (!nx || cls(this.ch(nx), big) !== c0) return q; q = nx; }
  }
  wordBack(p, big) {
    let q = this.prevPos(p);
    if (!q) return null;
    while (cls(this.ch(q), big) === 0) {
      if (this.len(q.r) === 0 && q.r !== p.r) return q;
      const pv = this.prevPos(q); if (!pv) return q; q = pv;
    }
    const c0 = cls(this.ch(q), big);
    for (;;) { const pv = this.prevPos(q); if (!pv || cls(this.ch(pv), big) !== c0) return q; q = pv; }
  }
  /** cw is special: it changes to the end of the word, not up to the next one. */
  changeWord(n, big) {
    let q = this.cur;
    for (let t = 0; t < n; t++) {
      const nx = this.nextPos(q);
      if (t === 0 && !(nx && cls(this.ch(nx), big) === cls(this.ch(q), big) && nx.r === q.r)) continue;
      const e = this.wordEnd(q, big); if (!e) break; q = e;
    }
    return { r: q.r, c: q.c, inclusive: true };
  }
  find(m, ch, n, repeat) {
    const l = this.lines[this.row];
    let idx = this.col;
    for (let t = 0; t < n; t++) {
      if (m === 'f' || m === 't') idx = l.indexOf(ch, idx + 1 + (m === 't' && repeat && t === 0 ? 1 : 0));
      else idx = idx - 1 - (m === 'T' && repeat && t === 0 ? 1 : 0) < 0 ? -1 : l.lastIndexOf(ch, idx - 1 - (m === 'T' && repeat && t === 0 ? 1 : 0));
      if (idx < 0) return null;
    }
    if (m === 't') idx--; if (m === 'T') idx++;
    return { r: this.row, c: idx, inclusive: m === 'f' || m === 't' };
  }
  matchBracket() {
    const l = this.lines[this.row];
    let c = this.col;
    while (c < l.length && !'()[]{}'.includes(l[c])) c++;
    if (c >= l.length) return null;
    const q = this.matchAt({ r: this.row, c });
    return q ? { ...q, inclusive: true } : null;
  }
  matchAt(p) {
    const ch = this.ch(p), pairs = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
    const fwd = '([{'.includes(ch), other = pairs[ch];
    let depth = 0, q = p;
    while ((q = fwd ? this.nextPos(q) : this.prevPos(q))) {
      const x = this.ch(q);
      if (x === ch) depth++;
      else if (x === other) { if (depth === 0) return q; depth--; }
    }
    return null;
  }

  doSearch(pat, dir, from) {
    const re = vimRegex(pat);
    const hits = r => { const out = []; re.lastIndex = 0; let m; const l = this.lines[r]; while ((m = re.exec(l))) { out.push(m.index); if (m[0] === '') re.lastIndex++; } return out; };
    const N = this.lines.length;
    for (let s = 0; s <= N; s++) {
      const r = ((from.r + dir * s) % N + N) % N;
      let cand = hits(r);
      if (s === 0) cand = cand.filter(c => (dir > 0 ? c > from.c : c < from.c));
      if (s === N) cand = cand.filter(c => (dir > 0 ? c <= from.c : c >= from.c));
      if (cand.length) {
        const wrapped = dir > 0 ? r < from.r || (r === from.r && s > 0) : r > from.r || (r === from.r && s > 0);
        this.msg(wrapped ? (dir > 0 ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM') : (dir > 0 ? '/' : '?') + pat, wrapped);
        return { r, c: dir > 0 ? cand[0] : cand[cand.length - 1] };
      }
    }
    this.msg('E486: Pattern not found: ' + pat, true);
    return null;
  }

  // --------------------------------------------------------------- text objects
  textObject(ia, o) {
    const r = this.row, l = this.lines[r], c = this.col;
    if (o === 'w' || o === 'W') {
      if (!l.length) return null;
      const big = o === 'W', cc = cls(l[c], big);
      let s = c, e = c;
      while (s > 0 && cls(l[s - 1], big) === cc) s--;
      while (e < l.length - 1 && cls(l[e + 1], big) === cc) e++;
      if (ia === 'a') {
        if (cc === 0) { while (e < l.length - 1 && cls(l[e + 1], big) !== 0) e++; }
        else if (e < l.length - 1 && cls(l[e + 1], big) === 0) { while (e < l.length - 1 && cls(l[e + 1], big) === 0) e++; }
        else while (s > 0 && cls(l[s - 1], big) === 0) s--;
      }
      return { a: { r, c: s }, b: { r, c: e + 1 } };
    }
    if (o === '"' || o === "'" || o === '`') {
      const qs = [];
      for (let i = 0; i < l.length; i++) if (l[i] === o && l[i - 1] !== '\\') qs.push(i);
      let pair = null;
      for (let i = 0; i + 1 < qs.length; i += 2) if (qs[i] <= c && c <= qs[i + 1]) pair = [qs[i], qs[i + 1]];
      if (!pair) for (let i = 0; i + 1 < qs.length; i += 2) if (qs[i] > c) { pair = [qs[i], qs[i + 1]]; break; }
      if (!pair) return null;
      let [s, e] = pair;
      if (ia === 'i') return { a: { r, c: s + 1 }, b: { r, c: e } };
      e++;
      if (/\s/.test(l[e] || '')) while (/\s/.test(l[e] || '')) e++;
      else while (s > 0 && /\s/.test(l[s - 1])) s--;
      return { a: { r, c: s }, b: { r, c: e } };
    }
    const br = { '(': '()', ')': '()', b: '()', '{': '{}', '}': '{}', B: '{}', '[': '[]', ']': '[]', '<': '<>', '>': '<>' }[o];
    if (br) {
      const [open, close] = br;
      let p = this.cur, start = null;
      if (this.ch(p) === open) start = p;
      else if (this.ch(p) === close) start = this.matchAt(p);
      else {
        let depth = 0, q = p;
        while ((q = this.prevPos(q))) { const x = this.ch(q); if (x === close) depth++; else if (x === open) { if (!depth) { start = q; break; } depth--; } }
        if (!start) { const i = l.indexOf(open, c); if (i >= 0) start = { r, c: i }; }
      }
      if (!start) return null;
      const end = this.matchAt(start);
      if (!end) return null;
      if (ia === 'a') return { a: start, b: { r: end.r, c: end.c + 1 } };
      if (end.r > start.r && start.c === this.len(start.r) - 1 && !/\S/.test(this.lines[end.r].slice(0, end.c))) {
        if (end.r - start.r < 2) return null;
        return { a: { r: start.r + 1, c: 0 }, b: { r: end.r - 1, c: 0 }, linewise: true };
      }
      let a = { r: start.r, c: start.c + 1 };
      if (a.c >= this.len(a.r) && a.r < end.r) a = { r: a.r + 1, c: 0 };
      return { a, b: end };
    }
    if (o === 'p') {
      const blank = x => this.len(x) === 0, kind = blank(r);
      let s = r, e = r;
      while (s > 0 && blank(s - 1) === kind) s--;
      while (e < this.last && blank(e + 1) === kind) e++;
      if (ia === 'a') {
        if (e < this.last) { e++; while (e < this.last && blank(e + 1) !== kind) e++; }
        else while (s > 0 && blank(s - 1) !== kind) s--;
      }
      return { a: { r: s, c: 0 }, b: { r: e, c: 0 }, linewise: true };
    }
    return null;
  }

  // --------------------------------------------------------------- operators
  applyMotionOp(op, t, m) {
    const s = this.cur;
    if (t.linewise) return this.opLines(op, Math.min(s.r, t.r), Math.max(s.r, t.r));
    let a = s, b = { r: t.r, c: t.c };
    if (cmp(b, a) < 0) [a, b] = [b, a];
    if (t.inclusive) b = { r: b.r, c: b.c + 1 };
    else if ((m === 'w' || m === 'W') && b.r > a.r) {
      let p = this.prevPos(b);
      while (p && cmp(p, a) > 0 && cls(this.ch(p), m === 'W') === 0) p = this.prevPos(p);
      b = { r: p.r, c: p.c + 1 };
    } else if (b.c === 0 && b.r > a.r) {
      b = { r: b.r - 1, c: this.len(b.r - 1) };
      if (a.c <= this.fnb(a.r) || !/\S/.test(this.lines[a.r].slice(0, a.c))) return this.opLines(op, a.r, b.r);
    }
    this.applyRange(op, { a, b });
  }

  applyRange(op, { a, b, linewise }) {
    if (linewise) return this.opLines(op, a.r, b.r);
    if (b.c > this.len(b.r)) b = b.r < this.last ? { r: b.r + 1, c: 0 } : { r: b.r, c: this.len(b.r) };
    const text = this.getText(a, b);
    if (op === 'y') { this.reg = { text, linewise: false }; this.row = a.r; this.col = a.c; this.clampCol(); return; }
    if (op === 'd' || op === 'c') {
      this.reg = { text, linewise: false };
      this.replaceRange(a, b, '');
      this.row = a.r; this.col = a.c;
      if (op === 'c') this.enterInsert('c', 1); else this.clampCol();
      return;
    }
    const fn = { gu: s => s.toLowerCase(), gU: s => s.toUpperCase(), 'g~': s => [...s].map(x => (x === x.toUpperCase() ? x.toLowerCase() : x.toUpperCase())).join('') }[op];
    this.replaceRange(a, b, fn(text));
    this.row = a.r; this.col = a.c; this.clampCol();
  }

  opLines(op, r1, r2) {
    const rows = this.lines.slice(r1, r2 + 1);
    if (op === 'y') { this.reg = { text: rows.join('\n'), linewise: true }; this.row = r1; this.clampCol(); this.msg(rows.length > 2 ? `${rows.length} lines yanked` : ''); return; }
    if (op === 'd') {
      this.reg = { text: rows.join('\n'), linewise: true };
      this.lines.splice(r1, rows.length);
      if (!this.lines.length) this.lines = [''];
      this.row = Math.min(r1, this.last); this.col = this.fnb(); this.want = this.col;
      if (rows.length > 2) this.msg(`${rows.length} fewer lines`);
      return;
    }
    if (op === 'c') {
      this.reg = { text: rows.join('\n'), linewise: true };
      this.lines.splice(r1, rows.length, '');
      this.row = r1; this.col = 0;
      this.enterInsert('c', 1);
      return;
    }
    const fn = { gu: s => s.toLowerCase(), gU: s => s.toUpperCase(), 'g~': s => [...s].map(x => (x === x.toUpperCase() ? x.toLowerCase() : x.toUpperCase())).join('') }[op];
    for (let r = r1; r <= r2; r++) this.lines[r] = fn(this.lines[r]);
    this.row = r1; this.clampCol();
  }

  getText(a, b) {
    if (a.r === b.r) return this.lines[a.r].slice(a.c, b.c);
    return [this.lines[a.r].slice(a.c), ...this.lines.slice(a.r + 1, b.r), this.lines[b.r].slice(0, b.c)].join('\n');
  }
  replaceRange(a, b, text) {
    const head = this.lines[a.r].slice(0, a.c), tail = this.lines[b.r].slice(b.c);
    const parts = (head + text + tail).split('\n');
    this.lines.splice(a.r, b.r - a.r + 1, ...parts);
  }
  joinLine(r) {
    const cur = this.lines[r].replace(/\s+$/, (m) => m), nxt = this.lines[r + 1].replace(/^\s+/, '');
    const sep = cur === '' || /\s$/.test(cur) || nxt === '' || nxt.startsWith(')') ? '' : ' ';
    this.lines.splice(r, 2, cur + sep + nxt);
    this.col = Math.max(0, cur.length - (sep ? 0 : 1)); this.want = this.col;
  }
  paste(after, n) {
    const { text, linewise } = this.reg;
    if (linewise) {
      const ls = [];
      for (let t = 0; t < n; t++) ls.push(...text.split('\n'));
      const at = after ? this.row + 1 : this.row;
      this.lines.splice(at, 0, ...ls);
      this.row = at; this.col = this.fnb(); this.want = this.col;
      return;
    }
    const t = text.repeat(n);
    const at = after && this.len() ? this.col + 1 : this.col;
    this.replaceRange({ r: this.row, c: at }, { r: this.row, c: at }, t);
    if (!t.includes('\n')) this.col = at + t.length - 1; else this.col = at;
    this.clampCol();
  }

  // --------------------------------------------------------------- insert mode
  enterInsert(kind, count) { this.mode = 'insert'; this.insert = { kind, count, keys: [] }; }
  insertKey(key) {
    const l = this.lines[this.row];
    if (key === 'Escape') {
      const ins = this.insert;
      if (ins && ins.count > 1) {
        for (let t = 1; t < ins.count; t++) {
          if (ins.kind === 'o' || ins.kind === 'O') { this.lines.splice(this.row + 1, 0, ''); this.row++; this.col = 0; }
          for (const k of ins.keys) this.typeKey(k);
        }
      }
      this.mode = 'normal'; this.insert = null;
      this.col = Math.max(0, this.col - 1); this.clampCol(); this.want = this.col;
      if (this.recording && !this.replaying) { this.lastChange = this.recording; }
      if (!this.replaying) this.recording = null;
      this.commit();
      return;
    }
    if (this.insert) this.insert.keys.push(key);
    this.typeKey(key, l);
  }
  typeKey(key) {
    const l = this.lines[this.row];
    switch (key) {
      case 'Enter': this.lines.splice(this.row, 1, l.slice(0, this.col), l.slice(this.col)); this.row++; this.col = 0; return;
      case 'Backspace':
        if (this.col > 0) { this.lines[this.row] = l.slice(0, this.col - 1) + l.slice(this.col); this.col--; }
        else if (this.row > 0) { const p = this.lines[this.row - 1]; this.lines.splice(this.row - 1, 2, p + l); this.row--; this.col = p.length; }
        return;
      case 'Delete':
        if (this.col < l.length) this.lines[this.row] = l.slice(0, this.col) + l.slice(this.col + 1);
        else if (this.row < this.last) this.lines.splice(this.row, 2, l + this.lines[this.row + 1]);
        return;
      case 'ArrowLeft': this.col = Math.max(0, this.col - 1); return;
      case 'ArrowRight': this.col = Math.min(l.length, this.col + 1); return;
      case 'ArrowUp': case 'ArrowDown': this.row = clamp(this.row + (key === 'ArrowUp' ? -1 : 1), 0, this.last); this.col = Math.min(this.col, this.len()); return;
      case 'Home': this.col = 0; return;
      case 'End': this.col = l.length; return;
      case '<C-w>': { let s = this.col; while (s > 0 && /\s/.test(l[s - 1])) s--; const k = cls(l[s - 1]); while (s > 0 && cls(l[s - 1]) === k && k) s--; this.lines[this.row] = l.slice(0, s) + l.slice(this.col); this.col = s; return; }
      case '<C-u>': this.lines[this.row] = l.slice(this.col); this.col = 0; return;
    }
    const ch = key === 'Tab' ? '\t' : key;
    if (ch.length !== 1) return;
    this.lines[this.row] = l.slice(0, this.col) + ch + l.slice(this.col);
    this.col++;
  }

  // --------------------------------------------------------------- visual mode
  vrange() {
    let a = this.anchor, b = this.cur;
    if (cmp(b, a) < 0) [a, b] = [b, a];
    if (this.mode === 'vline') return { a: { r: a.r, c: 0 }, b: { r: b.r, c: 0 }, linewise: true };
    return { a, b: { r: b.r, c: Math.min(b.c + 1, this.len(b.r) + 1) } };
  }
  parseVisual(keys) {
    const [c1, i] = this.count(keys, 0);
    const k = keys[i];
    if (k === undefined) return MORE;
    const exit = () => { this.mode = 'normal'; this.anchor = null; this.clampCol(); };
    if (k === 'Escape') { exit(); return OK; }
    if (k === 'v' || k === 'V') { const m = k === 'v' ? 'visual' : 'vline'; if (this.mode === m) exit(); else this.mode = m; return OK; }
    if (k === 'o') { const a = this.anchor; this.anchor = this.cur; this.row = a.r; this.col = a.c; return OK; }
    if (k === ':') {
      const { a, b } = this.vrange();
      this.vmarks = [a.r, b.r]; exit();
      this.mode = 'command'; this.cmd = { type: ':', text: "'<,'>", from: 'visual' };
      return OK;
    }
    const opMap = { d: 'd', x: 'd', X: 'D', D: 'D', y: 'y', Y: 'Y', c: 'c', s: 'c', C: 'C', S: 'C', R: 'C', u: 'gu', U: 'gU', '~': 'g~' };
    if (k === 'J') {
      const { a, b } = this.vrange(); exit(); this.begin();
      this.row = a.r;
      for (let t = 0; t < Math.max(1, b.r - a.r); t++) if (this.row < this.last) this.joinLine(this.row);
      this.commit(); return OK;
    }
    if (k === 'r') {
      const ch = keys[i + 1];
      if (ch === undefined) return MORE;
      if (ch.length !== 1) { exit(); return BAD; }
      const rng = this.vrange(); exit(); this.begin();
      const a = rng.linewise ? { r: rng.a.r, c: 0 } : rng.a, b = rng.linewise ? { r: rng.b.r, c: this.len(rng.b.r) } : rng.b;
      for (let r = a.r; r <= b.r; r++) {
        const l = this.lines[r], s = r === a.r ? a.c : 0, e = r === b.r ? Math.min(b.c, l.length) : l.length;
        this.lines[r] = l.slice(0, s) + ch.repeat(Math.max(0, e - s)) + l.slice(e);
      }
      this.row = a.r; this.col = a.c; this.clampCol(); this.commit(); return OK;
    }
    if (opMap[k] && k.length === 1) {
      let rng = this.vrange(), op = opMap[k];
      if (op === 'D' || op === 'Y' || op === 'C') { rng = { a: { r: rng.a.r, c: 0 }, b: { r: rng.b.r, c: 0 }, linewise: true }; op = op === 'D' ? 'd' : op === 'Y' ? 'y' : 'c'; }
      exit(); this.begin();
      this.applyRange(op, rng);
      if (this.mode !== 'insert') this.commit();
      return OK;
    }
    if ((k === 'i' || k === 'a') && this.mode === 'visual') {
      const o = keys[i + 1];
      if (o === undefined) return MORE;
      const rng = this.textObject(k, o);
      if (!rng) return BAD;
      if (rng.linewise) { this.mode = 'vline'; this.anchor = rng.a; this.row = rng.b.r; this.col = 0; return OK; }
      this.anchor = rng.a; const e = this.prevPos(rng.b) || rng.b; this.row = e.r; this.col = e.c;
      return OK;
    }
    const mo = this.parseMotion(keys, i);
    if (mo === MORE) return MORE;
    if (!mo) return BAD;
    const t = this.motion(mo.m, c1, mo.arg, null);
    if (!t) return BAD;
    this.moveTo(t, mo.m);
    return OK;
  }

  // --------------------------------------------------------------- command line
  cmdKey(key) {
    const c = this.cmd;
    if (key === 'Escape' || (key === 'Backspace' && c.text === '')) { this.mode = 'normal'; this.cmd = null; return; }
    if (key === 'Backspace') { c.text = c.text.slice(0, -1); return; }
    if (key === '<C-u>') { c.text = ''; return; }
    if (key === 'Enter') {
      this.mode = 'normal'; this.cmd = null;
      if (c.type === ':') this.ex(c.text);
      else {
        const pat = c.text || this.search?.pat;
        if (!pat) { this.msg('E35: No previous regular expression', true); return; }
        this.search = { pat, dir: c.type === '/' ? 1 : -1 };
        const q = this.doSearch(pat, this.search.dir, this.cur);
        if (q) { this.row = q.r; this.col = q.c; this.want = q.c; }
      }
      this.clampCol();
      return;
    }
    if (key === 'Tab') key = ' ';
    if (key.length === 1) c.text += key;
  }

  ex(line) {
    let s = line.trim().replace(/^:+/, '');
    let r1 = null, r2 = null;
    const addr = a => {
      const m = /^(\d+|\.|\$|'<|'>)([+-]\d+)?$/.exec(a);
      if (!m) return null;
      let v = m[1] === '.' ? this.row : m[1] === '$' ? this.last : m[1] === "'<" ? (this.vmarks?.[0] ?? this.row) : m[1] === "'>" ? (this.vmarks?.[1] ?? this.row) : Number(m[1]) - 1;
      if (m[2]) v += Number(m[2]);
      return clamp(v, 0, this.last);
    };
    if (s.startsWith('%')) { r1 = 0; r2 = this.last; s = s.slice(1); }
    else {
      const m = /^((?:\d+|\.|\$|'[<>])(?:[+-]\d+)?)(?:,((?:\d+|\.|\$|'[<>])(?:[+-]\d+)?))?/.exec(s);
      if (m) { r1 = addr(m[1]); r2 = m[2] ? addr(m[2]) : r1; s = s.slice(m[0].length); if (r1 > r2) [r1, r2] = [r2, r1]; }
    }
    s = s.trim();
    if (s === '') { if (r1 !== null) { this.row = r2; this.col = this.fnb(); this.want = this.col; } return; }
    const write = () => { this.disk = this.text; this.msg(`"${this.file}" ${this.lines.length}L, ${this.text.length + 1}B written`); };
    const cmdName = /^[a-z]+!?/i.exec(s)?.[0] || '';
    switch (cmdName) {
      case 'w': case 'w!': case 'write': write(); return;
      case 'q': case 'quit': case 'q!': case 'quit!': case 'qa': case 'qa!': case 'qall':
        if (this.modified && !cmdName.endsWith('!')) { this.msg('E37: No write since last change (add ! to override)', true); return; }
        this.quit = true; this.msg(''); return;
      case 'wq': case 'wq!': case 'x': case 'x!': case 'xit': case 'exit': case 'wqa':
        if (cmdName.startsWith('w') || this.modified) write();
        this.quit = true; return;
      case 'set': case 'se': {
        const opt = s.replace(/^se(t)?\s*/, '').trim();
        if (/^(nu|number)$/.test(opt)) this.number = true;
        else if (/^(nonu|nonumber)$/.test(opt)) this.number = false;
        else if (/^(nu|number)!$|^invnu(mber)?$/.test(opt)) this.number = !this.number;
        else if (opt) this.msg('E518: Unknown option: ' + opt, true);
        return;
      }
      case 'noh': case 'nohlsearch': return;
      case 'd': case 'delete': {
        const a = r1 ?? this.row, b = r2 ?? this.row;
        this.begin(); this.opLines('d', a, b); this.commit(); return;
      }
      case 'u': case 'undo': this.undo(false); return;
      case 'red': case 'redo': this.undo(true); return;
    }
    if (/^s[^a-z0-9\s]/i.test(s)) return this.substitute(s.slice(1), r1 ?? this.row, r2 ?? this.row);
    const g = /^([gv])(!?)([^a-z0-9\s])/.exec(s);
    if (g) {
      const [pat, cmdText = 'p'] = splitDelim(s.slice(g[0].length), g[3]);
      if (cmdText.trim() !== 'd') { this.msg('Only :g/pattern/d is supported here', true); return; }
      const re = vimRegex(pat || this.search?.pat || ''), inv = g[1] === 'v' || g[2] === '!';
      const a = r1 ?? 0, b = r2 ?? this.last;
      this.begin();
      const keep = this.lines.filter((l, r) => r < a || r > b || (re.lastIndex = 0, re.test(l)) === inv);
      const removed = this.lines.length - keep.length;
      if (!removed) { this.snap = null; this.msg('E486: Pattern not found: ' + pat, true); return; }
      this.lines = keep.length ? keep : [''];
      this.row = clamp(this.row, 0, this.last); this.col = this.fnb();
      this.commit(); this.msg(`${removed} fewer lines`);
      return;
    }
    this.msg(`E492: Not an editor command: ${s}`, true);
  }

  substitute(body, r1, r2) {
    const d = body[0];
    const [, pat = '', rep = '', flags = ''] = splitDelim(body, d);
    const p = pat || this.search?.pat;
    if (!p) { this.msg('E35: No previous regular expression', true); return; }
    this.search = { pat: p, dir: 1 };
    const global = flags.includes('g');
    const make = () => { const re = vimRegex(p, flags.includes('i') ? 'i' : ''); return global ? re : new RegExp(re.source, re.flags.replace('g', '')); };
    const replacement = vimReplacement(rep);
    this.begin();
    let lines = 0, subs = 0, lastRow = null;
    for (let r = r1; r <= r2; r++) {
      const re = make(), l = this.lines[r];
      const hits = (l.match(vimRegex(p, flags.includes('i') ? 'i' : '')) || []).length;
      if (!hits) continue;
      this.lines[r] = l.replace(re, replacement);
      lines++; subs += global ? hits : 1; lastRow = r;
    }
    if (!lines) { this.snap = null; this.msg('E486: Pattern not found: ' + p, true); return; }
    // a replacement may contain \r for a line break
    this.lines = this.lines.flatMap(l => l.split('\r'));
    this.row = clamp(lastRow, 0, this.last); this.col = this.fnb(); this.want = this.col;
    this.commit();
    if (lines > 1 || subs > 1) this.msg(`${subs} substitution${subs > 1 ? 's' : ''} on ${lines} line${lines > 1 ? 's' : ''}`);
  }
}

// ===================================================================== nano

export class Nano {
  constructor(text = '', { row = 0, col = 0, disk, file = 'file.txt' } = {}) {
    this.lines = String(text).split('\n');
    this.row = clamp(row, 0, this.lines.length - 1); this.col = clamp(col, 0, this.lines[this.row].length);
    this.disk = disk ?? this.text; this.file = file;
    this.cut = []; this.last = null; this.undoStack = []; this.redoStack = [];
    this.prompt = null; this.message = ''; this.exited = false;
    this.keys = 0; this.log = []; this.esc = 0; this.searchPat = ''; this.replace = null;
  }
  get text() { return this.lines.join('\n'); }
  get modified() { return this.text !== this.disk; }
  get line() { return this.lines[this.row]; }
  snapshot(kind) {
    if (kind && kind === this.last) return;
    this.undoStack.push({ lines: [...this.lines], row: this.row, col: this.col }); this.redoStack = [];
  }

  /** Translate the Esc-prefix forms and function keys real nano accepts. */
  translate(key) {
    const fkeys = { F1: '<C-g>', F2: '<C-x>', F3: '<C-o>', F6: '<C-w>', F9: '<C-k>', F10: '<C-u>', F11: '<C-c>', F13: '<C-_>', F14: '<C-\\>' };
    if (fkeys[key]) return fkeys[key];
    if (key === 'Escape') { this.esc = Math.min(2, this.esc + 1); return null; }
    if (this.esc && key.length === 1) { const n = this.esc; key = n === 2 ? `<C-${key.toLowerCase()}>` : `<M-${key.toLowerCase()}>`; }
    this.esc = 0;
    if (key === '<M-r>') return '<C-\\>';
    if (key === '<M-g>') return '<C-_>';
    return key;
  }

  feed(raw) {
    if (this.exited) return;
    this.keys++;
    const key = this.translate(raw);
    if (key === null) return;
    this.log.push(key);
    if (this.prompt) return this.promptKey(key);
    this.message = '';
    this.editKey(key);
  }
  feedAll(keys) { for (const k of (typeof keys === 'string' ? tokenize(keys) : keys)) this.feed(k); return this; }

  editKey(key) {
    const l = this.line;
    const act = kind => { this.last = kind; };
    switch (key) {
      case 'ArrowLeft': if (this.col > 0) this.col--; else if (this.row > 0) { this.row--; this.col = this.line.length; } return act('move');
      case 'ArrowRight': if (this.col < l.length) this.col++; else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; } return act('move');
      case 'ArrowUp': case 'ArrowDown': this.row = clamp(this.row + (key === 'ArrowUp' ? -1 : 1), 0, this.lines.length - 1); this.col = Math.min(this.col, this.line.length); return act('move');
      case 'Home': case '<C-a>': this.col = 0; return act('move');
      case 'End': case '<C-e>': this.col = l.length; return act('move');
      case 'Enter': this.snapshot(); this.lines.splice(this.row, 1, l.slice(0, this.col), l.slice(this.col)); this.row++; this.col = 0; return act('enter');
      case 'Backspace':
        this.snapshot('bs');
        if (this.col > 0) { this.lines[this.row] = l.slice(0, this.col - 1) + l.slice(this.col); this.col--; }
        else if (this.row > 0) { const p = this.lines[this.row - 1]; this.lines.splice(this.row - 1, 2, p + l); this.row--; this.col = p.length; }
        return act('bs');
      case 'Delete':
        this.snapshot('del');
        if (this.col < l.length) this.lines[this.row] = l.slice(0, this.col) + l.slice(this.col + 1);
        else if (this.row < this.lines.length - 1) this.lines.splice(this.row, 2, l + this.lines[this.row + 1]);
        return act('del');
      case '<C-k>':
        this.snapshot('cut');
        if (this.last === 'cut') this.cut.push(l); else this.cut = [l];
        if (this.lines.length > 1) this.lines.splice(this.row, 1); else this.lines = [''];
        this.row = Math.min(this.row, this.lines.length - 1); this.col = 0;
        return act('cut');
      case '<C-u>':
        if (!this.cut.length) { this.message = '[ Cutbuffer is empty ]'; return act('paste'); }
        this.snapshot();
        this.lines.splice(this.row, 0, ...this.cut); this.row += this.cut.length; this.col = 0;
        return act('paste');
      case '<C-o>': this.prompt = { kind: 'write', label: 'File Name to Write: ', text: this.file }; return act('o');
      case '<C-x>':
        if (!this.modified) { this.exited = true; return; }
        this.prompt = { kind: 'save?', label: 'Save modified buffer?  (Answering "No" will DISCARD changes.)', yesno: 'Y Yes   N No   ^C Cancel' }; return act('x');
      case '<C-w>': this.prompt = { kind: 'search', label: `Search${this.searchPat ? ` [${this.searchPat}]` : ''}: `, text: '' }; return act('w');
      case '<M-w>': this.findNext(this.searchPat); return act('w');
      case '<C-\\>': this.prompt = { kind: 'replace1', label: `Search (to replace)${this.searchPat ? ` [${this.searchPat}]` : ''}: `, text: '' }; return act('r');
      case '<C-_>': this.prompt = { kind: 'goto', label: 'Enter line number, column number: ', text: '' }; return act('g');
      case '<C-c>': this.message = `[ line ${this.row + 1}/${this.lines.length} (${Math.round(((this.row + 1) / this.lines.length) * 100)}%), col ${this.col + 1}/${l.length + 1} ]`; return act('c');
      case '<C-g>': this.message = '[ Help: ^ means Ctrl, M- means Alt (or press Esc first). Esc Esc + key also works as Ctrl+key. ]'; return act('g');
      case '<M-u>': case '<M-e>': {
        const [from, to] = key === '<M-u>' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
        if (!from.length) { this.message = key === '<M-u>' ? '[ Nothing to undo ]' : '[ Nothing to redo ]'; return act('u'); }
        to.push({ lines: [...this.lines], row: this.row, col: this.col });
        const s = from.pop(); this.lines = s.lines; this.row = s.row; this.col = s.col;
        this.message = key === '<M-u>' ? '[ Undid action ]' : '[ Redid action ]';
        return act('u');
      }
    }
    if (key === 'Tab') key = '\t';
    if (key.length !== 1) return;
    this.snapshot('type');
    this.lines[this.row] = l.slice(0, this.col) + key + l.slice(this.col);
    this.col++;
    act('type');
  }

  promptKey(key) {
    const p = this.prompt;
    if (key === '<C-c>') {
      this.prompt = null; this.replace = null; this.message = '[ Cancelled ]'; return;
    }
    if (p.yesno) {
      const k = key.toLowerCase();
      if (p.kind === 'save?') {
        if (k === 'y') this.prompt = { kind: 'write', label: 'File Name to Write: ', text: this.file, thenExit: true };
        else if (k === 'n') { this.prompt = null; this.exited = true; }
        return;
      }
      if (p.kind === 'replace?') {
        if (k === 'y' || k === 'a') { this.replaceHere(); if (k === 'a') { while (this.nextMatch()) this.replaceHere(); return this.endReplace(); } }
        else if (k !== 'n') return;
        else this.col += this.replace.pat.length;
        if (!this.nextMatch()) this.endReplace();
        return;
      }
      return;
    }
    if (key === 'Backspace') { p.text = p.text.slice(0, -1); return; }
    if (key !== 'Enter') { if (key.length === 1) p.text += key; return; }
    this.prompt = null;
    if (p.kind === 'write') {
      if (!p.text) { this.message = '[ Cancelled ]'; return; }
      this.file = p.text; this.disk = this.text;
      this.message = `[ Wrote ${this.lines.length} line${this.lines.length === 1 ? '' : 's'} ]`;
      if (p.thenExit) this.exited = true;
    } else if (p.kind === 'search') {
      const pat = p.text || this.searchPat;
      if (!pat) { this.message = '[ Cancelled ]'; return; }
      this.searchPat = pat; this.findNext(pat);
    } else if (p.kind === 'replace1') {
      const pat = p.text || this.searchPat;
      if (!pat) { this.message = '[ Cancelled ]'; return; }
      this.searchPat = pat;
      this.prompt = { kind: 'replace2', label: 'Replace with: ', text: '', pat };
    } else if (p.kind === 'replace2') {
      this.replace = { pat: p.pat, rep: p.text, count: 0 };
      this.snapshot();
      if (this.nextMatch()) this.prompt = { kind: 'replace?', label: 'Replace this instance?', yesno: 'Y Yes   N No   A All   ^C Cancel' };
      else { this.message = `[ "${p.pat}" not found ]`; this.replace = null; }
    } else if (p.kind === 'goto') {
      const [ln, cl] = p.text.split(/[,\s]+/).map(Number);
      if (!ln) { this.message = '[ Invalid line or column number ]'; return; }
      this.row = clamp(ln - 1, 0, this.lines.length - 1); this.col = clamp((cl || 1) - 1, 0, this.line.length);
    }
    this.last = null;
  }
  /** Case-insensitive literal search forward from just after the cursor, wrapping. */
  findNext(pat) {
    if (!pat) { this.message = '[ No current search pattern ]'; return; }
    const N = this.lines.length, lp = pat.toLowerCase();
    for (let s = 0; s <= N; s++) {
      const r = (this.row + s) % N, l = this.lines[r].toLowerCase();
      const from = s === 0 ? this.col + 1 : 0;
      const i = l.indexOf(lp, from);
      if (i >= 0 && !(s === N && i > this.col)) {
        if (s > 0 && r <= this.row) this.message = '[ Search Wrapped ]';
        this.row = r; this.col = i; return true;
      }
    }
    this.message = `[ "${pat}" not found ]`;
    return false;
  }
  /** Next match at or after the cursor, no wrapping (replace walks top to bottom). */
  nextMatch() {
    const lp = this.replace.pat.toLowerCase();
    for (let r = this.row; r < this.lines.length; r++) {
      const i = this.lines[r].toLowerCase().indexOf(lp, r === this.row ? this.col : 0);
      if (i >= 0) { this.row = r; this.col = i; this.prompt = { kind: 'replace?', label: 'Replace this instance?', yesno: 'Y Yes   N No   A All   ^C Cancel' }; return true; }
    }
    return false;
  }
  replaceHere() {
    const { pat, rep } = this.replace, l = this.line;
    this.lines[this.row] = l.slice(0, this.col) + rep + l.slice(this.col + pat.length);
    this.col += rep.length; this.replace.count++;
  }
  endReplace() {
    const n = this.replace.count;
    this.prompt = null; this.replace = null;
    this.message = `[ Replaced ${n} occurrence${n === 1 ? '' : 's'} ]`;
  }
}

/** Has the editor reached the level's goal? */
export function checkLevel(ed, L) {
  const isNano = ed instanceof Nano;
  const closed = isNano ? ed.exited : ed.quit;
  if (L.target !== undefined && ed.text !== L.target) return false;
  if (L.saved && ed.disk !== ed.text) return false;
  if (L.keepDisk !== undefined && ed.disk !== L.keepDisk) return false;
  if (L.quit ? !closed : closed) return false;
  if (!L.quit && !isNano && ed.mode !== 'normal') return false;
  if (!L.quit && isNano && ed.prompt) return false;
  if (L.mustUse && !L.mustUse.every(k => ed.log.includes(k))) return false;
  if (L.cursorTarget && (ed.row !== L.cursorTarget[0] || ed.col !== L.cursorTarget[1])) return false;
  return true;
}

export const starsForKeys = (keys, par) => (keys <= par ? 3 : keys <= Math.ceil(par * 1.5) + 1 ? 2 : 1);
