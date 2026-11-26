// The Pipeline builder's simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
// A model is { blocks, wires }: the trigger (on:), jobs, deployment environments and the repository's
// secrets. A wire from one job to another is `needs` (the arrow points the way the work flows). A job
// also names the artifact it uploads or downloads, its cache key, a matrix, an `if:` condition, the
// environment it deploys to and the secret it uses. run() plays one workflow run on a clock for an
// event (push to main, a pull request, a pull request from a fork): what starts when, what runs in
// parallel, what is skipped and why, artifacts, caches, approvals and secrets. Deterministic.
import * as Y from './miniyaml.js';

export const KINDS = {
  trigger: { label: 'Trigger (on:)', icon: '⚡' },
  job: { label: 'Job', icon: '⚙' },
  environment: { label: 'Environment', icon: '🏭' },
  secrets: { label: 'Repository secrets', icon: '🔑' },
};

/** What each kind of job does. install: it runs npm ci first (so caching helps). */
export const PRESETS = {
  build: { label: 'Build', run: 'npm run build', seconds: 60, install: true },
  lint: { label: 'Lint', run: 'npm run lint', seconds: 30, install: true },
  test: { label: 'Unit tests', run: 'npm test', seconds: 120, install: true, tests: true },
  e2e: { label: 'End-to-end tests', run: 'npm run e2e', seconds: 150, install: true, tests: true },
  coverage: { label: 'Upload coverage', run: 'npx codecov', seconds: 20, install: true },
  deploy: { label: 'Deploy', run: './deploy.sh', seconds: 40, deploys: true },
  notify: { label: 'Notify the team', run: 'curl -X POST "$SLACK_WEBHOOK" -d "CI failed"', seconds: 5 },
};
export const CONDITIONS = {
  '': { label: 'only if every needed job succeeded (default)', expr: null },
  main: { label: 'only on pushes to main', expr: "github.event_name == 'push' && github.ref == 'refs/heads/main'" },
  push: { label: 'only on pushes (not pull requests)', expr: "github.event_name == 'push'" },
  'not-fork': { label: 'not on pull requests from forks', expr: 'github.event.pull_request.head.repo.fork != true' },
  always: { label: 'always, even if a needed job failed', expr: 'always()' },
  failure: { label: 'only if a needed job failed', expr: 'failure()' },
};
export const CACHES = { none: 'no cache', fixed: 'key: deps (a fixed key)', hash: "key: deps-${{ hashFiles('package-lock.json') }}" };
export const EVENTS = {
  'push-main': { label: 'push to main', push: true, branch: 'main', ref: 'refs/heads/main' },
  'push-feature': { label: 'push to feature/login', push: true, branch: 'feature/login', ref: 'refs/heads/feature/login' },
  pr: { label: 'pull request from a branch', pr: true, branch: 'feature/login', ref: 'refs/pull/42/merge' },
  fork: { label: 'pull request from a fork', pr: true, fork: true, branch: 'patch-1', ref: 'refs/pull/43/merge' },
};
const SETUP_S = 10, INSTALL_S = 90, RESTORE_S = 8, STALE_EXTRA_S = 55, APPROVAL_S = 180;

export const DEFAULTS = {
  trigger: { push: true, branches: 'main', pr: false },
  job: { preset: 'build', seconds: 60, needsNone: false, upload: '', download: '', cache: 'none', secret: '', environment: '', cond: '', matrix: '', fails: false, failOn: '' },
  environment: { reviewers: true, branches: 'main', secrets: [] },
  secrets: { names: [] },
};
const clone = o => JSON.parse(JSON.stringify(o));
export const block = (kind, id, name, x = 0, y = 0, settings = {}) => {
  const b = { id, kind, name, x, y, ...clone(DEFAULTS[kind]), ...settings };
  if (kind === 'job' && settings.seconds == null) b.seconds = PRESETS[b.preset]?.seconds ?? 60;
  return b;
};
export const wire = (from, to) => ({ id: `W-${from}-${to}`, from, to });
export const byId = (m, id) => m.blocks.find(b => b.id === id);
export const jobs = m => m.blocks.filter(b => b.kind === 'job');
export const named = (m, kind, name) => m.blocks.find(b => b.kind === kind && b.name === name);
export const validName = n => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(n);
export const needsOf = (m, j) => m.wires.filter(w => w.to === j.id).map(w => byId(m, w.from)).filter(b => b?.kind === 'job');
const repoSecrets = m => m.blocks.find(b => b.kind === 'secrets')?.names || [];
const matrixOf = j => String(j.matrix || '').split(',').map(s => s.trim()).filter(Boolean);
const branchMatch = (pattern, branch) => String(pattern || '').split(',').map(s => s.trim()).filter(Boolean).some(p => p === branch || p === '*' || p === '**' || (p.endsWith('/*') && branch.startsWith(p.slice(0, -1))));
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export const TARGETS = { trigger: [], job: ['job', 'environment', 'secrets'], environment: [], secrets: [] };
export const canWire = (m, f, t) => !!f && !!t && f.id !== t.id && TARGETS[f.kind].includes(t.kind);

/** Drag a job onto another job (that job needs this one), an environment (deploys to it) or the secrets (uses one). */
export function connect(m, fromId, toId) {
  const f = byId(m, fromId), t = byId(m, toId);
  if (!canWire(m, f, t)) return false;
  if (t.kind === 'job') {
    if (!m.wires.some(w => w.from === f.id && w.to === t.id)) m.wires.push(wire(f.id, t.id));
    return `${t.name} now needs ${f.name}: it starts only after ${f.name} succeeds.`;
  }
  if (t.kind === 'environment') { f.environment = t.name; return `${f.name} now deploys to the ${t.name} environment: its protection rules and secrets apply.`; }
  const first = t.names.find(n => n !== f.secret) || t.names[0] || '';
  f.secret = first;
  return first ? `${f.name} now uses the secret ${first}. Change it in the job's inspector.` : 'There are no repository secrets yet.';
}

/** Lines the board draws besides needs: trigger -> first jobs, job -> environment, job -> secret store. */
export function refs(m) {
  const out = [];
  const trig = m.blocks.find(b => b.kind === 'trigger');
  const store = m.blocks.find(b => b.kind === 'secrets');
  for (const j of jobs(m)) {
    if (trig && !needsOf(m, j).length) out.push({ id: `T-${j.id}`, from: trig.id, to: j.id, kind: 'start' });
    const env = j.environment && named(m, 'environment', j.environment);
    if (env) out.push({ id: `E-${j.id}`, from: j.id, to: env.id, kind: 'env', label: 'environment' });
    if (j.secret && store && repoSecrets(m).includes(j.secret)) out.push({ id: `S-${j.id}`, from: j.id, to: store.id, kind: 'secret', label: j.secret });
  }
  return out;
}

function ancestors(m, j, seen = new Set()) {
  for (const n of needsOf(m, j)) if (!seen.has(n.id)) { seen.add(n.id); ancestors(m, n, seen); }
  return seen;
}

/** Topological order (Kahn, A to Z), or { cycle }. */
export function order(m) {
  const list = jobs(m), done = new Set(), out = [];
  while (out.length < list.length) {
    const ready = list.filter(j => !done.has(j.id) && needsOf(m, j).every(n => done.has(n.id))).sort((a, b) => (a.name < b.name ? -1 : 1));
    if (!ready.length) return { cycle: list.filter(j => !done.has(j.id)).map(j => j.name).sort() };
    done.add(ready[0].id); out.push(ready[0]);
  }
  return { order: out };
}

/**
 * One workflow run. eventId: a key of EVENTS. opts: { runNo: 1|2|3 (for caches), lockChanged, failTests } .
 * -> { error } | { triggered: false, why } | { triggered: true, jobs: Map(id -> result), steps, wall, conclusion, deployed, shippedBroken }
 */
export function run(m, eventId = 'push-main', opts = {}) {
  const ev = EVENTS[eventId];
  const trig = m.blocks.find(b => b.kind === 'trigger');
  const list = jobs(m);
  const seen = new Set();
  for (const j of list) {
    if (!validName(j.name)) return { error: `"${j.name}" is not a valid job id: letters, digits, - and _, starting with a letter or _.` };
    if (seen.has(j.name)) return { error: `Two jobs are called "${j.name}". Job ids must be unique.` };
    seen.add(j.name);
  }
  if (!list.length) return { error: 'There are no jobs yet. Add one from the palette.' };
  const o = order(m);
  if (o.cycle) return { error: `The needs form a cycle (${o.cycle.join(', ')}): each job waits for the other, so GitHub rejects the workflow file.` };
  if (!trig) return { error: 'There is no trigger: a workflow needs an on: section.' };
  if (ev.push && !(trig.push && branchMatch(trig.branches, ev.branch))) {
    return { triggered: false, why: trig.push ? `on: push only lists the branches "${trig.branches}", and this push went to ${ev.branch}. No run.` : 'The workflow has no push trigger, so a push starts nothing.' };
  }
  if (ev.pr && !trig.pr) return { triggered: false, why: 'The workflow has no pull_request trigger, so the pull request gets no checks at all. Reviewers merge untested code.' };

  const steps = [];
  const log = (at, j, tone, text) => steps.push({ at, who: j?.name || 'run', id: j?.id, tone, text, seq: steps.length });
  log(0, null, 'info', `Triggered by ${ev.label} (${ev.ref}).${ev.fork ? ' Because it comes from a fork, GitHub gives this run no secrets and a read-only token.' : ''}`);
  const R = new Map();
  const runNo = opts.runNo || 1;
  for (const j of o.order) {
    const preset = PRESETS[j.preset] || PRESETS.build;
    const needs = needsOf(m, j);
    const nres = needs.map(n => R.get(n.id));
    const ready = Math.max(0, ...nres.map(r => r.end));
    const allOk = nres.every(r => r.status === 'success');
    const anyFail = nres.some(r => r.status === 'failure');
    const r = { id: j.id, name: j.name, start: ready, end: ready, status: 'success', legs: [], notes: [] };
    R.set(j.id, r);
    const skip = why => { r.status = 'skipped'; r.why = why; log(ready, j, 'warn', `skipped: ${why}`); };
    const c = j.cond || '';
    if (c === 'always') { /* runs whatever happened */ }
    else if (c === 'failure') { if (!anyFail) { skip(needs.length ? 'its condition is failure(), and no job it needs failed.' : 'failure() with no needs never matches.'); continue; } }
    else if (!allOk) {
      const bad = needs.find(n => R.get(n.id).status !== 'success');
      skip(`it needs ${bad.name}, which ${R.get(bad.id).status === 'failure' ? 'failed' : 'was skipped'}. By default a job runs only if everything it needs succeeded.`);
      continue;
    } else if (c === 'main' && !(ev.push && ev.branch === 'main')) { skip(`its if: says pushes to main only, and this is ${ev.label}.`); continue; }
    else if (c === 'push' && !ev.push) { skip(`its if: says pushes only, and this is ${ev.label}.`); continue; }
    else if (c === 'not-fork' && ev.fork) { skip('its if: excludes pull requests from forks, which carry no secrets. The checks that need no secrets still run.'); continue; }

    let t = ready;
    // Environment: branch rules and required reviewers come before the job may start.
    if (j.environment) {
      const env = named(m, 'environment', j.environment);
      if (env) {
        if (env.branches && !(ev.push && branchMatch(env.branches, ev.branch))) {
          r.status = 'failure'; r.why = `the ${env.name} environment only allows deployments from ${env.branches}, and this run is ${ev.label}. "Branch is not allowed to deploy to ${env.name} due to environment protection rules."`;
          log(t, j, 'bad', `failed: ${r.why}`); continue;
        }
        if (env.reviewers) { log(t, j, 'warn', `waiting: deploying to ${env.name} needs a reviewer's approval. A reviewer approved after ${APPROVAL_S / 60} minutes.`); t += APPROVAL_S; r.approved = true; }
      } else r.notes.push(`environment "${j.environment}" did not exist, so GitHub created it with no protection rules`);
    }
    const legs = matrixOf(j).length ? matrixOf(j) : [null];
    let legFail = null;
    const legEnds = [];
    for (const v of legs) {
      const lname = v == null ? j.name : `${j.name} (${v})`;
      let lt = t + SETUP_S;
      const info = [];
      // cache + install
      if (preset.install) {
        if (j.cache === 'none') { lt += INSTALL_S; info.push(`npm ci downloaded everything (${INSTALL_S}s)`); }
        else if (runNo === 1) { lt += INSTALL_S; info.push(`cache miss (first run), npm ci ${INSTALL_S}s, cache saved`); }
        else if (runNo === 2 || j.cache === 'hash' && !opts.lockChanged) { lt += RESTORE_S; info.push(`cache hit, restored in ${RESTORE_S}s`); }
        else if (j.cache === 'hash') { lt += INSTALL_S; info.push(`package-lock.json changed, so the key changed: cache miss, fresh npm ci ${INSTALL_S}s, new cache saved`); }
        else { lt += RESTORE_S + STALE_EXTRA_S; info.push(`cache hit on the fixed key "deps", but it holds the OLD dependencies: npm had to fetch the changes (${RESTORE_S + STALE_EXTRA_S}s), and the cache is never updated, because a key is saved only once`); r.stale = true; }
      }
      // artifact
      if (j.download) {
        const up = jobs(m).find(x => x.upload === j.download);
        const ur = up && R.get(up.id);
        let why = null;
        if (!up) why = `Unable to find any artifacts named "${j.download}". ${jobs(m).some(x => x.upload) ? `Uploaded in this workflow: ${jobs(m).filter(x => x.upload).map(x => `"${x.upload}" (by ${x.name})`).join(', ')}.` : 'No job uploads anything.'}`;
        else if (!ancestors(m, j).has(up.id)) why = `Unable to find the artifact "${j.download}": ${j.name} started at ${mmss(t)}, while ${up.name} was still running. Nothing tells ${j.name} to wait. Add needs: ${up.name}.`;
        else if (ur?.status !== 'success') why = `the artifact "${j.download}" was never uploaded, because ${up.name} ${ur?.status === 'skipped' ? 'was skipped' : 'failed'}.`;
        if (why) { legFail = { lname, why, at: lt }; break; }
        info.push(`downloaded "${j.download}" from ${up.name}`);
      }
      // secret
      if (j.secret) {
        const env = j.environment ? named(m, 'environment', j.environment) : null;
        const inEnv = env?.secrets.includes(j.secret), inRepo = repoSecrets(m).includes(j.secret);
        let why = null;
        if (ev.fork && (inEnv || inRepo)) why = `secrets.${j.secret} is empty: GitHub never passes secrets to a pull request from a fork (anyone could open one and print them). "Error: Input required and not supplied: token".`;
        else if (!inEnv && !inRepo) why = `secrets.${j.secret} is empty: there is no such secret${env ? '' : ' (environment secrets only reach jobs that name that environment)'}.`;
        if (why) { legFail = { lname, why, at: lt }; break; }
        info.push(`used ${j.secret} (${inEnv ? `${env.name} environment secret` : 'repository secret'})`);
      }
      lt += Number(j.seconds) || preset.seconds;
      const failOn = String(j.failOn || '').trim();
      const failsHere = j.fails && (!failOn || (v != null && String(v) === failOn));
      if (failsHere) { legFail = { lname, why: preset.tests ? `${preset.run}: 3 tests failed${v != null ? ` on ${v}` : ''}.` : `${preset.run} exited with code 1.`, at: lt }; break; }
      legEnds.push(lt);
      r.legs.push(lname);
      log(lt, j, 'ok', `${lname} succeeded in ${mmss(lt - t)}: ${[...info, preset.run].join('; ')}.`);
    }
    if (legFail) {
      r.status = 'failure'; r.why = legFail.why; r.end = legFail.at;
      log(legFail.at, j, 'bad', `${legFail.lname} failed: ${legFail.why}`);
      if (legs.length > 1) { r.cancelled = legs.length - r.legs.length - 1; if (r.cancelled > 0) log(legFail.at, j, 'warn', `fail-fast cancelled the other ${r.cancelled} matrix leg${r.cancelled > 1 ? 's' : ''}.`); }
      continue;
    }
    r.start = ready; r.end = Math.max(...legEnds);
    r.ranAt = t;
    if (preset.deploys) r.deployed = true;
  }
  steps.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const all = [...R.values()];
  const wall = Math.max(0, ...all.map(r => r.end));
  const failed = all.filter(r => r.status === 'failure');
  const deployed = all.some(r => r.deployed);
  const testsFailed = all.some(r => r.status === 'failure' && PRESETS[byId(m, r.id).preset]?.tests);
  return { triggered: true, event: ev, jobs: R, steps, wall, conclusion: failed.length ? 'failure' : 'success', deployed, shippedBroken: deployed && testsFailed };
}

// ---------------------------------------------------------------- YAML

const quoteExpr = e => `\${{ ${e} }}`;
export function toYaml(m) {
  const trig = m.blocks.find(b => b.kind === 'trigger') || { push: false, pr: false };
  const L = ['name: CI', 'on:'];
  const branches = String(trig.branches || '').split(',').map(s => s.trim()).filter(Boolean);
  if (trig.push) L.push('  push:', ...(branches.length ? [`    branches: [${branches.map(Y.scalar).join(', ')}]`] : []));
  if (trig.pr) L.push('  pull_request:');
  if (!trig.push && !trig.pr) L.push('  workflow_dispatch:      # no automatic trigger');
  L.push('', 'jobs:');
  const o = order(m);
  const list = o.order || jobs(m);
  if (!list.length) L.push('  {}');
  for (const j of list) {
    const p = PRESETS[j.preset] || PRESETS.build;
    const needs = needsOf(m, j).map(n => n.name);
    L.push(`  ${j.name}:`, '    runs-on: ubuntu-latest');
    if (needs.length) L.push(`    needs: ${needs.length === 1 ? needs[0] : `[${needs.join(', ')}]`}`);
    if (CONDITIONS[j.cond]?.expr) L.push(`    if: ${CONDITIONS[j.cond].expr}`);
    if (j.environment) L.push(`    environment: ${Y.scalar(j.environment)}`);
    const mx = matrixOf(j);
    if (mx.length) L.push('    strategy:', '      fail-fast: true', '      matrix:', `        node: [${mx.map(v => (/^\d+$/.test(v) ? v : Y.scalar(v))).join(', ')}]`);
    L.push('    steps:', '      - uses: actions/checkout@v7');
    if (p.install) {
      L.push('      - uses: actions/setup-node@v7', '        with:', `          node-version: ${mx.length ? quoteExpr('matrix.node') : 20}`);
      if (j.cache !== 'none') L.push('      - uses: actions/cache@v6', '        with:', '          path: node_modules', `          key: ${j.cache === 'hash' ? `deps-${quoteExpr("hashFiles('package-lock.json')")}` : 'deps'}`);
      L.push('      - run: npm ci');
    }
    if (j.download) L.push('      - uses: actions/download-artifact@v8', '        with:', `          name: ${Y.scalar(j.download)}`);
    L.push(`      - run: ${p.run.includes(':') || p.run.includes('"') ? `'${p.run}'` : p.run}`);
    if (j.secret) L.push('        env:', `          ${j.preset === 'deploy' ? 'DEPLOY_TOKEN' : 'TOKEN'}: ${quoteExpr(`secrets.${j.secret}`)}`);
    if (j.upload) L.push('      - uses: actions/upload-artifact@v7', '        with:', `          name: ${Y.scalar(j.upload)}`, '          path: dist/');
  }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- challenges

const goal = (label, ok, why) => ({ label, ok: !!ok, why: ok ? '' : why });
const cost = m => m.blocks.length + m.wires.length;
const starsFor = (c, par, slack = 2) => (c <= par ? 3 : c <= par + slack ? 2 : 1);
const trigger = (s = {}) => block('trigger', 'on', 'on: push', 20, 200, { fixed: true, ...s });
const job = (id, preset, x, y, s = {}) => block('job', id, id, x, y, { preset, ...s });
const J = (m, name) => named(m, 'job', name);
const res = (r, m, name) => (r.jobs && J(m, name) ? r.jobs.get(J(m, name).id) : null);
const runWhy = r => r.error || (r.triggered === false ? r.why : '');
const status = (r, m, name) => res(r, m, name)?.status;
const jobGoal = (r, m, name, want, label) => {
  const x = res(r, m, name);
  return goal(label, x?.status === want, runWhy(r) || (!x ? `there is no job called ${name}` : `${name} ${x.status === 'success' ? 'succeeded' : x.status === 'failure' ? 'failed' : 'was skipped'}${x.why ? `: ${x.why}` : ''}`));
};
const withM = (m, fn) => { const c = clone(m); fn(c); return c; };

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free workflow. Add jobs, wire needs, pass artifacts, add caches, a matrix, environments and secrets, then run it for a push, a pull request or a pull request from a fork.',
    setup: () => ({ blocks: [trigger({ pr: true }), job('build', 'build', 340, 80, { upload: 'dist', cache: 'hash' }), job('test', 'test', 340, 320, { cache: 'hash', matrix: '20, 22' }),
      job('deploy', 'deploy', 700, 200, { download: 'dist', environment: 'production', secret: 'DEPLOY_TOKEN', cond: 'main' }),
      block('environment', 'env-prod', 'production', 1040, 200, { secrets: ['DEPLOY_TOKEN'] }), block('secrets', 'repo', 'Repository secrets', 1040, 420, { names: ['NPM_TOKEN'] })],
      wires: [wire('build', 'deploy'), wire('test', 'deploy')] }),
    solve: m => m, check: () => [] },

  { id: 'order', title: 'First things first', xp: 15,
    brief: 'Three jobs, and GitHub starts them **all at once**: jobs run in parallel unless one `needs` another. So deploy looks for the build before it exists. Wire **build → test → deploy** (drag a job\'s ▶ onto the job that must wait for it) and press **Push to main**.',
    setup: () => ({ blocks: [trigger(), job('build', 'build', 340, 200, { upload: 'dist' }), job('test', 'test', 640, 200), job('deploy', 'deploy', 940, 200, { download: 'dist' })], wires: [] }),
    solve: m => { m.wires.push(wire('build', 'test'), wire('test', 'deploy')); return m; },
    check: m => {
      const r = run(m, 'push-main');
      const t = res(r, m, 'test'), b = res(r, m, 'build');
      return [jobGoal(r, m, 'deploy', 'success', 'deploy succeeds on a push to main'),
        goal('test starts after build has finished', t && b && t.start >= b.end && t.status === 'success', runWhy(r) || 'test must need build')];
    } },

  { id: 'gate', title: 'Red tests, no deploy', xp: 20,
    brief: 'The tests are failing (keep them failing), and yet the push **deployed**: deploy only needs build, so it runs next to the tests, not after them. A failing test must stop the deploy. Make deploy wait for test.',
    setup: () => ({ blocks: [trigger(), job('build', 'build', 340, 200, { upload: 'dist' }), job('test', 'test', 640, 60, { fails: true, fixedFail: true }), job('deploy', 'deploy', 640, 340, { download: 'dist' })],
      wires: [wire('build', 'test'), wire('build', 'deploy')] }),
    solve: m => { m.wires.push(wire('test', 'deploy')); return m; },
    check: m => {
      const r = run(m, 'push-main');
      const pass = run(withM(m, c => { J(c, 'test') && (J(c, 'test').fails = false); }), 'push-main');
      return [goal('the tests still fail', J(m, 'test')?.fails, 'keep the failing tests: the point is what happens next'),
        jobGoal(r, m, 'deploy', 'skipped', 'with failing tests, deploy is skipped'),
        goal('with passing tests, deploy still runs', pass.deployed, runWhy(pass) || 'deploy must still succeed when the tests pass')];
    } },

  { id: 'artifact', title: 'Where is my build?', xp: 20,
    brief: 'deploy fails: *Unable to find any artifacts*. Jobs run on separate, fresh machines, so the files build made are gone unless build **uploads** them and deploy **downloads** them, by the same name. Read the names.',
    setup: () => ({ blocks: [trigger(), job('build', 'build', 340, 200, { upload: 'dist' }), job('test', 'test', 640, 200), job('deploy', 'deploy', 940, 200, { download: 'build' })],
      wires: [wire('build', 'test'), wire('test', 'deploy')] }),
    solve: m => { J(m, 'deploy').download = 'dist'; return m; },
    check: m => { const r = run(m, 'push-main'); return [jobGoal(r, m, 'deploy', 'success', 'deploy succeeds with the files build made')]; } },

  { id: 'parallel', title: 'Fan out', xp: 30,
    brief: 'Every push waits for lint, then unit tests, then end-to-end tests, one after another: over **13 minutes**. None of the three checks needs another one: only build. Run them **in parallel** and bring the whole run under **8 minutes**, while deploy still waits for all three.',
    setup: () => ({ blocks: [trigger(), job('build', 'build', 300, 200, { upload: 'dist' }), job('lint', 'lint', 560, 40), job('unit', 'test', 560, 200), job('e2e', 'e2e', 560, 360, { download: 'dist' }), job('deploy', 'deploy', 900, 200, { download: 'dist' })],
      wires: [wire('build', 'lint'), wire('lint', 'unit'), wire('unit', 'e2e'), wire('e2e', 'deploy')] }),
    solve: m => { m.wires = [wire('build', 'lint'), wire('build', 'unit'), wire('build', 'e2e'), wire('lint', 'deploy'), wire('unit', 'deploy'), wire('e2e', 'deploy')]; return m; },
    check: m => {
      const r = run(m, 'push-main');
      const d = J(m, 'deploy'), anc = d ? ancestors(m, d) : new Set();
      const missing = ['lint', 'unit', 'e2e'].filter(n => !J(m, n) || !anc.has(J(m, n).id));
      return [goal('deploy still waits for lint, unit and e2e', d && !missing.length, `deploy does not wait for ${missing.join(', ')}`), jobGoal(r, m, 'deploy', 'success', 'deploy succeeds'),
        goal('the whole run takes under 8:00', r.wall && r.wall < 480, runWhy(r) || `the run takes ${mmss(r.wall || 0)}`)];
    } },

  { id: 'cache', title: 'Stop downloading the internet', xp: 30, costLabel: 'blocks + wires',
    brief: 'Every run spends **90 s** in `npm ci`, downloading the same packages. Add a **cache** to the test job. Press **Three runs** to see a cold run, a warm run, and a run after someone changed package-lock.json. A good cache key changes exactly when the dependencies change.',
    setup: () => ({ blocks: [trigger(), job('test', 'test', 380, 200)], wires: [] }),
    solve: m => { J(m, 'test').cache = 'hash'; return m; },
    check: m => {
      const r1 = run(m, 'push-main', { runNo: 1 }), r2 = run(m, 'push-main', { runNo: 2 }), r3 = run(m, 'push-main', { runNo: 3, lockChanged: true });
      const t3 = res(r3, m, 'test');
      return [goal('a warm run is at least a minute faster', r1.wall && r2.wall && r1.wall - r2.wall >= 60, runWhy(r1) || `warm run ${mmss(r2.wall || 0)} vs cold ${mmss(r1.wall || 0)}`),
        goal('after a lockfile change, the job gets fresh dependencies', t3 && t3.status === 'success' && !t3.stale, runWhy(r3) || 'a fixed key keeps restoring the old dependencies and is never updated')];
    } },

  { id: 'matrix', title: 'Every supported version', xp: 30,
    brief: 'You promise to support Node **18, 20 and 22**, but CI only tests on 20. Users on 18 hit a bug you never saw. Give the test job a **matrix** of all three versions. (The code really is broken on 18: the run should go red and must not deploy.)',
    setup: () => ({ blocks: [trigger(), job('test', 'test', 380, 200, { fails: true, failOn: '18' }), job('deploy', 'deploy', 720, 200)], wires: [wire('test', 'deploy')] }),
    solve: m => { J(m, 'test').matrix = '18, 20, 22'; return m; },
    check: m => {
      const r = run(m, 'push-main');
      const mx = J(m, 'test') ? matrixOf(J(m, 'test')) : [];
      return [goal('test runs on 18, 20 and 22', ['18', '20', '22'].every(v => mx.includes(v)), `the matrix is [${mx.join(', ')}]`),
        jobGoal(r, m, 'test', 'failure', 'the Node 18 failure shows up'), goal('the broken build is not deployed', !r.deployed && J(m, 'deploy'), runWhy(r) || 'deploy ran anyway')];
    } },

  { id: 'triggers', title: 'Test the pull requests', xp: 30,
    brief: 'The workflow only runs on pushes to main, so pull requests get **no checks**: reviewers merge untested code. Run it on **pull requests** too. But a pull request must never **deploy**: only a push to main may.',
    setup: () => ({ blocks: [trigger(), job('build', 'build', 340, 200, { upload: 'dist' }), job('test', 'test', 640, 200), job('deploy', 'deploy', 940, 200, { download: 'dist' })],
      wires: [wire('build', 'test'), wire('test', 'deploy')] }),
    solve: m => { byId(m, 'on').pr = true; J(m, 'deploy').cond = 'main'; return m; },
    check: m => {
      const pr = run(m, 'pr'), main = run(m, 'push-main');
      return [jobGoal(pr, m, 'test', 'success', 'a pull request runs the tests'), goal('a pull request does not deploy', pr.triggered && !pr.deployed, runWhy(pr) || 'the pull request deployed'),
        goal('a push to main deploys', main.deployed, runWhy(main) || 'a push to main must still deploy')];
    } },

  { id: 'fork', title: 'Secrets and forks', xp: 35,
    brief: 'An outside contributor opens a pull request from their **fork**, and CI goes red at the coverage upload: `CODECOV_TOKEN` is empty. That is GitHub protecting you: a fork could change the workflow to print your secrets. Keep the tests running for forks, skip only what needs the secret. Do not reach for `pull_request_target`: it runs fork code with your secrets.',
    setup: () => ({ blocks: [trigger({ pr: true }), job('test', 'test', 340, 200), job('coverage', 'coverage', 680, 200, { secret: 'CODECOV_TOKEN' }), block('secrets', 'repo', 'Repository secrets', 1000, 200, { names: ['CODECOV_TOKEN'] })],
      wires: [wire('test', 'coverage')] }),
    solve: m => { J(m, 'coverage').cond = 'not-fork'; return m; },
    check: m => {
      const f = run(m, 'fork'), pr = run(m, 'pr');
      return [jobGoal(f, m, 'test', 'success', 'a fork\'s pull request runs the tests'), goal('a fork\'s pull request is green', f.conclusion === 'success', runWhy(f) || 'the fork run still fails'),
        jobGoal(pr, m, 'coverage', 'success', 'coverage still uploads for pull requests from this repository')];
    } },

  { id: 'approval', title: 'A human says go', xp: 40, costLabel: 'blocks + wires',
    brief: 'Every push to main goes straight to production, and the `DEPLOY_TOKEN` is a **repository** secret, so any workflow job on any branch can read it. Make deploy go through the **production** environment (it requires a reviewer), and move DEPLOY_TOKEN into that environment\'s secrets, out of the repository ones.',
    setup: () => ({ blocks: [trigger(), job('test', 'test', 340, 200), job('deploy', 'deploy', 680, 200, { secret: 'DEPLOY_TOKEN' }),
      block('environment', 'env-prod', 'production', 1000, 80, { secrets: [] }), block('secrets', 'repo', 'Repository secrets', 1000, 340, { names: ['DEPLOY_TOKEN', 'NPM_TOKEN'] })],
      wires: [wire('test', 'deploy')] }),
    solve: m => { J(m, 'deploy').environment = 'production'; byId(m, 'env-prod').secrets = ['DEPLOY_TOKEN']; byId(m, 'repo').names = ['NPM_TOKEN']; return m; },
    check: m => {
      const r = run(m, 'push-main');
      const d = res(r, m, 'deploy');
      const env = named(m, 'environment', 'production');
      return [goal('deploy waits for a reviewer in production', d?.approved && env?.reviewers, runWhy(r) || (d?.approved ? '' : 'deploy does not use an environment with required reviewers')),
        goal('DEPLOY_TOKEN is a production secret, not a repository secret', env?.secrets.includes('DEPLOY_TOKEN') && !repoSecrets(m).includes('DEPLOY_TOKEN'), 'move it: add it to the environment, remove it from the repository secrets'),
        jobGoal(r, m, 'deploy', 'success', 'a push to main still deploys (after approval)')];
    } },

  { id: 'notify', title: 'Tell someone it broke', xp: 35,
    brief: 'The notify job posts to the team chat when CI fails. It needs test, and the tests just failed... so notify was **skipped** and nobody heard. By default a job only runs when everything it needs succeeded. Give notify the right `if:` so it runs when tests fail, and stays quiet when they pass.',
    setup: () => ({ blocks: [trigger(), job('test', 'test', 380, 200, { fails: true, fixedFail: true }), job('notify', 'notify', 720, 200)], wires: [wire('test', 'notify')] }),
    solve: m => { J(m, 'notify').cond = 'failure'; return m; },
    check: m => {
      const r = run(m, 'push-main');
      const pass = run(withM(m, c => { J(c, 'test') && (J(c, 'test').fails = false); }), 'push-main');
      return [jobGoal(r, m, 'notify', 'success', 'when the tests fail, notify runs'), jobGoal(pass, m, 'notify', 'skipped', 'when the tests pass, notify stays quiet')];
    } },
];
for (const c of CHALLENGES) c.par ??= cost(c.solve(c.setup()));

export function judge(m, ch) {
  const goals = ch.check(m).filter(Boolean);
  const ok = goals.length > 0 && goals.every(g => g.ok);
  const c = cost(m);
  return { ok, goals, cost: c, stars: ok ? starsFor(c, ch.par) : 0 };
}
export { mmss, matrixOf, ancestors };
