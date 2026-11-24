// A small code editor: a transparent <textarea> over a syntax-highlighted <pre>.
// No dependencies, works offline. Tab indents, Enter keeps indentation, Ctrl+Enter runs.
import { h, highlight } from './util.js';

export function createEditor({ value = '', onChange, onRun, minLines = 6 } = {}) {
  const gutter = h('div.ed-gutter', { 'aria-hidden': 'true' });
  const pre = h('pre.ed-pre', { 'aria-hidden': 'true' });
  const area = h('textarea.ed-area', {
    spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Code editor',
  });
  const root = h('div.editor', h('div.ed-inner', gutter, h('div.ed-code', pre, area)));
  let errorLines = new Set(), warnLines = new Set();

  const paint = () => {
    const text = area.value;
    pre.innerHTML = highlight(text) + '\n';
    const count = Math.max(text.split('\n').length, minLines);
    gutter.innerHTML = Array.from({ length: count }, (_, i) =>
      `<span class="${errorLines.has(i + 1) ? 'err' : warnLines.has(i + 1) ? 'warn' : ''}">${i + 1}</span>`).join('');
  };

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

  area.addEventListener('keydown', e => {
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
    mark(diagnostics = []) {
      errorLines = new Set(diagnostics.filter(d => d.severity === 'error').map(d => d.line));
      warnLines = new Set(diagnostics.filter(d => d.severity !== 'error').map(d => d.line));
      paint();
    },
  };
}
