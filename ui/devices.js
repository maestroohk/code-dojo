// Device illustrations for the topology board (blocks.js): generic, hand-drawn inline SVG for every kind of
// thing a builder puts on the board (laptop, switch, router, server, database, container, pod, pipeline job...).
// No logos or trademarked artwork. All drawings share one 120 x 76 view box, one stroke width and the same few
// fills, set by CSS classes (dv-body, dv-face, dv-line, dv-acc, dv-scr, dv-dim) so they follow the dark theme;
// --dev on the block is the kind's accent colour, used sparingly. deviceSvg(art) returns an SVG string.

const B = 'class="dv-body"', F = 'class="dv-face"', A = 'class="dv-acc"', S = 'class="dv-scr"', L = 'class="dv-line"', D = 'class="dv-dim"';

const ART = {
  laptop: `<rect x="24" y="6" width="72" height="46" rx="4" ${B}/><rect x="29" y="11" width="62" height="36" rx="1.5" ${S}/>
    <path d="M33 15 L50 15 M33 20 L44 20" ${L}/><path d="M10 56 H110 L104 67 H16 Z" ${B}/><path d="M50 56 H70 L68 59 H52 Z" ${F}/>`,
  pc: `<rect x="18" y="4" width="84" height="52" rx="4" ${B}/><rect x="23" y="9" width="74" height="41" rx="1.5" ${S}/>
    <path d="M28 14 L46 14 M28 19 L40 19" ${L}/><path d="M53 56 H67 L70 66 H50 Z" ${B}/><rect x="38" y="66" width="44" height="5" rx="2.5" ${B}/>`,
  phone: `<rect x="42" y="3" width="36" height="70" rx="7" ${B}/><rect x="46" y="10" width="28" height="52" rx="2" ${S}/><circle cx="60" cy="67" r="2.2" ${F}/>`,
  router: `<path d="M34 34 L28 8 M86 34 L92 8" ${L} stroke-width="3" stroke-linecap="round"/><circle cx="28" cy="8" r="3" ${A}/><circle cx="92" cy="8" r="3" ${A}/>
    <rect x="12" y="32" width="96" height="34" rx="8" ${B}/><rect x="18" y="38" width="84" height="22" rx="4" ${F}/>
    <circle cx="28" cy="49" r="2.5" ${A}/><circle cx="37" cy="49" r="2.5" ${A}/><circle cx="46" cy="49" r="2.5" ${D}/>
    <rect x="66" y="44" width="9" height="9" rx="1.5" ${D}/><rect x="79" y="44" width="9" height="9" rx="1.5" ${D}/><rect x="92" y="44" width="6" height="9" rx="1.5" ${D}/>`,
  switch: `<rect x="6" y="24" width="108" height="30" rx="4" ${B}/><rect x="10" y="28" width="100" height="22" rx="2" ${F}/>
    ${[0, 1, 2, 3, 4, 5, 6, 7].map(i => `<rect x="${16 + i * 11.5}" y="35" width="8" height="8" rx="1" ${D}/><circle cx="${20 + i * 11.5}" cy="31.5" r="1.2" ${A}/>`).join('')}`,
  firewall: `<rect x="16" y="10" width="88" height="56" rx="5" ${B}/>
    <path d="M16 24 H104 M16 38 H104 M16 52 H104 M38 10 V24 M70 10 V24 M54 24 V38 M86 24 V38 M30 38 V52 M62 38 V52 M94 38 V52 M46 52 V66 M78 52 V66" ${L}/>`,
  server: `<rect x="16" y="6" width="88" height="28" rx="4" ${B}/><rect x="16" y="40" width="88" height="28" rx="4" ${B}/>
    <path d="M26 16 H62 M26 22 H62 M26 50 H62 M26 56 H62" ${L}/><circle cx="90" cy="20" r="3" ${A}/><circle cx="90" cy="54" r="3" ${A}/><circle cx="80" cy="20" r="3" ${D}/><circle cx="80" cy="54" r="3" ${D}/>`,
  gateway: `<rect x="10" y="12" width="100" height="52" rx="8" ${B}/><rect x="16" y="18" width="88" height="40" rx="5" ${F}/>
    <path d="M24 38 H48 M48 38 L68 26 H92 M48 38 H92 M48 38 L68 50 H92" ${L} stroke-width="2.2"/>
    <path d="M88 22 L95 26 L88 30 M88 34 L95 38 L88 42 M88 46 L95 50 L88 54" ${L} stroke-width="2.2"/><path d="M30 26 L36 30 V36 C36 42 30 46 30 46 C30 46 24 42 24 36 V30 Z" ${A}/>`,
  route: `<rect x="8" y="24" width="104" height="28" rx="14" ${B}/><rect x="14" y="30" width="92" height="16" rx="8" ${F}/>
    <path d="M28 33 L36 38 L28 43 M48 33 L56 38 L48 43 M68 33 L76 38 L68 43 M88 33 L96 38 L88 43" ${L} stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  database: `<path d="M26 14 V60 C26 72 94 72 94 60 V14" ${B}/><ellipse cx="60" cy="14" rx="34" ry="9" ${F}/>
    <path d="M26 30 C26 40 94 40 94 30 M26 45 C26 55 94 55 94 45" ${L}/><circle cx="82" cy="58" r="2.5" ${A}/>`,
  cache: `<rect x="10" y="22" width="100" height="34" rx="3" ${B}/><path d="M18 56 V64 M30 56 V64 M42 56 V64 M54 56 V64 M66 56 V64 M78 56 V64 M90 56 V64 M102 56 V64" ${L}/>
    <rect x="18" y="28" width="18" height="16" rx="1.5" ${F}/><rect x="40" y="28" width="18" height="16" rx="1.5" ${F}/><rect x="62" y="28" width="18" height="16" rx="1.5" ${F}/>
    <path d="M98 26 L89 40 H96 L91 52 L104 36 H97 Z" ${A}/>`,
  queue: `<rect x="6" y="18" width="94" height="40" rx="6" ${B}/><rect x="11" y="23" width="84" height="30" rx="3" ${F}/>
    ${[0, 1, 2, 3].map(i => `<rect x="${16 + i * 19}" y="29" width="15" height="18" rx="2" ${i === 3 ? A : D}/>`).join('')}
    <path d="M102 38 H114 M109 33 L114 38 L109 43" ${L} stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  cloud: `<path d="M30 62 C14 62 10 44 24 39 C22 24 42 18 50 28 C56 12 84 12 86 32 C102 30 110 48 98 58 C96 61 94 62 90 62 Z" ${B}/>
    <path d="M44 48 H76 M50 40 H70" ${L}/><circle cx="60" cy="44" r="12" fill="none" ${L}/><path d="M48 44 H72 M60 32 C55 38 55 50 60 56 C65 50 65 38 60 32" ${L}/>`,
  container: `<rect x="16" y="14" width="88" height="50" rx="3" ${B}/><rect x="16" y="14" width="88" height="7" rx="2" ${A}/>
    <path d="M30 25 V58 M42 25 V58 M54 25 V58 M66 25 V58 M78 25 V58 M90 25 V58" ${L}/><rect x="16" y="60" width="88" height="5" rx="1.5" ${F}/>`,
  network: `<rect x="6" y="27" width="108" height="7" rx="3.5" ${A}/>
    <path d="M26 34 V48 M60 34 V48 M94 34 V48" ${L} stroke-width="2"/>
    <rect x="17" y="48" width="18" height="12" rx="2" ${B}/><rect x="51" y="48" width="18" height="12" rx="2" ${B}/><rect x="85" y="48" width="18" height="12" rx="2" ${B}/>`,
  volume: `<rect x="18" y="12" width="84" height="52" rx="6" ${B}/><circle cx="50" cy="38" r="18" ${F}/><circle cx="50" cy="38" r="4" ${L} fill="none"/>
    <path d="M88 20 L62 42" ${L} stroke-width="3" stroke-linecap="round"/><circle cx="90" cy="56" r="2.5" ${A}/>`,
  folder: `<path d="M14 18 H46 L52 24 H106 V62 H14 Z" ${B}/><path d="M14 30 H106" ${L}/><path d="M22 40 H60 M22 48 H50" ${L}/>`,
  ingress: `<path d="M22 66 V30 C22 10 98 10 98 30 V66 Z" ${B}/><path d="M34 66 V34 C34 20 86 20 86 34 V66" ${F}/>
    <path d="M44 48 H70 M62 40 L70 48 L62 56" ${L} stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="18" y="64" width="84" height="5" rx="2" ${A}/>`,
  service: `<path d="M38 14 H82 L98 38 L82 62 H38 L22 38 Z" ${B}/><path d="M46 38 H60 M60 38 L74 26 M60 38 H76 M60 38 L74 50" ${L} stroke-width="2.2"/>
    <circle cx="76" cy="26" r="3.5" ${A}/><circle cx="78" cy="38" r="3.5" ${A}/><circle cx="76" cy="50" r="3.5" ${A}/><circle cx="44" cy="38" r="3.5" ${D}/>`,
  pod: `<rect x="8" y="8" width="104" height="60" rx="14" ${F}/><rect x="8" y="8" width="104" height="60" rx="14" fill="none" class="dv-dash"/>
    ${[0, 1, 2].map(i => `<rect x="${20 + i * 29}" y="24" width="22" height="28" rx="3" ${B}/><rect x="${20 + i * 29}" y="24" width="22" height="5" rx="2" ${A}/>`).join('')}`,
  document: `<path d="M34 6 H74 L88 20 V70 H34 Z" ${B}/><path d="M74 6 V20 H88" ${F}/><path d="M42 30 H78 M42 38 H78 M42 46 H70 M42 54 H74" ${L}/>`,
  vault: `<rect x="20" y="8" width="80" height="60" rx="6" ${B}/><rect x="26" y="14" width="68" height="48" rx="3" ${F}/>
    <circle cx="60" cy="38" r="13" ${B}/><circle cx="60" cy="38" r="3" ${A}/><path d="M60 25 V29 M60 47 V51 M47 38 H51 M69 38 H73" ${L}/><rect x="86" y="30" width="4" height="16" rx="2" ${A}/>`,
  trigger: `<circle cx="60" cy="38" r="28" ${B}/><circle cx="60" cy="38" r="22" ${F}/><path d="M64 18 L48 42 H59 L54 60 L72 34 H61 Z" ${A}/>`,
  job: `<rect x="10" y="8" width="100" height="60" rx="6" ${B}/><rect x="10" y="8" width="100" height="12" rx="6" ${F}/>
    <circle cx="19" cy="14" r="2" ${D}/><circle cx="26" cy="14" r="2" ${D}/><circle cx="33" cy="14" r="2" ${D}/><rect x="16" y="24" width="88" height="38" rx="2" ${S}/>
    <path d="M24 36 L32 42 L24 48 M38 50 H52" ${L} stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M60 32 H94 M60 40 H86" ${L}/>`,
  environment: `<path d="M14 66 V34 L34 24 V34 L54 24 V34 L74 24 V14 H94 V66 Z" ${B}/>
    <rect x="22" y="44" width="10" height="10" rx="1" ${S}/><rect x="40" y="44" width="10" height="10" rx="1" ${S}/><rect x="58" y="44" width="10" height="10" rx="1" ${S}/><rect x="78" y="30" width="8" height="24" rx="1" ${A}/>
    <path d="M6 66 H114" ${L}/>`,
  artifact: `<path d="M60 8 L96 22 V56 L60 70 L24 56 V22 Z" ${B}/><path d="M24 22 L60 36 L96 22 M60 36 V70" ${L}/><path d="M42 15 L78 29 V38" ${L}/>`,
  box: `<rect x="20" y="12" width="80" height="52" rx="6" ${B}/><rect x="26" y="18" width="68" height="40" rx="3" ${F}/>`,
};

export const ARTS = Object.keys(ART);

/** The SVG for a device; unknown names fall back to a plain box. */
export function deviceSvg(art, cls = '') {
  return `<svg class="dv dv-${art}${cls ? ' ' + cls : ''}" viewBox="0 0 120 76" aria-hidden="true" focusable="false">${ART[art] || ART.box}</svg>`;
}
