// Visuals for the testing topic (tracks/testing), on learn cards as "testviz" (checked by server/TestViz.cs):
//   pyramid   the test pyramid and the testing trophy side by side; pick a layer to see what it costs and catches
//   doubles   one class under test and its five kinds of test double, with NSubstitute and Moq for each
//   mutation  a Stryker-style mutation report: the code, each mutant on its line (killed, survived, timeout,
//             no coverage), the line coverage and the mutation score, so "100% coverage" can be seen to lie
//   tdd       a kata replayed step by step: red, green, refactor, with the test list, the code and why
//   flaky     a grid of repeated runs (one row per test), so the test that sometimes fails stands out
import { h, highlight, md, esc } from './util.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
/** replaceChildren that skips the false/undefined left by cond && h(...) (the DOM would print them). */
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false && k !== ''));
const lines = v => (Array.isArray(v) ? v.join('\n') : String(v ?? '')).replace(/\r\n/g, '\n').replace(/\n$/, '');

export function testViz(spec) {
  switch (spec?.kind) {
    case 'pyramid': return pyramid(spec);
    case 'doubles': return doubles(spec);
    case 'mutation': return mutation(spec);
    case 'tdd': return tdd(spec);
    case 'flaky': return flaky(spec);
    default: return h('div.muted.small', `Unknown testviz kind: ${spec?.kind}`);
  }
}

// ------------------------------------------------------------------ the pyramid and the trophy

const LAYERS = {
  e2e: { name: 'End-to-end', what: 'The whole system through its real front door: a browser (Playwright) or the public API against deployed services.',
    speed: 'seconds to minutes each', count: 'a handful: the journeys that make money (sign up, check out)', catches: 'wiring, configuration and deployment mistakes nothing else sees',
    cost: 'slow, flaky (network, timing, shared data), and a failure says little about where the bug is', tools: 'Playwright, a smoke test after deploy' },
  integration: { name: 'Integration', what: 'Your code with its real neighbours: the HTTP pipeline (TestServer / WebApplicationFactory), a real database (SQLite, Testcontainers), serialization.',
    speed: '10 ms to 1 s each', count: 'many: every endpoint and query that matters', catches: 'routing, model binding, DI registrations, SQL and mapping bugs, JSON contracts',
    cost: 'slower than unit tests and needs setup (a database, a host); still deterministic when done well', tools: 'xUnit + TestServer, EF Core + SQLite in memory, Testcontainers, Verify' },
  unit: { name: 'Unit', what: 'One class or function, in memory, with its awkward dependencies (clock, network, randomness) replaced.',
    speed: 'under a millisecond each', count: 'the most: every rule and edge case', catches: 'logic bugs: boundaries, rounding, state transitions, error paths',
    cost: 'they cannot see wiring, and over-mocked ones break on every refactor while catching nothing', tools: 'xUnit, NSubstitute, FakeTimeProvider' },
  static: { name: 'Static analysis', what: 'Checks that run without running the code: the compiler with nullable reference types and warnings as errors, analyzers, type checkers, linters.',
    speed: 'while you type', count: 'all the code, all the time', catches: 'null dereferences, typos, unused results, whole classes of bugs before any test exists',
    cost: 'almost free once on; noisy rules get ignored, so pick them with care', tools: 'Roslyn analyzers, <Nullable>enable</Nullable>, TreatWarningsAsErrors, mypy, tsc --strict' },
};

function pyramid(spec) {
  const detail = h('div.tv-detail');
  const shapes = [];
  const show = key => {
    const l = LAYERS[key];
    shapes.forEach(p => p.classList.toggle('on', p.dataset.layer === key));
    put(detail, h('h3', l.name),
      h('p', l.what),
      h('dl.tv-facts', h('dt', 'Speed'), h('dd', l.speed), h('dt', 'How many'), h('dd', l.count), h('dt', 'Catches'), h('dd', l.catches),
        h('dt', 'Costs'), h('dd', l.cost), h('dt', 'Tools'), h('dd', l.tools)));
  };
  const band = (points, key, label, x, y) => {
    const poly = s('polygon', { points, class: `tv-layer tv-${key}`, tabindex: 0, role: 'button', 'aria-label': LAYERS[key].name });
    poly.dataset.layer = key;
    poly.addEventListener('click', () => show(key));
    poly.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(key); } });
    shapes.push(poly);
    return [poly, s('text', { x, y, class: 'tv-label', 'text-anchor': 'middle' }, label)];
  };
  // Pyramid (Mike Cohn, 2009): many unit tests, fewer integration tests, very few end-to-end.
  const pyr = s('g', {},
    band('150,20 195,85 105,85', 'e2e', 'E2E', 150, 66),
    band('105,85 195,85 245,160 55,160', 'integration', 'Integration', 150, 128),
    band('55,160 245,160 290,235 10,235', 'unit', 'Unit', 150, 203),
    s('text', { x: 150, y: 262, class: 'tv-caption', 'text-anchor': 'middle' }, 'Test pyramid'));
  // Trophy (Kent C. Dodds, 2018): static analysis as the base, integration as the widest part.
  const tro = s('g', { transform: 'translate(320,0)' },
    band('125,20 175,20 170,60 130,60', 'e2e', 'E2E', 150, 46),
    band('70,60 230,60 245,150 55,150', 'integration', 'Integration', 150, 110),
    band('95,150 205,150 195,200 105,200', 'unit', 'Unit', 150, 180),
    band('80,200 220,200 235,235 65,235', 'static', 'Static', 150, 223),
    s('text', { x: 150, y: 262, class: 'tv-caption', 'text-anchor': 'middle' }, 'Testing trophy'));
  const svg = s('svg', { viewBox: '0 0 620 272', class: 'tv-svg', role: 'img', 'aria-label': 'The test pyramid and the testing trophy' },
    pyr, tro,
    s('text', { x: 338, y: 30, class: 'tv-axis', 'text-anchor': 'middle' }, 'slower,'),
    s('text', { x: 338, y: 44, class: 'tv-axis', 'text-anchor': 'middle' }, 'costlier ↑'),
    s('text', { x: 338, y: 228, class: 'tv-axis', 'text-anchor': 'middle' }, 'faster,'),
    s('text', { x: 338, y: 242, class: 'tv-axis', 'text-anchor': 'middle' }, 'cheaper ↓'));
  show(spec.highlight && LAYERS[spec.highlight] ? spec.highlight : 'unit');
  return h('div.testviz.tv-pyramid', h('div.tv-head', h('b', 'The pyramid and the trophy'), h('span.muted.small', 'Pick a layer.')), svg, detail);
}

// ------------------------------------------------------------------ test doubles

const DOUBLES = [
  { key: 'dummy', name: 'Dummy', dir: 'none', what: 'Passed only to fill a parameter. Never used by the code path under test.',
    use: 'A constructor needs an ILogger but this test never logs.',
    nsub: 'var logger = Substitute.For<ILogger<Checkout>>();   // or NullLogger<Checkout>.Instance',
    moq: 'var logger = Mock.Of<ILogger<Checkout>>();' },
  { key: 'stub', name: 'Stub', dir: 'in', what: 'Feeds canned answers INTO the class under test. You assert on the result, never on the stub.',
    use: 'Rates return 1.10 for EUR, so the test controls the input it cannot otherwise control.',
    nsub: 'var rates = Substitute.For<IRates>();\nrates.Get("EUR").Returns(1.10m);',
    moq: 'var rates = new Mock<IRates>();\nrates.Setup(r => r.Get("EUR")).Returns(1.10m);' },
  { key: 'spy', name: 'Spy', dir: 'out', what: 'Records what the class under test sent OUT, so the test can look at it afterwards.',
    use: 'Capture the email body that was sent and assert on its text.',
    nsub: 'string? body = null;\nmailer.Send(Arg.Any<string>(), Arg.Do<string>(b => body = b));\n// act, then:\nAssert.Contains("Order 42", body);',
    moq: 'string? body = null;\nmailer.Setup(m => m.Send(It.IsAny<string>(), It.IsAny<string>()))\n      .Callback<string, string>((_, b) => body = b);' },
  { key: 'mock', name: 'Mock', dir: 'out', what: 'Verifies an outgoing command happened (or did not). Use it for side effects that ARE the behaviour.',
    use: 'Placing an order must publish OrderPlaced exactly once.',
    nsub: 'bus.Received(1).Publish(Arg.Is<OrderPlaced>(e => e.OrderId == 42));\nbus.DidNotReceive().Publish(Arg.Any<OrderCancelled>());',
    moq: 'bus.Verify(b => b.Publish(It.Is<OrderPlaced>(e => e.OrderId == 42)), Times.Once);' },
  { key: 'fake', name: 'Fake', dir: 'both', what: 'A real, lightweight working implementation: an in-memory repository, FakeTimeProvider, SQLite in memory.',
    use: 'Save an order, read it back: state, not interactions. Fakes survive refactors best.',
    nsub: 'var repo = new InMemoryOrderRepository();      // hand-written, ~20 lines\nvar clock = new FakeTimeProvider(start);\nclock.Advance(TimeSpan.FromDays(31));',
    moq: '// Fakes are written by hand (or come with the library: FakeTimeProvider, FakeLogger); no mocking library needed.' },
];

function doubles() {
  const detail = h('div.tv-detail');
  const nodes = [];
  const show = key => {
    const d = DOUBLES.find(x => x.key === key);
    nodes.forEach(n => n.classList.toggle('on', n.dataset.key === key));
    put(detail, h('h3', d.name),
      h('p', d.what), h('p.muted', h('b', 'Typical use: '), d.use),
      h('div.tv-two',
        h('div', h('div.field-label', 'NSubstitute'), h('pre.code', h('code', { html: highlight(d.nsub, 'csharp') }))),
        h('div', h('div.field-label', 'Moq'), h('pre.code', h('code', { html: highlight(d.moq, 'csharp') })))));
  };
  const W = 620, cx = 310, cy = 150;
  const pos = [[90, 50], [90, 250], [530, 50], [530, 250], [310, 30]];
  const g = s('g', {});
  g.append(s('rect', { x: cx - 95, y: cy - 30, width: 190, height: 60, rx: 10, class: 'tv-sut' }),
    s('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', class: 'tv-label' }, 'Checkout'),
    s('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', class: 'tv-caption' }, 'class under test'));
  DOUBLES.forEach((d, i) => {
    const [x, y] = d.key === 'fake' ? [310, 268] : pos[i];
    const toSut = [cx + (x < cx ? -95 : x > cx ? 95 : 0), cy + (y < cy ? -30 : 30)];
    const from = [x + (x < cx ? 70 : x > cx ? -70 : 0), y + (x === cx ? (y < cy ? 18 : -18) : 0)];
    const [a, b] = d.dir === 'in' ? [from, toSut] : [toSut, from];
    if (d.dir !== 'none') g.append(s('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: `tv-arrow tv-${d.dir}`, 'marker-end': 'url(#tv-head)', 'marker-start': d.dir === 'both' ? 'url(#tv-head)' : null }));
    else g.append(s('line', { x1: from[0], y1: from[1], x2: toSut[0], y2: toSut[1], class: 'tv-arrow tv-none' }));
    const node = s('g', { class: 'tv-double', tabindex: 0, role: 'button', 'aria-label': d.name });
    node.dataset.key = d.key;
    node.append(s('rect', { x: x - 70, y: y - 18, width: 140, height: 36, rx: 18 }), s('text', { x, y: y + 5, 'text-anchor': 'middle' }, d.name));
    node.addEventListener('click', () => show(d.key));
    node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(d.key); } });
    nodes.push(node);
    g.append(node);
  });
  const svg = s('svg', { viewBox: `0 0 ${W} 300`, class: 'tv-svg', role: 'img', 'aria-label': 'Five kinds of test double around a class under test' },
    s('defs', {}, s('marker', { id: 'tv-head', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'tv-headfill' }))),
    g);
  show('stub');
  return h('div.testviz.tv-doubles', h('div.tv-head', h('b', 'Test doubles'), h('span.muted.small', 'Arrows into the class are inputs (stubs). Arrows out are outputs you check (spies, mocks). Pick one.')), svg, detail);
}

// ------------------------------------------------------------------ mutation report

const STATUS = { killed: ['Killed', 'a test failed: the bug was caught'], survived: ['Survived', 'every test still passed: nothing checks this'],
  timeout: ['Timeout', 'the tests hung: counted as caught, like Stryker does'], nocoverage: ['No coverage', 'no test even runs this line'] };

function mutation(spec) {
  const code = lines(spec.code).split('\n');
  const mutants = spec.mutants || [];
  const covered = new Set(spec.covered || []);
  const hasCoverage = Array.isArray(spec.covered);
  const detail = h('div.tv-detail', h('p.muted.small', 'Pick a mutant (a coloured mark) to see the change and who caught it.'));
  const marks = [];
  const pick = m => {
    marks.forEach(x => x.classList.toggle('on', x._m === m));
    const line = code[m.line - 1];
    const changed = line.replace(m.from, m.to);
    put(detail, 
      h('div', h(`span.tv-status.${m.status}`, STATUS[m.status][0]), ' ', h('span.muted.small', STATUS[m.status][1])),
      m.name && h('p', h('b', m.name)),
      h('pre.code.tv-diff', h('code', { html: `<span class="tv-minus">- ${esc(line.trim())}</span>\n<span class="tv-plus">+ ${esc(changed.trim())}</span>` })),
      m.by && h('p.small', h('b', 'Caught by: '), h('code', m.by)),
      m.status === 'survived' && h('p.small', m.hint || 'Write the test that would fail on this change. Usually it sits right on a boundary or checks a value nobody looks at.'));
  };
  const rows = code.map((text, i) => {
    const n = i + 1;
    const here = mutants.filter(m => m.line === n);
    const cov = hasCoverage ? h(`span.tv-cov${covered.has(n) ? '.yes' : text.trim() ? '.no' : ''}`, { title: covered.has(n) ? 'covered: a test runs this line' : '' }) : null;
    const dots = here.map(m => { const b = h(`button.tv-mut.${m.status}`, { type: 'button', title: `${STATUS[m.status][0]}: ${m.from} → ${m.to}`, onclick: () => pick(m) }); b._m = m; marks.push(b); return b; });
    return h('div.tv-line', h('span.tv-ln', String(n)), cov, h('span.tv-dots', dots), h('code', { html: highlight(text, spec.lang || 'csharp') || ' ' }));
  });
  const detected = mutants.filter(m => m.status === 'killed' || m.status === 'timeout').length;
  const score = mutants.length ? Math.round(100 * detected / mutants.length) : 0;
  const codeLines = code.filter(t => t.trim() && !/^\s*[{}]\s*$/.test(t)).length;
  const covPct = hasCoverage && codeLines ? Math.round(100 * Math.min(covered.size, codeLines) / codeLines) : null;
  const bar = (label, pct, cls) => h('div.tv-bar', h('span.small', label), h('div.tv-track', h(`div.tv-fill.${cls}`, { style: `width:${pct}%` })), h('b', `${pct}%`));
  const counts = Object.keys(STATUS).map(k => [k, mutants.filter(m => m.status === k).length]).filter(([, c]) => c);
  return h('div.testviz.tv-mutation',
    h('div.tv-head', h('b', `Mutation report: ${spec.file || 'the code'}`), h('span.muted.small', spec.tool || 'in the style of Stryker.NET')),
    h('div.tv-bars', covPct != null && bar('Line coverage', covPct, 'cov'), bar('Mutation score', score, score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad')),
    h('div.tv-legend', counts.map(([k, c]) => h(`span.tv-status.${k}`, `${STATUS[k][0]} ${c}`))),
    h('div.tv-code', rows), detail);
}

// ------------------------------------------------------------------ TDD replay

function tdd(spec) {
  const steps = spec.steps || [];
  let at = 0;
  const ring = s('svg', { viewBox: '0 0 120 120', class: 'tv-ring', 'aria-hidden': 'true' });
  const arcs = ['red', 'green', 'refactor'].map((p, i) => {
    const a0 = (i * 120 - 90) * Math.PI / 180, a1 = ((i + 1) * 120 - 94) * Math.PI / 180;
    const pt = a => [60 + 48 * Math.cos(a), 60 + 48 * Math.sin(a)];
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    const path = s('path', { d: `M${x0},${y0} A48,48 0 0 1 ${x1},${y1}`, class: `tv-arc tv-${p}` });
    ring.append(path);
    return [p, path];
  });
  const phaseText = s('text', { x: 60, y: 66, 'text-anchor': 'middle', class: 'tv-label' }, '');
  ring.append(phaseText);
  const list = h('ul.tv-list');
  const codeEl = h('pre.code', h('code'));
  const note = h('div.tv-note');
  const counter = h('span.muted.small');
  const go = i => {
    at = Math.max(0, Math.min(steps.length - 1, i));
    const st = steps[at];
    arcs.forEach(([p, path]) => path.classList.toggle('on', p === st.phase));
    phaseText.textContent = st.phase === 'refactor' ? 'REFACTOR' : st.phase.toUpperCase();
    put(list, ...(st.list || []).map(item => {
      const done = /^\[x\]\s*/i.test(item), now = /^\[>\]\s*/.test(item);
      return h(`li${done ? '.done' : now ? '.now' : ''}`, item.replace(/^\[[x> ]\]\s*/i, ''));
    }));
    codeEl.firstChild.innerHTML = highlight(lines(st.code), spec.lang || 'csharp');
    note.innerHTML = md(lines(st.note));
    note.className = `tv-note tv-${st.phase}`;
    counter.textContent = `Step ${at + 1} of ${steps.length}`;
    prev.disabled = at === 0; next.disabled = at === steps.length - 1;
  };
  const prev = h('button.btn.ghost.small', { type: 'button', onclick: () => go(at - 1), 'aria-label': 'Previous step' }, '◀ Back');
  const next = h('button.btn.primary.small', { type: 'button', onclick: () => go(at + 1), 'aria-label': 'Next step' }, 'Next ▶');
  const el = h('div.testviz.tv-tdd', { tabindex: 0 },
    h('div.tv-head', h('b', spec.title || 'Red, green, refactor'), counter),
    h('div.tv-tdd-grid', h('div.tv-side', ring, (steps.some(x => x.list)) && h('div', h('div.field-label', 'Test list'), list)), h('div.tv-main', note, codeEl)),
    h('div.ct-controls', prev, next));
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { go(at + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(at - 1); e.preventDefault(); }
  });
  if (steps.length) go(0);
  return el;
}

// ------------------------------------------------------------------ flaky test grid

function flaky(spec) {
  const tests = spec.tests || [];
  const runs = tests[0]?.runs?.length || 0;
  const detail = h('div.tv-detail', h('p.muted.small', 'Pick a row to see why that test behaves the way it does.'));
  const rows = tests.map(t => {
    const fails = [...t.runs].filter(c => c === 'F').length;
    const flakyRow = fails > 0 && fails < [...t.runs].filter(c => c !== 'S').length;
    const row = h(`button.tv-frow${flakyRow ? '.flaky' : fails ? '.broken' : ''}`, { type: 'button', onclick: () => {
      rowsEls.forEach(r => r.classList.toggle('on', r === row));
      put(detail, h('h3', t.name),
        h('p', flakyRow ? `Flaky: failed ${fails} of ${t.runs.length} runs with no code change.` : fails ? 'Fails every time: a real bug or a broken test, not flakiness.' : 'Passed every run.'),
        t.cause && h('div', { html: md(lines(t.cause)) }));
    } },
    h('span.tv-fname', t.name),
    h('span.tv-cells', [...t.runs].map((c, i) => h(`span.tv-cell.${c === 'P' ? 'p' : c === 'F' ? 'f' : 's'}`, { title: `run ${i + 1}: ${c === 'P' ? 'passed' : c === 'F' ? 'failed' : 'skipped'}` }))),
    h('span.tv-rate.small', `${fails}/${t.runs.length}`));
    return row;
  });
  const rowsEls = rows;
  return h('div.testviz.tv-flaky',
    h('div.tv-head', h('b', spec.title || `${runs} runs of the same commit`), h('span.muted.small', spec.subtitle || 'green passed, red failed')),
    h('div.tv-grid', rows), detail);
}
