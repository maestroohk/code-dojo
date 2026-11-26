// Pipeline builder: a CI/CD workflow from bricks. Jobs wired with needs, a trigger, artifacts passed
// between jobs, caches, a matrix, if: conditions, deployment environments with reviewers, and secrets.
// Run it for a push to main, a pull request, or a pull request from a fork, and watch the jobs start,
// run in parallel, fail, get skipped or wait for approval, each with the reason; a timeline shows where
// the minutes go. The generated GitHub Actions workflow follows every change.
// The simulation lives in pipesim.js (DOM-free, tested in Node); the page shell in buildlab.js.
import { h } from './util.js';
import { builderLab, controls, fill } from './buildlab.js';
import * as P from './pipesim.js';

const COLORS = { trigger: '#5f5590', job: '#2a6aa8', environment: '#b8572a', secrets: '#8a3f5a' };
const KINDS = Object.fromEntries(Object.entries(P.KINDS).map(([k, v]) => [k, { ...v, color: COLORS[k], width: k === 'job' ? 230 : 210 }]));
const STATUS_TONE = { success: 'ok', failure: 'bad', skipped: 'skip' };

export function pipeBuildLab(container, onXp) {
  return builderLab(container, onXp, {
    lab: 'pipebuild',
    sim: P,
    costLabel: 'blocks + wires',
    board: api => boardOptions(api),
    form: api => formView(api),
    actions: () => [
      { id: 'push-main', label: '▶ Push to main', title: 'git push to main' },
      { id: 'pr', label: '⎇ Pull request', title: 'A pull request from a branch in this repository' },
      { id: 'fork', label: '⑂ Pull request from a fork', title: 'A pull request from someone else\'s copy of the repository: no secrets' },
      { id: 'cache3', label: '↻ Three runs (cache)', title: 'Push to main three times: cold cache, warm cache, then after package-lock.json changed' },
    ],
    run: (m, id) => runIt(m, id),
    yaml: { title: '.github/workflows/ci.yml', text: P.toYaml, note: 'The GitHub Actions workflow for this board (read-only here: change the board or the inspector).' },
  });
}

function boardOptions(api) {
  const m = () => api.model;
  const blk = id => P.byId(m(), id);
  const { field, text, num, check, select, lines } = controls(api.changed, api.say);
  const allSecrets = () => [...new Set([...(m().blocks.find(b => b.kind === 'secrets')?.names || []), ...m().blocks.filter(b => b.kind === 'environment').flatMap(e => e.secrets)])];
  const nameOk = b => v => {
    if (b.kind === 'job' && !P.validName(v)) return 'A job id uses letters, digits, - and _, and starts with a letter or _.';
    if (!v) return 'A name is needed.';
    if (m().blocks.some(x => x !== b && x.kind === b.kind && x.name === v)) return `There is already a ${KINDS[b.kind].label.toLowerCase()} called ${v}.`;
    return true;
  };

  function add(kind, at) {
    if (kind === 'secrets' && m().blocks.some(b => b.kind === 'secrets')) return 'There is one secrets store per repository: add names to it in the inspector.';
    const base = { job: 'job', environment: 'staging', secrets: 'Repository secrets' }[kind];
    let i = 1, name = base;
    while (m().blocks.some(b => b.kind === kind && b.name === name)) name = `${base}${++i}`;
    let id = kind + '-' + name.replace(/\W/g, '');
    while (blk(id)) id += 'x';
    const b = P.block(kind, id, name, at.x, at.y);
    m().blocks.push(b);
    api.changed();
    return b;
  }

  function body(b) {
    const line = t => h('div.ab-line', t);
    const tag = (t, tone = '') => h(`span.bk-tag${tone ? '.' + tone : ''}`, t);
    if (b.kind === 'trigger') return [h('div.bk-name', 'on:'), b.push ? line(`push: ${b.branches || 'any branch'}`) : line('no push trigger'), line(b.pr ? 'pull_request' : 'no pull_request trigger')];
    if (b.kind === 'job') {
      const p = P.PRESETS[b.preset];
      return [h('div.bk-name', b.name), line(`${p?.label || b.preset} · ${P.mmss(Number(b.seconds) || 0)}${p?.install ? ' + npm ci' : ''}`),
        h('div.bk-tags', b.upload && tag(`⬆ ${b.upload}`), b.download && tag(`⬇ ${b.download}`), b.cache !== 'none' && tag(`cache: ${b.cache}`), P.matrixOf(b).length > 0 && tag(`matrix ${P.matrixOf(b).join('/')}`),
          b.cond && tag(`if: ${b.cond}`, 'warn'), b.environment && tag(`env: ${b.environment}`), b.secret && tag(`🔑 ${b.secret}`), b.fails && tag(b.failOn ? `fails on ${b.failOn}` : 'fails', 'bad'))];
    }
    if (b.kind === 'environment') return [h('div.bk-name', b.name), line(b.reviewers ? 'required reviewers' : 'no reviewers'), line(`branches: ${b.branches || 'any'}`), line(`secrets: ${b.secrets.join(', ') || 'none'}`)];
    return [h('div.bk-name', b.name), b.names.length ? b.names.map(n => line(`${n}: ••••`)) : line('none')];
  }

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click a block or a wire to configure it.');
    if (sel.type === 'wire') {
      const w = m().wires.find(x => x.id === sel.id);
      if (w) {
        const f = blk(w.from), t = blk(w.to);
        return h('div.pk-inspect', h('div.pk-inspect-head', h('b', `${t.name} needs ${f.name}`), h('button.btn.ghost.small', { type: 'button', onclick: () => { m().wires = m().wires.filter(x => x !== w); api.changed(); } }, 'Remove')),
          h('p', `${t.name} starts only after ${f.name} has finished, and by default only if it succeeded. Without needs, jobs start at the same moment, each on its own fresh machine.`));
      }
      const r = P.refs(m()).find(x => x.id === sel.id);
      if (!r) return null;
      const j = blk(r.kind === 'start' ? r.to : r.from);
      if (r.kind === 'start') return h('div.pk-inspect', h('p', `${j.name} needs no other job, so it starts as soon as the workflow is triggered.`));
      return h('div.pk-inspect', h('div.pk-inspect-head', h('b', r.kind === 'env' ? `${j.name} deploys to ${j.environment}` : `${j.name} uses ${j.secret}`),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { if (r.kind === 'env') j.environment = ''; else j.secret = ''; api.changed(); } }, 'Remove')),
        h('p.muted.small', r.kind === 'env' ? 'The environment\'s rules (reviewers, allowed branches) apply before the job starts, and its secrets become available to this job only.' : 'A repository secret is available to every job in every workflow run, except runs for pull requests from forks.'));
    }
    const b = blk(sel.id);
    if (!b) return null;
    const k = KINDS[b.kind];
    const parts = [h('div.pk-inspect-head', h('b', `${k.icon} ${k.label}`),
      h('button.btn.ghost.small', { type: 'button', disabled: !!b.fixed, onclick: () => { m().blocks = m().blocks.filter(x => x !== b); m().wires = m().wires.filter(w => w.from !== b.id && w.to !== b.id); api.changed(); } }, 'Delete'))];
    if (b.kind === 'trigger') {
      parts.push(check(b, 'push', 'on: push'), b.push && field('Branches (comma separated)', text(b, 'branches', 'main'), 'Empty means every branch. feature/* matches feature/login.'),
        check(b, 'pr', 'on: pull_request'), h('p.muted.small', 'Pull request runs test the code before it is merged. Runs from forks get no secrets.'));
      return h('div.pk-inspect', parts);
    }
    parts.push(field('Name', text(b, 'name', '', nameOk(b))));
    if (b.kind === 'job') {
      const envs = m().blocks.filter(x => x.kind === 'environment');
      parts.push(
        h('div.pk-two', field('Does', h('select', { onchange: e => { b.preset = e.target.value; b.seconds = P.PRESETS[b.preset].seconds; api.changed(); } },
          Object.entries(P.PRESETS).map(([v, p]) => h('option', { value: v, selected: b.preset === v }, p.label)))), field('Seconds of work', num(b, 'seconds', { min: 1, max: 3600 }))),
        h('p.muted.small', `Runs ${P.PRESETS[b.preset]?.run}.${P.PRESETS[b.preset]?.install ? ' Installs dependencies with npm ci first.' : ''}`),
        h('div.pk-two', field('Uploads artifact', text(b, 'upload', 'dist')), field('Downloads artifact', text(b, 'download', 'dist'))),
        P.PRESETS[b.preset]?.install && field('Cache node_modules', select(b, 'cache', Object.entries(P.CACHES))),
        field('Matrix: node versions (comma separated)', text(b, 'matrix', '18, 20, 22'), 'One copy of the job per value, all in parallel.'),
        field('Run if', select(b, 'cond', Object.entries(P.CONDITIONS).map(([v, c]) => [v, c.label]))),
        field('Environment', select(b, 'environment', [['', '(none)'], ...envs.map(e => [e.name, e.name])])),
        field('Uses secret', select(b, 'secret', [['', '(none)'], ...allSecrets().map(s => [s, s])]), 'Read as ${{ secrets.NAME }}.'),
        h('div.eyebrow', 'Break it'),
        check(b, 'fails', 'This job fails'),
        b.fails && field('…only on this matrix value', text(b, 'failOn', 'e.g. 18'), 'Empty: it fails everywhere.'),
        h('p.muted.small', 'Drag ▶ onto another job (it needs this one), an environment or the secrets.'));
    }
    if (b.kind === 'environment') parts.push(check(b, 'reviewers', 'Required reviewers: a person must approve each deployment'),
      field('Allowed branches', text(b, 'branches', 'main'), 'Only runs for these branches may deploy here. Empty: any.'),
      field('Environment secrets (names, one per line)', lines(b, 'secrets', 'DEPLOY_TOKEN', 2), 'Only jobs that name this environment can read them, and only after approval.'));
    if (b.kind === 'secrets') parts.push(field('Secret names (one per line)', lines(b, 'names', 'NPM_TOKEN', 3)),
      h('p.muted.small', 'Repository secrets reach every job in every run, on every branch, except pull requests from forks. Keep powerful tokens in an environment instead.'));
    return h('div.pk-inspect', parts);
  }

  return {
    kinds: KINDS,
    wireKinds: { needs: { label: '' }, start: { label: '', color: '#7d74b8' }, env: { label: '', color: '#c98a5a' }, secret: { label: '', color: '#b06a85' } },
    wires: () => [...m().wires.map(w => ({ id: w.id, kind: 'needs', from: { block: w.from, port: 'out' }, to: { block: w.to } })),
      ...P.refs(m()).map(r => ({ id: r.id, kind: r.kind, from: { block: r.from, port: r.kind === 'start' ? null : 'out' }, to: { block: r.to }, r }))],
    ports: b => (P.TARGETS[b.kind].length ? [{ id: 'out', label: '', on: m().wires.some(w => w.from === b.id), title: 'Drag onto a job (it will need this one), an environment or the secrets' }] : []),
    body,
    canConnect: (from, port, to) => P.canWire(m(), from, to),
    connect: (from, port, to) => {
      const msg = P.connect(m(), from.id, to.id);
      if (!msg) return `A ${KINDS[from.kind].label} cannot be wired to a ${KINDS[to.kind].label}.`;
      api.changed(); api.say(msg);
      return false;
    },
    onDropEmpty: () => { api.say('To remove a wire, click it and press Delete.'); return false; },
    palette: [
      { kind: 'job', title: 'Add a job: runs on its own fresh machine', add: at => add('job', at) },
      { kind: 'environment', title: 'Add a deployment environment: reviewers, branch rules, its own secrets', add: at => add('environment', at) },
      { kind: 'secrets', title: 'Add the repository secrets store', add: at => add('secrets', at) },
    ],
    howto: 'Drag a job\'s ▶ onto the job that must wait for it (needs). Click to configure; Delete removes. Wheel zooms.',
    inspector,
    onDelete: sel => {
      if (sel.type === 'wire') {
        if (m().wires.some(w => w.id === sel.id)) m().wires = m().wires.filter(w => w.id !== sel.id);
        else {
          const r = P.refs(m()).find(x => x.id === sel.id);
          if (r?.kind === 'env') blk(r.from).environment = '';
          else if (r?.kind === 'secret') blk(r.from).secret = '';
          else { api.say('This line only shows that the job starts first. Give it needs to change that.'); return; }
        }
      } else {
        const b = blk(sel.id);
        if (!b) return;
        if (b.fixed) { api.say('The trigger stays: a workflow always has an on: section.'); return; }
        m().blocks = m().blocks.filter(x => x !== b);
        m().wires = m().wires.filter(w => w.from !== b.id && w.to !== b.id);
      }
      api.changed();
    },
    wireLabel: w => (w.kind === 'secret' ? w.r.label : w.kind === 'needs' ? 'needs' : ''),
    blockClass: b => (b.fixed ? 'fixed' : ''),
  };
}

function formView(api) {
  const m = api.model;
  const { text, select } = controls(api.changed, api.say);
  let a = '', z = '';
  const list = P.jobs(m);
  return h('div.nb-form',
    h('table.nb-ftable',
      h('tr', h('th', 'Job'), h('th', 'Needs'), h('th', 'Artifacts ⬆ / ⬇'), h('th', 'Run if'), h('th', 'Environment')),
      list.map(j => h('tr', { onclick: e => { if (!e.target.closest('input,button,select')) api.select({ type: 'block', id: j.id }); } },
        h('td', h('b', j.name), h('div.muted.small', P.PRESETS[j.preset]?.label)),
        h('td.small', P.needsOf(m, j).map(n => h('div', n.name, ' ', h('button.btn.ghost.small', { type: 'button', onclick: () => { m.wires = m.wires.filter(w => !(w.from === n.id && w.to === j.id)); api.changed(); } }, '✕'))),
          P.needsOf(m, j).length ? '' : h('span.muted', 'starts first')),
        h('td', text(j, 'upload', '⬆ name'), text(j, 'download', '⬇ name')),
        h('td', select(j, 'cond', Object.entries(P.CONDITIONS).map(([v, c]) => [v, c.label]))),
        h('td.small', j.environment || h('span.muted', '—'))))),
    h('div.eyebrow', 'Add needs'),
    h('div.nb-cable-add',
      h('select', { onchange: e => { z = e.target.value; } }, h('option', { value: '' }, 'job…'), list.map(j => h('option', { value: j.id }, j.name))),
      h('span', 'needs'),
      h('select', { onchange: e => { a = e.target.value; } }, h('option', { value: '' }, 'job…'), list.map(j => h('option', { value: j.id }, j.name))),
      h('button.btn.primary.small', { type: 'button', onclick: () => { if (!a || !z || a === z) { api.say('Pick two different jobs.'); return; } P.connect(m, a, z); api.changed(); } }, 'Add')),
    h('p.muted.small', 'Click a row for caches, matrix, secrets and the rest in the inspector.'));
}

function runIt(m, id) {
  if (id === 'cache3') {
    const runs = [P.run(m, 'push-main', { runNo: 1 }), P.run(m, 'push-main', { runNo: 2 }), P.run(m, 'push-main', { runNo: 3, lockChanged: true })];
    const first = runs[0];
    if (first.error || first.triggered === false) return { ok: false, verdict: first.error || first.why, steps: [] };
    const labels = ['Run 1: cold, nothing cached yet', 'Run 2: same lockfile', 'Run 3: someone changed package-lock.json'];
    const steps = [];
    runs.forEach((r, i) => {
      steps.push({ who: `run ${i + 1}`, tone: 'info', text: `${labels[i]}. Total ${P.mmss(r.wall)}.` });
      for (const s of r.steps.filter(s => /cache|npm ci/.test(s.text))) steps.push({ at: P.mmss(s.at), who: s.who, tone: s.text.includes('OLD') ? 'bad' : s.tone, text: s.text });
    });
    const stale = runs[2].jobs && [...runs[2].jobs.values()].some(j => j.stale);
    const gain = runs[0].wall - runs[1].wall;
    return { ok: gain > 0 && !stale, verdict: `${runs.map((r, i) => `run ${i + 1}: ${P.mmss(r.wall)}`).join(' · ')}.${gain > 0 ? ` The warm run saved ${P.mmss(gain)}.` : ' No time saved: nothing is cached.'}${stale ? ' Run 3 restored stale dependencies.' : ''}`,
      steps, panel: h('div', runs.map((r, i) => timeline(m, r, labels[i]))) };
  }
  const r = P.run(m, id);
  if (r.error) return { ok: false, verdict: r.error, steps: [] };
  if (!r.triggered) return { ok: false, verdict: `No workflow run. ${r.why}`, steps: [{ who: 'GitHub', tone: 'bad', text: r.why }] };
  const steps = r.steps.map(s => ({ at: P.mmss(s.at), who: s.who, tone: s.tone, text: s.text }));
  const marks = {}, wires = {};
  for (const [jid, x] of r.jobs) marks[jid] = STATUS_TONE[x.status];
  for (const w of m.wires) { const t = r.jobs.get(w.to); wires[w.id] = t?.status === 'success' ? 'ok' : t?.status === 'failure' ? 'bad' : ''; }
  const trig = m.blocks.find(b => b.kind === 'trigger');
  const tokens = [];
  const roots = P.jobs(m).filter(j => !P.needsOf(m, j).length);
  for (const j of roots) if (trig) tokens.push({ hops: [{ from: trig.id, to: j.id }], label: '', endCls: STATUS_TONE[r.jobs.get(j.id)?.status] === 'bad' ? 'bad' : 'ok' });
  for (const w of m.wires) { const t = r.jobs.get(w.to); if (t && t.status !== 'skipped') tokens.push({ hops: [{ from: w.from, to: w.to }], endCls: t.status === 'success' ? 'ok' : 'bad' }); }
  const list = [...r.jobs.values()];
  const n = s => list.filter(x => x.status === s).length;
  let verdict = `${r.conclusion === 'success' ? 'Run succeeded' : 'Run failed'} in ${P.mmss(r.wall)}: ${n('success')} succeeded, ${n('failure')} failed, ${n('skipped')} skipped.${r.deployed ? ' Deployed.' : ' Nothing deployed.'}`;
  if (r.shippedBroken) { verdict += ' Tests failed, and it deployed anyway.'; steps.push({ who: 'run', tone: 'bad', text: 'Shipped broken code: a test job failed, but the deploy job did not wait for it.' }); }
  return { ok: r.conclusion === 'success' && !r.shippedBroken, verdict, steps, tokens, marks, wires, panel: timeline(m, r, `Timeline · ${r.event.label}`) };
}

function timeline(m, r, title) {
  const el = h('div.yb-card');
  if (!r.jobs) { fill(el, h('div.eyebrow', title), h('p.muted.small', r.error || r.why)); return el; }
  const wall = Math.max(1, r.wall);
  const rows = [...r.jobs.values()].sort((a, b) => a.start - b.start || (a.name < b.name ? -1 : 1));
  fill(el, h('div.eyebrow', `${title} · ${P.mmss(r.wall)}`),
    h('div.yb-gantt', rows.map(x => h('div.yb-gantt-row',
      h('span.yb-gantt-name', x.name),
      h('span.yb-gantt-track', h(`span.yb-gantt-bar.${STATUS_TONE[x.status]}`, {
        style: { left: `${(x.start / wall) * 100}%`, width: `${Math.max(1.5, ((x.end - x.start) / wall) * 100)}%` },
        title: `${x.name}: ${x.status}, ${P.mmss(x.start)} → ${P.mmss(x.end)}${x.why ? ` · ${x.why}` : ''}`,
      })),
      h('span.small.muted', x.status === 'skipped' ? 'skipped' : P.mmss(x.end - x.start))))),
    h('p.muted.small', 'Bars that overlap run in parallel. The run takes as long as its longest chain of needs.'));
  return el;
}
