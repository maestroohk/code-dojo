import { SQL_KEYWORD_LIST } from './util.js';
import { markupContext, markupItems, expandAbbreviation, componentsIn, openElement } from './markup-intel.js';
// Editor assistance, no dependencies: auto-closing brackets, quotes and HTML tags; a completion popup
// (keywords, words in the file, common library members, HTML tags/attributes, CSS properties and
// Tailwind classes inside class="..."); Ctrl+Space to complete and Ctrl+/ to toggle comments.
// Attached to the textarea of ui/editor.js.

const KIND_ICON = { function: 'ƒ', variable: 'x', module: '{}', method: 'ƒ', property: '◆', field: '▪', constant: 'π', event: '⚡', local: 'x', parameter: 'p', namespace: '{}', class: 'C', record: 'R', struct: 'S', interface: 'I', enum: 'E', keyword: 'k', tag: '<>', component: '<C>', attribute: '=', value: '"', cssprop: '#', snippet: '⇥' };

/** Is the `<` at index lt the start of JSX (not "less than", not a generic like Array<string>)? */
function jsxAngle(v, lt) {
  const before = v.slice(Math.max(0, lt - 40), lt).replace(/\s+$/, '');
  return before === '' || /(?:^|[([{,;:?=&|!>]|\breturn|\byield|\bdefault)$/.test(before);
}
// Languages whose completion comes from the server (the `remote` option).
const REMOTE_LANGS = new Set(['csharp', 'python', 'javascript', 'typescript']);
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const VOID_TAGS = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));

// ---------------------------------------------------------------- vocabularies

const KW = {
  csharp: 'abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit false finally float for foreach if implicit in int interface internal is lock long namespace new null object out override params private protected public readonly record ref return sealed short static string struct switch this throw true try typeof uint ulong using var virtual void while yield nameof required init get set when where select from orderby group into let join',
  python: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self print len range enumerate zip sorted reversed sum min max abs isinstance list dict set tuple str int float bool open input map filter any all super',
  javascript: 'async await break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null of return super switch this throw true try typeof undefined var void while yield console document window JSON Math Promise Array Object String Number Map Set',
  java: 'abstract boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static String super switch this throw throws try void while System',
};
KW.typescript = KW.javascript + ' interface type enum implements readonly keyof never unknown any number string boolean as satisfies';
KW.sql = SQL_KEYWORD_LIST.join(' ');

// "After a dot": the members people reach for most.
const MEMBERS = {
  csharp: {
    Console: 'WriteLine Write ReadLine Clear',
    Math: 'Abs Max Min Pow Sqrt Round Floor Ceiling Clamp PI',
    string: 'Join Split IsNullOrEmpty IsNullOrWhiteSpace Concat Format Empty',
    _: 'Length Count Add Remove Contains IndexOf ToString Trim ToUpper ToLower Replace Substring StartsWith EndsWith Split Where Select OrderBy OrderByDescending GroupBy First FirstOrDefault Any All Sum Average Max Min ToList ToArray ToDictionary Distinct Take Skip Aggregate',
  },
  python: { _: 'append extend insert pop remove sort index count keys values items get update split join strip lower upper replace startswith endswith format find' },
  javascript: {
    console: 'log error warn info table',
    document: 'getElementById querySelector querySelectorAll createElement addEventListener body',
    Math: 'max min floor ceil round random abs sqrt pow PI',
    JSON: 'stringify parse',
    Object: 'keys values entries assign freeze',
    _: 'length push pop shift unshift map filter reduce find findIndex some every includes indexOf join slice splice sort forEach flatMap then catch finally addEventListener textContent innerHTML classList appendChild value',
  },
};
MEMBERS.typescript = MEMBERS.javascript;


let tailwind = null;
/** Tailwind's utility vocabulary, generated once: spacing, sizing, colours, type, layout, effects. */
function tailwindClasses() {
  if (tailwind) return tailwind;
  const out = [];
  const space = ['0', 'px', '0.5', '1', '1.5', '2', '2.5', '3', '4', '5', '6', '8', '10', '12', '16', '20', '24', '32', '40', '48', '64', 'auto'];
  for (const p of ['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'gap', 'gap-x', 'gap-y', 'space-x', 'space-y', 'inset', 'top', 'right', 'bottom', 'left'])
    for (const v of space) out.push(`${p}-${v}`);
  for (const p of ['w', 'h', 'min-w', 'min-h', 'max-w', 'max-h', 'size'])
    for (const v of [...space, 'full', 'screen', 'fit', 'min', 'max', '1/2', '1/3', '2/3', '1/4', '3/4', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'prose']) out.push(`${p}-${v}`);
  const colors = 'slate gray zinc neutral stone red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose'.split(' ');
  for (const p of ['text', 'bg', 'border', 'ring', 'fill', 'stroke', 'from', 'to', 'via', 'divide', 'outline', 'decoration']) {
    for (const c of ['white', 'black', 'transparent', 'current']) out.push(`${p}-${c}`);
    for (const c of colors) for (const s of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) out.push(`${p}-${c}-${s}`);
  }
  out.push(...'text-xs text-sm text-base text-lg text-xl text-2xl text-3xl text-4xl text-5xl text-6xl text-left text-center text-right text-justify font-thin font-light font-normal font-medium font-semibold font-bold font-extrabold font-black font-sans font-serif font-mono italic underline line-through uppercase lowercase capitalize truncate leading-none leading-tight leading-snug leading-normal leading-relaxed leading-loose tracking-tight tracking-normal tracking-wide whitespace-nowrap break-words'.split(' '));
  out.push(...'block inline-block inline flex inline-flex grid inline-grid hidden contents flex-row flex-col flex-wrap flex-1 flex-auto flex-none grow shrink-0 items-start items-center items-end items-stretch justify-start justify-center justify-end justify-between justify-around justify-evenly self-center place-items-center place-content-center content-center relative absolute fixed sticky static overflow-hidden overflow-auto overflow-scroll overflow-x-auto z-0 z-10 z-20 z-50 container mx-auto'.split(' '));
  for (let i = 1; i <= 12; i++) out.push(`grid-cols-${i}`, `col-span-${i}`, `grid-rows-${Math.min(i, 6)}`, `order-${i}`);
  out.push(...'rounded-none rounded-sm rounded rounded-md rounded-lg rounded-xl rounded-2xl rounded-3xl rounded-full border border-0 border-2 border-4 border-t border-b border-dashed shadow-sm shadow shadow-md shadow-lg shadow-xl shadow-2xl shadow-none ring ring-1 ring-2 ring-4 opacity-0 opacity-50 opacity-75 opacity-100 transition transition-all duration-150 duration-300 ease-in-out cursor-pointer select-none pointer-events-none sr-only animate-spin animate-pulse animate-bounce bg-gradient-to-r bg-gradient-to-b object-cover aspect-square aspect-video'.split(' '));
  return (tailwind = [...new Set(out)]);
}

// ---------------------------------------------------------------- the assist

// vocab: optional () => ({ words: [...], members(name) => [...] }), e.g. table and column names from a database schema.
export function attachAssist(area, { language = () => 'csharp', enabled = () => true, insert, onPopupHost, remote, vocab } = {}) {
  const popup = document.createElement('div');
  popup.className = 'ac-pop';
  popup.hidden = true;
  onPopupHost(popup);
  let items = [], sel = 0, from = 0, open = false;

  const lang = () => language() || 'csharp';
  const isHtml = () => lang() === 'html';

  function close() { open = false; popup.hidden = true; }

  /** What is being typed, and which list to complete it from. */
  function context() {
    const v = area.value, pos = area.selectionStart;
    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const before = v.slice(lineStart, pos);
    const L = lang();
    const jsx = L === 'javascript' || L === 'typescript';
    // HTML, JSX and CSS: tags, attributes for that tag, values, CSS properties, each with a description.
    if (isHtml() || jsx || L === 'css') {
      const mc = L === 'css' ? cssOnly(v, pos) : markupContext(v, pos, { jsx });
      if (mc && (!jsx || mc.lt === undefined || jsxAngle(v, mc.lt))) {
        if (mc.kind === 'close') mc.open = openElement(v.slice(0, mc.lt));
        if (mc.kind === 'value' && (mc.attr === 'class' || mc.attr === 'className')) {
          // Tailwind: complete the last class, after any variant such as hover: or md:
          const variant = mc.word.match(/^((?:[a-z0-9-]+:)*)/)[1];
          return { word: mc.word.slice(variant.length), items: tailwindClasses().map(label => ({ label, kind: 'value' })), min: 1, markup: true };
        }
        const items = markupItems(mc, { jsx, components: jsx ? componentsIn(v) : [], tailwind: tailwindClasses });
        if (items.length) return { word: mc.word, items, min: mc.kind === 'attr' || mc.kind === 'cssprop' ? 1 : 0, markup: true };
        if (mc.kind !== 'cssvalue') return null;
      }
      if (isHtml()) {
        const inScript = v.lastIndexOf('<script', pos) > v.lastIndexOf('</script>', pos);
        if (!inScript) return null;
      }
      if (L === 'css') return null;
    }
    const dot = before.match(/([A-Za-z_]\w*)\.(\w*)$/);
    const base = L === 'html' ? 'javascript' : L;
    if (dot) {
      const own = vocab?.()?.members?.(dot[1], v);
      if (own?.length) return { word: dot[2], list: own, min: 0 };
      const m = MEMBERS[base] || {};
      return { word: dot[2], list: (m[dot[1]] || m._ || '').split(' ').filter(Boolean), min: 0 };
    }
    // "text".  f().  xs[0].  : only the server can say what these are.
    const anyDot = REMOTE_LANGS.has(L) && before.match(/[)\]"'`]\.(\w*)$/);
    if (anyDot) return { word: anyDot[1], list: [], min: 0 };
    const w = before.match(/([A-Za-z_]\w*)$/);
    if (!w) return null;
    const words = new Set([...(vocab?.()?.words || []), ...(KW[base] || '').split(' ')]);
    for (const m of v.matchAll(/[A-Za-z_]\w{2,}/g)) if (m[0] !== w[1]) words.add(m[0]);
    return { word: w[1], list: [...words], min: 2 };
  }

  /** CSS files: a declaration property or value at the caret. */
  function cssOnly(v, pos) {
    const ctx = markupContext(`<style>${v.slice(0, pos)}`, pos + 7, { jsx: false });
    return ctx && (ctx.kind === 'cssprop' || ctx.kind === 'cssvalue') ? ctx : null;
  }

  let asked = 0, timer = null;
  function refresh(force = false) {
    if (!enabled() && !force) return close();
    const ctx = context();
    if (!ctx || (ctx.word.length < ctx.min && !force)) return close();
    // Markup (HTML/JSX tags, attributes, CSS) is answered here, with descriptions.
    if (ctx.markup) { clearTimeout(timer); asked++; return show(ctx, ctx.items); }
    // C#, Python, JS/TS: the server knows the real members and what is in scope; ask it (debounced).
    if (remote && REMOTE_LANGS.has(lang())) {
      const ticket = ++asked;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const list = await remote(area.selectionStart).catch(() => null);
        if (ticket !== asked) return;
        const now = context();
        if (!now) return close();
        show(now, list?.length ? list : now.list.map(label => ({ label })));
      }, 110);
      return;
    }
    show(ctx, ctx.list.map(label => ({ label })));
  }

  function show(ctx, list) {
    const w = ctx.word.toLowerCase();
    // Prefix matches first; markup also matches inside names (typing "click" finds onClick).
    const score = x => { const l = x.label.toLowerCase(); return l.startsWith(w) ? 0 : ctx.markup && w.length > 1 && l.includes(w) ? 1 : -1; };
    items = list.filter(x => score(x) >= 0 && x.label !== ctx.word)
      .sort((a, b) => (score(a) - score(b)) || ((a.sort ?? 1) - (b.sort ?? 1)) || (a.label.length - b.label.length) || a.label.localeCompare(b.label)).slice(0, 50);
    if (!items.length) return close();
    from = area.selectionStart - ctx.word.length;
    sel = 0; open = true;
    render();
  }

  function render() {
    popup.replaceChildren(...items.map((it, i) => {
      const d = document.createElement('div');
      d.className = 'ac-item' + (i === sel ? ' sel' : '');
      if (it.kind) {
        const k = document.createElement('span'); k.className = `ac-kind k-${it.kind}`; k.textContent = KIND_ICON[it.kind] || '•'; k.title = it.kind; d.append(k);
      }
      const l = document.createElement('span'); l.className = 'ac-label'; l.textContent = it.label; d.append(l);
      if (it.detail && i === sel) { const t = document.createElement('span'); t.className = 'ac-detail'; t.textContent = it.detail; d.append(t); }
      d.onmousedown = e => { e.preventDefault(); sel = i; accept(); };
      return d;
    }));
    popup.hidden = false;
    popup.children[sel]?.scrollIntoView({ block: 'nearest' });
    // Place it under the caret: monospace, so column x char width and line x line height.
    const v = area.value, pos = area.selectionStart;
    const line = v.slice(0, pos).split('\n').length - 1;
    const col = pos - (v.lastIndexOf('\n', pos - 1) + 1);
    const cs = getComputedStyle(area);
    const ch = measure(cs.font), lh = parseFloat(cs.lineHeight) || 22;
    // Fixed to the viewport, so the editor's own scroll box cannot clip it; flips above the caret
    // when there is no room below.
    const box = area.getBoundingClientRect();
    const x = box.left + parseFloat(cs.paddingLeft) + col * ch;
    const caretTop = box.top + parseFloat(cs.paddingTop) + line * lh;
    const height = Math.min(240, popup.scrollHeight + 2);
    const below = caretTop + lh + 2;
    popup.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
    popup.style.top = `${below + height > window.innerHeight - 8 ? caretTop - height - 2 : below}px`;
  }

  function accept() {
    const it = items[sel];
    const text = it.insert ?? it.label;
    area.setSelectionRange(from, area.selectionStart);
    insert(text);
    close();
    // Snippets put the caret where you type next: inside "", {} or {{ }}.
    if (it.caret !== undefined) { const at = from + it.caret; area.setSelectionRange(at, at); }
    // An attribute that takes known values (type="", target="", class="") shows them straight away.
    if (/=["']$/.test(area.value.slice(0, area.selectionStart)) || /:\s$/.test(text)) refresh(true);
  }

  area.addEventListener('keydown', e => {
    const { selectionStart: s, selectionEnd: en, value: v } = area;
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; render(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); accept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    }
    if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); refresh(true); return; }
    // Emmet-style: div.card, ul>li*3, section#hero, ! (an HTML page), then Tab.
    if (e.key === 'Tab' && !e.shiftKey && s === en && (isHtml() || lang() === 'javascript' || lang() === 'typescript') && expand(v, s)) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (e.key === '/' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleComment(); return; }
    if (!enabled()) return;

    // Typing over a closing character that is already there.
    if ((e.key === ')' || e.key === ']' || e.key === '}' || e.key === '"' || e.key === "'" || e.key === '`') && s === en && v[s] === e.key) {
      e.preventDefault(); area.setSelectionRange(s + 1, s + 1); return;
    }
    // Opening a pair. Quotes only pair when not in the middle of a word.
    if (PAIRS[e.key] && !e.ctrlKey && !e.metaKey) {
      const quote = e.key === '"' || e.key === "'" || e.key === '`';
      if (quote && (/\w/.test(v[s - 1] || '') || (e.key === "'" && isHtml()))) return;
      if (s !== en) { e.preventDefault(); const inner = v.slice(s, en); insert(e.key + inner + PAIRS[e.key]); area.setSelectionRange(s + 1, s + 1 + inner.length); return; }
      if (/\w/.test(v[s] || '')) return;
      e.preventDefault(); insert(e.key + PAIRS[e.key]); area.setSelectionRange(s + 1, s + 1); return;
    }
    // Backspace inside an empty pair removes both halves.
    if (e.key === 'Backspace' && s === en && PAIRS[v[s - 1]] === v[s] && v[s] !== undefined) {
      e.preventDefault(); area.setSelectionRange(s - 1, s + 1); insert(''); return;
    }
    // HTML and JSX: '>' after an opening tag writes the closing tag.
    if (e.key === '>' && (isHtml() || lang() === 'javascript' || lang() === 'typescript')) {
      const before = v.slice(0, s);
      const m = before.match(/<([a-zA-Z][\w.$-]*)((?:\s(?:[^<>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*\})*)?)$/);
      // In JS/TS only real JSX: not a generic (Array<string>), not a comparison (a <b), not an arrow (=>).
      const jsxOk = isHtml() || (m && jsxAngle(v, s - m[0].length));
      if (m && jsxOk && !before.endsWith('/') && !before.endsWith('=') && !VOID_TAGS.has(m[1].toLowerCase())) {
        e.preventDefault(); insert(`></${m[1]}>`); area.setSelectionRange(s + 1, s + 1); return;
      }
    }
    // HTML and JSX: '</' closes the innermost open element.
    // In JSX the `<` may follow text (<p>Hello</): what counts is that an element is open.
    if (e.key === '/' && v[s - 1] === '<' && (isHtml() || lang() === 'javascript' || lang() === 'typescript')) {
      const open = isHtml() ? unclosedTag(v.slice(0, s - 1)) : openElement(v.slice(0, s - 1));
      if (open) { e.preventDefault(); insert(`/${open}>`); return; }
    }
  }, true);

  area.addEventListener('input', () => { if (enabled()) refresh(); else close(); });
  area.addEventListener('blur', () => setTimeout(close, 120));
  area.addEventListener('click', close);
  area.addEventListener('scroll', () => open && render());

  /** Expand the abbreviation before the caret. Returns true when it did. */
  function expand(v, s) {
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const line = v.slice(lineStart, s);
    const m = /([!\w.#>*-]+)$/.exec(line);
    if (!m) return false;
    const lead = line.slice(0, line.length - m[1].length);
    // Only where markup can go: start of a line, or right after a tag, ( or return.
    if (!/^\s*$|[>(]\s*$|\breturn\s+$/.test(lead)) return false;
    const jsx = !isHtml();
    if (isHtml() && markupContext(v, s, { jsx: false })?.kind) return false;       // inside a tag: not here
    if (jsx) {
      // In JS/TS a bare word only expands inside JSX; div.card or ul>li always does.
      const inside = openElement(v.slice(0, s - m[1].length));
      if (!/[.#>*]/.test(m[1]) && !inside) return false;
    }
    const indent = /^\s*/.exec(line)[0];
    const out = expandAbbreviation(m[1], { jsx, indent });
    if (!out) return false;
    const start = s - m[1].length;
    area.setSelectionRange(start, s);
    insert(out.text);
    area.setSelectionRange(start + out.caret, start + out.caret);
    close();
    return true;
  }

  function toggleComment() {
    const L = lang();
    const prefix = L === 'python' ? '# ' : L === 'sql' ? '-- ' : '// ';
    const v = area.value;
    const start = v.lastIndexOf('\n', area.selectionStart - 1) + 1;
    let end = v.indexOf('\n', area.selectionEnd); if (end < 0) end = v.length;
    const lines = v.slice(start, end).split('\n');
    let text;
    if (isHtml()) {
      const block = v.slice(start, end);
      text = /^\s*<!--[\s\S]*-->\s*$/.test(block) ? block.replace(/<!--\s?/, '').replace(/\s?-->/, '') : `<!-- ${block} -->`;
    } else {
      const all = lines.every(l => !l.trim() || l.trimStart().startsWith(prefix.trim()));
      text = lines.map(l => !l.trim() ? l : all ? l.replace(new RegExp('^(\\s*)' + prefix.trim().replace('/', '\\/') + ' ?'), '$1') : l.replace(/^(\s*)/, '$1' + prefix)).join('\n');
    }
    area.setSelectionRange(start, end);
    insert(text);
    area.setSelectionRange(start, start + text.length);
  }

  return { close };
}

function unclosedTag(html) {
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
    const name = m[2].toLowerCase();
    if (m[3] || VOID_TAGS.has(name)) continue;
    if (m[1]) { const i = stack.lastIndexOf(name); if (i >= 0) stack.length = i; }
    else stack.push(name);
  }
  return stack.pop();
}

let measured = null;
function measure(font) {
  if (measured?.font === font) return measured.w;
  const c = document.createElement('canvas').getContext('2d');
  c.font = font;
  measured = { font, w: c.measureText('M'.repeat(50)).width / 50 };
  return measured.w;
}
