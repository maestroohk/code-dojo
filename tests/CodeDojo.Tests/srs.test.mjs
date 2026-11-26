// Checks the flashcard scheduler and the "type it" command comparison (ui/srs.js) in plain Node.
// Run: node tests/CodeDojo.Tests/srs.test.mjs   (PracticeExtrasTests.cs runs it as part of dotnet test)
const S = await import(new URL('../../ui/srs.js', import.meta.url));

const failures = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) failures.push(what); };
const MIN = 60_000, DAY = 86_400_000;
const t0 = new Date(2026, 10, 26, 9, 0, 0).getTime();
const days = (card, now) => Math.round((S.dayStart(card.due) - S.dayStart(now)) / DAY);

// ---- learning steps: 1 min, 10 min, then 1 day; Easy graduates to 4 days
let c = S.grade(null, 3, t0, 'a');
check(c.s === 'learn' && c.due - t0 === 10 * MIN, 'Good on a new card: next learning step, 10 minutes');
c = S.grade(c, 3, t0 + 10 * MIN, 'a');
check(c.s === 'review' && c.ivl === 1 && days(c, t0) === 1, 'Good on the last step graduates to 1 day');
check(S.grade(null, 1, t0).due - t0 === MIN, 'Again on a new card: 1 minute');
const easy = S.grade(null, 4, t0);
check(easy.s === 'review' && easy.ivl === 4, 'Easy on a new card graduates to 4 days');
check(S.grade(null, 2, t0).due - t0 === 5.5 * MIN, 'Hard on the first step: halfway between the steps');

// ---- review intervals grow by ease, Hard < Good < Easy, ease moves
const rev = { s: 'review', step: 0, ivl: 10, ease: 2.5, reps: 5, lapses: 0, due: t0 };
const h = S.grade(rev, 2, t0, 'x'), g = S.grade(rev, 3, t0, 'x'), e = S.grade(rev, 4, t0, 'x');
check(h.ivl < g.ivl && g.ivl < e.ivl, `review intervals order Hard ${h.ivl} < Good ${g.ivl} < Easy ${e.ivl}`);
check(Math.abs(g.ivl - 25) <= 2, `Good multiplies by ease (about 25 days, got ${g.ivl})`);
check(h.ease === 2.35 && g.ease === 2.5 && e.ease === 2.65, 'ease: Hard -0.15, Good same, Easy +0.15');
check(rev.ivl === 10 && rev.ease === 2.5, 'grade() does not change its input');

// ---- a lapse: relearn in 10 minutes, ease -0.2, interval shrinks, then back to review
const lapse = S.grade(rev, 1, t0, 'x');
check(lapse.s === 'relearn' && lapse.lapses === 1 && lapse.ease === 2.3 && lapse.due - t0 === 10 * MIN, 'Again on a review card is a lapse');
const back = S.grade(lapse, 3, t0 + 10 * MIN, 'x');
check(back.s === 'review' && back.ivl === 2, `after relearning it returns at 20% of the old interval (got ${back.ivl})`);
let low = { ...rev, ease: 1.35 };
low = S.grade(low, 1, t0);
check(low.ease === 1.3, 'ease never drops under 1.3');

// ---- overdue reviews: remembering after a gap earns a longer interval
const late = S.grade({ ...rev, due: t0 - 10 * DAY }, 3, t0, 'x');
check(late.ivl > g.ivl, 'a card remembered late gets a longer interval');

// ---- fuzz is deterministic and small
check(S.fuzz(100, 'id', 3) === S.fuzz(100, 'id', 3), 'fuzz is deterministic');
check(Math.abs(S.fuzz(100, 'id', 3) - 100) <= 5, 'fuzz stays within ±5%');
check(S.fuzz(2, 'id', 1) === 2, 'no fuzz under 3 days');

// ---- previews for the buttons
check(S.preview(null, 1, t0) === '1m' || S.preview(null, 1, t0) === '<1m', 'preview: Again on a new card');
check(S.preview(null, 4, t0) === '4d', 'preview: Easy on a new card is 4d');

// ---- queue and daily limits
const cards = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}` }));
const flash = S.ensure({ settings: { newPerDay: 10, reviewsPerDay: 3 } });
flash.cards.c0 = { ...rev, due: t0 - DAY };
flash.cards.c1 = { ...rev, due: t0 };
flash.cards.c2 = { ...rev, due: t0 + 3 * 3600_000 };   // later today: due
flash.cards.c3 = { ...rev, due: t0 + 2 * DAY };        // not due
flash.cards.c4 = { ...rev, due: t0 - 3 * DAY };
flash.cards.c5 = { s: 'learn', step: 1, due: t0 + 5 * MIN, ivl: 0, ease: 2.5, reps: 1 };
let q = S.buildQueue(cards, flash, t0);
check(q.counts.review === 3 && q.review[0].id === 'c4', 'reviews: most overdue first, capped at the daily limit');
check(q.counts.learning === 1, 'a learning card due today is in the queue');
check(q.counts.fresh === 10, 'new cards limited per day');
S.answer(flash, 'c10', 3, t0);
check(flash.days[S.dayKeyOf(t0)].new === 1, 'answering a new card counts against the new limit');
q = S.buildQueue(cards, flash, t0);
check(q.counts.fresh === 9, 'one fewer new card left');
flash.suspended.c4 = true;
check(!S.buildQueue(cards, flash, t0).review.some(x => x.id === 'c4'), 'suspended cards are skipped');
check(S.dueCount(flash, t0) >= 4, 'due count for the badge');

// ---- stats: retention, streak, 7-day forecast
const st0 = S.ensure({});
st0.log = [
  { t: t0 - DAY, id: 'a', g: 3, s: 'review' }, { t: t0 - DAY, id: 'b', g: 1, s: 'review' },
  { t: t0 - 2 * DAY, id: 'c', g: 3, s: 'review' }, { t: t0, id: 'd', g: 4, s: 'new' }, { t: t0 - 40 * DAY, id: 'e', g: 1, s: 'review' },
];
st0.cards = { a: { ...rev, due: t0 }, b: { ...rev, due: t0 + DAY }, c: { ...rev, due: t0 + 6 * DAY }, d: { ...rev, due: t0 + 9 * DAY, ivl: 30 } };
const st = S.stats(st0, t0);
check(Math.abs(st.retention - 2 / 3) < 1e-9, `retention counts review answers in 30 days (got ${st.retention})`);
check(st.streak === 3, `streak of active days (got ${st.streak})`);
check(st.forecast.length === 7 && st.forecast[0] === 1 && st.forecast[1] === 1 && st.forecast[6] === 1, `forecast ${st.forecast}`);
check(st.states.mature === 1 && st.states.young === 3, 'mature cards have 21+ day intervals');

// ---- "type it"
const same = (a, b) => S.compareCommand(a, b).ok;
check(same('git log --oneline --graph', 'git log --oneline --graph'), 'exact command');
check(S.compareCommand('git log --oneline --graph', 'git log --oneline --graph').exact, 'exact is flagged');
check(same('git log --graph --oneline', 'git log --oneline --graph'), 'flags in another order');
check(same('rg -wn TODO', 'rg -nw TODO'), 'clustered short flags in another order');
check(same('rg -n -w TODO', 'rg -nw TODO'), 'clustered = separate short flags');
check(same('docker run --cpus 1 --memory 512m nginx', 'docker run --memory 512m --cpus 1 nginx'), 'flags with values in another order');
check(same("git commit -m 'Fix typo'", 'git commit -m "Fix typo"'), 'quotes do not matter');
check(same('kubectl logs --since=10m api', 'kubectl logs --since 10m api'), '--name=value equals --name value');
check(same('git range-diff main...topic', 'git range-diff <range>'), 'a placeholder accepts any word');
check(!same('git log --oneline', 'git log --oneline --graph'), 'a missing flag fails');
check(!same('git log --oneline --graph --all', 'git log --oneline --graph'), 'an extra flag fails');
check(!same('find . -type f -name x', 'find . -name x -type f'), 'find keeps its order');
check(!same('kubectl get pods', 'kubectl get svc'), 'a different subcommand fails');
check(same('ps aux | grep -i nginx', 'ps aux | grep -i nginx'), 'pipelines');
check(!same('grep -i nginx | ps aux', 'ps aux | grep -i nginx'), 'pipeline order matters');
const diff = S.compareCommand('git log --oneline', 'git log --oneline --graph');
check(diff.missing.join() === '--graph' && diff.extra.length === 0, 'reports the missing token');
check(S.tokenize('echo "a b" | wc -l').join('|') === 'echo|a b|||wc|-l', 'tokenize groups quotes and splits pipes');

if (failures.length) { console.error(failures.map(f => '  FAIL ' + f).join('\n')); console.error(`${failures.length} of ${checks} checks failed`); process.exit(1); }
console.log(`${checks} checks passed`);
