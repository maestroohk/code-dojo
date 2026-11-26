// Checks the System design board's simulator (ui/sdsim.js) in plain Node: the queueing and popularity maths,
// every graded challenge fails at its setup and passes with its reference solution at 3 stars, the wrong fixes
// the briefs warn about really fail, the sandbox runs with every incident, and runs are deterministic.
// Run: node tests/CodeDojo.Tests/sdsim.test.mjs   (SdSimTests.cs runs it as part of dotnet test)
const S = await import(new URL('../../ui/sdsim.js', import.meta.url));

const failures = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) failures.push(what); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const digest = R => JSON.stringify(R);

// ---- the maths
check(near(S.erlangC(1, 0.5), 0.5, 1e-9), 'Erlang C: M/M/1 waits with probability rho');
check(near(S.erlangC(2, 1), 1 / 3, 1e-9), 'Erlang C: two servers at 50% wait a third of the time');
check(S.erlangC(64, 0.8 * 64) < S.erlangC(8, 0.8 * 8), 'Erlang C: more servers wait less at the same utilisation');
check(near(S.mmcWaitMs(1, 100, 50), 10, 1e-6), 'M/M/1 at 50%: mean wait equals the 10 ms service time');
check(S.mmcWaitMs(1, 100, 100) === Infinity, 'M/M/1 at 100%: unbounded wait');
check(near(S.coverage(1000, 0, 100), 0.1, 0.01), 'uniform keys: the top 10% get 10% of requests');
check(S.coverage(1e6, 1, 1e4) > 0.6, 'Zipf s=1: the top 1% of a million keys take most requests');
check(near(S.hitRate({ N: 1000, s: 0, k: 1000, ttl: 0, R: 100 }), 1, 1e-6), 'everything cached, nothing expires: hit rate 1');
check(S.hitRate({ N: 1e6, s: 0.9, k: 1e6, ttl: 60, R: 1000 }) < S.hitRate({ N: 1e6, s: 0.9, k: 1e6, ttl: 3600, R: 1000 }), 'a longer TTL hits more');
check(S.hitRate({ N: 1e6, s: 0.9, k: 1e5, ttl: 600, R: 1e4 }) < S.hitRate({ N: 1e6, s: 0.9, k: 1e6, ttl: 600, R: 1e4 }), 'a bigger cache hits more');
check(near(S.distinctKeys(1, 1000, 1), 1, 0.02) && near(S.distinctKeys(1e7, 1000, 1), 1000, 1), 'distinct keys: one request touches one key, ten million touch them all');

// ---- challenges
const graded = S.CHALLENGES.filter(c => c.xp > 0);
check(graded.length >= 10 && graded.length <= 14, `10 to 14 graded challenges (found ${graded.length})`);
check(new Set(S.CHALLENGES.map(c => c.id)).size === S.CHALLENGES.length, 'challenge ids are unique');
for (const c of graded) {
  const before = S.judge(c.setup(), c);
  check(!before.ok, `${c.id}: the setup must fail its goals`);
  check(before.goals.every(g => g.ok || g.why), `${c.id}: every failing goal says why`);
  const after = S.judge(c.solve(c.setup()), c);
  check(after.ok, `${c.id}: the solution must pass (${after.goals.filter(g => !g.ok).map(g => `${g.label}: ${g.why}`).join(' | ')})`);
  check(after.stars === 3, `${c.id}: the solution earns 3 stars (got ${after.stars}, cost ${after.cost}, par ${c.par})`);
  check(c.par > 0 && c.par >= after.cost, `${c.id}: par covers the reference design`);
  check(digest(after.run) === digest(S.judge(c.solve(c.setup()), c).run), `${c.id}: two runs of the solution are identical`);
  check(S.explain(c.solve(c.setup()), after.run).length > 2, `${c.id}: the findings explain the run`);
  check(c.goals.length >= 2, `${c.id}: has at least two goals`);
}

// ---- the wrong fixes really are wrong
const ch = id => S.CHALLENGES.find(c => c.id === id);
const set = (m, id, s) => { Object.assign(S.byId(m, id), s); return m; };
const fails = (id, label, f) => check(!S.judge(f(ch(id).setup()), ch(id)).ok, `${id}: "${label}" must not pass`);
fails('hot-key', 'more cache nodes', m => set(m, 'cache', { nodes: 12 }));
fails('hot-key', 'bigger cache nodes', m => set(m, 'cache', { nodes: 12, size: 'XL' }));
fails('slow-query', 'a bigger database', m => set(m, 'db', { size: '2XL' }));
fails('hot-shard', 'more range shards', m => set(m, 'db', { shards: 16 }));
fails('stampede', 'coalescing alone', m => set(m, 'cache', { coalesce: true }));
fails('retry-storm', 'a breaker alone', m => set(m, 'app', { breaker: true }));
fails('az-down', 'three zones without a standby', m => { set(m, 'lb', { healthChecks: true }); return set(m, 'app', { azs: 3, instances: 18 }); });
fails('az-down', 'three zones without health checks', m => { set(m, 'db', { standby: true }); return set(m, 'app', { azs: 3, instances: 18 }); });
fails('region-failover', 'health checks with a 300 s TTL', m => { set(m, 'dns', { healthChecks: true }); return set(m, 'rep2', { promote: true }); });
fails('right-size', 'running at 94% CPU', m => set(m, 'app', { instances: 16, size: 'L' }));
fails('write-burst', 'fewer partitions than workers', m => {
  m.blocks.push(S.block('queue', 'q', 'Q', 0, 0, { partitions: 4 }), S.block('worker', 'w', 'W', 0, 0, { instances: 8, batch: 20 }));
  S.connect(m, 'app', 'q'); S.connect(m, 'q', 'w'); S.connect(m, 'w', 'db'); return m;
});
{
  const c = ch('photo-share');
  const m = c.solve(c.setup());
  m.blocks = m.blocks.filter(b => b.kind !== 'objstore'); m.wires = m.wires.filter(w => w.to !== 'obj');
  check(!S.judge(m, c).ok, 'photo-share: photos in the database must not pass');
  const t = c.setup(); S.byId(t, 'users').qps = 1;
  const j = S.judge(c.solve(t), c);
  check(!j.ok && /traffic/.test(j.goals[0].label), 'changing the traffic fails the challenge');
}

fails('first-service', 'a database nothing is cabled to', m => { m.wires = [S.wire('users', 'lb'), S.wire('lb', 'app')]; return m; });

// ---- semantics worth pinning down
{
  const c = ch('retry-storm');
  const R = S.judge(c.setup(), c).run;
  check(R.ticks.some(t => t.clientAmp > 3.5), 'retry storm: client retries amplify load to almost 4x');
  check(R.ticks[R.ticks.length - 1].err > 0.9, 'retry storm: still failing at the end (metastable)');
  const Rs = S.judge(c.solve(c.setup()), c).run;
  check(Rs.ticks[Rs.ticks.length - 1].err < 0.01, 'retry storm: shedding at the edge recovers');
}
{
  const c = ch('pool-exhaustion');
  const R = S.judge(c.setup(), c).run;
  check(R.ticks[0].conns === 1200 && R.ticks[0].maxConn === 800, 'pool exhaustion: 60 x 20 connections against 800');
  check(near(R.ticks[0].connRefused, 1 / 3, 1e-9), 'pool exhaustion: a third of instances cannot connect');
}
{
  const c = ch('region-failover');
  const R = S.judge(c.solve(c.setup()), c).run;
  check(R.rpo.seconds > 0 && R.rpo.seconds < 1, 'region failover: RPO is the async replica\'s lag');
}
{
  const c = ch('az-down');
  const R = S.judge(c.solve(c.setup()), c).run;
  const at = t => R.ticks.find(x => x.t === t);
  check(at(240).dbMode === 'failover' && at(270).dbMode !== 'failover', 'zone loss: the standby takes over after about 30 s');
  check(at(300).alive.app === 12, 'zone loss: 18 instances over 3 zones keep 12');
}

// ---- the sandbox with every incident
const sandbox = S.CHALLENGES.find(c => c.xp === 0);
check(!!sandbox, 'there is a sandbox');
for (const kind of ['az', 'region', 'flush', 'hotkey', 'slowdb', 'spike', 'slownode', 'retrystorm']) {
  const sc = { incidents: [{ kind, at: 120, until: 300, share: 0.5, factor: 3 }] };
  const R = S.simulate(sandbox.setup(), sc);
  check(!R.error && R.ticks.length === 60, `sandbox runs with ${kind} (${R.error || R.ticks.length + ' ticks'})`);
  check(!R.error && digest(R) === digest(S.simulate(sandbox.setup(), sc)), `sandbox is deterministic with ${kind}`);
}
check(!!S.simulate({ blocks: [], wires: [] }).error, 'an empty board explains what is missing');

if (failures.length) { console.error(failures.map(f => '✗ ' + f).join('\n')); console.error(`${failures.length} of ${checks} checks failed`); process.exit(1); }
console.log(`${checks} checks passed`);
