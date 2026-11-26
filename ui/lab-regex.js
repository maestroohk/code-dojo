// The regex lab (#/labs/regex): write a pattern, watch it match live, read it explained part by part, step through
// the engine (backtracking included), substitute, and take the same pattern into C#, JavaScript, Python and the shell.
// .NET is the authoritative flavour (the server runs System.Text.RegularExpressions with a match timeout);
// JavaScript runs in the browser, in a worker, so a catastrophic pattern can be stopped.
import { h, esc, api, codeBlock, md } from './util.js';
import * as game from './game.js';
import { parse, runJsGuarded, nameJsGroups, flavourNotes, FLAVOUR_TABLE, generateCode, replacementFlavours, REFERENCE, FLAG_INFO } from './regex-core.js';
import { hiliteBox, patternHtml, textHtml, explainView, debuggerView, growthChart, measureGrowth, GROUP_COLORS, put } from './regex-ui.js';

const SAMPLE_TEXT = [
  '2026-11-26T09:12:03Z INFO  [api] GET /orders/1842 200 41ms user=ann@contoso.com',
  '2026-11-26T09:12:04Z ERROR [api] GET /orders/1843 503 30012ms user=bob@example.org trace=7f3a9c',
  '2026-11-26T09:12:09Z WARN  [worker] retry 2/5 for job OPS-311 after timeout',
  '2026-11-26T09:13:41Z INFO  [api] POST /login 401 12ms user=eve@contoso.com ip=203.0.113.7',
].join('\n');
const SAMPLE_PATTERN = String.raw`^(?<time>\S+) (?<level>[A-Z]+)\s+\[(?<area>\w+)\] (.*?)(?<ms>\d+)ms`;

// ---------------------------------------------------------------- challenges: real tasks first, a little golf at the end

export const CHALLENGES = [
  { id: 'tickets', title: 'Ticket keys in commit messages', level: 'Starter', par: 22,
    task: 'Find every ticket key like `OPS-311` or `PAY-7`: 2 to 5 capital letters, a dash, digits. Not `ab-12`, not `X-1`, and not the `ISO-8601` inside a word like `PREISO-8601`.',
    text: 'OPS-311: fix retry\nRevert "PAY-7 add refunds" (see PAY-12)\nformat dates as ISO-8601 in PREISO-8601 mode\nab-12 is not a key, nor X-1',
    step: { tests: { all: [{ input: 'OPS-311: fix retry; Revert "PAY-7 add refunds" (see PAY-12)', matches: ['OPS-311', 'PAY-7', 'PAY-12'] }],
      noFind: ['ab-12 is not a key, nor X-1', 'in PREISO-8601 mode'] } }, solution: String.raw`\b[A-Z]{2,5}-\d+\b` },
  { id: 'iso-date', title: 'A valid ISO date', level: 'Starter', par: 50,
    task: 'Match a whole string that is a date `YYYY-MM-DD` with month 01-12 and day 01-31 (do not worry about 30 February: real code calls `DateOnly.TryParseExact` after the regex).',
    text: '2026-11-26\n2026-13-01\n2026-00-10\n2026-02-31\n26-11-26', flags: '',
    step: { tests: { match: ['2026-11-26', '1999-01-31', '2024-12-01'], reject: ['2026-13-01', '2026-00-10', '2026-11-32', '26-11-26', '2026-1-5', '2026-11-26x'] } },
    solution: String.raw`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$` },
  { id: 'log-fields', title: 'Pull fields out of a log line', level: 'Everyday', par: 60,
    task: 'Capture the named groups `level` (INFO, WARN, ERROR) and `ms` (the number before `ms`) from each log line.',
    text: SAMPLE_TEXT,
    step: { tests: { captures: [
      { input: '2026-11-26T09:12:04Z ERROR [api] GET /orders/1843 503 30012ms user=bob', groups: { level: 'ERROR', ms: '30012' } },
      { input: '2026-11-26T09:12:03Z INFO  [api] GET /orders/1842 200 41ms user=ann', groups: { level: 'INFO', ms: '41' } }] } },
    solution: String.raw`(?<level>INFO|WARN|ERROR)\b.*?(?<ms>\d+)ms\b` },
  { id: '5xx', title: 'Only the server errors', level: 'Everyday', par: 30,
    task: 'Find lines of an access log whose status code is 5xx (500-599). The status is the number after the path. A response time like `5012ms` or a path like `/orders/503` must not count.',
    text: 'GET /orders/1842 200 41ms\nGET /orders/503 200 9ms\nGET /orders/1843 503 30012ms\nPOST /pay 500 12ms\nGET /health 204 5012ms',
    step: { tests: { find: ['GET /orders/1843 503 30012ms', 'POST /pay 500 12ms'], noFind: ['GET /orders/503 200 9ms', 'GET /health 204 5012ms', 'GET /orders/1842 200 41ms'] } },
    solution: String.raw` 5\d\d ` },
  { id: 'semver', title: 'Semantic versions', level: 'Everyday', par: 70,
    task: 'Match a whole semantic version: `MAJOR.MINOR.PATCH` with no leading zeros, and an optional pre-release like `-rc.1` or `-beta`. Capture `major`, `minor` and `patch` by name.',
    text: '1.2.3\n10.0.0-rc.1\n01.2.3\n1.2\nv1.2.3',
    step: { tests: { match: ['1.2.3', '10.0.0-rc.1', '0.9.12-beta', '2.0.0'], reject: ['01.2.3', '1.2', 'v1.2.3', '1.2.3-', '1.02.3'],
      captures: [{ input: '10.20.30-rc.1', groups: { major: '10', minor: '20', patch: '30' } }] } },
    solution: String.raw`^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(-[0-9A-Za-z.]+)?$` },
  { id: 'ipv4', title: 'An IPv4 address', level: 'Everyday', par: 70,
    task: 'Match a whole IPv4 address: four numbers 0-255 separated by dots. (In real code, `IPAddress.TryParse` is the final word; the regex finds candidates in text.)',
    text: '192.168.1.10\n10.0.0.256\n203.0.113.7\n1.2.3',
    step: { tests: { match: ['192.168.1.10', '203.0.113.7', '0.0.0.0', '255.255.255.255'], reject: ['10.0.0.256', '1.2.3', '1.2.3.4.5', '300.1.1.1', '1.2.3.04x'] } },
    solution: String.raw`^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$` },
  { id: 'swap-names', title: 'Swap "Last, First"', level: 'Replace', par: 30, replace: true,
    task: 'Turn `Lovelace, Ada` into `Ada Lovelace` on every line. Use named groups and `${name}` in the replacement.',
    text: 'Lovelace, Ada\nHopper, Grace\nTorvalds, Linus',
    step: { tests: { replace: [{ input: 'Lovelace, Ada\nHopper, Grace', output: 'Ada Lovelace\nGrace Hopper' }] } },
    solution: String.raw`(?<last>\w+), (?<first>\w+)`, solutionReplacement: '${first} ${last}' },
  { id: 'mask-card', title: 'Mask a card number for the logs', level: 'Replace', par: 14, replace: true,
    task: 'Replace every digit with `*` except the last four, so `4111111111111111` logs as `************1111`. A lookahead does it in one pass.',
    text: 'card=4111111111111111 ok\ncard=5500005555555559',
    step: { tests: { replace: [{ input: 'card=4111111111111111 ok', output: 'card=************1111 ok' }, { input: '5500005555555559', output: '************5559' }] } },
    solution: String.raw`\d(?=\d{4})`, solutionReplacement: '*' },
  { id: 'thousands', title: 'Thousands separators', level: 'Replace', par: 24, replace: true,
    task: 'Insert a comma every three digits from the right: `1234567` becomes `1,234,567`. You insert at positions, so match an empty string with lookarounds.',
    text: '1234567\n1000\n999\n12345678901',
    step: { tests: { replace: [{ input: '1234567', output: '1,234,567' }, { input: '1000 and 999', output: '1,000 and 999' }, { input: '12345678901', output: '12,345,678,901' }] } },
    solution: String.raw`\B(?=(\d{3})+(?!\d))`, solutionReplacement: ',' },
  { id: 'password', title: 'A password policy in one pattern', level: 'Lookaround', par: 50,
    task: 'Match a whole password of at least 12 characters with at least one lowercase letter, one uppercase letter and one digit. (Real policy: check length and a breached-password list too. NIST no longer recommends composition rules; this is about lookaheads.)',
    text: 'Tr0ubadour&3x\nshortA1\nalllowercase123\nNoDigitsHereAtAll',
    step: { tests: { match: ['Tr0ubadour&3x', 'Correct1HorseBattery'], reject: ['shortA1', 'alllowercase123', 'ALLUPPERCASE123', 'NoDigitsHereAtAll'] } },
    solution: String.raw`^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$` },
  { id: 'dup-words', title: 'Doubled words in docs', level: 'Backreference', par: 18, flags: 'i',
    task: 'Find words typed twice in a row, like `the the` or `Is is`, in any case. Not `this is`.',
    text: 'Paris in the the spring.\nIs is this right?\nthis is fine, and and so is this',
    step: { flags: 'i', tests: { all: [{ input: 'Paris in the the spring. Is is it? and and', matches: ['the the', 'Is is', 'and and'] }], noFind: ['this is fine', 'the theme'] } },
    solution: String.raw`\b(\w+)\s+\1\b` },
  { id: 'trailing', title: 'Strip trailing whitespace', level: 'Replace', par: 8, replace: true, flags: 'm',
    task: 'Remove spaces and tabs at the end of every line, keeping the line breaks. Think about what `$` means with the m flag.',
    text: 'line one   \nline two\t\nline three',
    step: { flags: 'm', tests: { replace: [{ input: 'a  \nb\t\nc', output: 'a\nb\nc' }, { input: 'keep  inner  spaces ', output: 'keep  inner  spaces' }] } },
    solution: String.raw`[ \t]+$`, solutionReplacement: '' },
  { id: 'quoted', title: 'Quoted strings, fast', level: 'Performance', par: 8,
    task: 'Find each double-quoted string, quotes included, without a lazy quantifier: a negated class is faster and works in every tool, even `sed -E`.',
    text: 'name="ann" role="admin" note=""',
    step: { tests: { all: [{ input: 'name="ann" role="admin" note=""', matches: ['"ann"', '"admin"', '""'] }] }, forbid: [{ pattern: String.raw`[*+]\?`, message: 'Does not use a lazy quantifier' }] },
    solution: '"[^"]*"' },
  { id: 'redos', title: 'Fix the catastrophic pattern', level: 'Performance', par: 30,
    task: 'Someone validated "words separated by single spaces" with `^(\\w+\\s?)*$`. On a long line ending in `!` it hangs the server. Write a pattern that accepts and rejects the same things and answers instantly. Try the bad one in the Debugger tab first.',
    text: 'hello big world\nhello  world\nhello world!',
    step: { tests: { match: ['hello big world', 'one', 'a b c'], reject: ['hello  world', 'hello world!', ' leading'], fast: [{ repeat: 'word ', times: 2000, suffix: '!' }, { repeat: 'a', times: 5000, suffix: '!' }] } },
    solution: String.raw`^\w+(?: \w+)* ?$` },
  { id: 'rename', title: 'Rename a method across a codebase', level: 'Refactor', par: 20, replace: true,
    task: 'Rename calls to `GetUser(` into `GetUserAsync(`, but leave `GetUserName(`, `TryGetUser(` and `GetUsers(` alone. This is the pattern you would type in VS Code or Rider find-and-replace (Alt+R / regex mode).',
    text: 'var u = repo.GetUser(id);\nvar n = repo.GetUserName(id);\nif (TryGetUser(id, out u)) GetUsers();',
    step: { tests: { replace: [{ input: 'var u = repo.GetUser(id); var n = repo.GetUserName(id); TryGetUser(id); GetUsers(); GetUser (x)', output: 'var u = repo.GetUserAsync(id); var n = repo.GetUserName(id); TryGetUser(id); GetUsers(); GetUser (x)' }] } },
    solution: String.raw`\bGetUser\(`, solutionReplacement: 'GetUserAsync(' },
  { id: 'global-using', title: 'Promote usings to global usings', level: 'Refactor', par: 24, replace: true, flags: 'm',
    task: 'Turn each line `using System.Text;` into `global using System.Text;`. Leave `using var x = ...;` statements and lines already global alone.',
    text: 'using System.Text;\nusing System.Text.Json;\nglobal using System.IO;\nusing var stream = File.OpenRead(p);',
    step: { flags: 'm', tests: { replace: [{ input: 'using System.Text;\nusing System.Text.Json;\nglobal using System.IO;\nusing var s = File.OpenRead(p);', output: 'global using System.Text;\nglobal using System.Text.Json;\nglobal using System.IO;\nusing var s = File.OpenRead(p);' }] } },
    solution: String.raw`^using ([\w.]+);`, solutionReplacement: 'global using $1;' },
  { id: 'hex-golf', title: 'Golf: a CSS hex colour', level: 'Golf', par: 25, golf: true, flags: 'i',
    task: 'Match a whole CSS hex colour: `#` then 3 or 6 hex digits, any case. Shortest pattern wins the third star (par 25).',
    text: '#fff\n#A1B2C3\n#abcd\n#12345g',
    step: { flags: 'i', tests: { match: ['#fff', '#A1B2C3', '#000000'], reject: ['#abcd', '#12345g', 'fff', '#ffff'] } },
    solution: '^#([0-9a-f]{3}){1,2}$' },
];

// ---------------------------------------------------------------- the lab

export function regexLab(host, solved) {
  const saved = game.state.labs.regex ||= { stars: {}, last: null };
  const handoff = (() => { try { const v = JSON.parse(sessionStorage.getItem('regexLab') || 'null'); sessionStorage.removeItem('regexLab'); return v; } catch { return null; } })();
  const start = handoff || saved.last || { pattern: SAMPLE_PATTERN, flags: 'm', text: SAMPLE_TEXT, replacement: '${level}: ${ms} ms' };
  let flavor = 'dotnet', engine = 'backtracking', flags = start.flags || '';
  let result = null, parsed = null, seq = 0, timer = null, selected = -1, tab = 'matches', challenge = null, active = null;

  // ---- inputs
  const pat = hiliteBox({ value: start.pattern || '', label: 'Regular expression', placeholder: 'type a pattern, e.g. \\d+', onInput: () => changed(), className: 'rx-pattern.big' });
  const txt = hiliteBox({ value: start.text || '', rows: 9, label: 'Test text', placeholder: 'paste some text to test against', onInput: () => changed(), className: 'rx-text.big', mono: true });
  const rep = hiliteBox({ value: start.replacement ?? '', label: 'Replacement', placeholder: 'e.g. $1 or ${name}', onInput: () => changed(), className: 'rx-rep' });
  const errLine = h('div.rx-errline', { role: 'alert' });
  const statusLine = h('div.rx-status', { 'aria-live': 'polite' });
  const flagBox = h('div.rx-flags', { role: 'group', 'aria-label': 'Flags' });
  const tabsEl = h('div.rx-tabs', { role: 'tablist' });
  const panel = h('div.rx-panel', { role: 'tabpanel' });
  const challengeBox = h('div.rx-challenge', { hidden: true });

  const flavorSel = seg([['dotnet', '.NET'], ['js', 'JavaScript']], () => flavor, v => { flavor = v; if (v === 'js') flags = flags.replace(/[xn]/g, ''); paintFlags(); changed(true); }, 'Flavour');
  const engineSel = seg([['backtracking', 'Backtracking'], ['nonbacktracking', 'NonBacktracking']], () => engine, v => { engine = v; changed(true); }, '.NET engine');

  function seg(options, get, set, label) {
    const el = h('div.rx-seg', { role: 'radiogroup', 'aria-label': label });
    const paint = () => [...el.children].forEach((b, k) => { const on = options[k][0] === get(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    options.forEach(([v, l]) => el.append(h('button', { type: 'button', role: 'radio', onclick: () => { set(v); paint(); } }, l)));
    el.paint = paint;
    paint();
    return el;
  }

  function paintFlags() {
    const list = flavor === 'dotnet' ? 'imsxn' : 'imsu';
    flagBox.replaceChildren(...[...list].map(f => {
      const on = flags.includes(f);
      const info = FLAG_INFO[f] || { name: 'Unicode', text: 'u: full Unicode mode (needed for \\p{...}), stricter syntax' };
      return h(`button.rx-flag${on ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(on), title: `${info.name}: ${info.text}`,
        onclick: () => { flags = flags.includes(f) ? flags.replace(f, '') : flags + f; paintFlags(); changed(); } }, f);
    }));
  }

  // ---- running
  function changed(now) {
    parsed = parse(pat.value, { flavor, flags });
    paintPattern();
    clearTimeout(timer);
    timer = setTimeout(runNow, now ? 0 : 220);
    saved.last = { pattern: pat.value, flags, text: txt.value.length < 20000 ? txt.value : txt.value.slice(0, 20000), replacement: rep.value };
    game.save();
  }
  function paintPattern() { pat.paint(patternHtml(pat.value, parsed, active)); }

  async function runNow() {
    const my = ++seq;
    const pattern = pat.value, text = txt.value;
    if (!pattern) { result = { matches: [], empty: true }; paintAll(); return; }
    put(statusLine, h('span.muted', 'Running…'));
    let r;
    if (flavor === 'dotnet') {
      try { r = await api('regex', { pattern, flags, input: text, replacement: rep.value, nonBacktracking: engine === 'nonbacktracking', timeoutMs: 1000 }); }
      catch { r = { error: 'Could not reach the dojo server. Is it still running?', matches: [] }; }
    } else {
      r = await runJsGuarded(pattern, flags, text, rep.value, 1000);
      if (r.timedOut) r.note = 'Stopped after 1 s. JavaScript has no match timeout: in a real page this would freeze the tab. That is why this lab runs it in a worker.';
      if (!r.error && parsed && !parsed.error) nameJsGroups(r, parsed);
    }
    if (my !== seq) return;
    result = r;
    selected = -1;
    paintAll();
  }

  function paintAll() {
    const r = result || { matches: [] };
    errLine.replaceChildren();
    if (r.error) {
      const at = r.errorOffset >= 0 ? r.errorOffset : parsed?.error?.at;
      errLine.append(h('b', flavor === 'dotnet' ? '.NET says: ' : 'JavaScript says: '), r.error, at != null && at >= 0 ? h('span.muted', ` (position ${at})`) : '');
    } else if (parsed?.error && flavor === 'dotnet') {
      errLine.append(h('span.muted', 'The explainer could not read this part: ' + parsed.error.message));
    }
    txt.paint(r.error ? esc(txt.value) : textHtml(txt.value, r.matches, { selected }));
    const n = r.matches?.length || 0;
    put(statusLine, 
      r.empty ? h('span.muted', 'Type a pattern.') : r.error ? h('span.bad', 'No result: the pattern has an error.')
        : h('span', h('b', `${n}${r.truncated ? '+' : ''} match${n === 1 ? '' : 'es'}`),
          h('span.muted', ` · ${flavor === 'dotnet' ? `.NET ${engine === 'nonbacktracking' ? 'NonBacktracking' : 'backtracking'}` : 'JavaScript'}${r.ms != null ? ` · ${r.ms} ms` : ''}`)),
      r.timedOut && h('div.rx-timeout', '⏱ ', r.note || 'Timed out.'));
    paintTab();
  }

  // ---- tabs
  const TABS = [['matches', 'Matches'], ['explain', 'Explain'], ['debug', 'Debugger'], ['replace', 'Replace'], ['code', 'Code'], ['flavours', 'Flavours']];
  function paintTabs() {
    tabsEl.replaceChildren(...TABS.map(([id, label]) => h(`button.rx-tab${tab === id ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; paintTabs(); paintTab(); } }, label)));
  }
  let dbg = null;
  function paintTab() {
    const r = result || { matches: [] };
    if (tab === 'matches') panel.replaceChildren(matchesView(r));
    else if (tab === 'explain') panel.replaceChildren(explainView(parsed || parse('', {}), { onHover: range => { active = range; paintPattern(); } }));
    else if (tab === 'debug') { if (!dbg || !panel.contains(dbg.el)) panel.replaceChildren(debugView()); }
    else if (tab === 'replace') panel.replaceChildren(replaceView(r));
    else if (tab === 'code') panel.replaceChildren(codeView());
    else panel.replaceChildren(flavourView());
  }

  function matchesView(r) {
    if (r.error || !r.matches?.length) return h('p.muted', r.error ? 'Fix the pattern to see matches.' : 'No matches yet. Every match and its groups will be listed here.');
    const rows = r.matches.slice(0, 200).map((m, k) => {
      const groups = m.groups.filter(g => g.number > 0);
      return h(`div.rx-match${k === selected ? '.sel' : ''}`, { tabindex: 0, onclick: () => select(k), onkeydown: e => { if (e.key === 'Enter') select(k); } },
        h('div.rx-match-head', h('span.rx-mno', `Match ${k + 1}`), h('code.rx-mval', JSON.stringify(m.value)), h('span.muted.small', `position ${m.index}–${m.index + m.length}`)),
        groups.length > 0 && h('table.rx-groups', h('tbody', groups.map(g => h('tr',
          h('td', h(`span.rx-chip.rxg${((g.number - 1) % GROUP_COLORS) + 1}`, g.number)),
          h('td', g.name && g.name !== String(g.number) ? h('b', g.name) : h('span.muted', '—')),
          h('td', g.success ? h('code', JSON.stringify(g.value)) : h('span.muted', 'did not take part')),
          h('td.muted.small', g.success ? `${g.index}–${g.index + g.length}` : ''),
          h('td.muted.small', g.captures?.length > 1 ? `${g.captures.length} captures: ${g.captures.slice(0, 6).map(c => JSON.stringify(c.value)).join(', ')}` : ''))))));
    });
    return h('div.rx-matches', rows, r.matches.length > 200 && h('p.muted.small', `…and ${r.matches.length - 200} more.`),
      flavor === 'dotnet' && r.matches.some(m => m.groups.some(g => g.number > 0 && g.name !== String(g.number))) && r.matches[0].groups.some(g => g.number > 0 && g.name === String(g.number))
        && h('p.small.muted', 'Note the numbers: .NET numbers unnamed groups first, then the named ones.'));
  }
  function select(k) { selected = selected === k ? -1 : k; paintAll(); }

  function debugView() {
    dbg = debuggerView(() => ({ pattern: pat.value, flags, flavor, text: txt.value }), { onActive: range => { active = range; paintPattern(); } });
    const chartSlot = h('div');
    const realSlot = h('div');
    const presets = [
      ['Catastrophic: ^(a+)+$', String.raw`^(a+)+$`, 'aaaaaaaaaaaaaaaaaaaaaaaa!'],
      ['Fixed with an atomic group', String.raw`^(?>a+)+$`, 'aaaaaaaaaaaaaaaaaaaaaaaa!'],
      ['Fixed by rewriting', String.raw`^a+$`, 'aaaaaaaaaaaaaaaaaaaaaaaa!'],
      ['Real-world: words and spaces', String.raw`^(\w+\s?)*$`, 'this line looks harmless but it ends with a bang!'],
      ['Greedy vs lazy', String.raw`<.+>`, '<b>bold</b> and <i>it</i>'],
      ['Lazy', String.raw`<.+?>`, '<b>bold</b> and <i>it</i>'],
    ];
    const load = (p, t) => { pat.value = p; txt.value = t; flags = ''; paintFlags(); changed(true); setTimeout(() => dbg.load(), 50); };
    const drawChart = () => {
      const sizes = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
      const make = n => 'a'.repeat(n) + '!';
      const rows = [String.raw`^(a+)+$`, String.raw`^(?>a+)+$`, String.raw`^a+$`].map(p => ({ label: p, series: measureGrowth(p, '', 'dotnet', make, sizes) }));
      const mine = pat.value && !rows.some(r => r.label === pat.value) ? [{ label: pat.value + '  (yours, on aaa…!)', series: measureGrowth(pat.value, flags, flavor, make, sizes) }] : [];
      chartSlot.replaceChildren(growthChart([...rows, ...mine]));
    };
    const measureReal = async btn => {
      btn.disabled = true;
      const pattern = pat.value || String.raw`^(a+)+$`;
      const rows = [];
      realSlot.replaceChildren(h('p.muted.small', 'Measuring in real .NET, one size at a time…'));
      for (const n of [12, 16, 20, 22, 24, 26, 28]) {
        const input = 'a'.repeat(n) + '!';
        const [bt, nb] = [await api('regex', { pattern, flags, input, timeoutMs: 1000 }).catch(() => null), await api('regex', { pattern, flags, input, timeoutMs: 1000, nonBacktracking: true }).catch(() => null)];
        rows.push(h('tr', h('td', n + 1), h('td', bt?.error ? 'error' : bt?.timedOut ? h('b.bad', 'timeout (1 s)') : `${bt?.ms} ms`), h('td', nb?.error ? h('span.muted', nb.error.slice(0, 60)) : nb?.timedOut ? 'timeout' : `${nb?.ms} ms`)));
        realSlot.replaceChildren(h('table.rx-real', h('thead', h('tr', h('th', 'Input length'), h('th', 'Backtracking'), h('th', 'NonBacktracking'))), h('tbody', rows)));
        if (bt?.timedOut && rows.length > 3) break;
      }
      btn.disabled = false;
    };
    const el = h('div.rx-debug',
      h('div.rx-presets', presets.map(([label, p, t]) => h('button.pk-ch', { type: 'button', onclick: () => load(p, t) }, label))),
      dbg.el,
      h('details.rx-cata', { open: /\(\w?\+\)[+*]|\(\\w\+\\s\?\)\*/.test(pat.value) },
        h('summary', h('b', 'Catastrophic backtracking: why it happens and how to fix it')),
        h('div.prose', { html: md([
          'A nested quantifier like `(a+)+` can split `aaaa` into groups in 2^(n-1) ways. When the text *almost* matches (an `!` at the end), the engine tries every one of them before giving up. Each extra character doubles the work.',
          '',
          'Fixes, best first:',
          '1. **Rewrite** so each character can be matched only one way: `^a+$`, or `^\\w+(?: \\w+)*$` instead of `^(\\w+\\s?)*$`.',
          '2. **Atomic group** `(?>...)` (or a possessive `a++` in PCRE, Java, Python 3.11+): once matched, never backtrack into it.',
          '3. **`RegexOptions.NonBacktracking`** (.NET 7+): linear time guaranteed, but no lookarounds, backreferences or atomic groups.',
          '4. **Always a timeout** for input you do not control: `new Regex(p, opts, TimeSpan.FromMilliseconds(250))`, or a process-wide default with `AppContext.SetData("REGEX_DEFAULT_MATCH_TIMEOUT", TimeSpan.FromSeconds(1))`.',
          '',
          'It happens in production. In 2016 a post with about 20,000 spaces took Stack Overflow down through a trim regex `^[\\s\\u200c]+|[\\s\\u200c]+$`. In 2019 Cloudflare\'s edge spent all its CPU on a WAF rule containing `.*(?:.*=.*)`. Both are ReDoS: regular expression denial of service.',
        ].join('\n')) }),
        h('div.rx-cata-actions', h('button.btn.ghost.small', { type: 'button', onclick: drawChart }, '📈 Draw steps as the input grows'),
          h('button.btn.ghost.small', { type: 'button', onclick: e => measureReal(e.currentTarget) }, '⏱ Measure your pattern in real .NET')),
        chartSlot, realSlot));
    setTimeout(() => dbg.load());
    return el;
  }

  function replaceView(r) {
    const flav = parsed && !parsed.error ? replacementFlavours(rep.value, parse(pat.value, { flavor: 'dotnet', flags })) : [];
    return h('div.rx-replace',
      h('label.field-label', 'Replace each match with'), rep.el,
      h('p.small.muted', flavor === 'dotnet'
        ? '.NET replacement syntax: $1 or ${1} for a group, ${name} for a named group, $0 for the whole match, $$ for a literal $. A \\1 here is just the text \\1.'
        : 'JavaScript replacement syntax: $1, $<name>, $& for the whole match, $$ for a literal $.'),
      h('div.field-label', 'Result'),
      h('pre.rx-out.mono', r.error ? '' : r.replaced ?? ''),
      flav.length > 0 && rep.value && h('div', h('div.field-label', 'The same replacement in each tool'),
        h('table.rx-ftable', h('tbody', flav.map(([tool, text, note]) => h('tr', h('td', tool), h('td', h('code', text || '""')), h('td.muted.small', note)))))),
      r.split && h('details', h('summary', `Regex.Split gives ${r.split.length} part${r.split.length === 1 ? '' : 's'}`),
        h('ol.rx-split', r.split.slice(0, 100).map(s => h('li', h('code', JSON.stringify(s))))),
        h('p.small.muted', 'Capturing groups in a split pattern are included in the result in .NET and JavaScript. Use (?:...) to leave them out.')));
  }

  function codeView() {
    if (!pat.value) return h('p.muted', 'Type a pattern first.');
    const g = generateCode(pat.value, flavor === 'dotnet' ? flags : flags.replace(/u/g, ''), rep.value || null);
    const block = (title, code, lang, notes = []) => {
      const copy = h('button.mini', { type: 'button', onclick: async e => { try { await navigator.clipboard.writeText(code); e.currentTarget.textContent = 'Copied'; } catch { e.currentTarget.textContent = 'Select and copy'; } } }, 'Copy');
      return h('section.rx-code', h('div.rx-code-head', h('b', title), h('span.spacer'), copy), h('div', { html: codeBlock(code, lang) }), notes.map(n => h('div.rx-note', '⚠ ', n)));
    };
    return h('div.rx-codes',
      flavor === 'js' && h('p.small.muted', 'The generator reads the pattern as .NET syntax, the lab\'s reference flavour.'),
      block('C#: Regex with options and a timeout', g.csharp, 'csharp', g.notes.csharp),
      block('C#: source-generated [GeneratedRegex] (.NET 7+, the default for fixed patterns)', g.generated, 'csharp'),
      block('JavaScript / TypeScript', g.javascript, 'javascript', g.notes.javascript),
      block('Python (re)', g.python, 'python', g.notes.python),
      block('Command line: rg, grep, sed', g.cli, 'bash', g.notes.cli),
      block('PowerShell', g.powershell, 'powershell'));
  }

  function flavourView() {
    const p = parse(pat.value, { flavor: 'dotnet', flags });
    const notes = p.error ? [] : flavourNotes(p, pat.value);
    const compareSlot = h('div');
    const compare = async () => {
      compareSlot.replaceChildren(h('p.muted.small', 'Running in both engines…'));
      const net = await api('regex', { pattern: pat.value, flags: flags.replace(/u/g, ''), input: txt.value, timeoutMs: 1000 }).catch(() => ({ error: 'server unreachable' }));
      const js = await runJsGuarded(pat.value, flags.replace(/[xn]/g, ''), txt.value, null, 1000);
      const a = (net.matches || []).map(m => `${m.index}:${m.value}`), b = (js.matches || []).map(m => `${m.index}:${m.value}`);
      const same = !net.error && !js.error && a.join('\n') === b.join('\n');
      compareSlot.replaceChildren(h(`div.rx-compare.${same ? 'good' : 'bad'}`,
        same ? `Same ${a.length} match${a.length === 1 ? '' : 'es'} in .NET and JavaScript.` : 'The flavours disagree on this text:',
        !same && h('table.rx-ftable', h('thead', h('tr', h('th', '.NET'), h('th', 'JavaScript'))), h('tbody',
          h('tr', h('td', net.error ? h('span.bad', net.error) : h('code', (net.matches || []).slice(0, 12).map(m => JSON.stringify(m.value)).join(', ') || 'no match')),
            h('td', js.error ? h('span.bad', js.error) : js.timedOut ? 'timed out' : h('code', (js.matches || []).slice(0, 12).map(m => JSON.stringify(m.value)).join(', ') || 'no match')))))));
    };
    return h('div.rx-flavours',
      h('div.rx-cata-actions', h('button.btn.ghost.small', { type: 'button', onclick: compare }, '⇄ Run this pattern in .NET and JavaScript and compare')),
      compareSlot,
      notes.length ? h('div.rx-fnotes', h('div.field-label', 'Your pattern, elsewhere'), notes.map(n => h(`div.rx-fnote.${n.level}`, h('b', n.where), ' ', n.text)))
        : h('p.muted.small', 'Nothing in this pattern behaves differently across the common flavours.'),
      h('div.field-label', 'Flavours at a glance'),
      h('div.rx-table-wrap', h('table.rx-ftable.full', h('thead', h('tr', FLAVOUR_TABLE[0].map(c => h('th', c)))), h('tbody', FLAVOUR_TABLE.slice(1).map(r => h('tr', r.map((c, k) => (k === 0 ? h('th', c) : h('td', c)))))))),
      h('p.small.muted', 'Python notes: use raw strings r"..."; re.match anchors only the start, re.fullmatch the whole string; flags go as re.I | re.M; named groups are (?P<name>...).'));
  }

  // ---- side panel: reference and challenges
  let side = 'challenges';
  const sideBody = h('div.rx-side-body');
  const sideTabs = h('div.rx-side-tabs');
  function paintSide() {
    sideTabs.replaceChildren(...[['challenges', 'Challenges'], ['ref', 'Quick reference']].map(([id, l]) =>
      h(`button.rx-tab${side === id ? '.on' : ''}`, { type: 'button', onclick: () => { side = id; paintSide(); } }, l)));
    if (side === 'ref') {
      sideBody.replaceChildren(...REFERENCE.map(([title, rows]) => h('div.rx-ref', h('div.field-label', title),
        rows.map(([tok, text]) => h('button.rx-ref-row', { type: 'button', title: 'Insert into the pattern', onclick: () => insert(tok.split(' ')[0]) }, h('code', tok), h('span', text))))));
    } else {
      const total = CHALLENGES.reduce((s, c) => s + (saved.stars[c.id] || 0), 0);
      sideBody.replaceChildren(h('p.small.muted', `${total} of ${CHALLENGES.length * 3} stars. Real tasks first; checks run in .NET.`),
        ...CHALLENGES.map(c => h(`button.rx-ch${challenge?.id === c.id ? '.on' : ''}`, { type: 'button', onclick: () => openChallenge(c) },
          h('span.rx-ch-level', c.level), h('span.rx-ch-title', c.title), h('span.rx-ch-stars', { 'aria-label': `${saved.stars[c.id] || 0} stars` }, '★'.repeat(saved.stars[c.id] || 0) + '☆'.repeat(3 - (saved.stars[c.id] || 0))))));
    }
  }
  function insert(tok) {
    const ta = pat.ta;
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + tok + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + tok.length;
    pat.autosize();
    changed();
  }

  function openChallenge(c) {
    challenge = { ...c, attempts: 0, shown: false };
    flavor = 'dotnet'; flavorSel.paint(); engine = 'backtracking'; engineSel.paint();
    flags = c.flags || c.step.flags || '';
    paintFlags();
    pat.value = '';
    txt.value = c.text;
    if (c.replace) { rep.value = ''; tab = 'replace'; } else tab = 'matches';
    paintTabs();
    const results = h('div.rx-ch-results');
    const check = async () => {
      challenge.attempts++;
      put(results, h('p.muted.small', 'Checking in .NET…'));
      let r;
      const step = { ...c.step, flags: flags };
      try { r = await api('regex/grade', { step, pattern: pat.value, flags, replacement: c.replace ? rep.value : null }); }
      catch { put(results, h('div.bad', 'Could not reach the dojo server.')); return; }
      if (r.error) { put(results, h('div.rx-err', r.error)); return; }
      const stars = r.passed ? 1 + (challenge.shown ? 0 : 1) + (pat.value.length <= c.par ? 1 : 0) : 0;
      put(results, 
        h(`div.rx-ch-verdict.${r.passed ? 'good' : 'bad'}`, r.passed ? `Solved: ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}` : `${r.tests.filter(t => t.pass).length} of ${r.tests.length} checks pass`),
        r.passed && stars < 3 && h('p.small.muted', [challenge.shown ? 'You looked at a solution, so one star is held back.' : '', pat.value.length > c.par ? ` Third star: a pattern of at most ${c.par} characters (yours is ${pat.value.length}).` : ''].join(' ')),
        testRows(r.tests));
      if (r.passed) {
        const before = saved.stars[c.id] || 0;
        if (stars > before) { saved.stars[c.id] = stars; game.save(); solved?.((stars - before) * 10, c.title); }
        paintSide();
      }
    };
    challengeBox.hidden = false;
    challengeBox.replaceChildren(
      h('div.rx-ch-head', h('span.rx-ch-level', c.level), h('b', c.title), h('span.spacer'), h('button.mini', { type: 'button', onclick: () => { challenge = null; challengeBox.hidden = true; paintSide(); } }, 'Close')),
      h('div.prose.small', { html: md(c.task) }),
      h('div.rx-ch-actions',
        h('button.btn.primary.small', { type: 'button', onclick: check }, 'Check in .NET'),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { if (challenge.attempts < 2) { put(results, h('p.small.muted', 'Try at least twice first. The checks below tell you what is still wrong.')); return; } challenge.shown = true; pat.value = c.solution; if (c.solutionReplacement != null) rep.value = c.solutionReplacement; changed(true); } }, 'Show a solution'),
        h('span.muted.small', c.par && `Par: ${c.par} characters`)),
      results);
    paintSide();
    changed(true);
    pat.focus();
  }

  // ---- full screen
  const root = h('div.rx-lab');
  const fullBtn = h('button.btn.ghost.small', { type: 'button', title: 'Full screen (Esc to return)', onclick: () => toggleFull() }, '⤢ Full screen');
  function toggleFull(on) {
    on ??= !root.classList.contains('bk-full');
    root.classList.toggle('bk-full', on);
    document.body.classList.toggle('ed-modal-open', on);
    fullBtn.textContent = on ? '⤡ Exit full screen' : '⤢ Full screen';
  }
  const onKey = e => { if (e.key === 'Escape' && root.classList.contains('bk-full')) { e.preventDefault(); toggleFull(false); } };
  document.addEventListener('keydown', onKey);

  root.append(
    h('div.rx-toolbar', h('span.field-label', 'Flavour'), flavorSel, h('span.field-label', 'Engine'), engineSel,
      h('span.spacer'), fullBtn),
    h('div.rx-grid',
      h('div.rx-main',
        challengeBox,
        h('label.field-label', 'Regular expression'),
        h('div.rx-row', h('span.rx-slash', '/'), pat.el, h('span.rx-slash', '/'), flagBox),
        errLine,
        h('label.field-label', 'Test text'),
        txt.el,
        statusLine,
        tabsEl, panel),
      h('aside.rx-side', sideTabs, sideBody)));
  host.replaceChildren(root);
  // The engine toggle only makes sense for .NET.
  const syncEngine = () => { engineSel.hidden = flavor !== 'dotnet'; engineSel.previousSibling.hidden = flavor !== 'dotnet'; };
  flavorSel.addEventListener('click', syncEngine);
  paintFlags(); paintTabs(); paintSide(); syncEngine();
  setTimeout(() => { pat.autosize(); rep.autosize(); });
  changed(true);
  return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('ed-modal-open'); clearTimeout(timer); };
}

/** Rows of regex check results with the input highlighted (shared with lesson steps). */
export function testRows(tests) {
  return h('div.rx-tests', tests.map(t => h(`div.test.${t.pass ? 'pass' : 'fail'}`,
    h('span.test-mark', t.pass ? '✓' : '✗'),
    h('div.rx-test-body',
      h('div.test-name', t.name),
      t.input && h('pre.rx-test-input.mono', { html: textHtml(t.input.length > 400 ? t.input.slice(0, 400) : t.input, null, { spans: (t.spans || []).filter(s => s[0] < 400) }) + (t.input.length > 400 ? '<span class="muted">…</span>' : '') }),
      !t.pass && t.detail && h('pre.test-detail', t.detail)))));
}
