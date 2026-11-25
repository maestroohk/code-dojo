// LINQ in motion. One column per stage of the query (the source, then each operator). The query is
// run for real on the server with every stage tapped; here the recorded events are replayed, so you
// watch each item leave the source and travel through the operators in the order it really did.
// Streaming operators pass items along one by one; OrderBy and GroupBy hold everything back first.
import { h, api, esc } from './util.js';

const STREAMING = /^\.(Where|Select|SelectMany|Take|Skip|TakeWhile|SkipWhile|Cast|OfType|Concat|Zip|Chunk|Append|Prepend|Distinct|DistinctBy)\b/;
const BUFFERING = /^\.(OrderBy|OrderByDescending|ThenBy|ThenByDescending|GroupBy|Reverse|ToList|ToArray|ToLookup|Join|GroupJoin)\b/;

/**
 * @param spec      { source, query, setup? }
 * @param editable  show inputs so the learner can change the query (the lab does; lesson cards don't)
 */
export function linqViz(spec, { editable = false, autoplay = false } = {}) {
  let data = null, shown = 0, timer = null, speed = 450;
  const cols = h('div.lv-cols');
  const caption = h('div.lv-caption.small');
  const result = h('div.lv-result');
  const sourceIn = h('input.mono', { value: spec.source, spellcheck: false, 'aria-label': 'Source' });
  const queryIn = h('textarea.mono', { value: spec.query, spellcheck: false, rows: 2, 'aria-label': 'Query' });
  const playBtn = h('button.btn.primary.small', { type: 'button', onclick: () => (timer ? pause() : play()) }, '▶ Watch it run');
  const stepBtn = h('button.btn.ghost.small', { type: 'button', onclick: () => { pause(); stepOnce(); } }, 'Step');
  const resetBtn = h('button.btn.ghost.small', { type: 'button', onclick: () => { pause(); shown = 0; paint(); } }, '↺');
  const speedIn = h('input', { type: 'range', min: 80, max: 900, value: 900 - speed + 80, title: 'Speed',
    oninput: e => { speed = 980 - Number(e.target.value); } });

  async function load() {
    pause();
    data = null; shown = 0;
    caption.textContent = 'Running your query…';
    try {
      data = await api('linqviz', { source: editable ? sourceIn.value : spec.source, query: editable ? queryIn.value : spec.query, setup: spec.setup });
    } catch { data = { error: 'Could not reach the dojo server.', stages: [], events: [] }; }
    paint();
  }

  function stepOnce() {
    if (!data || shown >= data.events.length) return false;
    shown++;
    paint(true);
    return true;
  }
  function play() {
    if (!data) return;
    if (shown >= data.events.length) shown = 0;
    playBtn.textContent = '❚❚ Pause';
    const tick = () => { if (stepOnce()) timer = setTimeout(tick, speed); else pause(); };
    tick();
  }
  function pause() { clearTimeout(timer); timer = null; playBtn.textContent = shown && data && shown < data.events.length ? '▶ Resume' : '▶ Watch it run'; }

  function paint(animateLast) {
    if (!data) return;
    if (data.error) {
      cols.replaceChildren();
      caption.replaceChildren(h('span.bad', data.error));
      result.replaceChildren();
      return;
    }
    const perStage = data.stages.map(() => []);
    data.events.slice(0, shown).forEach((e, i) => perStage[e.stage]?.push({ text: e.text, i }));
    const last = shown > 0 ? data.events[shown - 1] : null;
    cols.replaceChildren(...data.stages.map((label, s) => {
      const kind = s === 0 ? 'source' : STREAMING.test(label) ? 'streams' : BUFFERING.test(label) ? 'buffers' : '';
      return h(`div.lv-col${last?.stage === s ? '.active' : ''}`,
        h('div.lv-head', h('code', label), kind && h(`span.lv-kind.${kind}`, kind === 'streams' ? 'streams' : kind === 'buffers' ? 'buffers' : 'source')),
        h('div.lv-items', perStage[s].map((it, k) => h(`span.lv-item${animateLast && it.i === shown - 1 ? '.fresh' : ''}`, it.text))),
        h('div.lv-count.small.muted', `${perStage[s].length}`));
    }));
    // Narrate the latest event in plain words.
    if (!last) caption.textContent = data.lazy
      ? `Nothing has run yet. Building the query did no work: it only runs when something pulls items out (here, a foreach). ${data.events.length} steps to watch.`
      : 'Press play to watch the items flow.';
    else {
      const label = data.stages[last.stage];
      const next = data.events[shown];
      caption.replaceChildren(h('span', { html: last.stage === 0
        ? `The source hands out <b>${esc(last.text)}</b>.`
        : `<code>${esc(label)}</code> passes on <b>${esc(last.text)}</b>.` }),
        shown >= data.events.length ? h('span.muted', ' Done.') : '',
        next && next.stage === 0 && last.stage > 0 ? h('span.muted', ' Then the pipeline goes back to the source for the next item.') : '',
        next && next.stage === 0 && last.stage === 0 && data.stages.length > 1 && perStage[1].length === 0 && shown > 1 ? h('span.muted', ' The next operator is still holding back: it needs every item before it can give out the first.') : '');
    }
    result.replaceChildren(shown >= data.events.length && data.result != null
      ? h('div', h('span.muted.small', 'Result: '), h('code', data.result))
      : '');
  }

  load();
  if (autoplay) setTimeout(play, 300);
  return h('div.lv',
    h('div.lv-title', h('b', 'LINQ in motion'), h('span.muted.small', ' runs for real; each chip is one item leaving that stage')),
    editable && h('div.lv-inputs',
      h('label', h('span.small.muted', 'Source'), sourceIn),
      h('label', h('span.small.muted', 'Query'), queryIn),
      h('button.btn.ghost.small', { type: 'button', onclick: load }, 'Run it')),
    h('div.lv-controls', playBtn, stepBtn, resetBtn, h('span.muted.small', 'speed'), speedIn),
    cols, caption, result);
}
