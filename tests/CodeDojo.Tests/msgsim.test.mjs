// Checks the Messaging builder's simulators (ui/rabbitsim.js, ui/kafkasim.js) in plain Node:
// every graded challenge's setup fails its goals, its solution passes with 3 stars, the sandbox runs
// (with every incident), the commands panel renders, and two runs of the same board give the same result.
// Run: node tests/CodeDojo.Tests/msgsim.test.mjs   (MsgSimTests.cs runs it as part of dotnet test)
const ui = new URL('../../ui/', import.meta.url);
const RS = await import(new URL('rabbitsim.js', ui));
const KS = await import(new URL('kafkasim.js', ui));

const failures = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) failures.push(what); };
const digest = R => JSON.stringify(R, (k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : typeof v === 'function' ? undefined : v));

// ---- routing and hashing rules
const tm = RS.topicMatch;
check(tm('order.*', 'order.created') && !tm('order.*', 'order.eu.created'), 'topic: * is exactly one word');
check(tm('order.#', 'order') && tm('order.#', 'order.eu.created') && tm('#', ''), 'topic: # is zero or more words');
check(tm('order.*.created', 'order.us.created') && !tm('order.*.created', 'order.us.shipped'), 'topic: fixed words must match');
check(tm('#.created', 'order.eu.created') && !tm('*.created', 'order.eu.created'), 'topic: leading wildcards');
check(KS.crc32('123456789') === 0xcbf43926, 'crc32 check value');
check(KS.partitionOf('order-7', 3) === KS.partitionOf('order-7', 3), 'the same key always maps to the same partition');

for (const [name, S, sandboxRuns] of [
  ['rabbitmq', RS, [{}, { restartAt: 1.05 }, { kill: { consumer: 'billing', at: 1 } }]],
  ['kafka', KS, [{}, { kill: { broker: 2, at: 30 } }, { outages: [{ consumer: 'billing-1', from: 10, to: null }] }, { outages: [{ consumer: 'billing-1', from: 20.25, to: 25 }] }, { lostAcks: true }]],
]) {
  const graded = S.CHALLENGES.filter(c => c.xp > 0);
  check(graded.length === 11, `${name}: 11 graded challenges (found ${graded.length})`);
  check(new Set(S.CHALLENGES.map(c => c.id)).size === S.CHALLENGES.length, `${name}: challenge ids are unique`);
  for (const c of graded) {
    const before = S.judge(c.setup(), c);
    check(!before.ok, `${name}/${c.id}: the setup must fail its goals`);
    check(before.goals.every(g => g.ok || g.why), `${name}/${c.id}: every failing goal says why`);
    const after = S.judge(c.solve(c.setup()), c);
    check(after.ok, `${name}/${c.id}: the solution must pass (${after.goals.filter(g => !g.ok).map(g => `${g.label}: ${g.why}`).join(' | ')})`);
    check(after.stars === 3, `${name}/${c.id}: the solution earns 3 stars (got ${after.stars}, cost ${after.cost}, par ${c.par})`);
    check(c.par === S.partsCost(c.solve(c.setup())), `${name}/${c.id}: par is the cost of the solution`);
    const again = S.judge(c.solve(c.setup()), c);
    check(digest(after.run) === digest(again.run), `${name}/${c.id}: two runs of the solution are identical`);
    check(digest(before.run) === digest(S.judge(c.setup(), c).run), `${name}/${c.id}: two runs of the setup are identical`);
    check(S.toText(c.setup()).length > 50, `${name}/${c.id}: the commands panel renders`);
  }
  const sandbox = S.CHALLENGES.find(c => c.xp === 0);
  check(!!sandbox, `${name}: there is a sandbox`);
  for (const sc of sandboxRuns) {
    const R = S.simulate(sandbox.setup(), sc);
    check(!R.error && R.steps.length > 3, `${name}: the sandbox runs with ${JSON.stringify(sc)} (${R.error || R.steps.length + ' steps'})`);
    check(!R.error && digest(R) === digest(S.simulate(sandbox.setup(), sc)), `${name}: the sandbox is deterministic with ${JSON.stringify(sc)}`);
  }
}

// ---- a few semantics worth pinning down
{
  const ch = RS.CHALLENGES.find(c => c.id === 'autoack');
  const R = RS.judge(ch.setup(), ch).run;
  check(R.counts.lostCrash === 17, `rabbitmq: autoAck crash loses the 17 messages in memory (got ${R.counts.lostCrash})`);
  const poison = RS.judge(RS.CHALLENGES.find(c => c.id === 'poison').setup(), RS.CHALLENGES.find(c => c.id === 'poison')).run;
  check(poison.counts.looping === 1 && poison.steps.some(s => /redelivered 500 times, still looping/.test(s.text)), 'rabbitmq: a requeued poison message is reported as looping');
  const rs = RS.CHALLENGES.find(c => c.id === 'restart');
  const R2 = RS.judge(rs.setup(), rs).run;
  check(R2.counts.lostRestart > 0 && R2.counts.lostInFlight > 0, 'rabbitmq: a restart loses the non-durable queue and the unconfirmed in-flight publishes');
  const k = KS.CHALLENGES.find(c => c.id === 'duplicates');
  check(KS.judge(k.setup(), k).run.counts.logDuplicates > 0 && KS.judge(k.solve(k.setup()), k).run.counts.dedupedByBroker > 0, 'kafka: retries duplicate without idempotence and are deduplicated with it');
  const bad = KS.CHALLENGES.find(c => c.id === 'acks').setup();
  bad.blocks.find(b => b.kind === 'producer').idempotence = true;
  check(/acks/.test(KS.simulate(bad).error || ''), 'kafka: enable.idempotence without acks=all is refused');
}

if (failures.length) {
  console.error(`FAILED ${failures.length} of ${checks} checks:\n- ` + failures.join('\n- '));
  process.exit(1);
}
console.log(`ok: ${checks} checks passed`);
