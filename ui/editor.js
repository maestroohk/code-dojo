// A small code editor: a transparent <textarea> over a syntax-highlighted <pre>.
// No dependencies, works offline. Tab indents, Enter keeps indentation, Ctrl+Enter runs.
// ui/assist.js adds completion, auto-closing and comment toggling (switchable: autocompleteOn()).
import { h, highlight, api } from './util.js';
import { attachAssist } from './assist.js';

/** The learner's choice, shared by every editor. */
export const autocompleteOn = () => localStorage.getItem('dojo-autocomplete') !== 'off';
export const setAutocomplete = on => localStorage.setItem('dojo-autocomplete', on ? 'on' : 'off');

/**
 * @param files     () => [{ path, code }] every file of the project (default: just this one, as Program.cs)
 * @param path      this editor's file path within those files
 * @param onNavigate (path, line, column) when a definition or reference is in another file
 */
export function createEditor({ value = '', onChange, onRun, minLines = 6, language, assist = true, files, path = 'Program.cs', onNavigate, references, vocab, onGutterClick } = {}) {
  const gutter = h('div.ed-gutter', { 'aria-hidden': 'true' });
  const pre = h('pre.ed-pre', { 'aria-hidden': 'true' });
  const area = h('textarea.ed-area', {
    spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Code editor',
  });
  // Debugger: breakpoints (red dots in the gutter) and the line the debugger is stopped on.
  const curBar = h('div.ed-curline', { hidden: true, 'aria-hidden': 'true' });
  const root = h('div.editor', h('div.ed-inner', gutter, h('div.ed-code', curBar, pre, area)));
  let errorLines = new Set(), warnLines = new Set(), bpLines = new Set(), curLine = 0, curKind = '';
  if (onGutterClick) {
    gutter.classList.add('clickable');
    gutter.title = 'Click a line number to set or clear a breakpoint (F9)';
    gutter.addEventListener('mousedown', e => {
      const span = e.target.closest('span');
      if (!span || !gutter.contains(span)) return;
      e.preventDefault();
      onGutterClick(Number(span.dataset.line));
    });
  }

  const paint = () => {
    const text = area.value;
    pre.innerHTML = highlight(text, lang()) + '\n';
    const count = Math.max(text.split('\n').length, minLines);
    gutter.innerHTML = Array.from({ length: count }, (_, i) =>
      `<span data-line="${i + 1}" class="${errorLines.has(i + 1) ? 'err' : warnLines.has(i + 1) ? 'warn' : ''}${bpLines.has(i + 1) ? ' bp' : ''}${curLine === i + 1 ? ' cur' : ''}">${i + 1}</span>`).join('');
    placeCur();
  };
  function placeCur() {
    curBar.hidden = !curLine;
    if (!curLine) return;
    const cs = getComputedStyle(area);
    const lh = parseFloat(cs.lineHeight) || 22;
    curBar.style.top = `${(parseFloat(cs.paddingTop) || 12) + (curLine - 1) * lh}px`;
    curBar.style.height = `${lh}px`;
    curBar.className = `ed-curline${curKind ? ' ' + curKind : ''}`;
  }

  const insert = (text, selectFrom, selectTo) => {
    area.focus();
    if (!document.execCommand('insertText', false, text)) area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
    if (selectFrom !== undefined) area.setSelectionRange(selectFrom, selectTo ?? selectFrom);
  };

  area.addEventListener('input', () => {
    if (errorLines.size || warnLines.size) { errorLines = new Set(); warnLines = new Set(); }
    paint();
    onChange?.(area.value);
  });

  const lang = () => (typeof language === 'function' ? language() : language) || document.documentElement.dataset.codeLang || 'csharp';
  // ---- code intelligence (C#): the server compiles the files with Roslyn and answers questions.
  const allFiles = () => (files ? files() : [{ path, code: area.value }]).map(f => (f.path === path ? { path, code: area.value } : f));
  const intel = (action, position) => api('intel', { action, files: allFiles(), path, position, references: references?.() });
  const isCs = () => lang() === 'csharp';
  if (assist) attachAssist(area, {
    language: lang, enabled: autocompleteOn, insert: text => insert(text),
    onPopupHost: p => root.querySelector('.ed-code').append(p),
    remote: async pos => (await intel('complete', pos)).items,
    vocab,
  });

  const tip = h('div.ed-tip', { hidden: true });
  const refs = h('div.ed-refs', { hidden: true });
  const select = (line, column, length) => {
    const lines = area.value.split('\n');
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
    area.focus();
    area.setSelectionRange(start, start + (length || 0));
    const lh = parseFloat(getComputedStyle(area).lineHeight) || 22;
    root.scrollTo?.({ top: Math.max(0, (line - 5) * lh), behavior: 'smooth' });
  };
  const jump = loc => (loc.path === path ? select(loc.line, loc.column, loc.length) : onNavigate?.(loc.path, loc.line, loc.column, loc.length));
  const showTip = (text, x, y) => {
    tip.textContent = text; tip.hidden = false;
    tip.style.left = `${Math.min(x, window.innerWidth - 420)}px`; tip.style.top = `${y + 18}px`;
  };
  async function goToDefinition(pos) {
    if (!isCs()) return;
    const r = await intel('definition', pos).catch(() => null);
    if (r?.definition) jump(r.definition);
    else if (r?.external) { const c = caretXY(pos); showTip(r.external, c.x, c.y); }
  }
  async function findReferences(pos) {
    if (!isCs()) return;
    const r = await intel('references', pos).catch(() => null);
    const list = r?.references || [];
    refs.hidden = false;
    refs.replaceChildren(
      h('div.ed-refs-head', h('b', `${list.length} reference${list.length === 1 ? '' : 's'}`), h('span.muted.small', ' · click one to jump'),
        h('button.icon-btn', { type: 'button', onclick: () => { refs.hidden = true; area.focus(); } }, '×')),
      ...list.map(l => h('button.ed-ref', { type: 'button', onclick: () => jump(l) },
        h('span.ed-ref-where', `${l.path}:${l.line}`), h('code', l.preview))));
  }
  /** Screen position of a character offset (monospace maths). */
  function caretXY(pos) {
    const v = area.value, line = v.slice(0, pos).split('\n').length - 1, col = pos - (v.lastIndexOf('\n', pos - 1) + 1);
    const cs = getComputedStyle(area), box = area.getBoundingClientRect();
    const ch = charWidth(cs.font), lh = parseFloat(cs.lineHeight) || 22;
    return { x: box.left + parseFloat(cs.paddingLeft) + col * ch, y: box.top + parseFloat(cs.paddingTop) + line * lh };
  }
  /** Character offset under the mouse. */
  function offsetAt(e) {
    const cs = getComputedStyle(area), box = area.getBoundingClientRect();
    const ch = charWidth(cs.font), lh = parseFloat(cs.lineHeight) || 22;
    const line = Math.floor((e.clientY - box.top - parseFloat(cs.paddingTop)) / lh);
    const col = Math.floor((e.clientX - box.left - parseFloat(cs.paddingLeft)) / ch);
    const lines = area.value.split('\n');
    if (line < 0 || line >= lines.length || col < 0 || col > lines[line].length) return -1;
    return lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;
  }
  let hoverTimer = null, lastHover = -1;
  area.addEventListener('mousemove', e => {
    if (!isCs()) return;
    clearTimeout(hoverTimer);
    const pos = offsetAt(e);
    if (pos < 0 || !/\w/.test(area.value[pos] || '')) { tip.hidden = true; lastHover = -1; return; }
    hoverTimer = setTimeout(async () => {
      if (pos === lastHover) return;
      lastHover = pos;
      const r = await intel('hover', pos).catch(() => null);
      if (r?.hover) showTip(r.hover + '\n\nF12 go to definition · Shift+F12 references', e.clientX, e.clientY); else tip.hidden = true;
    }, 450);
  });
  area.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); tip.hidden = true; lastHover = -1; });
  area.addEventListener('mousedown', e => {
    tip.hidden = true;
    if ((e.ctrlKey || e.metaKey) && isCs()) { const pos = offsetAt(e); if (pos >= 0) { e.preventDefault(); goToDefinition(pos); } }
  });
  area.addEventListener('keydown', e => {
    if (e.key === 'F12') { e.preventDefault(); (e.shiftKey ? findReferences : goToDefinition)(area.selectionStart); }
    else if (e.key === 'Escape' && !tip.hidden) tip.hidden = true;
  }, true);
  root.append(tip, refs);

  area.addEventListener('keydown', e => {
    if (e.defaultPrevented) return;      // the assist already handled this key
    const { selectionStart: s, selectionEnd: en, value: v } = area;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onRun?.(); return; }
    if (e.key === 'Escape') { area.blur(); return; }

    if (e.key === 'Tab') {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      if (s !== en || e.shiftKey) {
        // Indent or outdent every selected line.
        const block = v.slice(lineStart, en);
        const changed = e.shiftKey ? block.replace(/^( {1,4}|\t)/gm, '') : block.replace(/^/gm, '    ');
        area.setSelectionRange(lineStart, en);
        insert(changed, lineStart, lineStart + changed.length);
      } else insert(' '.repeat(4 - ((s - lineStart) % 4)));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const indent = v.slice(lineStart, s).match(/^[ \t]*/)[0];
      const opens = /[{(\[]\s*$/.test(v.slice(lineStart, s));
      const closes = /^\s*[})\]]/.test(v.slice(en));
      if (opens && closes) {
        insert('\n' + indent + '    \n' + indent, s + indent.length + 5);
      } else insert('\n' + indent + (opens ? '    ' : ''));
      return;
    }
    if (e.key === '}' && s === en) {
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const before = v.slice(lineStart, s);
      if (before.length >= 4 && /^ +$/.test(before)) {      // closing brace on a blank line: step back one level
        e.preventDefault();
        area.setSelectionRange(s - 4, s);
        insert('}');
      }
      return;
    }
    if (e.key === 'Backspace' && s === en) {
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const before = v.slice(lineStart, s);
      if (before.length && /^ +$/.test(before) && before.length % 4 === 0) {   // delete a whole indent level
        e.preventDefault();
        area.setSelectionRange(s - 4, s);
        insert('');
      }
    }
  });

  area.value = value;
  paint();

  return {
    el: root,
    get value() { return area.value; },
    set value(v) { area.value = v; errorLines = new Set(); warnLines = new Set(); paint(); },
    focus() { area.focus({ preventScroll: true }); },
    /** Select a range (1-based line and column), e.g. after navigating here from another file. */
    select,
    /** Put the cursor on a line (1-based), select it, and scroll it into view. */
    goto(line) {
      const lines = area.value.split('\n');
      const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
      area.focus();
      area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
      root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const lh = parseFloat(getComputedStyle(area).lineHeight) || 22;
      root.querySelector('.ed-inner')?.scrollTo?.({ top: Math.max(0, (line - 4) * lh) });
    },
    /** Debugger: the lines with a breakpoint (a Set of 1-based numbers). */
    setBreakpoints(lines) { bpLines = new Set(lines); paint(); },
    /** Debugger: highlight the line it is stopped on (0 clears); kind 'exception' paints it as a crash. Scrolls it into view. */
    setCurrent(line, kind = '') {
      curLine = line || 0; curKind = kind; paint();
      if (!curLine) return;
      requestAnimationFrame(() => {
        const lh = parseFloat(getComputedStyle(area).lineHeight) || 22;
        const y = (curLine - 1) * lh;
        if (y < root.scrollTop + lh || y > root.scrollTop + root.clientHeight - 3 * lh) root.scrollTo({ top: Math.max(0, y - root.clientHeight / 3) });
      });
    },
    /** The 1-based line the caret is on. */
    caretLine() { return area.value.slice(0, area.selectionStart).split('\n').length; },
    mark(diagnostics = []) {
      errorLines = new Set(diagnostics.filter(d => d.severity === 'error').map(d => d.line));
      warnLines = new Set(diagnostics.filter(d => d.severity !== 'error').map(d => d.line));
      paint();
    },
  };
}

let measuredFont = null;
function charWidth(font) {
  if (measuredFont?.font === font) return measuredFont.w;
  const c = document.createElement('canvas').getContext('2d');
  c.font = font;
  measuredFont = { font, w: c.measureText('M'.repeat(50)).width / 50 };
  return measuredFont.w;
}
