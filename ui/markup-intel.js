// Markup intelligence for the editor: HTML and JSX tags, the attributes each tag takes, attribute
// values, CSS properties and values, and Emmet-style expansion (div.card + Tab). Used by assist.js.
// Every suggestion carries a short description, shown next to the selected item.

// ---------------------------------------------------------------- tags

/** name: description. Grouped loosely by what they are for. */
const TAGS = {
  // document
  html: 'Root of the page', head: 'Metadata: title, links, scripts', body: 'Everything the page shows', title: 'Text in the browser tab',
  meta: 'Page metadata (charset, viewport, description)', link: 'Link a stylesheet or icon', script: 'JavaScript to run', style: 'CSS for this page',
  base: 'Base URL for relative links', noscript: 'Shown when JavaScript is off',
  // layout and sections
  main: 'The main content (one per page)', header: 'Intro or top bar of a page or section', footer: 'Bottom of a page or section',
  nav: 'A block of navigation links', section: 'A themed group of content, usually with a heading', article: 'Self-contained content (a post, a card)',
  aside: 'Side content (sidebar, callout)', div: 'Generic block container', span: 'Generic inline container', address: 'Contact information',
  hgroup: 'A heading with its subtitle', search: 'A search area',
  // text
  h1: 'Top-level heading (one per page)', h2: 'Section heading', h3: 'Subsection heading', h4: 'Heading level 4', h5: 'Heading level 5', h6: 'Heading level 6',
  p: 'Paragraph', a: 'Link (href)', strong: 'Important text (bold)', em: 'Stressed text (italic)', b: 'Bold, no extra meaning', i: 'Italic, no extra meaning',
  u: 'Underlined text', s: 'Struck-through text', small: 'Fine print', mark: 'Highlighted text', code: 'Inline code', pre: 'Preformatted text, keeps spaces',
  kbd: 'Keyboard input', samp: 'Program output', var: 'A variable', abbr: 'Abbreviation (title shows the full form)', cite: 'Title of a work',
  q: 'Short inline quote', blockquote: 'Long quotation', sub: 'Subscript', sup: 'Superscript', time: 'A date or time (datetime)', br: 'Line break',
  hr: 'Thematic break (horizontal rule)', wbr: 'Optional line-break point', del: 'Deleted text', ins: 'Inserted text', dfn: 'Term being defined', bdi: 'Isolated text direction',
  // lists
  ul: 'Bulleted list', ol: 'Numbered list', li: 'List item', dl: 'Description list', dt: 'Term in a description list', dd: 'Description of a term', menu: 'Toolbar-style list',
  // media
  img: 'Image (src, alt)', picture: 'Responsive image with sources', source: 'A media source for picture, video or audio', video: 'Video player',
  audio: 'Audio player', track: 'Subtitles for video', iframe: 'Embedded page', canvas: 'Drawing surface for scripts', svg: 'Vector graphics',
  figure: 'Self-contained figure with an optional caption', figcaption: 'Caption of a figure', embed: 'External content', object: 'External resource', map: 'Image map', area: 'Clickable area in an image map',
  // forms
  form: 'A form that submits data', input: 'Text, number, checkbox, date … field', button: 'Clickable button', label: 'Caption for a form control',
  select: 'Drop-down list', option: 'An option in a select', optgroup: 'A group of options', textarea: 'Multi-line text field',
  fieldset: 'Group of related controls', legend: 'Caption of a fieldset', datalist: 'Suggestions for an input', output: 'Result of a calculation',
  progress: 'Progress bar', meter: 'Gauge within a known range',
  // tables
  table: 'Table', caption: 'Table caption', thead: 'Header rows', tbody: 'Body rows', tfoot: 'Footer rows', tr: 'Table row', th: 'Header cell', td: 'Data cell',
  colgroup: 'Group of columns', col: 'A column',
  // interactive
  details: 'Disclosure widget (open/close)', summary: 'Visible heading of details', dialog: 'Dialog box or modal', template: 'Inert HTML for scripts', slot: 'Placeholder in a web component',
};

const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));

// ---------------------------------------------------------------- attributes

const GLOBAL_ATTRS = {
  id: 'Unique id (for CSS, links and labels)', class: 'CSS classes (Tailwind utilities go here)', style: 'Inline CSS',
  title: 'Tooltip text', hidden: 'Hide the element', lang: 'Language of the content', dir: 'Text direction', tabindex: 'Order in keyboard focus',
  role: 'Accessibility role', 'aria-label': 'Accessible name', 'aria-hidden': 'Hide from screen readers', 'aria-describedby': 'Id of describing text',
  'aria-expanded': 'Whether a menu or section is open', 'aria-current': 'The current item in a set (page, step)', 'aria-live': 'Announce changes',
  'data-': 'Custom data attribute (data-name)', draggable: 'Can be dragged', contenteditable: 'Text can be edited', spellcheck: 'Spell-check the content',
  autofocus: 'Focus when the page loads', inert: 'Not interactive', popover: 'Make it a popover',
};

const TAG_ATTRS = {
  a: { href: 'Where the link goes', target: 'Where to open it (_blank = new tab)', rel: 'Relationship (noopener noreferrer for _blank)', download: 'Download instead of navigate', hreflang: 'Language of the target', type: 'MIME type of the target' },
  img: { src: 'Image URL', alt: 'Text alternative (describe the image)', width: 'Intrinsic width', height: 'Intrinsic height', loading: 'lazy or eager', decoding: 'async, sync or auto', srcset: 'Images for different sizes', sizes: 'Sizes for srcset', fetchpriority: 'high, low or auto' },
  input: { type: 'Kind of field', name: 'Name sent with the form', value: 'Current value', placeholder: 'Hint text when empty', required: 'Must be filled in', disabled: 'Cannot be used', readonly: 'Cannot be edited', checked: 'Ticked (checkbox, radio)', min: 'Minimum value', max: 'Maximum value', step: 'Step between values', minlength: 'Minimum length', maxlength: 'Maximum length', pattern: 'Regex the value must match', autocomplete: 'Autofill hint', list: 'Id of a datalist', multiple: 'Allow several values', accept: 'File types (type=file)', inputmode: 'Virtual keyboard to show', size: 'Visible width in characters' },
  button: { type: 'button, submit or reset', disabled: 'Cannot be clicked', name: 'Name sent with the form', value: 'Value sent with the form', form: 'Id of its form', popovertarget: 'Id of a popover to toggle' },
  form: { action: 'Where to send the data', method: 'get or post', enctype: 'Encoding (multipart/form-data for files)', novalidate: 'Skip browser validation', autocomplete: 'Autofill for the form', target: 'Where to show the response' },
  label: { for: 'Id of the control it labels' },
  select: { name: 'Name sent with the form', value: 'Selected value', multiple: 'Allow several choices', required: 'A choice is required', disabled: 'Cannot be used', size: 'Rows shown' },
  option: { value: 'Value sent when chosen', selected: 'Chosen by default', disabled: 'Cannot be chosen', label: 'Text shown' },
  textarea: { name: 'Name sent with the form', rows: 'Visible lines', cols: 'Visible width', placeholder: 'Hint text when empty', required: 'Must be filled in', maxlength: 'Maximum length', readonly: 'Cannot be edited', disabled: 'Cannot be used', wrap: 'soft or hard' },
  link: { rel: 'stylesheet, icon, preload …', href: 'URL of the resource', type: 'MIME type', media: 'Media query', as: 'Kind of resource to preload', crossorigin: 'CORS mode' },
  meta: { name: 'Kind of metadata (description, viewport …)', content: 'Its value', charset: 'Character encoding (utf-8)', 'http-equiv': 'Pragma directive', property: 'Open Graph property' },
  script: { src: 'URL of the script', type: 'module for ES modules', defer: 'Run after the page is parsed', async: 'Run as soon as it loads', crossorigin: 'CORS mode', integrity: 'Subresource hash' },
  video: { src: 'Video URL', controls: 'Show player controls', autoplay: 'Start playing at once', loop: 'Play again when done', muted: 'Start muted', poster: 'Image before it plays', playsinline: 'Play inline on phones', preload: 'none, metadata or auto', width: 'Width', height: 'Height' },
  audio: { src: 'Audio URL', controls: 'Show player controls', autoplay: 'Start playing at once', loop: 'Play again when done', muted: 'Start muted', preload: 'none, metadata or auto' },
  source: { src: 'Media URL', srcset: 'Images (inside picture)', type: 'MIME type', media: 'Media query' },
  iframe: { src: 'URL of the page', title: 'Accessible title', width: 'Width', height: 'Height', allow: 'Permissions policy', loading: 'lazy or eager', sandbox: 'Restrictions', referrerpolicy: 'Referrer sent' },
  td: { colspan: 'Columns this cell spans', rowspan: 'Rows this cell spans', headers: 'Ids of header cells' },
  th: { colspan: 'Columns this cell spans', rowspan: 'Rows this cell spans', scope: 'row, col, rowgroup or colgroup', abbr: 'Short label' },
  ol: { start: 'First number', reversed: 'Count down', type: '1, a, A, i or I' },
  li: { value: 'Number of this item (in ol)' },
  details: { open: 'Shown open', name: 'Group name (only one open)' },
  dialog: { open: 'Shown (prefer showModal())' },
  time: { datetime: 'Machine-readable date or time' },
  progress: { value: 'Current progress', max: 'Total' },
  meter: { value: 'Current value', min: 'Minimum', max: 'Maximum', low: 'Low threshold', high: 'High threshold', optimum: 'Best value' },
  blockquote: { cite: 'URL of the source' }, q: { cite: 'URL of the source' },
  canvas: { width: 'Width in pixels', height: 'Height in pixels' },
  fieldset: { disabled: 'Disable every control inside', name: 'Name' },
  output: { for: 'Ids of the inputs', name: 'Name' },
  col: { span: 'Columns it covers' }, colgroup: { span: 'Columns it covers' },
  html: { lang: 'Language of the page (en)' },
  svg: { viewBox: 'Coordinate system: x y width height', width: 'Width', height: 'Height', fill: 'Fill colour', stroke: 'Stroke colour', xmlns: 'SVG namespace' },
};

/** Attributes that are true just by being there: no value. */
const BOOLEAN = new Set('hidden disabled checked readonly required multiple selected autofocus autoplay controls loop muted defer async open novalidate reversed playsinline inert'.split(' '));

// JSX spells some attributes differently, and has events and React-only props.
const JSX_NAME = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength',
  autofocus: 'autoFocus', autocomplete: 'autoComplete', colspan: 'colSpan', rowspan: 'rowSpan', contenteditable: 'contentEditable',
  spellcheck: 'spellCheck', novalidate: 'noValidate', enctype: 'encType', crossorigin: 'crossOrigin', srcset: 'srcSet', inputmode: 'inputMode',
  fetchpriority: 'fetchPriority', playsinline: 'playsInline', datetime: 'dateTime', 'http-equiv': 'httpEquiv', popovertarget: 'popoverTarget',
  referrerpolicy: 'referrerPolicy', charset: 'charSet',
};
const JSX_EXTRA = {
  key: 'Stable identity in a list (required in .map)', ref: 'A ref to the DOM element',
  onClick: 'Click handler', onChange: 'Value changed (inputs)', onSubmit: 'Form submitted (call e.preventDefault())', onInput: 'Every keystroke',
  onKeyDown: 'Key pressed', onKeyUp: 'Key released', onFocus: 'Got focus', onBlur: 'Lost focus', onMouseEnter: 'Pointer entered', onMouseLeave: 'Pointer left',
  onDoubleClick: 'Double click', onPointerDown: 'Pointer pressed', onScroll: 'Scrolled', onLoad: 'Finished loading', onError: 'Failed to load',
  defaultValue: 'Initial value of an uncontrolled input', defaultChecked: 'Initial state of an uncontrolled checkbox',
  dangerouslySetInnerHTML: 'Raw HTML ({ __html }) — only for trusted content', suppressHydrationWarning: 'Allow a server/client text difference',
};
const JSX_EXPR_ATTRS = new Set(['style', 'ref', 'dangerouslySetInnerHTML', 'children']);

// Next.js components and their props.
const COMPONENT_PROPS = {
  Link: { href: 'Where the link goes (a path like /about)', prefetch: 'Prefetch the page in the background', replace: 'Replace history instead of pushing', scroll: 'Scroll to the top after navigating', className: 'CSS classes', target: 'Where to open it' },
  Image: { src: 'Image URL or import', alt: 'Text alternative', width: 'Width in pixels', height: 'Height in pixels', fill: 'Fill the parent (parent needs position)', sizes: 'Sizes for responsive images', priority: 'Load early (above the fold)', placeholder: 'blur or empty', quality: 'Quality 1–100', className: 'CSS classes' },
  Script: { src: 'URL of the script', strategy: 'beforeInteractive, afterInteractive, lazyOnload', onLoad: 'Runs after it loads' },
  Suspense: { fallback: 'Shown while the children load' },
  Fragment: { key: 'Key when rendered in a list' },
};

const VALUES = {
  'input.type': 'text email password number tel url search date time datetime-local month week color range file checkbox radio hidden submit reset button',
  'button.type': 'button submit reset',
  target: '_blank _self _parent _top',
  rel: 'noopener noreferrer nofollow stylesheet icon preload prefetch canonical manifest alternate',
  method: 'get post dialog',
  loading: 'lazy eager',
  decoding: 'async sync auto',
  fetchpriority: 'high low auto', fetchPriority: 'high low auto',
  preload: 'none metadata auto',
  autocomplete: 'on off name given-name family-name email username current-password new-password one-time-code tel street-address postal-code country cc-number',
  autoComplete: 'on off name given-name family-name email username current-password new-password one-time-code tel street-address postal-code country cc-number',
  inputmode: 'none text decimal numeric tel search email url', inputMode: 'none text decimal numeric tel search email url',
  dir: 'ltr rtl auto', wrap: 'soft hard', scope: 'row col rowgroup colgroup',
  enctype: 'application/x-www-form-urlencoded multipart/form-data text/plain', encType: 'application/x-www-form-urlencoded multipart/form-data text/plain',
  crossorigin: 'anonymous use-credentials', crossOrigin: 'anonymous use-credentials',
  referrerpolicy: 'no-referrer origin strict-origin-when-cross-origin same-origin', referrerPolicy: 'no-referrer origin strict-origin-when-cross-origin same-origin',
  'script.type': 'module text/javascript importmap application/json',
  'ol.type': '1 a A i I',
  role: 'button link navigation main banner contentinfo complementary region search dialog alertdialog alert status tab tablist tabpanel menu menuitem list listitem img presentation none checkbox switch progressbar tooltip',
  'aria-live': 'off polite assertive', 'aria-current': 'page step location date time true false',
  'aria-hidden': 'true false', 'aria-expanded': 'true false',
  'meta.name': 'viewport description author keywords robots theme-color color-scheme',
  'meta.content': 'width=device-width, initial-scale=1',
  charset: 'utf-8', charSet: 'utf-8', lang: 'en en-US en-GB fr de es sw',
  strategy: 'beforeInteractive afterInteractive lazyOnload worker', placeholder: '', 'Image.placeholder': 'blur empty',
  draggable: 'true false', spellcheck: 'true false', contenteditable: 'true false plaintext-only', popover: 'auto manual',
};

// ---------------------------------------------------------------- CSS

const CSS = {
  display: 'block inline inline-block flex inline-flex grid inline-grid none contents', position: 'static relative absolute fixed sticky',
  'flex-direction': 'row column row-reverse column-reverse', 'flex-wrap': 'nowrap wrap wrap-reverse',
  'justify-content': 'flex-start center flex-end space-between space-around space-evenly stretch', 'align-items': 'stretch flex-start center flex-end baseline',
  'align-self': 'auto stretch flex-start center flex-end', 'align-content': 'stretch flex-start center flex-end space-between space-around',
  'place-items': 'center start end stretch', 'text-align': 'left center right justify start end', 'font-weight': 'normal bold 100 200 300 400 500 600 700 800 900',
  'font-style': 'normal italic', 'text-decoration': 'none underline line-through overline', 'text-transform': 'none uppercase lowercase capitalize',
  'white-space': 'normal nowrap pre pre-wrap pre-line', overflow: 'visible hidden auto scroll clip', 'overflow-x': 'visible hidden auto scroll', 'overflow-y': 'visible hidden auto scroll',
  cursor: 'auto default pointer text move not-allowed grab grabbing wait crosshair', visibility: 'visible hidden collapse',
  'box-sizing': 'content-box border-box', 'object-fit': 'fill contain cover none scale-down', 'pointer-events': 'auto none',
  'user-select': 'auto none text all', 'list-style': 'none disc circle square decimal', 'border-style': 'none solid dashed dotted double',
  'grid-template-columns': 'repeat(3, 1fr) 1fr 1fr auto minmax(0, 1fr)', 'grid-template-rows': 'auto 1fr repeat(2, auto)',
  transition: 'all 0.2s ease', animation: '', transform: 'translateX() translateY() scale() rotate()', 'word-break': 'normal break-all keep-all break-word',
  'aspect-ratio': '16 / 9', color: 'currentColor inherit transparent', background: 'none transparent', 'background-color': 'transparent currentColor',
  'font-family': 'system-ui sans-serif serif monospace', 'font-size': '1rem 0.875rem 1.25rem 1.5rem 2rem', 'line-height': '1.5 1.2 normal',
  margin: '0 auto 0 auto', padding: '0', gap: '1rem 0.5rem', width: '100% auto fit-content max-content min-content', height: '100% auto 100vh',
  'max-width': '100% 65ch none', 'min-height': '100vh 0', 'border-radius': '0.5rem 9999px 50%', border: '1px solid currentColor', 'box-shadow': '0 1px 2px rgb(0 0 0 / 0.1) none',
  opacity: '0 0.5 1', 'z-index': '0 1 10 50 auto', top: '0 auto', right: '0 auto', bottom: '0 auto', left: '0 auto', inset: '0', outline: 'none',
  content: "'' none", 'font-variant-numeric': 'tabular-nums', 'scroll-behavior': 'auto smooth', 'accent-color': 'auto', 'flex': '1 auto none 0 1 auto',
  'flex-grow': '0 1', 'flex-shrink': '0 1', 'flex-basis': 'auto 0', 'grid-column': 'span 2 1 / -1', 'grid-row': 'span 2', order: '0 1 -1',
  'letter-spacing': 'normal -0.01em 0.05em', 'text-overflow': 'clip ellipsis', 'vertical-align': 'baseline middle top bottom',
};

// ---------------------------------------------------------------- helpers

const list = s => s.split(' ').filter(Boolean);

/**
 * Where the caret is, in markup terms. `markup` is true for .html files; for JS/TS the caller has
 * already decided the text before the caret is JSX. Returns { kind, word, ... } or null.
 *   kind: 'tag' (after <), 'close' (after </), 'attr' (inside an open tag), 'value' (inside attr="…"), 'css'
 */
export function markupContext(text, pos, { jsx }) {
  const before = text.slice(0, pos);
  // Inside <style> in HTML: CSS.
  if (!jsx && before.lastIndexOf('<style') > before.lastIndexOf('</style>')) return cssContext(before);
  // The last `<` that is not closed by `>` yet.
  const lt = lastOpenAngle(before);
  if (lt < 0) return null;
  const inTag = before.slice(lt);
  if (/^<\//.test(inTag)) { const w = inTag.slice(2); return /^[\w.$-]*$/.test(w) ? { kind: 'close', word: w, lt } : null; }
  const tag = /^<([A-Za-z][\w.$:-]*)?$/.exec(inTag);
  if (tag) return { kind: 'tag', word: tag[1] || '', lt };
  const head = /^<([A-Za-z][\w.$:-]*)/.exec(inTag);
  if (!head) return null;
  const name = head[1];
  // Inside a JSX {expression} in the tag: that is code, not markup.
  if (jsx && braceDepth(inTag) > 0) return null;
  const val = /([\w:.-]+)\s*=\s*(["'])([^"']*)$/.exec(inTag);
  if (val) {
    if (val[1] === 'style' && !jsx) return { ...cssContext(val[3].slice(val[3].lastIndexOf(';') + 1), true), tag: name };
    return { kind: 'value', tag: name, attr: val[1], word: val[3].split(/\s+/).pop(), whole: val[3], lt };
  }
  if (/=\s*$/.test(inTag)) return null;
  const at = /\s([\w:.@-]*)$/.exec(inTag);
  if (!at) return null;
  const present = new Set([...inTag.matchAll(/\s([\w:.@-]+)(?=\s*=|\s|$)/g)].map(m => m[1]));
  return { kind: 'attr', tag: name, word: at[1], present, lt };
}

function cssContext(before, inline = false) {
  const tail = before.slice(Math.max(before.lastIndexOf('{'), before.lastIndexOf(';'), before.lastIndexOf('}')) + 1);
  const val = /([a-z-]+)\s*:\s*([^;{}]*)$/i.exec(tail);
  if (val) return { kind: 'cssvalue', prop: val[1].toLowerCase(), word: val[2].split(/\s+/).pop() };
  if (!inline && before.lastIndexOf('{') <= before.lastIndexOf('}')) return null;   // a selector, not a declaration
  const w = /([a-z-]*)$/i.exec(tail)[1];
  return /^\s*[a-z-]*$/i.test(tail) ? { kind: 'cssprop', word: w } : null;
}

/** Index of the last `<` in text that has not been closed by a `>` (quotes and {…} respected). */
function lastOpenAngle(text) {
  for (let i = text.length - 1, seen = 0; i >= 0 && seen < 4000; i--, seen++) {
    const c = text[i];
    if (c === '>' && !inQuotesBetween(text, i)) return -1;
    if (c === '<' && /[A-Za-z/]/.test(text[i + 1] || '') || c === '<' && i === text.length - 1) return i;
    if (c === '\n' && seen > 600) return -1;
  }
  return -1;
}
function inQuotesBetween(text, i) {
  // `>` inside an attribute value such as title="a > b": count quotes after the last `<`.
  const lt = text.lastIndexOf('<', i);
  if (lt < 0) return false;
  const seg = text.slice(lt, i);
  return (seg.split('"').length - 1) % 2 === 1 || (seg.split("'").length - 1) % 2 === 1 || braceDepth(seg) > 0;
}
function braceDepth(s) {
  let d = 0;
  for (const c of s) { if (c === '{') d++; else if (c === '}') d = Math.max(0, d - 1); }
  return d;
}

/** The innermost element opened in text and not closed yet. */
export function openElement(text) {
  const stack = [];
  for (const m of text.matchAll(/<(\/?)([A-Za-z][\w.$:-]*)(?:[^<>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*\})*?(\/?)>/g)) {
    const name = m[2];
    // Array<string>, useState<number>: a generic after a name, not an element.
    if (!m[1] && /[\w$)\].]$/.test(text.slice(Math.max(0, m.index - 1), m.index))) continue;
    if (m[3] || VOID.has(name.toLowerCase())) continue;
    if (m[1]) { const i = stack.lastIndexOf(name); if (i >= 0) stack.length = i; } else stack.push(name);
  }
  return stack.pop();
}

/** Completion items for a markup context. `components`: PascalCase names defined or imported in the file. */
export function markupItems(ctx, { jsx, components = [], tailwind }) {
  const item = (label, kind, detail, insert, caret) => ({ label, kind, detail, insert, caret });
  switch (ctx.kind) {
    case 'tag': {
      const tags = Object.entries(TAGS).map(([t, d]) => item(t, 'tag', d));
      const comps = jsx ? [...new Set([...components, ...Object.keys(COMPONENT_PROPS).filter(c => components.includes(c))])]
        .map(c => item(c, 'component', COMPONENT_PROPS[c] ? `Component (${Object.keys(COMPONENT_PROPS[c]).slice(0, 3).join(', ')} …)` : 'Component from this file')) : [];
      return [...comps, ...tags];
    }
    case 'close': return ctx.open ? [item(ctx.open, jsx && /^[A-Z]/.test(ctx.open) ? 'component' : 'tag', 'Close the open element', `${ctx.open}>`)] : [];
    case 'attr': {
      const lower = ctx.tag.toLowerCase();
      const isComp = jsx && /^[A-Z]/.test(ctx.tag);
      const own = isComp ? (COMPONENT_PROPS[ctx.tag] || {}) : { ...(TAG_ATTRS[lower] || {}) };
      const all = isComp ? { ...own, className: 'CSS classes', key: JSX_EXTRA.key } : { ...own, ...GLOBAL_ATTRS };
      const out = [];
      for (const [name, detail] of Object.entries(all)) {
        const label = jsx && !isComp ? (JSX_NAME[name] || name) : name;
        if (ctx.present.has(label)) continue;
        out.push(attrItem(label, detail, jsx, own[name] !== undefined));
      }
      if (jsx && !isComp) for (const [name, detail] of Object.entries(JSX_EXTRA)) if (!ctx.present.has(name)) out.push(attrItem(name, detail, true, false));
      return out;
    }
    case 'value': {
      const lower = ctx.tag.toLowerCase();
      if (ctx.attr === 'class' || ctx.attr === 'className') return tailwind().map(c => item(c, 'value', ''));
      const key = [`${lower}.${ctx.attr}`, `${ctx.tag}.${ctx.attr}`, ctx.attr].find(k => VALUES[k] !== undefined);
      return key ? list(VALUES[key]).map(v => item(v, 'value', `${ctx.attr}="${v}"`)) : [];
    }
    case 'cssprop': return Object.keys(CSS).map(p => item(p, 'cssprop', CSS[p] ? `e.g. ${list(CSS[p]).slice(0, 3).join(', ')}` : '', `${p}: `));
    case 'cssvalue': return list(CSS[ctx.prop] || '').map(v => item(v, 'value', `${ctx.prop}: ${v}`));
  }
  return [];
}

/** An attribute with the right shape: name="" (caret inside), onClick={} in JSX, or a bare boolean. */
function attrItem(label, detail, jsx, specific) {
  const event = /^on[A-Z]/.test(label);
  const lowerName = label.toLowerCase();
  let insert = `${label}=""`, caret = label.length + 2, kind = specific ? 'attribute' : 'attribute';
  if (BOOLEAN.has(lowerName)) { insert = label; caret = label.length; }
  else if (jsx && (event || JSX_EXPR_ATTRS.has(label) || label === 'key')) {
    insert = label === 'style' ? 'style={{  }}' : label === 'dangerouslySetInnerHTML' ? 'dangerouslySetInnerHTML={{ __html:  }}' : `${label}={}`;
    caret = label === 'style' ? 9 : label === 'dangerouslySetInnerHTML' ? insert.length - 3 : label.length + 2;
    if (event) kind = 'event';
  } else if (label === 'data-') { insert = 'data-'; caret = 5; }
  return { label, kind, detail, insert, caret, sort: specific ? 0 : event ? 2 : 1 };
}

// ---------------------------------------------------------------- Emmet-style expansion

/**
 * `div.card#main` → <div class="card" id="main"></div>, `ul>li*3` → nested, `!` → an HTML page.
 * Returns { text, caret } (caret: offset inside text) or null when `abbr` is not an abbreviation.
 */
export function expandAbbreviation(abbr, { jsx, indent = '' }) {
  if (!jsx && abbr === '!') {
    const text = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title></title>\n</head>\n<body>\n  \n</body>\n</html>';
    return { text, caret: text.indexOf('<title>') + 7 };
  }
  if (!/^[a-zA-Z][\w-]*(?:[.#][\w-]+)*(?:\*\d+)?(?:>[a-zA-Z][\w-]*(?:[.#][\w-]+)*(?:\*\d+)?)*$/.test(abbr)) return null;
  const parts = abbr.split('>');
  const parsed = parts.map(p => {
    const m = /^([a-zA-Z][\w-]*)((?:[.#][\w-]+)*)(?:\*(\d+))?$/.exec(p);
    const classes = [...m[2].matchAll(/\.([\w-]+)/g)].map(x => x[1]);
    const id = (/#([\w-]+)/.exec(m[2]) || [])[1];
    return { tag: m[1], classes, id, times: Math.min(Number(m[3] || 1), 20) };
  });
  // Only expand real tags (or a PascalCase component in JSX), so ordinary words never turn into markup.
  if (!parsed.every(p => TAGS[p.tag] !== undefined || (jsx && /^[A-Z]/.test(p.tag)))) return null;
  if (parts.length === 1 && !parsed[0].classes.length && !parsed[0].id && parsed[0].times === 1 && !TAGS[parsed[0].tag]) return null;
  const cls = jsx ? 'className' : 'class';
  let caret = -1;
  const build = (i, pad) => {
    const p = parsed[i];
    const attrs = (p.id ? ` id="${p.id}"` : '') + (p.classes.length ? ` ${cls}="${p.classes.join(' ')}"` : '');
    const one = () => {
      const open = `<${p.tag}${attrs}`;
      if (VOID.has(p.tag)) return `${pad}${open}${jsx ? ' />' : '>'}`;
      if (i === parsed.length - 1) return `${pad}${open}>\u0000</${p.tag}>`;
      return `${pad}${open}>\n${build(i + 1, pad + '  ')}\n${pad}</${p.tag}>`;
    };
    return Array.from({ length: p.times }, one).join('\n');
  };
  let text = build(0, '').split('\n').map((l, n) => (n ? indent + l : l)).join('\n');
  caret = text.indexOf('\u0000');
  text = text.replaceAll('\u0000', '');
  return { text, caret: caret < 0 ? text.length : caret };
}

/** PascalCase names imported or declared in a JS/TS file: candidate JSX components. */
export function componentsIn(code) {
  const names = new Set();
  for (const m of code.matchAll(/\bimport\s+(?:([A-Z]\w*)|\{([^}]*)\})/g)) {
    if (m[1]) names.add(m[1]);
    if (m[2]) for (const n of m[2].split(',')) { const x = n.trim().split(/\s+as\s+/).pop(); if (/^[A-Z]/.test(x)) names.add(x); }
  }
  for (const m of code.matchAll(/\b(?:function|const|class)\s+([A-Z]\w*)/g)) names.add(m[1]);
  return [...names];
}
