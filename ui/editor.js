// A small code editor: a transparent <textarea> over a syntax-highlighted <pre>.
// No dependencies, works offline. Tab indents, Enter keeps indentation, Ctrl+Enter runs.
// ui/assist.js adds completion, auto-closing and comment toggling (switchable: autocompleteOn()).
import { h, highlight, api } from './util.js';
import { attachAssist } from './assist.js';

/** The learner's choice, shared by every editor. */
/** Languages the server answers code-intelligence questions for (definition, references, hover, completion). */
const INTEL_LANGS = new Set(['csharp', 'python', 'javascript', 'typescript']);
export const autocompleteOn = () => localStorage.getItem('dojo-autocomplete') !== 'off';
export const setAutocomplete = on => localStorage.setItem('dojo-autocomplete', on ? 'on' : 'off');

/**
 * @param files     () => [{ path, code }] every file of the project (default: just this one, as Program.cs)
 * @param path      this editor's file path within those files
 * @param onNavigate (path, line, column) when a definition or reference is in another file
 */
/**
 * popout: the pop-out (large view) for this editor.
 *   title       text for the pop-out's header (default: the file name)
 *   side        () => [elements] shown beside the code while popped out (the task, the output). They are
 *               moved into the pop-out and put back where they were when it closes.
 *   runLabel    label of the header's run button (it calls onRun), e.g. 'Run checks'
 *   onPopOut    replaces the built-in pop-out entirely (Code spaces makes its whole IDE full screen)
 *   false       no pop-out button
 */
export function createEditor({ value = '', onChange, onRun, minLines = 6, language, assist = true, files, path = 'Program.cs', onNavigate, references, space, vocab, onGutterClick, popout = {} } = {}) {
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
  // ---- code intelligence: C# (Roslyn), Python (Jedi, else server/intel/pyintel.py) and JavaScript/TypeScript (TypeScript's
  // LanguageService, else server/JsIntel.cs). space: the code space the files belong to, so its packages are seen.
  // The server reads the files and answers questions; the language goes with each request.
  const allFiles = () => {
    const list = (files ? files() : [{ path, code: area.value }]).map(f => (f.path === path ? { path, code: area.value } : f));
    return list.some(f => f.path === path) ? list : [...list, { path, code: area.value }];
  };
  const intel = (action, position) => api('intel', { action, files: allFiles(), path, position, references: references?.(), language: lang(), space: space?.() || undefined });
  const hasIntel = () => INTEL_LANGS.has(lang());
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
    if (!hasIntel()) return;
    const r = await intel('definition', pos).catch(() => null);
    if (r?.definition) jump(r.definition);
    else if (r?.external) { const c = caretXY(pos); showTip(r.external, c.x, c.y); }
  }
  async function findReferences(pos) {
    if (!hasIntel()) return;
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
    if (!hasIntel()) return;
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
    if ((e.ctrlKey || e.metaKey) && hasIntel()) { const pos = offsetAt(e); if (pos >= 0) { e.preventDefault(); goToDefinition(pos); } }
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
    // Ctrl+Shift+F: pop the editor out into a large view (and back).
    if ((e.key === 'F' || e.key === 'f') && e.shiftKey && (e.ctrlKey || e.metaKey) && popout !== false) { e.preventDefault(); togglePop(); return; }
    if ((e.key === 'b' || e.key === 'B') && (e.ctrlKey || e.metaKey) && !e.shiftKey && popped) { e.preventDefault(); popped.toggleSide(); return; }
    if (e.key === 'Escape') { if (popped) { e.preventDefault(); popIn(); area.focus(); } else area.blur(); return; }

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

  // ---- pop-out: a large view of this editor, with the task and output beside it.
  let popped = null;          // { modal, homes: [[element, placeholder]] } while popped out
  if (popout !== false) {
    const btn = h('button.ed-pop-btn', {
      type: 'button', title: 'Pop out: a large editor with the task and output beside it (Ctrl+Shift+F)', 'aria-label': 'Pop out the editor',
      onmousedown: e => e.preventDefault(), onclick: () => togglePop(),
    }, '⤢');
    root.prepend(h('div.ed-popbar', btn));
  }
  function togglePop() { if (popped) popIn(); else popOut(); }
  function popOut() {
    if (popped) return;
    if (popout?.onPopOut) { popout.onPopOut(); return; }
    const POP_SIZE = 'dojo-editor-pop-size';
    let size = Number(localStorage.getItem(POP_SIZE)) || 17;
    const sizeLabel = h('span.ed-modal-size', `${size}px`);
    const setSize = d => {
      size = Math.min(28, Math.max(12, size + d));
      localStorage.setItem(POP_SIZE, String(size));
      modal.style.setProperty('--ed-pop-font', `${size}px`);
      sizeLabel.textContent = `${size}px`;
      paint();
    };
    const sideEls = (popout?.side?.() || []).filter(Boolean);
    const title = (typeof popout?.title === 'function' ? popout.title() : popout?.title) || path;
    const main = h('div.ed-modal-main');
    const side = sideEls.length ? h('div.ed-modal-side') : null;
    // The side panel (task, results) can be folded away; new results bring it back by themselves.
    let sideOpen = localStorage.getItem('dojo-pop-side') !== 'closed';
    const sideBtn = side && h('button.btn.ghost.small', { type: 'button', title: 'Show or hide the task and results (Ctrl+B)', onclick: () => setSide(!sideOpen) });
    const setSide = (open, remember = true) => {
      if (!side) return;
      sideOpen = open;
      if (remember) localStorage.setItem('dojo-pop-side', open ? 'open' : 'closed');
      body.classList.toggle('side-hidden', !open);
      sideBtn.textContent = open ? '◨ Hide side panel' : '◧ Task & results';
      sideBtn.setAttribute('aria-expanded', String(open));
    };
    const body = h(`div.ed-modal-body${side ? '.with-side' : ''}`, main, side);
    const modal = h('div.ed-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `Editor: ${title}` },
      h('div.ed-modal-head',
        h('b.ed-modal-title', title),
        h('span.spacer'),
        sideBtn,
        onRun && h('button.btn.primary.small', { type: 'button', onclick: () => onRun() }, `▶ ${popout?.runLabel || 'Run'}`),
        h('span.ed-modal-zoom',
          h('button.btn.ghost.small', { type: 'button', title: 'Smaller text', onclick: () => setSize(-1) }, 'A−'),
          sizeLabel,
          h('button.btn.ghost.small', { type: 'button', title: 'Larger text', onclick: () => setSize(1) }, 'A+')),
        h('button.btn.ghost.small', { type: 'button', title: 'Back to the page (Esc)', onclick: () => { popIn(); area.focus(); } }, '⤡ Close  Esc')),
      body);
    modal.style.setProperty('--ed-pop-font', `${size}px`);
    // Move the editor (and the side panels) in, leaving a placeholder to put each one back.
    const homes = [root, ...sideEls].map(el => { const ph = document.createComment('ed-pop'); el.replaceWith(ph); return [el, ph]; });
    main.append(root);
    side?.append(...sideEls);
    setSide(sideOpen, false);
    // Results arriving (an .output panel changing) re-open a folded side panel.
    const watcher = side && new MutationObserver(() => { if (!sideOpen) setSide(true, false); });
    if (watcher) for (const out of side.querySelectorAll('.output')) watcher.observe(out, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    document.body.append(modal);
    document.body.classList.add('ed-modal-open');
    root.classList.add('popped');
    popped = { modal, homes, watcher, toggleSide: () => setSide(!sideOpen) };
    paint();
    area.focus({ preventScroll: true });
  }
  function popIn() {
    if (!popped) return;
    const { modal, homes, watcher } = popped;
    popped = null;
    watcher?.disconnect();
    for (const [el, ph] of homes) ph.replaceWith(el);
    modal.remove();
    if (!document.querySelector('.ed-modal')) document.body.classList.remove('ed-modal-open');
    root.classList.remove('popped');
    paint();
  }

  area.value = value;
  paint();

  return {
    el: root,
    /** Open or close the large view (the same as the ⤢ button or Ctrl+Shift+F). */
    popOut, popIn,
    get popped() { return !!popped; },
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

// Leaving the page (Back, a link) while an editor is popped out: the pop-out goes with it.
window.addEventListener('hashchange', () => {
  document.querySelectorAll('.ed-modal').forEach(m => m.remove());
  document.body.classList.remove('ed-modal-open');
});

let measuredFont = null;
function charWidth(font) {
  if (measuredFont?.font === font) return measuredFont.w;
  const c = document.createElement('canvas').getContext('2d');
  c.font = font;
  measuredFont = { font, w: c.measureText('M'.repeat(50)).width / 50 };
  return measuredFont.w;
}
