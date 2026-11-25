// Code in motion: a debugger you can scrub. The server runs the code with every statement traced;
// here you step forwards and backwards through what happened: the line about to run, every
// variable (changed ones flash), arrays as rows of boxes, the call stack, and the console output.
import { h, api, highlight } from './util.js';
import { createEditor } from './editor.js';

/**
 * @param spec      { code, stdin? }   code may be a string or an array of lines
 * @param editable  the lab lets you edit and re-run; lesson cards show fixed code
 */
export function codeTrace(spec, { editable = false } = {}) {
  let code = Array.isArray(spec.code) ? spec.code.join('\n') : spec.code;
  let data = null, at = 0, timer = null, speed = 500;

  const codeView = h('div.ct-code');
  const varsView = h('div.ct-vars');
  const stackView = h('div.ct-stack');
  const outView = h('pre.ct-out');
  const status = h('div.ct-status.small');
  const slider = h('input.ct-slider', { type: 'range', min: 0, max: 0, value: 0, oninput: e => { pause(); go(Number(e.target.value)); } });
  const playBtn = h('button.btn.primary.small', { type: 'button', onclick: () => (timer ? pause() : play()) }, '▶ Run step by step');
  const editor = editable ? createEditor({ value: code, minLines: 10, onRun: () => load() }) : null;

  async function load() {
    pause();
    if (editor) code = editor.value;
    status.textContent = 'Running…';
    try { data = await api('trace', { code, stdin: spec.stdin }); } catch { data = { error: 'Could not reach the dojo server.', steps: [], lines: code.split('\n') }; }
    editor?.mark(data.diagnostics || []);
    data.steps = data.steps || [];
    slider.max = Math.max(0, data.steps.length - 1);
    go(0);
  }

  function go(i) {
    if (!data) return;
    at = Math.max(0, Math.min(i, data.steps.length - 1));
    slider.value = at;
    paint();
  }
  function play() {
    if (!data?.steps.length) return;
    if (at >= data.steps.length - 1) at = -1;
    playBtn.textContent = '❚❚ Pause';
    const tick = () => { if (at < data.steps.length - 1) { go(at + 1); timer = setTimeout(tick, speed); } else pause(); };
    tick();
  }
  function pause() { clearTimeout(timer); timer = null; playBtn.textContent = '▶ Run step by step'; }

  function paint() {
    const step = data.steps[at];
    const prev = data.steps[at - 1];
    const lines = data.lines || code.split('\n');
    codeView.replaceChildren(...lines.map((text, i) => h(`div.ct-line${step && step.l === i + 1 && !step.end ? '.now' : ''}${prev && prev.l === i + 1 && !(step && step.l === i + 1) ? '.was' : ''}`,
      h('span.ct-ln', i + 1), h('span.ct-src', { html: highlight(text) || ' ' }))));
    codeView.querySelector('.now')?.scrollIntoView({ block: 'nearest' });

    if (data.error && !data.steps.length) {
      status.replaceChildren(h('span.bad', data.error));
      varsView.replaceChildren(); stackView.replaceChildren(); outView.textContent = '';
      return;
    }
    const before = new Map((prev?.v || []).map(v => [v.n, v.t]));
    varsView.replaceChildren(...(step?.v?.length ? step.v.map(v => {
      const changed = prev && before.get(v.n) !== v.t;
      const fresh = prev && !before.has(v.n);
      const prevItems = (prev?.v || []).find(p => p.n === v.n)?.items || [];
      return h(`div.ct-var${changed ? '.changed' : ''}${fresh ? '.fresh' : ''}`,
        h('span.ct-name', v.n),
        v.items
          ? h('span.ct-boxes', v.items.length ? v.items.map((it, k) => h(`span.ct-box${prevItems[k] !== undefined && prevItems[k] !== it ? '.changed' : ''}`, h('span.ct-idx', k), it)) : h('span.muted', 'empty'))
          : h('span.ct-val', v.t));
    }) : [h('span.muted.small', 'No variables yet.')]));

    const frames = step?.s || [];
    stackView.replaceChildren(...(frames.length > 1
      ? frames.map((f, i) => h(`div.ct-frame${i === frames.length - 1 ? '.top' : ''}`, f)).reverse()
      : [h('span.muted.small', 'top level')]));

    outView.textContent = data.steps.slice(0, at + 1).map(s => s.o || '').join('') || '';
    const line = step && !step.end ? lines[step.l - 1]?.trim() : null;
    status.replaceChildren(
      h('b', `Step ${at + 1} of ${data.steps.length}`),
      step?.end ? h('span', ' · the program has finished') : line ? h('span.muted', ` · about to run line ${step.l}: `, h('code', line)) : '',
      data.truncated ? h('span.warn', ' · stopped after 800 steps (is a loop endless?)') : '',
      data.error ? h('span.bad', ' · ' + data.error) : '');
  }

  const keys = e => {
    if (e.target.matches('textarea, input')) return;
    if (e.key === 'ArrowRight') { pause(); go(at + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { pause(); go(at - 1); e.preventDefault(); }
  };

  const root = h('div.ct', { tabindex: 0, onkeydown: keys },
    h('div.ct-title', h('b', 'Code in motion'), h('span.muted.small', ' runs for real · ← → to step · drag the bar to scrub')),
    editable && h('div.ct-edit', editor.el, h('div.ct-edit-bar', h('button.btn.ghost.small', { type: 'button', onclick: load }, 'Trace this code'), h('span.muted.small', 'Ctrl + Enter'))),
    h('div.ct-controls',
      playBtn,
      h('button.btn.ghost.small', { type: 'button', title: 'Back one step', onclick: () => { pause(); go(at - 1); } }, '◀'),
      h('button.btn.ghost.small', { type: 'button', title: 'Forward one step', onclick: () => { pause(); go(at + 1); } }, '▶'),
      slider,
      h('select.ct-speed', { title: 'Speed', onchange: e => { speed = Number(e.target.value); } },
        [[900, 'slow'], [500, 'normal'], [200, 'fast'], [60, 'very fast']].map(([v, l]) => h('option', { value: v, selected: v === speed }, l)))),
    status,
    h('div.ct-grid',
      codeView,
      h('div.ct-side',
        h('div.ct-panel', h('div.ct-head', 'Variables'), varsView),
        h('div.ct-panel', h('div.ct-head', 'Call stack'), stackView),
        h('div.ct-panel', h('div.ct-head', 'Output'), outView))));
  load();
  return root;
}
