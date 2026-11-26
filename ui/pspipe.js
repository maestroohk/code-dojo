// "pspipe" learn cards (tracks/powershell): the PowerShell object pipeline, stage by stage. Each stage is one command;
// under it are the objects that flow out of it, drawn as cards with their type and properties, so the learner sees
// that PowerShell passes objects (not lines of text) and which property each cmdlet reads. Objects a stage dropped
// stay visible, faded and struck through. Optional "text" shows what a text pipeline (bash) would carry instead.
// The data is authored from real pwsh output (tracks/AUTHORING.md, "pspipe").
//
//   "pspipe": { "stages": [ { "cmd": "Get-ChildItem ./logs -File", "type": "System.IO.FileInfo",
//                             "objects": [ { "Name": "api.log", "Length": 48213 } ], "reads": ["Length"],
//                             "dropped": ["old.txt"], "note": "One line about this stage." } ],
//               "text": ["optional lines a text pipeline would see"] }
import { h, inline } from './util.js';

export function pipeViz(spec) {
  const stages = Array.isArray(spec?.stages) ? spec.stages : [];
  if (!stages.length) return null;
  let at = 0, textView = false;

  const chips = stages.map((s, i) => h('button.psp-chip', { type: 'button', title: 'Show what comes out of this command', onclick: () => go(i) }, s.cmd));
  const rail = h('div.psp-rail', { role: 'tablist', 'aria-label': 'Pipeline stages' },
    chips.flatMap((c, i) => (i ? [h('span.psp-pipe', { 'aria-hidden': 'true' }, '|'), c] : [c])));
  const body = h('div.psp-body', { 'aria-live': 'polite' });
  const prev = h('button.btn.ghost.small', { type: 'button', onclick: () => go(at - 1) }, '← Back');
  const next = h('button.btn.ghost.small', { type: 'button', onclick: () => go(at + 1) }, 'Next stage →');
  const count = h('span.muted.small');
  const toggle = spec.text && h('button.btn.ghost.small', { type: 'button', title: 'Compare with what a text pipeline would carry', onclick: () => { textView = !textView; draw(); } });

  const value = v => (v === null || v === undefined ? h('span.psp-null', '$null')
    : Array.isArray(v) ? h('span.psp-arr', `{${v.join(', ')}}`)
    : typeof v === 'number' ? h('span.psp-num', String(v))
    : typeof v === 'boolean' ? h('span.psp-num', v ? '$true' : '$false')
    : h('span.psp-str', String(v)));

  function card(obj, type, reads, dropped) {
    const props = Object.entries(obj).filter(([k]) => !k.startsWith('_'));
    return h(`div.psp-obj${dropped ? '.dropped' : ''}`, { title: dropped ? 'Dropped by this stage' : '' },
      h('div.psp-type', obj._type || type || 'PSObject'),
      h('table.psp-props', h('tbody', props.map(([k, v]) =>
        h(`tr${reads.includes(k) ? '.read' : ''}`, h('th', k), h('td', value(v)))))));
  }

  function draw() {
    const s = stages[at];
    chips.forEach((c, i) => { c.classList.toggle('on', i === at); c.classList.toggle('done', i < at); c.setAttribute('aria-selected', String(i === at)); });
    prev.disabled = at === 0;
    next.disabled = at === stages.length - 1;
    count.textContent = `Stage ${at + 1} of ${stages.length}`;
    if (toggle) toggle.textContent = textView ? 'Show the objects' : 'What would bash see?';
    if (textView) {
      body.replaceChildren(h('p.muted.small', 'A text pipeline only ever carries lines of characters. To get one value back out, the next command must cut it out of the text by position or pattern:'),
        h('pre.psp-text', [].concat(spec.text).join('\n')));
      return;
    }
    const reads = s.reads || [];
    const objs = (s.objects || []).map(o => card(o, s.type, reads, false));
    const gone = (s.dropped || []).map(name => card(typeof name === 'string' ? { Name: name } : name, s.type, [], true));
    body.replaceChildren(
      s.note ? h('p.psp-note', { html: inline(s.note) }) : null,
      h('div.psp-objs', objs.length || gone.length ? [...objs, ...gone] : h('p.muted', 'Nothing comes out: the pipeline is empty here.')),
      h('p.muted.small', `${(s.objects || []).length} object${(s.objects || []).length === 1 ? '' : 's'} of type ${s.type || 'PSObject'} flow on${reads.length ? `; this command read ${reads.map(r => `.${r}`).join(', ')}` : ''}.`));
  }
  function go(i) { at = Math.max(0, Math.min(stages.length - 1, i)); textView = false; draw(); }

  const el = h('div.psp', { tabindex: 0, 'aria-label': 'The object pipeline, stage by stage' },
    h('div.psp-head', h('b', 'Objects in the pipeline'), h('span.spacer'), count),
    rail, body, h('div.psp-bar', prev, next, h('span.spacer'), toggle));
  el.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(at + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
  });
  draw();
  return el;
}
