// The "regex" lesson step: write a pattern (and flags, and a replacement), see what .NET finds in every sample as you
// type, then run the checks. Grading is server-side with System.Text.RegularExpressions and a match timeout (RegexLab.cs).
import { h, md, api, esc } from './util.js';
import { parse } from './regex-core.js';
import { hiliteBox, patternHtml, textHtml, explainView } from './regex-ui.js';
import { testRows } from './lab-regex.js';

const FLAG_NAMES = { i: 'IgnoreCase', m: 'Multiline', s: 'Singleline', x: 'IgnorePatternWhitespace', n: 'ExplicitCapture' };

/** Every sample the step's checks use, so the learner sees what they are working against. */
function samples(step) {
  const t = step.tests || {};
  const asText = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v.input != null ? asText(v.input) : `${v.prefix || ''}${(v.repeat || '').repeat(Math.min(v.times || 1, 3))}${v.times > 3 ? '…' : ''}${v.suffix || ''}`) : '');
  const out = [];
  const add = (kind, label, v) => { const s = asText(v); if (s && !out.some(o => o.text === s)) out.push({ kind, label, text: s }); };
  for (const v of t.match || []) add('match', 'should match fully', v);
  for (const v of t.find || []) add('find', 'should contain a match', v);
  for (const v of t.reject || []) add('reject', 'should not match', v);
  for (const v of t.noFind || []) add('noFind', 'should contain no match', v);
  for (const o of t.all || []) add('all', `should find ${JSON.stringify(o.matches)}`, o.input);
  for (const o of t.captures || []) add('captures', `groups: ${Object.entries(o.groups || {}).map(([k, v]) => `${/^\d+$/.test(k) ? '$' + k : k}=${JSON.stringify(v)}`).join(', ')}`, o.input);
  for (const o of t.replace || []) add('replace', `→ ${JSON.stringify(typeof o.output === 'string' ? o.output : '')}`, o.input);
  for (const o of t.split || []) add('split', `split → ${JSON.stringify(o.parts)}`, o.input);
  return out;
}

export function regexStep(step, ctx) {
  const lockFlags = !!step.lockFlags;
  let flags = step.flags || '';
  const fixedRep = step.replacement != null;
  const wantsRep = !fixedRep && !!(step.tests?.replace?.length || step.solutionReplacement != null);
  const draftKey = ctx.draftKey;
  const draft = (() => { try { return JSON.parse(localStorage.getItem('rx:' + draftKey) || 'null'); } catch { return null; } })();
  let timer = null, seq = 0, busy = false;
  const list = samples(step);

  const pat = hiliteBox({ value: draft?.pattern ?? step.starter ?? '', label: 'Your pattern', placeholder: 'type your pattern', onInput: () => changed(), className: 'rx-pattern.big' });
  const rep = wantsRep ? hiliteBox({ value: draft?.replacement ?? step.starterReplacement ?? '', label: 'Replacement', placeholder: 'e.g. $1 or ${name}', onInput: () => changed(), className: 'rx-rep' }) : null;
  if (draft?.flags != null && !lockFlags) flags = draft.flags;
  pat.ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ctx.submit(); } });
  rep?.ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ctx.submit(); } });

  const errLine = h('div.rx-errline', { role: 'alert' });
  const flagBox = h('div.rx-flags', { role: 'group', 'aria-label': 'Flags' });
  const preview = h('div.rx-samples', { 'aria-live': 'off' });
  const results = h('div.rx-step-results', { hidden: true });
  const explainSlot = h('details.rx-card-explain', h('summary', 'Explain my pattern'));

  function paintFlags() {
    flagBox.replaceChildren(...[...'imsxn'].map(f => h(`button.rx-flag${flags.includes(f) ? '.on' : ''}`, {
      type: 'button', title: `${FLAG_NAMES[f]}${lockFlags ? ' (fixed for this exercise)' : ''}`, disabled: lockFlags, 'aria-pressed': String(flags.includes(f)),
      onclick: () => { flags = flags.includes(f) ? flags.replace(f, '') : flags + f; paintFlags(); changed(); },
    }, f)));
  }

  function changed() {
    try { localStorage.setItem('rx:' + draftKey, JSON.stringify({ pattern: pat.value, flags, replacement: rep?.value })); } catch { /* private mode */ }
    const parsed = parse(pat.value, { flavor: 'dotnet', flags });
    pat.paint(patternHtml(pat.value, parsed));
    explainSlot.replaceChildren(h('summary', 'Explain my pattern'), explainView(parsed, { onHover: r => pat.paint(patternHtml(pat.value, parsed, r)) }));
    results.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(runPreview, 200);
    ctx.onChange();
  }

  async function runPreview() {
    const my = ++seq;
    if (!pat.value) { errLine.replaceChildren(); paintSamples(null); return; }
    let r;
    try { r = await api('regex/preview', { pattern: pat.value, flags, inputs: list.map(s => s.text), replacement: fixedRep ? step.replacement : rep ? rep.value : null, nonBacktracking: !!step.nonBacktracking }); }
    catch { return; }
    if (my !== seq) return;
    errLine.replaceChildren(r.error ? h('span', h('b', '.NET says: '), r.error, r.errorOffset >= 0 ? h('span.muted', ` (position ${r.errorOffset})`) : '') : '');
    paintSamples(r.error ? null : r.items);
  }

  function paintSamples(items) {
    preview.replaceChildren(
      h('div.field-label', 'What your pattern finds (live, in .NET)'),
      ...list.map((s, k) => {
        const it = items?.[k];
        const hasMatch = it?.spans?.length > 0;
        return h(`div.rx-sample.k-${s.kind}`,
          h('div.rx-sample-label.small', h('span.rx-kind', s.label)),
          h('pre.rx-sample-text.mono', { html: it ? textHtml(s.text, null, { spans: it.spans }) : esc(s.text) }),
          it?.timedOut && h('div.small.bad', 'Timed out: this pattern backtracks too much on this input.'),
          it?.replaced != null && h('div.rx-sample-out.small', h('span.muted', 'becomes '), h('code', JSON.stringify(it.replaced))),
          !it?.replaced && items && s.kind === 'noFind' && hasMatch && h('div.small.bad', 'found something here'));
      }));
  }

  const el = h('div.regex-step',
    step.title && h('h2', step.title),
    h('div.prompt', { html: md(step.prompt || '') }),
    h('div.rx-row', h('span.rx-slash', '/'), pat.el, h('span.rx-slash', '/'), flagBox),
    errLine,
    rep && h('div.rx-row', h('span.rx-lbl.small', 'Replace with'), rep.el),
    fixedRep && h('p.small.muted', 'Replacement (given): ', h('code', step.replacement || '""')),
    step.maxLength && h('p.small.muted', `Golf: at most ${step.maxLength} characters.`),
    h('div.code-tools', h('span.muted.small', 'Enter to check · the checks run in .NET with a 250 ms timeout'), h('span.spacer'),
      h('a.mini', { href: '#/labs/regex', target: '_blank', onclick: () => { try { sessionStorage.setItem('regexLab', JSON.stringify({ pattern: pat.value, flags, text: list.map(s => s.text).join('\n'), replacement: rep?.value ?? step.replacement })); } catch { /* ignore */ } } }, 'Open in the regex lab ↗')),
    results, preview, explainSlot);

  paintFlags();
  setTimeout(() => { pat.autosize(); rep?.autosize(); changed(); });

  return {
    el,
    ready: () => !busy && pat.value.length > 0,
    async check() {
      busy = true; ctx.onChange();
      try {
        const r = await api('regex/check', { track: ctx.track, module: ctx.module, lesson: ctx.lesson, step: ctx.idx, pattern: pat.value, flags, replacement: rep ? rep.value : null });
        results.hidden = false;
        if (r.error) {
          results.replaceChildren(h('div.out-section', h('div.out-title.bad', 'The pattern does not work yet'), h('div.diag.error', r.error)));
          return { correct: false, detail: 'The pattern has an error. Read it below.' };
        }
        const failed = r.tests.filter(t => !t.pass).length;
        results.replaceChildren(h('div.out-section',
          h(`div.out-title.${failed ? 'bad' : 'good'}`, failed ? `${r.tests.length - failed} of ${r.tests.length} checks pass` : `All ${r.tests.length} checks pass`),
          testRows(r.tests)));
        return { correct: r.passed, detail: r.passed ? '' : `${failed} check${failed === 1 ? '' : 's'} failed${r.timedOut ? ' (one timed out: catastrophic backtracking)' : ''}. The details are below.` };
      } catch {
        return { correct: false, detail: 'Could not reach the dojo server. Is it still running?', noPenalty: true };
      } finally { busy = false; ctx.onChange(); }
    },
    reveal() {
      pat.value = step.solution || '';
      if (!lockFlags && step.solutionFlags != null) { flags = step.solutionFlags; paintFlags(); }
      if (rep && step.solutionReplacement != null) rep.value = step.solutionReplacement;
      changed();
    },
    lock(on) { pat.ta.readOnly = on; if (rep) rep.ta.readOnly = on; },
    focus() { pat.focus(); },
    destroy() { clearTimeout(timer); },
  };
}
