// Vim & nano trainer: a real modal-editor emulator (vim-core.js) rendered as a big editor,
// with keystroke-golf challenges, free practice, a cheat sheet, and a nano tab.
import { h } from './util.js';
import * as game from './game.js';
import { Vim, Nano, checkLevel, starsForKeys, tokenize, keyLabel } from './vim-core.js';
import { VIM_LEVELS, NANO_LEVELS, VIM_SAMPLE } from './vim-levels.js';

/** `code` spans in level text. */
const rich = s => String(s).split('`').map((part, i) => (i % 2 ? h('code', part) : part));
/** replaceChildren, skipping null/false like h() does. */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const starRow = n => h('span.stars', [0, 1, 2].map(i => h(`span.star${i < n ? '.on' : ''}`, '★')));

const CHEAT = [
  ['Modes', [['i a', 'insert before / after cursor'], ['I A', 'insert at line start / end'], ['o O', 'open line below / above'], ['Esc', 'back to Normal'], ['v V', 'visual / visual line'], [':', 'command line']]],
  ['Move', [['h j k l', '← ↓ ↑ →'], ['w b e', 'next word / back / end'], ['W B E', 'same, WORDs (by spaces)'], ['0 ^ $', 'line start / first char / end'], ['gg G', 'first / last line'], ['7G  :7', 'go to line 7'], ['} {', 'next / previous blank line'], ['%', 'matching bracket']]],
  ['Find on the line', [['f x', 'jump onto next x'], ['t x', 'jump to just before x'], ['F T', 'same, backwards'], ['; ,', 'repeat / reverse last f t']]],
  ['Edit', [['x X', 'delete char / char before'], ['r x', 'replace char with x'], ['J', 'join lines'], ['~', 'toggle case'], ['p P', 'paste after / before'], ['D C', 'delete / change to end of line'], ['dd cc yy', 'delete / change / yank line']]],
  ['Operator + motion', [['d c y', 'delete, change, yank…'], ['dw d$ d}', '…up to a motion'], ['3dd d3w', 'counts multiply'], ['cw', 'change to end of word'], ['gu gU', 'lower / upper case']]],
  ['Text objects', [['iw aw', 'inner / a word'], ['i" a"', 'inside / around quotes'], ['i( a(', 'inside / around parens'], ['i{ i[', 'braces, brackets'], ['ip ap', 'paragraph'], ['ciw di( ya"', 'combine with an operator']]],
  ['Undo, repeat, search', [['u', 'undo'], ['Ctrl+R', 'redo'], ['.', 'repeat last change'], ['/text ?text', 'search forward / back'], ['n N', 'next / previous match'], ['* #', 'word under cursor']]],
  ['Command line', [[':w', 'write (save)'], [':q  :q!', 'quit / quit discarding'], [':wq  :x  ZZ', 'save and quit'], [':s/a/b/', 'replace on this line'], [':%s/a/b/g', 'replace everywhere'], [':g/re/d', 'delete matching lines'], [':set nonu', 'hide line numbers']]],
];

const NANO_BAR = [
  [['^G', 'Help', '<C-g>'], ['^O', 'Write Out', '<C-o>'], ['^W', 'Where Is', '<C-w>'], ['^K', 'Cut', '<C-k>'], ['^C', 'Location', '<C-c>'], ['M-U', 'Undo', '<M-u>']],
  [['^X', 'Exit', '<C-x>'], ['^\\', 'Replace', '<C-\\>'], ['^U', 'Paste', '<C-u>'], ['^_', 'Go To Line', '<C-_>'], ['M-W', 'Next', '<M-w>'], ['M-E', 'Redo', '<M-e>']],
];

// ------------------------------------------------------------------ key translation

const NAMED = new Set(['Escape', 'Enter', 'Backspace', 'Tab', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
function vimToken(e) {
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.altKey) {
    if (e.key === '[') return 'Escape';
    if (e.key === 'r' || e.key === 'R') return '<C-r>';
    if (e.key === 'w' || e.key === 'u') return `<C-${e.key}>`;
    return null;
  }
  if (NAMED.has(e.key)) return e.key;
  return e.key.length === 1 && !e.altKey ? e.key : null;
}
function nanoToken(e) {
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.altKey) {
    if (e.key === '\\' || e.code === 'Backslash') return '<C-\\>';
    if (e.key === '_' || e.key === '-') return '<C-_>';
    if (/^[a-z]$/i.test(e.key)) return `<C-${e.key.toLowerCase()}>`;
    return null;
  }
  if (e.altKey && !e.ctrlKey) { const k = e.code?.startsWith('Key') ? e.code.slice(3) : e.key; return /^[a-z]$/i.test(k) ? `<M-${k.toLowerCase()}>` : null; }
  if (NAMED.has(e.key) || /^F\d{1,2}$/.test(e.key)) return e.key;
  return e.key.length === 1 ? e.key : null;
}

// ------------------------------------------------------------------ rendering

/** Render buffer lines with an optional cursor, selection and diff marks. */
function renderLines(lines, { cursor, sel, number = true, diff, empty = false } = {}) {
  return lines.map((line, r) => {
    const range = sel?.(r, line.length);
    const curC = cursor && cursor.r === r ? cursor.c : -1;
    const width = Math.max(line.length, curC + 1, range ? Math.min(range[1], line.length + 1) : 0);
    const segs = [];
    for (let i = 0; i < width; i++) {
      const k = (i === curC ? (cursor.shape === 'bar' ? 'b' : 'c') : '') + (range && i >= range[0] && i < range[1] ? 's' : '');
      const ch = line[i] ?? ' ';
      const last = segs[segs.length - 1];
      if (last && last.k === k && !k.includes('c') && !k.includes('b')) last.t += ch; else segs.push({ k, t: ch });
    }
    const kids = segs.map(({ k, t }) => (k ? h(`span${k.includes('c') ? '.vm-cur' : ''}${k.includes('b') ? '.vm-bar' : ''}${k.includes('s') ? '.vm-sel' : ''}`, t) : t));
    const differs = diff && diff[r] !== line;
    return h(`div.vm-line${differs ? '.vm-differs' : ''}`,
      number && h('span.vm-num', differs ? '≠' : String(r + 1)),
      h('span.vm-text', kids.length ? kids : empty ? '' : '​'));
  });
}

function vimView(v, { onKey }) {
  const body = h('div.vm-body');
  const status = h('div.vm-status');
  const cmd = h('div.vm-cmd');
  const screen = h('div.vm-screen', { tabindex: 0, 'aria-label': 'Vim editor. Click here and type.' }, body, status, cmd,
    h('div.vm-focus-hint', 'Click here to type'));
  screen.addEventListener('keydown', e => {
    const k = vimToken(e);
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    onKey(k);
  });
  screen.addEventListener('mousedown', () => setTimeout(() => screen.focus({ preventScroll: true })));
  function paint(v) {
    const vis = v.mode === 'visual' || v.mode === 'vline';
    let sel = null;
    if (vis) {
      const { a, b } = v.vrange();
      sel = (r, len) => (r < a.r || r > b.r ? null : v.mode === 'vline' ? [0, len + 1] : [r === a.r ? a.c : 0, r === b.r ? b.c : len + 1]);
    }
    const lines = renderLines(v.lines, { cursor: v.quit ? null : { r: v.row, c: v.col, shape: v.mode === 'insert' ? 'bar' : 'block' }, sel, number: v.number });
    const tildes = Array.from({ length: Math.max(0, 6 - v.lines.length) }, () => h('div.vm-line.vm-tilde', v.number && h('span.vm-num', ''), h('span.vm-text', '~')));
    fill(body, ...lines, ...tildes);
    if (v.quit) body.append(h('div.vm-quit', h('b', 'Vim has exited.'), ' You are back at the shell prompt.'));
    const modeName = { normal: 'NORMAL', insert: 'INSERT', visual: 'VISUAL', vline: 'V-LINE', command: 'COMMAND' }[v.mode];
    fill(status, 
      h(`span.vm-mode.vm-mode-${v.mode}`, modeName),
      h('span.vm-file', v.file, v.modified ? ' [+]' : ''),
      h('span.spacer'),
      v.pending.length ? h('span.vm-pending', v.pending.map(keyLabel).join('')) : null,
      h('span.vm-pos', `${v.row + 1}:${v.col + 1}`),
      h('span.vm-count', `${v.keys} keys`));
    if (v.mode === 'command') fill(cmd, h('span', v.cmd.type + v.cmd.text), h('span.vm-cmd-caret', ' '));
    else if (v.mode === 'insert' && !v.message) fill(cmd, h('span.vm-insert-msg', '-- INSERT --'));
    else if (vis && !v.message) fill(cmd, h('span.vm-insert-msg', v.mode === 'vline' ? '-- VISUAL LINE --' : '-- VISUAL --'));
    else fill(cmd, h(`span${v.error ? '.vm-err' : ''}`, v.message || ' '));
  }
  return { el: screen, paint };
}

function nanoView({ onKey }) {
  const title = h('div.nn-title');
  const body = h('div.vm-body.nn-body');
  const msg = h('div.nn-msg');
  const bar = h('div.nn-bar', NANO_BAR.map(row => h('div.nn-row', row.map(([k, label, tok]) =>
    h('button.nn-key', { type: 'button', tabindex: -1, onmousedown: e => e.preventDefault(), onclick: () => onKey(tok) }, h('span.nn-k', k), ' ', label)))));
  const screen = h('div.vm-screen.nn-screen', { tabindex: 0, 'aria-label': 'nano editor. Click here and type.' }, title, body, msg, bar,
    h('div.vm-focus-hint', 'Click here to type'));
  screen.addEventListener('keydown', e => {
    const k = nanoToken(e);
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    onKey(k);
  });
  screen.addEventListener('mousedown', () => setTimeout(() => screen.focus({ preventScroll: true })));
  function paint(n) {
    fill(title, h('span', '  GNU nano 7.2'), h('span.nn-name', n.file), h('span', n.modified ? 'Modified  ' : ' '));
    fill(body, ...renderLines(n.lines, { cursor: n.exited || n.prompt ? null : { r: n.row, c: n.col }, number: false }));
    if (n.exited) body.append(h('div.vm-quit', h('b', 'nano has exited.'), ' You are back at the shell prompt.'));
    if (n.prompt) {
      msg.className = 'nn-msg nn-prompt';
      fill(msg, h('span', n.prompt.label + (n.prompt.yesno ? '' : n.prompt.text)), !n.prompt.yesno && h('span.vm-cur', ' '),
        n.prompt.yesno && h('span.nn-yesno', n.prompt.yesno));
    } else {
      msg.className = 'nn-msg';
      fill(msg, n.message ? h('span.nn-note', n.message) : ' ');
    }
  }
  return { el: screen, paint };
}

function keyTrail(log) {
  const shown = log.slice(-40);
  return h('div.vm-trail', shown.length ? shown.map(k => h('kbd', keyLabel(k))) : h('span.muted.small', 'Your keystrokes appear here.'));
}

// ------------------------------------------------------------------ the lab

export function vimLab(container, notify = () => {}) {
  const S = game.state.labs.vim ||= {};
  S.solved ||= {}; S.tab ||= 'vim'; S.at ??= 0; S.nanoAt ??= 0; S.cheat ??= true;
  // A lesson's lab step (labsteps.js) asks for one challenge: open on it, then forget the request.
  if (S.challenge) {
    const v = VIM_LEVELS.findIndex(l => l.id === S.challenge), n = NANO_LEVELS.findIndex(l => l.id === S.challenge);
    if (v >= 0) { S.tab = 'vim'; S.at = v; } else if (n >= 0) { S.tab = 'nano'; S.nanoAt = n; }
    delete S.challenge;
  }

  const tabs = h('div.vm-tabs');
  const progress = h('div.vm-progress');
  const stage = h('div.vm-stage');
  const cheatBtn = h('button.btn.ghost.small', { type: 'button', onclick: () => { S.cheat = !S.cheat; game.save(); paintCheat(); } });
  const cheat = h('div.vm-cheat');

  function paintTabs() {
    fill(tabs, ...[['vim', 'Vim challenges'], ['free', 'Vim free practice'], ['nano', 'nano']].map(([id, label]) =>
      h(`button.tab${S.tab === id ? '.active' : ''}`, { type: 'button', onclick: () => { S.tab = id; game.save(); show(); } }, label)));
    const done = VIM_LEVELS.filter(l => S.solved[l.id]).length, nDone = NANO_LEVELS.filter(l => S.solved[l.id]).length;
    const stars = [...VIM_LEVELS, ...NANO_LEVELS].reduce((t, l) => t + (S.solved[l.id]?.stars || 0), 0);
    fill(progress, h('span', h('b', `${done}/${VIM_LEVELS.length}`), ' Vim'), h('span', h('b', `${nDone}/${NANO_LEVELS.length}`), ' nano'),
      h('span', h('b', stars), ' ★'), cheatBtn);
  }
  function paintCheat() {
    cheatBtn.textContent = S.cheat ? 'Hide cheat sheet' : 'Show cheat sheet';
    cheat.hidden = !S.cheat || S.tab === 'nano';
    fill(cheat, h('h3', 'Vim cheat sheet'), h('div.vm-cheat-grid', CHEAT.map(([group, rows]) =>
      h('div.vm-cheat-group', h('div.eyebrow', group), rows.map(([k, d]) => h('div.vm-cheat-row', h('span.vm-cheat-k', k), h('span.muted', d)))))));
  }

  function show() {
    paintTabs(); paintCheat();
    if (S.tab === 'nano') challenges(true);
    else if (S.tab === 'free') freePractice();
    else challenges(false);
  }

  function freePractice() {
    let v = new Vim(VIM_SAMPLE, { file: 'nginx.conf' });
    const trail = h('div');
    const view = vimView(v, { onKey: k => { v.feed(k); paint(); } });
    const paint = () => { view.paint(v); fill(trail, keyTrail(v.log)); };
    fill(stage, h('div.vm-free',
      h('div.vm-main', view.el, trail),
      h('div.vm-side', h('div.vm-card',
        h('h3', 'Free practice'),
        h('p.muted', 'A scratch file to try anything from the cheat sheet. Nothing is graded and nothing is saved to your real disk.'),
        h('p', 'Ideas: fix ', h('code', 'teh'), ' with ', h('code', 'xp'), ', change the port with ', h('code', 'f8ciw'), ', empty the function with ', h('code', 'di{'), ', or rename ', h('code', 'message'), ' with ', h('code', ':%s/message/msg/g'), '.'),
        h('div.vm-actions', h('button.btn.ghost', { type: 'button', onclick: () => { v = new Vim(VIM_SAMPLE, { file: 'nginx.conf' }); paint(); view.el.focus(); } }, 'Reset the file'))))));
    paint();
    view.el.focus({ preventScroll: true });
  }

  function challenges(isNano) {
    const levels = isNano ? NANO_LEVELS : VIM_LEVELS;
    const atKey = isNano ? 'nanoAt' : 'at';
    let L, ed, solvedNow = false, hintShown = false;
    const list = h('div.vm-levels');
    const side = h('div.vm-side');
    const trail = h('div');
    const view = isNano ? nanoView({ onKey }) : vimView(null, { onKey });

    function onKey(k) {
      if (solvedNow) return;
      ed.feed(k);
      if (checkLevel(ed, L)) win();
      paint();
    }

    function load(i) {
      S[atKey] = i; game.save();
      L = levels[i]; solvedNow = false; hintShown = false;
      const opts = { row: L.cursor?.[0] ?? 0, col: L.cursor?.[1] ?? 0, disk: L.disk, pre: L.pre, file: L.file || (isNano ? 'config' : 'file.txt') };
      ed = isNano ? new Nano(L.start, opts) : new Vim(L.start, opts);
      paintList(); paint();
      view.el.focus({ preventScroll: true });
    }

    function win() {
      solvedNow = true;
      const stars = starsForKeys(ed.keys, L.par);
      const prev = S.solved[L.id];
      const first = !prev;
      S.solved[L.id] = { stars: Math.max(stars, prev?.stars || 0), keys: Math.min(ed.keys, prev?.keys ?? Infinity) };
      let xp = 0;
      if (first) { xp = 5 + stars * 5; game.addXp(xp); notify(xp, L.title); }
      game.save();
      game.sound?.(stars === 3 ? 'done' : 'right');
      L._result = { stars, keys: ed.keys, xp, first, improved: prev && stars > prev.stars };
      paintTabs(); paintList();
    }

    function paintList() {
      const groups = [];
      levels.forEach((l, i) => {
        const g = l.group || 'nano';
        if (!groups.length || groups[groups.length - 1].g !== g) groups.push({ g, items: [] });
        groups[groups.length - 1].items.push([l, i]);
      });
      fill(list, ...groups.map(({ g, items }) => h('div.vm-level-group',
        !isNano && h('div.eyebrow', g),
        items.map(([l, i]) => h(`button.vm-level${l === L ? '.active' : ''}${S.solved[l.id] ? '.done' : ''}`, { type: 'button', onclick: () => load(i) },
          h('span.vm-level-n', i + 1), h('span.vm-level-t', l.title), S.solved[l.id] ? starRow(S.solved[l.id].stars) : h('span.stars.ghost', '☆☆☆'))))));
    }

    function goals() {
      const items = [];
      if (L.target !== undefined) items.push([ed.text === L.target, 'Buffer matches the target']);
      if (L.saved) items.push([ed.disk === ed.text && (L.target === undefined || ed.disk === L.target), 'Written to disk']);
      if (L.keepDisk !== undefined) items.push([ed.disk === L.keepDisk, 'File on disk left untouched']);
      if (L.mustUse) items.push([L.mustUse.every(k => ed.log.includes(k)), `Used ${L.mustUse.map(keyLabel).join(' and ')}`]);
      if (L.quit) items.push([isNano ? ed.exited : ed.quit, isNano ? 'nano exited' : 'Vim exited']);
      else if (!isNano) items.push([ed.mode === 'normal' && !ed.quit, 'Back in Normal mode (and still in Vim)']);
      return h('ul.vm-goals', items.map(([ok, label]) => h(`li${ok ? '.ok' : ''}`, h('span.vm-tick', ok ? '✓' : '○'), label)));
    }

    function paint() {
      view.paint(ed);
      fill(trail, keyTrail(ed.log));
      const r = solvedNow && L._result;
      const targetLines = L.target !== undefined ? L.target.split('\n') : null;
      const diffCount = targetLines ? Math.max(targetLines.length, ed.lines.length) - targetLines.filter((t, i) => ed.lines[i] === t).length : 0;
      const i = levels.indexOf(L);
      fill(side, 
        h('div.vm-card',
          h('div.eyebrow', `${isNano ? 'nano' : L.group} · level ${i + 1} of ${levels.length}`),
          h('h3', L.title),
          h('p.vm-task', rich(L.text)),
          hintShown ? h('p.vm-hint', rich(L.hint)) : h('button.btn.ghost.small', { type: 'button', onclick: () => { hintShown = true; paint(); view.el.focus(); } }, 'Show a hint'),
          h('div.vm-par', h('span', 'Par ', h('b', L.par), ' keys'), h('span', 'You: ', h('b', ed.keys)),
            S.solved[L.id] && h('span.muted', 'Best ', S.solved[L.id].keys))),
        r ? h('div.vm-card.vm-win',
          h('div.vm-win-stars', starRow(r.stars)),
          h('p', h('b', 'Solved'), ` in ${r.keys} keystroke${r.keys === 1 ? '' : 's'} (par ${L.par}).`, r.first ? ` +${r.xp} XP` : r.improved ? ' New best.' : ''),
          r.stars < 3 && h('p.muted.small', `Three stars at ${L.par} keys or fewer.`),
          h('p.small', 'One way: ', h('span.vm-solution', tokenize(L.solution).map(k => h('kbd', keyLabel(k))))),
          h('div.vm-actions',
            i + 1 < levels.length && h('button.btn.primary', { type: 'button', onclick: () => load(i + 1) }, 'Next level →'),
            h('button.btn.ghost', { type: 'button', onclick: () => load(i) }, 'Try again'))) : null,
        h('div.vm-card',
          h('div.vm-target-head', h('span.eyebrow', 'Goal'),
            targetLines && h(`span.vm-match${diffCount ? '' : '.ok'}`, diffCount ? `${diffCount} line${diffCount === 1 ? '' : 's'} differ` : 'Matches target')),
          targetLines && h('div.vm-target', renderLines(targetLines, { diff: ed.lines, empty: true })),
          goals(),
          !r && h('div.vm-actions', h('button.btn.ghost.small', { type: 'button', onclick: () => load(i) }, 'Restart level'))),
        isNano && h('div.vm-card.vm-note',
          h('b', 'Browser shortcuts get in the way. '),
          'Ctrl+W closes the tab and Ctrl+N/Ctrl+T open windows before this page ever sees them. Real nano gives you other ways in, and they all work here: ',
          h('ul',
            h('li', h('kbd', 'Esc'), h('kbd', 'Esc'), h('kbd', 'W'), ' = ', h('code', '^W'), ' (two Escapes, then a key, acts as Ctrl+key)'),
            h('li', h('kbd', 'Esc'), h('kbd', 'U'), ' = ', h('code', 'M-U'), ' (one Escape, then a key, acts as Alt+key)'),
            h('li', h('kbd', 'F6'), ' Where Is, ', h('kbd', 'F3'), ' Write Out, ', h('kbd', 'F2'), ' Exit, ', h('kbd', 'Esc'), h('kbd', 'R'), ' Replace'),
            h('li', 'Or click a shortcut in the bar.'))));
    }

    fill(stage, h(`div.vm-play${isNano ? '.vm-nano' : ''}`, list, h('div.vm-main', view.el, trail), side));
    load(Math.min(S[atKey] || 0, levels.length - 1));
  }

  fill(container, h('div.vm-lab', h('div.vm-top', tabs, progress), stage, cheat));
  show();
}
