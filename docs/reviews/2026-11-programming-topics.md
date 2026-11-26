# Programming topics audit against docs/QUALITY.md

Scope: fundamentals, csharp (lessons 01-09, projects p01-p06 briefly), python, typescript, dsa, design, sql,
efcore, datascience, auth, crypto. Paths are relative to `C:\Users\henry\source\repos\code-dojo`.
Method: every track.json and module.json, every lesson title, every learn-card title and opening, every
code prompt, and every boss prompt and solution were extracted and read. Targeted cards were read in full
where a fact needed checking.

## Findings that apply to every topic

- **Rule 2 is unmet everywhere. There is not one "senior's toolkit" card in any of the 11 topics.** The word
  "toolkit" appears only in boss titles (`csharp/06-generics-and-linq/06-boss.json`,
  `dsa/05-trees/05-boss.json`, `python/04-functions/06-boss.json`, `crypto/02-hashing-and-macs/06-boss.json`),
  and none of those is a card of commands with flags.
- **Rule 6: the only visualizers that exist are `trace` (C# only) and `linq`.** Learn cards with a visualizer:
  fundamentals 26, dsa 52, crypto 11, csharp 8 (all `linq`, all in module 09), design 4, auth 3. Python,
  typescript, sql, efcore and datascience have **zero**. C# modules 01-08 have zero.
- **Rule 7 is held back by the runner.** C# steps can use only the shared framework plus EF Core with SQLite,
  so there is no xUnit, no NuGet and no Polly. `csharp/08-advanced/04-testing-basics.json` uses a stand-in
  `Assert`, and `csharp/08-advanced/03-dependency-injection.json` says MS DI "is a NuGet package, so it is not
  available here". TypeScript runs through Node type stripping, so type errors are never graded
  (`typescript/05-typescript-types/01-annotations-and-inference.json`, card "Types are erased"). SQL runs
  only on SQLite. No step type runs a real CLI. Every `terminal` hit is a track.json preview, not a step.
- **Rule 3:** most debugging steps say "this code has N bugs, fix it". Few start from a real artefact: a stack
  trace, a log line, a failing test's output or a metric. The good ones (SQL Case #8 p95 jump, EF "could not be
  translated", C# race in `07-concurrency`) show the pattern that should be copied.

## Cross-topic summary: the 15 most valuable additions, in priority order

1. **A senior's toolkit card in every module** (none exist today). It gives commands and APIs with their flags,
   for example `dotnet test --filter "FullyQualifiedName~Orders" --logger "console;verbosity=detailed"`,
   `pytest -k name -x --lf -vv`, `EXPLAIN (ANALYZE, BUFFERS)`, `dotnet ef migrations script --idempotent`,
   `openssl rand -base64 32`.
2. **A real-CLI lab step type** (container or sandboxed shell) graded on resulting state. Use it for
   `dotnet new/add package/build/test/user-secrets/watch`, `npm init/i/run`, `tsc --noEmit`,
   `uv init/add/run`, `psql`, `dotnet ef`, `openssl`. This unlocks most of the missing items below.
3. **Real test frameworks, graded:** xUnit (`[Fact]`, `[Theory]/[InlineData]`, fixtures, NSubstitute or Moq) for
   C#, efcore and auth; pytest with fixtures, `parametrize`, `monkeypatch` and `tmp_path` for Python;
   vitest for TS. Today each of these uses a stand-in.
4. **Visualizers outside C#:** a Python and TS line tracer; an event-loop and microtask visual for TS; SQL
   row-flow for JOIN, GROUP BY buckets, window frames and an EXPLAIN plan tree; a pandas
   groupby/merge/melt visual; `trace` cards in C# modules 01-08.
5. **Grade TypeScript with `tsc --strict --noEmit`.** Today a type error still passes, which defeats the
   purpose of the track. Add a tsconfig/npm module.
6. **Symptom-first debugging with real artefacts in every module:** a stack trace with an inner exception, a
   Python traceback, a source-mapped TS error, `SqliteException`/`DbUpdateException` text, a `JwtBearer`
   IDX10214 log, a slow-query plan. Add one IDE debugger lesson (breakpoints, conditional breakpoints,
   watch, call stack, "break on thrown exceptions").
7. **C# production plumbing module:** `ILogger<T>` with structured templates and scopes;
   `IOptions<T>`/`IOptionsMonitor` with appsettings and env overrides and `dotnet user-secrets`;
   `IHttpClientFactory` with typed clients and `AddStandardResilienceHandler`; `CancellationToken` passed
   through endpoints; health checks; OpenTelemetry basics; `BackgroundService`.
8. **SQL concurrency and safety:** transactions and isolation levels (lost update, `SELECT ... FOR UPDATE`,
   deadlock retry), parameterized queries vs SQL injection, keyset pagination in SQL. Add a PostgreSQL
   engine (or at least `EXPLAIN ANALYZE` output to read).
9. **EF Core as it is used in ASP.NET Core:** `ToListAsync`/`SaveChangesAsync` with `CancellationToken`
   everywhere (zero CancellationToken mentions in the track today), migrations in CI/CD (idempotent scripts,
   bundles, never `EnsureCreated` in prod), SQL Server `rowversion`/Postgres `xmin`, `TagWith`,
   interceptors, Testcontainers.
10. **Python workplace module:** asyncio with httpx, argparse or typer CLIs, `re`, subprocess, `uv` and
    pyproject.toml, `logging.config`, pdb/`breakpoint()`, mypy graded on hints, `datetime`/`zoneinfo`.
11. **Code review module (design):** review a realistic PR diff. Find the bug, the missing test and the naming
    problem, then write the review comments. Also add characterization tests for legacy code and an
    architecture/API design lesson.
12. **Data science on the real stack:** scikit-learn `Pipeline`/`ColumnTransformer`, cross-validation,
    logistic regression, gradient boosting, a target-leakage debugging case, SQL/DuckDB/Parquet into pandas,
    and notebook hygiene.
13. **Auth with the real middleware:** `AddJwtBearer` against an issuer (Authority, Audience,
    `MapInboundClaims=false`) and a "why is it 401?" debugging case from real log text;
    Microsoft.Identity.Web/Entra; ASP.NET Core Identity with passkeys.
14. **TS real front end and back end:** React hooks (`useState`/`useEffect`/custom hooks, keys,
    stale-closure bugs) with Testing Library, real DOM APIs (not HTML strings), a Node HTTP API, and zod
    validation at boundaries.
15. **DSA missing patterns and measured performance:** union-find, trie, backtracking, monotonic
    stack/deque, interval merge, bit tricks, binary search on the answer; Stopwatch/BenchmarkDotNet
    measurement; a "which .NET collection?" decision lab.

Verdicts: fundamentals 3, csharp 3, python 2, typescript 2, dsa 4, design 3, sql 4, efcore 3, datascience 3,
auth 4, crypto 4.

---

## fundamentals: 3/5

The thinking and tracing are strong: 26 `trace` cards, a debugging lesson, edge cases and tests. But it is
all puzzles and a terminal game (Delve), with no tools and no workplace framing.

**MISSING** (most needed at work first)
- Reading a compiler error and a runtime stack trace (file:line, top frame vs root cause). Only
  `05-thinking-like-a-programmer/04-debugging.json` touches this, and it uses no real output.
- Using an IDE debugger: breakpoint, step over/into, watch, call stack.
- Running code from a terminal (`dotnet run`, reading exit codes and stdout vs stderr).
- Strings and text processing beyond the basics (split, parse, format). Collections (list/map/set) are
  deferred entirely to the language tracks.
- Version control as part of working practice. Even one card on "commit small, read the diff" would help.

**WRONG OR OUTDATED:** none found. Overflow, float and truncation cards (`01-state-and-values/03-limits.json`)
are correct for C#.

**GIMMICKS**
- `04-functions-and-recursion/05-boss.json`: a base-32 "save password" in its last step.
- `01-state-and-values/04-boss.json`: an old-money gold/silver/copper converter.
- The Delve scaffolding is motivating, but every module ends in a game piece, not a job task.

**RULE GAPS**
- Toolkit: all 5 modules.
- Symptom-first debugging: none in `01-state-and-values` or `04-functions-and-recursion`. The others use
  "it returns 6, should be 10" style, which is close.
- Visual: covered.
- Boss not a realistic task: `01`..`04` bosses are puzzle sets (Xor, FizzBuzz-like Encounter, Spiral,
  Paths).

**TOP 5 FIXES**
1. `05-thinking-like-a-programmer/04-debugging.json`: add a code step whose prompt is a real C# stack trace
   (`IndexOutOfRangeException ... at Program.<Main>$ line 14`). The learner finds the line and fixes the
   off-by-one. Add an mcq "which frame is your code?".
2. Add lesson `05/02b-using-a-debugger`: learn cards with screenshots or an animated trace of breakpoints,
   watch and the call stack, then `order` steps for a debugging session. Toolkit: F9, F10, F11, Shift+F11,
   conditional breakpoint, "Break when thrown".
3. Add a toolkit card to every module: `dotnet run`, `dotnet watch`, Ctrl+. quick fix, F12 go to definition,
   Shift+F12 find references, rename (F2).
4. Rework bosses 01-04 as tickets. For example "Billing reports a split of £10 among 3 that sums to
   £9.99: fix `Split` and add the edge-case tests" (reuse the existing Split). Keep one Delve piece per
   module as the optional extra.
5. Add a short "strings and text parsing" lesson to module 01 or 03 (parse `key=value` lines, trim, validate),
   because every later track assumes it.

---

## csharp: 3/5 (lessons strong, toolchain weak)

The language coverage is excellent and current: nullability, pattern matching, records, `TimeProvider`,
`WaitAsync`, `CountBy/AggregateBy`, Span, Channels, expression trees. The `sk` artifact is real and installs as
a .NET tool. But the working engineer's plumbing is missing, testing is a stand-in, and modules 01-08 have no
visuals.

**MISSING** (most needed at work first)
- xUnit for real: `[Fact]`, `[Theory]` with `[InlineData]`, `IClassFixture`, `dotnet test --filter`, and a
  mocking library (NSubstitute/Moq). The stand-in is in `08-advanced/04-testing-basics.json`.
- The dotnet CLI and project system in early modules: `dotnet new console/classlib/xunit`, `dotnet sln add`,
  `dotnet add package/reference`, csproj (`TargetFramework`, `Nullable`, `ImplicitUsings`,
  `TreatWarningsAsErrors`), `Directory.Build.props`. Today it appears only in `08-advanced/10-ship-sk.json`.
- Debugging in VS/VS Code/Rider: breakpoints, exception settings, Immediate window, the debugging-async
  "Tasks" window.
- `ILogger<T>`: message templates, levels, scopes and `LoggerMessage` source generation. Zero lesson hits.
- Configuration: `IConfiguration`, appsettings layering, environment variables, `IOptions<T>` with
  validation, `dotnet user-secrets`. Zero hits.
- `IHttpClientFactory` and typed clients, `AddStandardResilienceHandler`, `HttpRequestException.StatusCode`,
  `TaskCanceledException` on timeout. Today only `new HttpClient` is taught
  (`07-async/02-composing-tasks.json`, card "HttpClient, for real").
- Microsoft.Extensions.DependencyInjection lifetimes and the captive-dependency bug. The lesson builds a
  toy container; `AddScoped` has zero lesson hits.
- `IDisposable`/`IAsyncDisposable` patterns, `await using`, streams (`StreamReader`, `File.ReadLinesAsync`),
  `System.Text.Json` options (naming policy, converters, source gen) in lessons.
- Performance measurement: BenchmarkDotNet concepts, `Stopwatch`, `dotnet-counters`/`dotnet-trace`,
  allocations in the profiler. The Span lesson has no measurement.
- Analyzers and formatting: `dotnet format`, `.editorconfig`, nullable warnings as errors.

**WRONG OR OUTDATED / MISLEADING**
- `07-async/02-composing-tasks.json` "HttpClient, for real": "Create one HttpClient and reuse it" without the
  DNS-staleness caveat. A singleton needs `SocketsHttpHandler.PooledConnectionLifetime`, and in apps the norm
  is `IHttpClientFactory`. Timeouts throw `TaskCanceledException`, which is not mentioned.
- `08-advanced/03-dependency-injection.json`: the hand-made `Container` with `Register`/`Singleton` is
  presented as "at its heart". That is fine, but learners never write `builder.Services.AddScoped<...>()`
  in a lesson (only in projects p01/p06).
- `08-advanced/04-testing-basics.json`: the stand-in `Assert` is labelled clearly, but no step ever runs a
  real test project.

**GIMMICKS:** few.
- `02-control-flow/05-boss.json` (FizzBuzz, star staircase, guessing game) and `03-methods-and-collections/06-boss.json`
  (hand-written Min/Max/Average) are classroom drills.
- `01-first-steps/01-hello-world.json`: the banner-printing steps are thin.

**RULE GAPS**
- Toolkit: all 9 modules.
- Visual: `01`..`08` have no `trace`/`linq` card. Async (07) especially needs a timeline of
  WhenAll/WhenAny/cancel, and objects (04) a reference/heap picture.
- Symptom-first: present (race, leaks, deferred traps), but `07-async` lacks a "deadlock/hang from `.Result`"
  symptom step and `05-robust-code` lacks a stack-trace-with-InnerException step.
- Bosses not realistic: `02-control-flow/05-boss.json`, `03-methods-and-collections/06-boss.json`.
- Projects: p01 and p06 are genuinely workplace-shaped (minimal API, ProblemDetails, middleware, DI, paging,
  tests-you-write boss). p02-p05 are solid console tickets. None use xUnit, ILogger or configuration.

**TOP 5 FIXES**
1. New module `08-advanced/11-the-real-app-host` (web framework). Cover `ILogger<T>` with structured
   templates, `IOptions<T>` bound from appsettings with `ValidateOnStart`, `dotnet user-secrets`,
   `AddHttpClient<TClient>` with resilience, and `CancellationToken` from `HttpContext.RequestAborted`.
   Boss: a "weather proxy" endpoint that must time out, retry, log with correlation id and read its API base URL
   from config. Tests check the logs and the 504.
2. Add runner support for xUnit plus NSubstitute and rewrite `08-advanced/04-testing-basics.json`:
   `[Fact]`, `[Theory]`, fixtures, mocks, a code step "write tests that kill these 4 mutants", and a toolkit
   card for `dotnet test --filter`, `--blame-hang-timeout`, `dotnet test --collect:"XPlat Code Coverage"`.
3. Add `trace` cards to modules 01-05 (references vs values in 04, exceptions unwinding in 05) and an async
   timeline visual to 07 (start vs await, WhenAll, cancellation propagation).
4. Add a symptom-first step to `07-async/04-pitfalls.json`. Give the learner a hung request plus a thread dump
   ("Thread pool starvation: 200 threads blocked in Task.Result"), have them find the sync-over-async call,
   and add `dotnet-counters monitor --counters System.Runtime` to its toolkit.
5. Move `dotnet new/add package/sln/csproj` from `10-ship-sk.json` into `01-first-steps` as a lesson with a
   lab or `order` steps, plus a card on reading a build error (`CS8602`, `CS0246`) and fixing it.

---

## python: 2/5

Idiomatic and correct, and targeted at C# developers (it constantly maps to C#). It stops at the language: no
concurrency, no HTTP, no CLI, no regex, no packaging, and tests are graded with bare `assert`.

**MISSING** (most needed at work first)
- pytest itself: running `pytest -k -x --lf -vv`, fixtures in `conftest.py`, `monkeypatch`, `tmp_path`,
  `capsys`. `parametrize` is mentioned in a card (`08-testing-and-tooling/02-good-tests.json`) but the steps
  grade plain functions.
- `asyncio`: `async def`, `gather`, `TaskGroup`, timeouts, and httpx/requests for HTTP calls. Zero hits.
- A CLI with `argparse` (or typer): arguments, exit codes, stdin/stdout/stderr. Zero hits.
- The `re` module: search/match/groups/named groups, `re.compile`, raw strings.
- Packaging in 2026: `uv init/add/run/sync`, `pyproject.toml`, lock files. The track teaches only
  `venv` and `pip freeze` (`08-testing-and-tooling/03-venv-and-pip.json`).
- Debugging: reading a traceback bottom-up, `breakpoint()`/pdb, `python -X dev`, logging config with
  `dictConfig`.
- `datetime` and `zoneinfo`, `os.environ` and config, `subprocess.run(check=True, capture_output=True)`.
- Type checking for real: `TypedDict`, `Optional`/`X | None`, generics, running mypy/pyright as a graded check.
- Concurrency basics: threads vs processes, the GIL, `concurrent.futures`.

**WRONG OR OUTDATED:** nothing incorrect. The toolchain card (`08-testing-and-tooling/04-layout-and-style.json`) is
current (ruff, pyright, pip-audit). It omits uv, which is now the default in many teams.

**GIMMICKS**
- `p01-text-adventure` (whole project): little transfer to work. `p02-data-cruncher` is the useful one.
- `02-control-flow/06-boss.json`: FizzBuzz and diamond printing.

**RULE GAPS**
- Toolkit: all 8 modules (the toolchain table in 08 is close but has no flags).
- Visual: all 8 modules have none. Python object references/aliasing and generators need traces.
- Symptom-first: none in `05-objects`, `06-robust-python` (surprising for an exceptions module) or
  `07-pythonic`.
- Bosses not realistic: `01-basics/06-boss.json`, `02-control-flow/06-boss.json`. Bosses 06, 07 and 08 are good.

**TOP 5 FIXES**
1. New module `09-python-at-work`. Cover argparse CLI, `re`, `subprocess`, `pathlib` and `logging.config`.
   Boss: "write `logscan.py --since 2h --level ERROR file...`", graded by running it with args and checking
   stdout and exit code.
2. New module `10-async-and-http`: `asyncio.gather`/`TaskGroup`/`timeout`, httpx with a fake transport, retries
   with backoff, cancellation. Boss: a rate-limited concurrent fetcher (semaphore of 5, retries, timeout per
   call).
3. Make the runner execute pytest. Rewrite `08-testing-and-tooling/01-02` to use fixtures, `parametrize`,
   `monkeypatch` and `tmp_path` for real, with a toolkit card (`pytest -k`, `-x`, `--lf`, `-vv`, `--pdb`,
   `-q --cov`).
4. In `06-robust-python/01-exceptions.json`, add a traceback-first step: show a 3-level traceback with
   `During handling of the above exception...`, have the learner identify the root cause and fix it. Add a
   `breakpoint()` card.
5. Rewrite `08-testing-and-tooling/03-venv-and-pip.json` around `uv` and `pyproject.toml` (keep pip/venv as
   "you will still see this"), and add a mypy-graded step on hints.

---

## typescript: 2/5

The JS semantics are good: equality, `this`, the event loop, promises, discriminated unions, `assertNever`. But
the "TypeScript" is never type-checked, the DOM and React are simulated with HTML strings, and there is no npm,
no testing and no server.

**MISSING** (most needed at work first)
- `tsc` and `tsconfig` (`strict`, `noUncheckedIndexedAccess`, `moduleResolution`), and graded type errors.
  Zero tsconfig hits; types are stripped at run time.
- npm/pnpm and package.json scripts, lockfiles, `npx`, semver ranges. Zero hits.
- Testing with vitest/jest (`describe/it/expect`, mocks, fake timers) and React Testing Library. Zero hits.
- Real React: `useEffect` (cleanup, dependency arrays, stale closures), keys, controlled inputs, custom
  hooks, data fetching. `useEffect` has zero hits. `08-toward-react-and-next` renders HTML strings.
- The real DOM API: `createElement`, `addEventListener`, `AbortController` for listeners, `FormData`.
  `07-the-dom-and-the-browser` returns strings.
- Browser DevTools: Network tab, breakpoints, `debugger`, source maps, the Performance panel.
- A Node back end: an HTTP handler, env vars, `node --test`, ESM vs CJS.
- Runtime validation at boundaries with zod/valibot, and `satisfies`.
- ESLint and Prettier, `@typescript-eslint` rules that catch floating promises.

**WRONG OR OUTDATED / MISLEADING**
- `08-toward-react-and-next/04-how-nextjs-works.json` "Server and client components": "Zero JavaScript ships
  for them". This overstates it: the RSC payload and React runtime still ship, though no component code does.
- The track promises types that "catch mistakes before users do" (track.json tagline), but
  `05-typescript-types/01-annotations-and-inference.json` admits a type error will not stop an exercise. Steps
  asking "does it compile" are graded on wording, not by `tsc`. This conflicts with rule 7.

**GIMMICKS**
- `08-toward-react-and-next/03-what-jsx-is.json`: writing your own `h()`/renderer is interesting but not work.
- `08-toward-react-and-next/05-thinking-in-tailwind.json`: building class strings is light.

**RULE GAPS**
- Toolkit: all 8 modules.
- Visual: all 8 modules. The event loop (04) is the classic case for a visual.
- Symptom-first: none in `05-typescript-types` (no TS2322/TS2345 error-reading step) or
  `08-toward-react-and-next` (no "infinite re-render" or "state did not update" step).
- Bosses: mostly realistic (job runner, typed inventory, contact book). `08` boss is a simulated page.

**TOP 5 FIXES**
1. Grade every TS code step with `tsc --strict --noEmit` before running. Add lesson
   `05-typescript-types/00-reading-type-errors`: predict/fix steps from real TS2322, TS2345 and TS18048
   messages, with a toolkit card (`tsc --noEmit -p .`, `--watch`, `// @ts-expect-error`, `satisfies`).
2. New module `09-tooling`: package.json, `npm i -D`, scripts, vitest (`it.each`, `vi.useFakeTimers`, `vi.fn`),
   ESLint `no-floating-promises`. Boss: a failing CI log; make the tests and lint pass.
3. Replace `08-toward-react-and-next` string renderers with real React plus Testing Library: `useState`,
   `useEffect` with cleanup and AbortController fetch, keys, a custom `useDebounce`. Add a symptom step:
   "the search shows stale results" (race), to be fixed with abort/ignore flag.
4. Add a Node API lesson (route handler, zod-validated body, 400 with issues, env config). Boss: Next.js
   `route.ts` GET/POST with validation and error shape.
5. Add an event-loop visualizer (call stack, microtask queue, macrotask queue) to `04-async/01-the-event-loop.json`,
   and a DevTools card (Network throttling, breakpoints on fetch/XHR, Pause on exceptions).

---

## dsa: 4/5

This is interview-ready for the core: Big-O with traces, the classic structures, BFS/DFS/topological
sort/Dijkstra, DP, greedy, and time-limited tests. It falls short on several frequent interview patterns and on
measuring real performance.

**MISSING** (most needed at work and in interviews first)
- Measuring: Stopwatch pitfalls, BenchmarkDotNet, allocations; "Big-O said X, the profiler said Y" (cache
  locality, `List<T>` vs `LinkedList<T>`).
- Choosing .NET collections: `SortedDictionary`/`SortedSet`, `ImmutableArray`, `FrozenDictionary`, `Queue` vs
  `Channel`, `HashSet` with a custom comparer. Zero hits for Sorted*.
- Union-find (DSU), tries, backtracking (subsets/permutations/N-queens), monotonic stack/deque (next greater,
  sliding max), interval merge/insert, bit manipulation, binary search on the answer. None are present.
- Strings: two-pointer and window on strings is present; KMP/rolling hash are optional.
- Interview communication: clarifying questions, stating complexity, testing out loud.

**WRONG OR OUTDATED:** none. The introsort/stability card (`04-searching-and-sorting/04-quicksort-and-stability.json`) is correct.

**GIMMICKS:** none significant. `02-linear-structures/05-boss.json` (Josephus "hot potato") is an interview
classic, acceptable.

**RULE GAPS**
- Toolkit: all 7 modules. There is no card of .NET APIs with their complexities (`PriorityQueue.EnqueueRange`,
  `BinarySearch` returning `~index`, `CollectionsMarshal.AsSpan`).
- Symptom-first: none in `01-complexity`, `02-linear-structures`, `05-trees` or `06-graphs`. For example: a
  `StackOverflowException` from recursive DFS on a 500x500 grid, or a timeout from O(n²) `List.Contains`.
- Visual: good (52 traces).
- Bosses are LeetCode-style, not job tickets (fine for rule 10, weak for rule 1).

**TOP 5 FIXES**
1. New module `08-more-patterns`: union-find, trie, backtracking, monotonic stack, intervals, each with a
   trace card and a timed code step. Boss: a mixed interview set where the learner must first pick the
   technique (`sort` step), then solve.
2. New lesson `01-complexity/05-measure-dont-guess`: Stopwatch warm-up traps and BenchmarkDotNet
   output to read (mcq: which row allocates?), plus a code step "this endpoint times out on 100k items" with
   `List.Contains` in a loop; fix it with `HashSet`.
3. Add a symptom-first step to `06-graphs`: the recursive flood fill crashes with
   `Stack overflow. Repeat 10000 times: at Program.Dfs` and must be converted to an explicit stack.
4. Add a toolkit card per module listing .NET APIs with complexity and gotchas (`List.Insert(0)` O(n),
   `Dictionary` enumeration order not guaranteed, `PriorityQueue` no decrease-key).
5. Make one boss a job ticket. For example the `06-graphs` boss: "the build system's dependency resolver
   loops forever on a cycle: detect it and print the cycle path".

---

## design: 3/5

Clean, correct code-level design: naming, guard clauses, SOLID, illegal states, seams, functional core,
mutation-style test grading, and refactoring with behaviour locked. It stays at class level. There is no code
review, no architecture, no API design and no legacy-code workflow.

**MISSING** (most needed at work first)
- Code review: reading a diff, prioritising (correctness > tests > design > nits), and writing actionable
  comments. This is a weekly activity and is absent.
- Working with legacy code: characterization (golden-master) tests before refactoring, the strangler
  pattern, sprout/wrap method.
- IDE refactoring tools: Rename (F2 / Ctrl+R,R), Extract Method (Ctrl+R,M), Introduce Parameter,
  safe-delete, Find usages.
- Architecture basics: layering vs vertical slices, modular monolith boundaries, dependency direction,
  where validation and transactions live, DTOs vs domain types.
- API/contract design: naming, versioning, backward-compatible changes, error shapes (ProblemDetails),
  idempotency.
- Error-handling design: exceptions vs Result at boundaries, logging once, failing fast.
- Concurrency-aware design: immutability for thread safety, avoiding shared mutable statics.

**WRONG OR OUTDATED:** none found. Primary constructors and `readonly record struct` are used correctly.

**GIMMICKS:** none. The examples are small but always tied to a rule with a reason.

**RULE GAPS**
- Toolkit: all 6 modules.
- Visual: none in `04-patterns`, `05-testable-code` or `06-refactoring`. A dependency-arrow diagram before and
  after inversion, and a pattern object diagram, are needed.
- Symptom-first: none in `01-readable-code`, `03-coupling-and-cohesion`, `04-patterns` or `06-refactoring`.
  For example: "a change to tax broke shipping: find the hidden coupling".
- Bosses: realistic (legacy invoice, payroll knot, order monster). Good.

**TOP 5 FIXES**
1. New module `07-code-review`. Learn cards cover what to look for and how to phrase comments. Steps: `sort`
   comments into blocking/non-blocking, an mcq "which comment is actionable?", and a code step that fixes the 3
   real issues in a diff. Boss: review a 60-line PR (a hidden N+1, a missing null check, a test that asserts
   nothing) by writing a test that exposes each issue.
2. Add `06-refactoring/00-characterization-tests`: lock legacy output with a golden-master test, then
   refactor. The boss of 06 should start with this step.
3. Add a toolkit card to each module with IDE refactorings and their shortcuts (VS, Rider, VS Code), plus
   `dotnet format` and analyzer IDs (CA1822, IDE0052).
4. New lesson `03-coupling-and-cohesion/06-architecture-boundaries`: vertical slice vs layers, with a
   dependency diagram visual. Code step: move logic out of an endpoint into a handler so it is testable without
   HTTP.
5. Add a symptom-first step to `03-coupling-and-cohesion/01-cohesion-and-coupling.json`: a failing test after an
   unrelated change. The learner traces the shared mutable static and removes it.

---

## sql: 4/5

This is the best-designed track here. Every module ends in a realistic investigation case, it covers NULL logic,
anti-joins, the row-explosion trap, windows, gaps and islands, data quality, EXPLAIN QUERY PLAN,
SARGability, N+1, and a star-schema project. It is limited by SQLite and misses concurrency and safety.

**MISSING** (most needed at work first)
- Parameterized queries and SQL injection, from the application side. Zero hits in sql.
- Transactions under concurrency: isolation levels, lost update, `SELECT ... FOR UPDATE`, deadlocks and retry,
  lock waits. Only BEGIN/COMMIT appears (`06-modifying-data/04-upserts-and-transactions.json`).
- PostgreSQL/SQL Server reality: `EXPLAIN (ANALYZE, BUFFERS)`, actual vs estimated rows, `pg_stat_statements`,
  SQL Server execution plans, statistics, `VACUUM`/autovacuum. The dialect cheat sheet exists, but no engine.
- Keyset pagination in SQL (OFFSET cost). It is taught only in efcore.
- Zero-downtime schema changes: add nullable column, backfill in batches, add constraint `NOT VALID` then
  validate, create index concurrently.
- `RETURNING`/`OUTPUT`, `MERGE`, generated columns, partial indexes, date and time-zone storage (UTC,
  `timestamptz`).
- Working with a client: `psql` (`\d`, `\x`, `\timing`), `sqlcmd`, `sqlite3 .mode/.schema`.

**WRONG OR OUTDATED:** none found. `->>` JSON (SQLite 3.38+) and ON CONFLICT upsert are correct for SQLite.

**GIMMICKS**
- "Query golf" holes, which grade on character count and reward terse SQL over readable SQL:
  `01-select-basics/03-shaping-results.json`, `02-aggregation/03-having.json`,
  `04-subqueries-and-ctes/03-ctes.json`, `05-window-functions/01-ranking.json`.

**RULE GAPS**
- Toolkit: all 9 modules. The "Dialect cheat sheet" in `09-real-world/04-gaps-islands-quality.json` is the
  only near-toolkit card.
- Visual: all 9 modules. JOIN row-matching, GROUP BY buckets, window frames and B-tree lookups all need
  pictures.
- Symptom-first: none in `02-aggregation` (no "the total is double what finance says" step) or
  `07-designing-schemas`. Module 08's Case #8 is the model to copy.
- Bosses: all realistic. Excellent.

**TOP 5 FIXES**
1. New module `10-concurrency-and-safety`. Card on isolation levels with a two-session timeline visual. Code
   steps: reproduce a lost update, fix it with an atomic `UPDATE ... SET stock = stock - 1 WHERE stock > 0`,
   then with `FOR UPDATE`. A parameterization lesson takes an injected `' OR 1=1 --` login query and fixes
   it. Boss: an "oversold concert" incident.
2. Add a PostgreSQL engine (or a recorded-plan reader) to `08-performance`. Read `EXPLAIN ANALYZE` output
   (Seq Scan vs Index Scan, rows estimate vs actual, Buffers), with a toolkit card
   (`EXPLAIN (ANALYZE, BUFFERS)`, `\timing`, `pg_stat_statements`, `CREATE INDEX CONCURRENTLY`).
3. Replace the 4 query-golf holes with "review this query" steps: a correct but slow or unreadable query, to be
   rewritten for SARGability or clarity, graded on results plus plan.
4. Add visualizers: a join matcher (rows pairing, NULL-filled for LEFT), a GROUP BY bucket animation and a
   window-frame slider. Use them in 02, 03 and 05.
5. Add `07-designing-schemas/05-changing-a-live-schema`: expand/contract migration steps (`order` step),
   backfill in batches, and a symptom step where a migration locked the table for 10 minutes.

---

## efcore: 3/5

The coverage is broad and correct: conventions, Fluent API, owned types, relationships, translation errors,
`ExecuteUpdate`, concurrency tokens, split queries, keyset paging, and real web+EF bosses. But it teaches
synchronous EF in a web context and SQLite-only behaviour.

**MISSING** (most needed at work first)
- Async everywhere with `CancellationToken`: `ToListAsync(ct)`, `SaveChangesAsync(ct)`,
  `FirstOrDefaultAsync`. Today there are 41 files with `SaveChanges()`, 8 with `SaveChangesAsync`, and zero
  CancellationToken mentions.
- Migrations as deployed: `dotnet ef migrations script --idempotent` in CI, migration bundles, reviewing
  generated SQL, `HasPendingModelChanges`, and why `Migrate()` at startup is risky with several instances.
- SQL Server/Postgres specifics: `rowversion`/`IsRowVersion`, `xmin`, `UseSqlServer` retry strategy
  (`EnableRetryOnFailure`), collation and case sensitivity differences.
- Diagnostics: `LogTo` with filters, `EnableSensitiveDataLogging` (dev only), `TagWith`, interceptors, reading
  `DbUpdateException` inner exceptions.
- Testing against the real engine with Testcontainers, and why the InMemory provider lies.
- Global query filters (soft delete, multi-tenant), JSON columns/`ComplexProperty`, `AddDbContextPool`,
  `IDbContextFactory` for background services.

**WRONG OR OUTDATED / MISLEADING**
- `06-migrations-and-real-apps/05-boss.json` and `p01-library-api`: APIs call `EnsureCreated()` at startup and
  use sync `ToList()`/`SaveChanges()` inside minimal-API handlers. This is not the modern norm for ASP.NET
  Core. Say so, and use async with `ct`.
- `06-migrations-and-real-apps/05-boss.json` step 3: "do the count and insert inside a transaction". On SQL
  Server the default READ COMMITTED does **not** prevent the double booking. The prompt notes this in passing,
  but the taught fix only works because SQLite locks the whole database. Teach a unique or check constraint, or
  `SERIALIZABLE`, or a conditional update.

**GIMMICKS:** none.

**RULE GAPS**
- Toolkit: all 7 modules. This is the biggest miss: no card for `dotnet ef migrations add/list/remove/script`,
  `database update <migration>`, `ToQueryString()`, `LogTo`.
- Visual: all 7 modules. The change tracker state machine, Include join shape and Cartesian explosion need
  pictures.
- Symptom-first: none in `01-first-context`, `02-modelling` or `06-migrations-and-real-apps`.
  `04-querying` (could-not-be-translated) and `07-performance` (query counts) have good ones.
- Bosses: realistic (help desk concurrency, events API, library API). Good.

**TOP 5 FIXES**
1. Convert all web+efcore steps (`06-*`, `p01-library-api`) to async with a `CancellationToken` parameter, and
   add a card on why (thread pool, request aborts). Tests check that `ct` is passed (`TagWith` or an
   interceptor can detect it).
2. Add `06-migrations-and-real-apps/05-migrations-in-production`. Order the steps of a deploy (script, review,
   apply, deploy app), plus a code step where a rename migration would drop data and must be fixed with
   `RenameColumn`. Toolkit card: `dotnet ef migrations add X -o Data/Migrations`, `migrations script A B
   --idempotent`, `migrations bundle`, `database update 0`.
3. Add a symptom-first step to `02-modelling`. Show `SQLite Error 19: 'UNIQUE constraint failed: Accounts.Username'`
   (and its SQL Server twin 2601) wrapped in `DbUpdateException`; the learner maps it to a 409 response.
4. Add a change-tracker visual (Added → Unchanged → Modified → Deleted with the SQL each sends) to
   `05-change-tracking-and-saving/01-entity-states.json`.
5. Fix the race lesson in `06-migrations-and-real-apps/05-boss.json`. Teach the database-enforced fix (a
   conditional `ExecuteUpdate` decrementing `SeatsLeft WHERE SeatsLeft > 0`, or a constraint), explain
   isolation levels on SQL Server/Postgres, and add a Testcontainers note.

---

## datascience: 3/5

The pandas is solid and current (copy-on-write, pandas 3 `str` dtype, `resample("ME")`, time zones,
`validate="many_to_one"`). Statistics are taught by simulation (bootstrap, permutation A/B), and the honest-charts
lesson is good. But models are hand-built and the real ML/analysis stack is barely touched.

**MISSING** (most needed at work first)
- scikit-learn as used: `Pipeline`, `ColumnTransformer`, `StandardScaler`/`OneHotEncoder`, `cross_val_score`,
  `GridSearchCV`, `train_test_split(stratify=)`. It is mentioned only in
  `09-first-models/06-kmeans-and-next-steps.json`.
- Logistic regression, tree ensembles (RandomForest, gradient boosting/LightGBM/XGBoost), feature importance,
  class imbalance, ROC-AUC/PR-AUC, calibration.
- Data leakage: fitting the scaler on all data, target leakage, time-based splits. Only touched in one boss step.
- Getting data in: SQL from Python (`pd.read_sql` with SQLAlchemy), Parquet, DuckDB, large files
  (`chunksize`, dtypes, `pyarrow`), polars awareness.
- Notebook workflow: Jupyter/VS Code notebooks, restart-and-run-all, moving code into modules.
- Plotting beyond matplotlib: seaborn for statistical plots, plotly for interactive charts.
- Classical stats people get asked about: t-test/chi-square via `scipy.stats`, power and sample size, multiple
  testing, peeking in A/B tests.

**WRONG OR OUTDATED:** none found.

**GIMMICKS:** none. Implementing kNN and k-means from scratch is justified as "what the tools do inside"
(`09-first-models/06-kmeans-and-next-steps.json`).

**RULE GAPS**
- Toolkit: all 9 modules. There is no card such as `df.info(memory_usage="deep")`, `value_counts(dropna=False)`,
  `pd.set_option("display.max_columns")`, `df.pipe`, `query`, `assign`.
- Visual: no visualizer card in any of the 9 modules. Code steps do produce charts, but groupby, merge,
  melt/pivot and broadcasting are never visualised.
- Symptom-first: none in `01-thinking-with-data`, `02-numpy`, `05-grouping-and-joining` (no "revenue doubled
  after merge" step, though the trap card exists), `06-time-series` (no "daily totals off by one day: UTC
  vs local" step) or `08-statistics`.
- Bosses: realistic and graded on behaviour. Good.

**TOP 5 FIXES**
1. New module `10-ml-with-scikit-learn`: Pipeline plus ColumnTransformer, cross-validation, logistic regression
   and gradient boosting, metrics (ROC-AUC, PR-AUC), a confusion matrix at a chosen threshold. Boss: a churn
   model with a leakage bug to find (a scaler fit before the split, or a future column), graded on CV score
   within a range and on the leak being removed.
2. Add a symptom-first step to `05-grouping-and-joining/04-merge.json`: "the finance total is 2.3x the ledger",
   fixed with `validate=` and `indicator=True`. Add one to `06-time-series/05-time-zones.json`: "Monday's sales
   include Sunday night".
3. Add a groupby/merge/melt visualizer (split-apply-combine animation, merge key matching with row
   multiplication) to modules 03 and 05.
4. New lesson `03-pandas-foundations/08-getting-data-in`: `read_sql` against SQLite with parameters, Parquet
   round-trip, DuckDB SQL over a DataFrame, `chunksize`. Toolkit card with the flags.
5. Add `08-statistics/08-classical-tests`: `scipy.stats.ttest_ind(equal_var=False)`, `chi2_contingency`, power
   with `statsmodels`, and an A/B "peeking" simulation showing a false-positive inflation.

---

## auth: 4/5

Accurate and current: OWASP's 600,000 PBKDF2 iterations, Argon2id noted, TOTP per RFC 6238 with replay
protection, fixation, CSRF with SameSite, JWT attacks, JWKS/kid, refresh rotation with reuse detection, PKCE,
OIDC discovery, BOLA, CORS, log redaction. The main gap is that ASP.NET Core's real `JwtBearer` and Identity
stacks are described but not exercised (the runner cannot load those packages).

**MISSING** (most needed at work first)
- Configuring `AddJwtBearer` against a real issuer (Authority, Audience, `TokenValidationParameters`,
  `MapInboundClaims = false`, `ValidAlgorithms`) and debugging it from its logs (IDX10214 audience,
  IDX10223 lifetime, IDX10503 signature, `WWW-Authenticate: Bearer error="invalid_token"`). Today steps use a
  hand-written `HsBearerHandler` (`05-in-aspnet-core/03-handlers-and-policies.json`).
- Microsoft.Identity.Web/MSAL with Entra ID (the Microsoft workplace default): app registrations, scopes vs app
  roles, on-behalf-of. Entra is mentioned on a card only.
- ASP.NET Core Identity (`AddIdentity`/`MapIdentityApi`), and passkeys/WebAuthn hands-on (passkeys appear on one
  card).
- Decoding tokens in practice: jwt.ms/jwt.io, `dotnet user-jwts create` for local testing.
- Rate limiting with `AddRateLimiter` on login, and resource-based authorization (`IAuthorizationHandler` with an
  owner check) as the framework way to stop BOLA.
- The BFF pattern for SPAs (tokens out of the browser), DPoP awareness.

**WRONG OR OUTDATED:** none found. The algorithm and iteration guidance in
`01-foundations/02-hashing-passwords.json` and `01-foundations/03-verifying-passwords.json` is current.

**GIMMICKS:** none.

**RULE GAPS**
- Toolkit: all 6 modules. Missing items include `dotnet user-jwts`, `curl -H "Authorization: Bearer ..." -v`,
  jwt.ms, browser DevTools Application > Cookies, and `openssl rand`.
- Visual: none in `01-foundations`, `02-sessions-and-cookies` (cookie and CSRF sequence diagrams needed),
  `05-in-aspnet-core` (middleware pipeline: authn, authz, endpoint) or `06-api-security` (CORS preflight
  sequence).
- Symptom-first: none in `01-foundations`, `04-oauth2-and-oidc` (for example a callback failing with
  `invalid_grant` or a state mismatch) or `05-in-aspnet-core`.
- Bosses: realistic. Good.

**TOP 5 FIXES**
1. Ship `Microsoft.AspNetCore.Authentication.JwtBearer` in the web runner. Add
   `05-in-aspnet-core/05-the-real-jwtbearer`: configure it against the dojo's OIDC server from module 04.
   Symptom-first step: "every call returns 401" with the IDX10214 log line; the learner fixes the Audience
   setting. Toolkit card: `dotnet user-jwts create --role admin --scope tasks:write`, `curl -i`, jwt.ms.
2. Add `04-oauth2-and-oidc/06-entra-and-microsoft-identity-web`: app registration fields, `AddMicrosoftIdentityWebApi`,
   scopes vs app roles, the client credentials flow. Use mcq/match steps if packages cannot run.
3. Add sequence-diagram visuals: the cookie session flow, CSRF attack vs SameSite, the auth code + PKCE redirect
   dance, and the CORS preflight.
4. Add `01-foundations/06-passkeys-and-identity`: how WebAuthn registration and assertion work (visual), and
   ASP.NET Core Identity's PasswordHasher and lockout as the framework counterpart of the hand-built pieces.
5. Add a resource-based authorization step (`IAuthorizationService.AuthorizeAsync(user, invoice, "Owner")`) to
   `06-api-security/02-bola-and-the-owasp-top-10.json`, plus `AddRateLimiter` on `/login`.

---

## crypto: 4/5

Deep, correct and current: AEAD, nonce reuse demonstrated, padding oracles, HKDF, envelope encryption and KEK
rotation, blind indexes, timing attacks, downgrade protection, ML-KEM/ML-DSA (`MLKem` noted with
`IsSupported`). Many steps are already the "fix this broken code" kind. It lacks the operational tools
engineers actually touch.

**MISSING** (most needed at work first)
- A real KMS/Key Vault SDK: Azure `KeyClient`/`CryptographyClient` (WrapKey/UnwrapKey), AWS KMS
  `GenerateDataKey`, managed identity. Envelope encryption is taught, but only with in-memory KEKs.
- The `openssl` CLI: `rand -hex 32`, `dgst -sha256 -hmac`, `genpkey -algorithm EC`, `pkeyutl`, `s_client
  -connect` (one mention only). Also `age`/gpg for file encryption.
- ASP.NET Core Data Protection hands-on: key ring persistence to blob/Redis, `ProtectKeysWithAzureKeyVault`,
  the "keys lost on container restart → users logged out" symptom. It appears on one card only.
- X.509 basics in code (`X509Certificate2`, loading PFX/PEM, `GetRSAPrivateKey`). This may live in the pki
  track; cross-link it.
- Libraries teams reach for: libsodium/NSec (XChaCha20, Ed25519), Tink, and when to prefer them.

**WRONG OR OUTDATED:** none found.

**GIMMICKS**
- `01-foundations/06-boss.json`, step 1: print byte count/hex/base64 per line. Trivial.
- `06-attacks-and-the-future/05-boss.json`, step 1 and `06-attacks-and-the-future/01-brute-force-math.json`:
  brute-force "years" calculators. These are arithmetic, not work.
- `01-foundations/04-xor-and-the-one-time-pad.json` is acceptable as a foundation, since it sets up nonce reuse.

**RULE GAPS**
- Toolkit: all 6 modules. There is no card with `openssl` commands, .NET API names with their footguns
  (`AesGcm(key, tagSizeInBytes)`, `RandomNumberGenerator.GetString`) or `az keyvault key` commands.
- Visual: none in `05-in-practice`. Envelope encryption and the key hierarchy need a diagram.
- Symptom-first: present in every module.
- Bosses: realistic (payments encryption layer, secure team mail, vault).

**TOP 5 FIXES**
1. Add `05-in-practice/06-kms-for-real`: Key Vault/KMS wrap and unwrap with a local emulator or a recorded fake
   that has the real SDK shape. Code step: rewrite the in-memory KEK ring from the boss to call `WrapKeyAsync`
   with a cached DEK. Toolkit card: `az keyvault key create --kty RSA-HSM`, `aws kms generate-data-key`.
2. Add an `openssl` lab (needs the CLI lab step): generate keys, HMAC a webhook body and compare it with the
   C# result, inspect a server cert with `s_client -showcerts`. Graded on outputs.
3. Add a Data Protection lesson with a symptom-first step: "after redeploy every user is logged out and
   antiforgery fails". The learner adds `PersistKeysTo...` and `SetApplicationName`.
4. Add an envelope-hierarchy visual (KMS → KEK → DEK → data, with what rotates when) to
   `05-in-practice/02-envelope-encryption.json`.
5. Replace the two calculator boss steps with ops tasks. For example "audit this config dump: flag
   ECB/CBC-without-MAC/static IV/RSA-1024 and propose replacements", graded on the findings list.
