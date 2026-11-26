# code-dojo curriculum redesign: every topic builds something real

Status: plan, no content changed yet. Audience: whoever edits `tracks/` and whoever builds the engine side
(`server/Builds.cs`, `server/Content.cs`, the UI). Lesson ids below are real file names.

## 0. What is wrong today (survey of all 21 tracks, 852 lessons)

- **The final code step of most lessons produces a throwaway function.** In the DevOps and tooling tracks it is
  worse: the learner writes a C# *model* of the tool instead of using the tool. Docker never asks for a real
  Dockerfile (30 of 30 final steps are C# parsers of Dockerfiles or compose files, including the
  `p01-containerize-an-app` stages after stage 1). Kubernetes (29/29), editors (22/22), Linux (29/29) and Git
  (35/37) are the same. CI/CD's project prints YAML with `Console.WriteLine`. The learner finishes able to
  explain `docker ps` output but has never shipped a container.
- **Language tracks have no through-line.** C# module lessons jump between a till, a guessing game, a stockroom,
  a bank, an insurer and a staff directory. Six C# projects each build a different app (tasks, expenses,
  gradebook, logs, orders, a library). Nothing the learner writes in lesson 3 is still alive in lesson 30.
- **Projects build toys the learner will not run again**: a library system (Shelfwise, 32 stages), a gradebook,
  a text adventure, an in-memory CA with fixed dates (`pki/p01-mini-ca`), a "house prices" model.
- **Thin and fast lessons.** Lessons whose final solution is under 8 lines: Python 20, TypeScript 14,
  fundamentals 10, CI/CD 8, data science 7, auth 7, EF Core 7, Git 6 (full list in each track section).
  SQL looks thin by line count but is not (3 to 5 code steps per lesson); it is fine.
- **No gates.** Every module's first lesson is open and nothing checks that a skill survived a week.
- Bug spotted: `tracks/cicd/track.json` is titled "Linux & the shell" with the Linux tagline. It should be
  `"CI/CD"` / "Build, test and ship every change automatically."

## 1. Principles

### 1.1 One dream per topic, chosen by the learner

1. **Every track builds ONE real artifact per learner** that they keep and use on their own Windows machine with
   Docker Desktop and the .NET 10 SDK: a tool, a service, a script kit, a database, a report. The learner picks
   it from **4 to 5 curated dreams** per track (2.17), all built on one shared skeleton, suggested by their
   onboarding profile (3.8). Some artifacts are shared across tracks (section 2.0). Sections 2.1 to 2.16 describe
   each track's flagship dream, which defines the skeleton.
2. **It is a dream, not a chore.** Each artifact is something a beginner would *look up to*: a personal assistant
   with a dashboard, a game, a local certificate authority, a gateway in front of your own services. The track
   opens by showing the finished thing working (the *dream reveal*, section 3.6).
3. **Lesson 1, code step 1 already contributes a piece** (often just the banner the finished app prints). From
   then on, every lesson's **final code step** adds the next piece, in order. The whole track is the through-line,
   not just its projects.
4. **Pieces are the learner's own passing code**, saved as a file of the artifact (`build` marker, section 3).
   Practice steps can live in other worlds (a hospital, a bike share) for variety; the final step brings the
   skill home into the artifact. Learners often do not notice the pieces adding up until the reveal moment
   when the artifact first runs ("you have been building this all along").
5. **Real world at the edges, deterministic in the middle.** Graded code never touches the network, the clock or
   the real file system. Pieces take seams (`IClock`, `IFileSystem`, `IGit`, `Func<string, Task<string>> fetch`,
   a `root` path). The artifact's template wires the real ones (`TimeProvider.System`, `HttpClient`,
   `Process.Start("git")`, `%USERPROFILE%\.sidekick`). The tests and the real program then run the same code.
6. **Up to 20% of a track's lessons may be practice-only** (no `build`), each with a reason written in this doc
   (for example an algorithm that the artifact does not need). Every other lesson builds.
7. **Pieces are files that compile together.** C# pieces are `static` methods or types inside a namespace
   (the step's `transform` wraps them, see 3.2), never top-level statements, except a project's `Program.cs`.
   Python pieces are modules in a package. SQL pieces are `.sql` files applied in order. Shell pieces are
   scripts. Names in one artifact are unique and every later piece may depend only on earlier pieces.

### 1.2 Pacing: stop the rush, make it stick

| Rule | What it means |
|---|---|
| **Minimum depth** | A lesson has 8 to 12 steps and at least 2 code steps; its final solution is at least 8 meaningful lines (SQL: 3 code steps instead). `dojo validate` warns below this. Thin lessons are deepened or merged (listed per track). |
| **Recognise → complete → write → bring home** | The final code step is the hardest and is always the artifact piece. Earlier code steps practise in a neutral world. |
| **Interleaved review** | Every lesson from module 2 on has at least one step that re-uses a skill from an *earlier module*, preferably by calling the learner's own earlier piece (`build.uses`, 3.2). Example: the C# LINQ report step calls the learner's `Duration.Format` from module 1. If the learner's piece is broken, the review fails, which is the point. |
| **Cold rebuild** | Each module has a cold check, just before its boss: a code step with an empty editor, no hints, no carry, no starter, no solution reveal, and the same tests as an earlier piece of this module (`"cold": true`). It is short (one piece) and it is graded exactly like the original. |
| **Mastery gate per module** | The next module unlocks when (a) the boss is passed with at least 2 stars and (b) the cold rebuild is passed. Free roam still exists for experienced learners, but a gated module shows "not yet proven" on its pieces. |
| **Spaced re-proof** | The existing review queue (1, 3, 7, 14 days) also re-asks cold rebuilds. A piece that fails a later re-proof dims in the dream panel until rebuilt. |
| **Rush detector** | A lesson completed in under 40% of its `minutes` with 1+ hints, or a boss failed then passed by revealing hints, sends that lesson's cold check into tomorrow's review queue. No punishment, only a re-check. |
| **Assisted pieces** | A piece passed after revealing the last hint is saved but marked *assisted* (dashed in the dream panel) until a cold rebuild or re-proof passes. |

### 1.3 Attention: make them come back

1. **Story first.** Each track has a through-line character or situation ("You start a new job; your Sidekick
   makes your first standup easy"). Briefing cards speak to the learner about *their* artifact, not a fictional
   shop. Practice worlds (SQL's case files, the Larkspur bookshop) stay: they are the variety.
2. **Visible progress every lesson.** The dream panel lights the piece; a "Try it" command runs the assembled
   artifact with what exists so far (`build.try`).
3. **Short wins.** Every lesson ends with something that runs. Milestones are explicit: *first run*,
   *first real use on your own data*, *first time someone else could use it*, *installed* (e.g. `dotnet tool install`).
4. **Variety of step types** stays as AUTHORING.md requires (drag, predict/mcq, code). Add one "use it for real"
   moment per module: a step whose prompt says "run `sk today` in your Code space and paste the first line"
   (graded leniently by `expectContains`).
5. **Field tests.** Where a live lab exists (netlabs 01 to 22) the module ends with the learner's artifact mounted
   into the lab container and used on the lab's task.

## 2. The artifacts, track by track

### 2.0 Overview and sharing

| Artifact (id) | Owner track | Contributing tracks | What it is | Tech, how it runs |
|---|---|---|---|---|
| **Delve** (`delve`) | fundamentals | | A playable dungeon crawler in the terminal: map, hero, monsters, shop, save codes, high scores | C# console; `dotnet run` in a Code space |
| **Sidekick** (`sidekick`) | csharp | efcore, design (optional), auth (optional) | Your developer assistant: `sk` CLI (today, add, start/stop timer, standup, week, notes, find, expenses, logs) and a local dashboard + API at `http://localhost:5099` | .NET solution: `Sidekick.Core`, `sk` (dotnet global tool), `Sidekick.Web`, `Sidekick.Data` (EF Core SQLite), tests |
| **Sidekick SQL** (`sidekick-sql`) | sql | | Schema, reporting views, checks and an importer for Toggl/Clockify/Jira CSV exports, over Sidekick's database | `.sql` files; `sqlite3 %USERPROFILE%\.sidekick\sidekick.db < build.sql`; Sidekick maps the views |
| **Butler** (`butler`) | python | | An automation bot: tidy Downloads, find duplicates, compare folders, rename in bulk, bank/CSV reports, undo journal, scheduled runs | Python package with `python -m butler`, Windows Task Scheduler entry |
| **Homebase** (`homebase`) | typescript | | Your browser start page: greeting, focus timer, task board, bookmarks, notes, quick search, Sidekick sync | TypeScript served by a zero-dependency `serve.mjs` (Node strips types on the fly); `node serve.mjs` → `http://localhost:5173` |
| **Money Lens** (`moneylens`) | datascience | | Analyses your own bank export: cleaning, categories, monthly trends, spike alerts, honest charts, "did my no-spend month work?", next-month forecast, auto-categoriser; writes `report.html` | Python + pandas/NumPy/matplotlib; `python -m moneylens bank.csv` |
| **Keystone** (`keystone`) | pki | crypto | A local CA and secret toolkit: `ks ca init/issue/revoke/export`, `ks doctor host:443`, `ks inspect`, `ks convert`, `ks trust`, `ks encrypt/decrypt`, `ks seal --to`, `ks vault`, `ks hmac` for webhooks | .NET global tool `ks`; files in `%USERPROFILE%\.keystone` |
| **netdoc** (`netdoc`) | networking | | A network diagnostics CLI: `cidr`, `split`, `plan`, `route-for`, `dns`, `http`, `tls`, `trace`, `mtu`, `scan`, `fw`, `logs`, `sshd-audit` | .NET global tool `netdoc`, real sockets at the edges |
| **gitkit** (`gitkit`) | git | | `gk` plus hooks: commit-msg linter, pre-commit secret scanner, conflict resolver, autosquash editor, next-version and release notes, reflog rescue, diff | .NET global tool + `hooks/` + `gitconfig` (`core.hooksPath`, `include.path`) |
| **Dotfiles** (`dotfiles`) | linux | editors | A personal toolkit: `.bashrc`, aliases, functions, `bin/` scripts (bigdirs, logtail, topips, anonymise, permaudit, backup, deploy, ports, whatami, pkg), cron/systemd units, ssh config, `.vimrc`, `.nanorc`, `install.sh` | bash; WSL, Git Bash or any container; `./install.sh` |
| **Gatekeeper** (`gatekeeper`) | auth | | A local identity server for development: users, login page, sessions, JWT (HS256/RS256), JWKS, OIDC discovery, auth code + PKCE, client credentials, refresh rotation, API keys | ASP.NET Core minimal API at `http://localhost:5080` |
| **Relay** (`relay`) | integration | | A working mini API gateway in front of your own services: routes from `relay.json`, header policy, JSON transforms, OpenAPI validation and mock mode, error contract with trace ids, timeouts/retries/breaker, idempotency, JWT via Gatekeeper's JWKS, rate limits, metrics | ASP.NET Core at `http://localhost:8088` |
| **Herald** (`herald`) | design | | A pluggable notifier: `herald send "Build passed" --to console,file,teams`, retries, quiet hours, templates, used by scripts, CI and Sidekick | .NET global tool + library |
| **Seek** (`seek`) | dsa | | Code search and repo insight: indexed ranked search, fuzzy file find, duplicates, project dependency graph, build order, cycles, diff | .NET global tool |
| **Shipyard** (`shipyard`) | docker | cicd, kubernetes | Ships *your* apps: Dockerfiles for Sidekick, Gatekeeper and Relay, `compose.yaml` for the whole platform, dev scripts, GitHub Actions workflows, Kubernetes manifests with kustomize for Docker Desktop | Files + PowerShell scripts; `docker compose -f ship/compose.yaml up --build`, `kubectl apply -k ship/k8s/overlays/dev` |

Why shared: SQL, EF Core and C# end up as one data app (Sidekick) seen from three angles; Docker, CI/CD and
Kubernetes ship the apps the learner built elsewhere; PKI and crypto make one security toolkit; Linux and editors
make one personal environment. A contributor track works even if the owner track is untouched: missing pieces
fall back to stubs (3.3) so the artifact always builds.

Notation in the maps: **CHANGE** = the final code step is rewritten to produce this piece (practice steps
mostly stay). **NEW** = a new code step or lesson. **DEEPEN** = also too thin, add steps. **MERGE** = fold into
the named lesson. **PRACTICE** = keeps no build, with the reason. Paths are relative to the artifact root.

---

### 2.1 fundamentals → Delve (the gateway drug)

**Artifact.** *Delve*, a seeded, turn-based dungeon crawler in the terminal: `n/s/e/w` to move, fights, gold,
a shop that gives change, a map drawn with loops, a recursively carved maze, retro password saves and a high
score table. C# console (`dotnet-console`). Why: a beginner's first program should be something they show a
friend. It also uses every fundamentals idea literally: state (hero stats), logic (rules), loops (game loop,
map), functions and recursion (maze), testing (the game's own tests).
Template: `Delve.csproj`, `Program.cs` (game loop shell that calls the pieces, with stubs), `README.md`.
Run: `dotnet run` (Code space "Delve").

| Lesson | Piece (file: what it does) | Status |
|---|---|---|
| 01-state-and-values/01-named-boxes | first code step: `src/Banner.cs` prints the DELVE title screen; final: `src/Hero.cs` hero stats as named values, `RotateSlots` rotates weapon/shield/potion slots | NEW first step, CHANGE |
| 01/02-whole-and-fractional | `src/Damage.cs`: integer damage with `/` and `%` (armour absorbs every 3rd point) | CHANGE, DEEPEN (L7) |
| 01/03-limits | `src/Stats.cs`: `Heal` that never overflows max HP, `NearlyEqual` for hit chances | CHANGE, DEEPEN |
| 01/04-boss | `src/Shop.cs`: pay in gold/silver/copper and give change; split loot among the party (existing "change machine" and "split the bill") | CHANGE |
| 02-logic/01-truth-tables | `src/Rules.cs`: `CanOpenDoor(hasKey, locked, magic)` as one boolean expression | CHANGE, DEEPEN |
| 02/02-de-morgan-and-short-circuits | `Rules.IsOutsideMap(x, y, w, h)` without an outer NOT | CHANGE, DEEPEN |
| 02/03-clear-conditions | `Rules.CanMove(...)` single clear return | CHANGE, DEEPEN |
| 02/04-boss | `src/Encounter.cs`: what a room holds (FizzBuzz-shaped decision table on room numbers) | CHANGE |
| 03-loops/01-accumulators | `src/Inventory.cs`: total weight, `IndexOfMax` best item | CHANGE |
| 03/02-boundaries-and-termination | `src/GameLoop.cs`: a loop that always ends (turn limit, death, exit) | CHANGE |
| 03/03-nested-loops | `src/Map.cs`: `Render(grid)` draws the map with walls, hero, fog | CHANGE |
| 03/04-boss | `src/Floors.cs`: boss floors are the prime floors (`PrimesUpTo`) | CHANGE |
| 04-functions-and-recursion/01-decomposition | `src/Hud.cs`: status line from small functions (min/max/avg of party HP) | CHANGE |
| 04/02-scope-and-the-call-stack | `src/Depth.cs`: dungeon depth counter shows the call stack idea | CHANGE, DEEPEN |
| 04/03-recursion | `src/Maze.cs`: recursive backtracker carves a maze from a seed | CHANGE, DEEPEN (new step: carve) |
| 04/04-recursion-vs-loops | `Maze.Reachable`: flood fill, recursive then iterative | CHANGE, DEEPEN |
| 04/05-boss | `src/SaveCode.cs`: password save (encode level/gold/HP to base-32 digits recursively, decode back) | CHANGE |
| 05-thinking-like-a-programmer/01-tracing-by-hand | `src/CombatLog.cs`: the fight prints its own trace table | CHANGE, DEEPEN |
| 05/02-breaking-problems-down | `src/Scores.cs`: high scores, runner-up (`SecondLargest`) | CHANGE |
| 05/03-edge-cases-and-testing | `tests/DelveChecks.cs`: the learner writes the edge-case checks for `Heal`, `Damage`, `CanMove` | CHANGE |
| 05/04-debugging | Fix three planted bugs in a provided `src/Loot.cs` (loot average) | CHANGE |
| 05/05-boss | `src/Reveal.cs`: spiral fog-of-war reveal; then **NEW step "Ship Delve"**: cold rebuild of `GameLoop` wiring that makes the game playable | CHANGE, NEW |

Gaps: reading a command each turn (`Console.ReadLine` in a loop), seeded `Random`, string padding for the HUD.
Add one card each where first needed (03/02, 04/03, 04/01). Cold rebuilds: end of modules 2 (`CanMove`),
3 (`Map.Render`), 4 (`Maze` carve), 5 ("Ship Delve"). Gates: every boss ≥ 2 stars.

---

### 2.2 csharp → Sidekick (the flagship)

**Artifact.** *Sidekick*, the assistant a working developer actually opens every day:

```text
> sk
  ____  _     _      _    _      _
 / ___|(_) __| | ___| | _(_) ___| | __   Good morning, Hassan. Tuesday 24 Nov.
 \___ \| |/ _` |/ _ \ |/ / |/ __| |/ /   3 tasks today · 2h 10m logged yesterday · streak 6 days
  ___) | | (_| |  __/   <| | (__|   <
 |____/|_|\__,_|\___|_|\_\_|\___|_|\_\
> sk add "Fix login redirect" --tag auth --est 45m
> sk start 12        # timer
> sk standup         # yesterday / today / blockers, ready to paste in Teams
> sk week            # timesheet by project with bar chart
> sk find "tag=auth and minutes>30"
> sk web             # dashboard + API on http://localhost:5099
```

Why useful: standups, timesheets, a task list and a personal API the learner's other artifacts (Homebase,
Relay, Shipyard) can talk to. Tech: `.NET 10` solution (`dotnet-web` kind); data in `%USERPROFILE%\.sidekick`
(JSON file in C# track, SQLite after EF Core). Template: `Sidekick.slnx`, csproj files (`sk` has
`<PackAsTool>`), `src/sk/Program.cs` host (wires real clock, file store, `HttpClient`), stub files for every
piece, `README.md`, `tests/Sidekick.Tests` (xUnit, reference tests that exercise the learner's pieces).
Run: `dotnet run --project src/sk -- today`; install: `dotnet pack src/sk && dotnet tool install -g sk --add-source src/sk/nupkg`.

Module lessons build `Sidekick.Core` and the `sk` CLI. Projects add features. Shelfwise (p06) is re-themed in
wave 3 (below).

| Lesson | Piece | Status |
|---|---|---|
| 01-first-steps/01-hello-world | step 2 (first code step): `src/sk/Banner.cs` prints the Sidekick banner and version. Final "fix the bugs" fixes a broken greeting in the same file | NEW build, CHANGE |
| 01/02-variables-and-types | `src/Sidekick.Core/Profile.cs`: name, day start hour, daily goal minutes; the greeting line | CHANGE |
| 01/03-numbers-and-math | `Core/Duration.cs`: `Format(int seconds)` → `1h 02m 05s` (the existing seconds-to-clock exercise) | CHANGE |
| 01/04-strings | `Core/Text.cs`: `Initials`, `Slug(title)`, `Truncate(title, 40)` | CHANGE, DEEPEN |
| 01/05-input-and-conversion | `Core/Parse.cs`: `TryParseMinutes("1h30")`, `TryParseInt` with messages | CHANGE, DEEPEN |
| 01/06-boss | `Core/DayReceipt.cs`: the "day receipt" (tasks done, minutes, goal %), money-style alignment from the till boss | CHANGE |
| 02-control-flow/01-booleans-and-if | `Core/Calendar.cs`: `IsWorkday`, `GreetingFor(hour)` (leap-year logic kept as practice) | CHANGE, DEEPEN |
| 02/02-switch | `src/sk/Commands.cs` v1: switch expression dispatch on `args[0]` (`today`, `add`, `done`, `help`) | CHANGE |
| 02/03-while-loops | `src/sk/Shell.cs`: `sk shell` reads commands until `quit` | CHANGE |
| 02/04-for-loops | `Core/Bars.cs`: ASCII bar chart of minutes per weekday | CHANGE |
| 02/05-boss | `Core/Focus.cs`: plan pomodoro blocks for N minutes (work/break loop) | CHANGE |
| 03-methods-and-collections/01-methods | `Core/Text.cs` += `ReadingTime(text)`, `WordCount` | CHANGE |
| 03/02-parameters | `Core/Stats.cs`: `Stats(params int[] minutes)` → (min, max, total); `out` parsing | CHANGE |
| 03/03-arrays | `Core/Week.cs`: seven-day minutes array, last-7-days view | CHANGE |
| 03/04-lists | `Core/TaskList.cs`: add, dedupe titles case-insensitively | CHANGE |
| 03/05-dictionaries-and-sets | `Core/Tags.cs`: tag tally, top tag, tags used both weeks | CHANGE |
| 03/06-boss | `Core/Inbox.cs`: command processor `add/done/list/drop` over the list: the brain of `sk` v1. **First milestone: sk runs.** | CHANGE |
| 04-objects-and-types/01-classes-and-objects | `Core/Model/TaskItem.cs`: `Start()`, `Stop(at)`, accumulated minutes | CHANGE |
| 04/02-constructors-and-properties | `TaskItem` constructor validation (title, estimate ≥ 0) | CHANGE (same file, replace) |
| 04/03-encapsulation | `Core/Journal.cs`: tasks behind a private list; cannot get into a bad state | CHANGE |
| 04/04-static-members | `Core/Ids.cs`: sequential ids, constants | CHANGE |
| 04/05-inheritance | `Core/Reports/Report.cs`: abstract `Report`, `StandupReport`, `WeekReport` | CHANGE |
| 04/06-interfaces | `Core/IStore.cs` + `MemoryStore`; tests pass a store the learner has never seen | CHANGE |
| 04/07-records-structs-enums | `Core/Model/TimeEntry.cs` (record), `Status` enum with allowed transitions | CHANGE |
| 04/08-boss | `Core/Assistant.cs`: the facade every command goes through, store-agnostic | CHANGE |
| 05-robust-code/01-nullability | `TaskItem` gains `Due?`, `Estimate?`, `Project?` honestly | CHANGE |
| 05/02-exceptions | `Core/SidekickException.cs` + `Journal` guarded operations | CHANGE |
| 05/03-pattern-matching | `src/sk/Commands.cs` v2: list and property patterns parse `sk add "x" --tag a --est 30m` | CHANGE |
| 05/04-result-modelling | `Core/Result.cs` and `Parse.Command(args)` returning `Result<Command>` | CHANGE |
| 05/05-boss | `Core/Priority.cs`: priority score rules (due soon, estimate, tag weights) | CHANGE |
| **NEW 05/045-dates-and-time** (before the boss) | `Core/Clock.cs`: `DateOnly`, `TimeOnly`, `TimeProvider` seam, "yesterday" across weekends. Gap: an assistant lives on dates and the track never teaches them | NEW |
| 06-generics-and-linq/01-generics | `Core/Ranking.cs`: `TopBy<T, TKey>` with constraints | CHANGE |
| 06/02-delegates-and-lambdas | `Core/Filters.cs`: predicate factories (`Tagged`, `LongerThan`) | CHANGE |
| 06/03-linq-basics | `Core/Reports/Standup.cs`: yesterday / today / blockers with LINQ; **review: uses `Duration.Format` (`uses`)** | CHANGE |
| 06/04-linq-aggregates-and-grouping | `Core/Reports/Week.cs`: minutes by project and tag | CHANGE |
| 06/05-deferred-execution | `Core/Recurring.cs`: infinite `yield` of workdays and "every Monday" | CHANGE |
| 06/06-boss | `Core/Reports/Summary.cs`: time by project per week (sales by region, re-themed) | CHANGE |
| 07-async/01-tasks-and-await | `Core/Storage/JsonFileStore.cs`: async load/save (`root` seam; real path in template) | CHANGE |
| 07/02-composing-tasks | `Core/Links.cs`: fetch titles of linked URLs concurrently (`Func<string, Task<string>>` seam) | CHANGE |
| 07/03-cancellation-and-timeouts | `Links` with timeout and cached fallback | CHANGE |
| 07/04-pitfalls | `Core/Import/IssuePages.cs`: `IAsyncEnumerable` over paged issue lists (GitHub-shaped) | CHANGE |
| 07/05-boss | `Core/Net/ResilientClient.cs`: retry + bounded concurrency, used by links and webhooks | CHANGE |
| 08-advanced/01-events | `Core/Events.cs`: `TaskCompleted`, unsubscribe that works; `sk` celebrates streaks | CHANGE |
| 08/02-advanced-generics | `Core/Stats.cs` += generic-math `Average<T>` | CHANGE |
| 08/03-dependency-injection | `src/sk/Container.cs`: the learner's 20-line container wires `sk` for real | CHANGE |
| 08/04-testing-basics | `tests/Sidekick.Tests/DueSoonTests.cs` with a fake clock (learner writes the tests) | CHANGE |
| 08/05-reflection-and-attributes | `src/sk/CommandAttribute.cs` + discovery: `[Command("today")]` methods found by reflection; `sk help` generated | CHANGE |
| 08/06-span-and-memory | `Core/Parse.cs` += span-based `TryParseTime("07:45")` for imports | CHANGE |
| 08/07-concurrency | `Core/Storage/Autosave.cs`: `Channel<T>` background writer | CHANGE |
| 08/08-expression-trees | `Core/Query/FilterCompiler.cs`: `sk find "tag=auth and minutes>30"` → `Expression<Func<TaskItem,bool>>` (and `ToSql`, re-used by EF Core) | CHANGE |
| 08/09-final-boss | `Core/Jobs/JobRunner.cs`: bounded async job runner behind `sk sync` | CHANGE |
| **NEW 08/10-ship-sk** | `src/sk/sk.csproj` settings, `PackAsTool`, `dotnet tool install`, `--version`; **milestone: installed** | NEW |
| 09-linq-in-depth/01-thinking-in-pipelines | `Core/Reports/Focus.cs`: today's top picks (query syntax) | CHANGE |
| 09/02-flattening-and-combining | `Core/Reports/Timesheet.cs`: billable lines per entry, no loops | CHANGE |
| 09/03-joins | `Reports/Timesheet` joins tasks, projects, entries; left join for unbilled | CHANGE, DEEPEN (L7) |
| 09/04-grouping-deeply | `Core/Reports/Tags.cs`: `CountBy` / `AggregateBy` | CHANGE |
| 09/05-ordering-and-sets | `Core/Reports/QuickWins.cs`: smallest estimate per project, sets of tags | CHANGE |
| 09/06-aggregate-and-reductions | `Core/Reports/Streak.cs`: longest streak of active days (the existing exercise, literally) | CHANGE |
| 09/07-deferred-execution-traps | `Core/Import/CsvEntries.cs`: parse and fail early | CHANGE |
| 09/08-write-your-own-operators | `Core/Linq/Batching.cs` | CHANGE |
| 09/09-boss | `Core/Reports/Sessions.cs`: work sessions from activity timestamps (the click-sessions exercise) | CHANGE |
| p01-tasks-api 01→08 | `src/Sidekick.Web/Program.cs` (carry): `/health`, `/`, `/tasks` CRUD, query and paging, DI store, API key, route groups. Re-theme "Tasks API" → "Sidekick API" (names only; stays in-memory, EF Core replaces the store later) | CHANGE (light) |
| p02-expense-report 01→06 | `Core/Expenses/*` + `sk expenses claims.csv`: work expense claims report with policy flags and budgets (domain kept) | CHANGE (build markers + seams) |
| p03-gradebook 01→05 | `Core/Learning/*` + `sk learn`: your own course scores (dojo export), weighted level, histogram | CHANGE (re-theme), low priority |
| p04-log-detective 01→05 | `Core/Logs/*` + `sk logs access.log`: incident report from a web server log | CHANGE (build markers) |
| p05-order-pipeline 01→05 | `Core/Inbox/Pipeline.cs`: captured items (from `sk capture`, files, webhooks) validated by rules, stored, broadcast, batched, retried to a Teams webhook | CHANGE (re-theme) |
| p06-capstone-shelfwise 01→32 | Wave 3: re-theme library → Sidekick, stage by stage (catalog card → task card, members/loans → projects/time entries, fines → overtime, book info service → issue tracker lookup, reminders → due-soon reminders). Its stages then replace `Sidekick.Web` with the layered, tested, authenticated version. Until then: no build markers (practice capstone) | wave 3 |

Thin: `01/01-hello-world`, `01/04-strings`, `01/05-input-and-conversion`, `02/01-booleans-and-if`,
`09/03-joins`: deepen each with one more code step. Gaps besides the two new lessons: `args` handling (02/02),
file paths and `%USERPROFILE%` (07/01 card), `HttpClient` for real (07/02 card). Cold rebuilds: end of each
module (`Duration.Format`, `Commands` v1, `Inbox`, `TaskItem`, `Result` parse, `Standup`, `JsonFileStore`,
`FilterCompiler` (short form), `Sessions`). Gates: boss ≥ 2 stars + cold rebuild.

---

### 2.3 python → Butler

**Artifact.** *Butler*, an automation bot that does the chores of a Windows machine: `python -m butler tidy
~/Downloads --dry-run`, `dupes`, `compare A B`, `rename "IMG_*" --pattern`, `report bank.csv`, `undo`,
`schedule daily tidy` (creates a Windows Task Scheduler entry via `schtasks`). Python package (`python` kind),
standard library only. Template: `pyproject.toml` (console script `butler`), `butler/__main__.py`,
`butler/fs.py` (real file system adapter; pieces take a `root`), README. Run: `python -m butler --help`.

| Lesson | Piece | Status |
|---|---|---|
| 01-basics/01-hello-python | first code step: `butler/banner.py` prints the Butler greeting; final: fix the greeting | NEW build, CHANGE, DEEPEN |
| 01/02-variables | `butler/config.py`: defaults (downloads dir, archive dir, rules) | CHANGE, DEEPEN |
| 01/03-numbers | `butler/sizes.py`: `human_size(bytes)` → `1.4 MB` | CHANGE, DEEPEN |
| 01/04-strings | `butler/names.py`: `safe_filename`, `slug` | CHANGE, DEEPEN |
| 01/05-input-and-truthiness | `butler/prompt.py`: `ask(question, default)` | CHANGE, DEEPEN |
| 01/06-boss | `butler/receipt.py`: the tidy receipt (files moved, bytes freed, aligned) | CHANGE |
| 02-control-flow/01-if-elif-else | `butler/rules.py`: `category_for(ext)` | CHANGE, DEEPEN |
| 02/02-while | `butler/shell.py`: interactive mode until `quit` | CHANGE |
| 02/03-for-and-range | `butler/listing.py`: numbered listing with `enumerate`/`zip` | CHANGE |
| 02/04-break-continue-else | `butler/find.py`: first match / "not found" via loop `else` | CHANGE |
| 02/05-match | `butler/cli.py` v1: command dispatch with `match` | CHANGE |
| 02/06-boss | `butler/progress.py`: progress bar and spinner drawing | CHANGE |
| 03-collections/01-lists | `butler/queue.py`: pending actions list | CHANGE |
| 03/02-tuples-and-unpacking | `butler/stats.py`: smallest/largest/middle file sizes | CHANGE, DEEPEN |
| 03/03-dicts-and-sets | `butler/compare.py`: in both / only left / only right (folder diff) | CHANGE, DEEPEN |
| 03/04-comprehensions | `butler/filters.py`: file filters | CHANGE, DEEPEN |
| 03/05-sorting-and-collections | `butler/top.py`: biggest files, `Counter` by extension | CHANGE |
| 03/06-boss | `butler/usage.py`: disk usage by category | CHANGE |
| 04-functions/01-def-and-defaults | `butler/textstats.py` | CHANGE, DEEPEN |
| 04/02-args-and-kwargs | `butler/log.py`: `record(name, *tags, **fields)` log lines | CHANGE, DEEPEN |
| 04/03-lambdas-closures-scope | `butler/counters.py`: running totals for a session | CHANGE, DEEPEN |
| 04/04-decorators | `butler/registry.py`: `@command("tidy")` plugin registry; `cli.py` v2 uses it | CHANGE |
| 04/05-generators | `butler/walk.py`: lazy, chunked directory walk | CHANGE |
| 04/06-boss | `butler/growth.py`: moving average of folder growth | CHANGE |
| 05-objects/01-classes | `butler/rule.py`: `Rule` class | CHANGE |
| 05/02-properties-and-dunders | `butler/size.py`: `Size` value with ordering and `__str__` | CHANGE |
| 05/03-dataclasses | `butler/models.py`: `FileInfo` dataclass | CHANGE |
| 05/04-inheritance-and-composition | `butler/notify.py`: `Notifier` with senders | CHANGE |
| 05/05-duck-typing-and-hints | `butler/actions.py`: `Action` protocol (Move, Copy, Recycle) | CHANGE |
| 05/06-boss | `butler/organizer.py`: the organiser composed of rules and actions | CHANGE |
| 06-robust-python/01-exceptions | `butler/safe.py`: per-file errors reported, run continues | CHANGE |
| 06/02-raising-and-custom | `butler/errors.py` | CHANGE |
| 06/03-context-managers | `butler/dryrun.py`: `with dry_run():` and timing | CHANGE |
| 06/04-files-and-pathlib | `butler/tidy.py`: real moves with pathlib (tests use `tmp_path`). **Milestone: first real use** | CHANGE |
| 06/05-json-and-logging | `butler/settings.py`: `~/.butler.json` + logging | CHANGE |
| 06/06-boss | `butler/journal.py`: undo journal; `butler undo` | CHANGE |
| 07-pythonic/01-iterators-and-itertools | `butler/rename.py`: batch rename with counters | CHANGE |
| 07/02-functools | `butler/hashing.py`: cached file hashes | CHANGE |
| 07/03-any-all-walrus | `butler/validate.py`: config checks | CHANGE |
| 07/04-idioms | refactor `organizer.py` Pythonically (replace) | CHANGE |
| 07/05-performance | `butler/dupes.py`: size-then-hash duplicate finder | CHANGE |
| 07/06-boss | `butler/logs.py`: error bursts in log files | CHANGE |
| 08-testing-and-tooling/01-tests-with-assert | `tests/test_names.py` | CHANGE |
| 08/02-good-tests | `tests/test_tidy.py` with fixtures and a fake clock | CHANGE |
| 08/03-venv-and-pip | `pyproject.toml` dependencies section and `requirements.txt` check | CHANGE |
| 08/04-layout-and-style | `butler/__main__.py` entry guard, layout | CHANGE |
| 08/05-boss | `tests/test_schedule.py` with a mock `schtasks` runner | CHANGE |
| **NEW 08/045-a-real-cli** (before the boss) | `butler/cli.py` v3 with `argparse` subcommands; `butler/schedule.py` builds the `schtasks` command (runner seam) | NEW |
| p02-data-cruncher 01→04 | `butler/csvreport.py`: `butler report bank.csv` aligned report | CHANGE (build markers) |
| p01-text-adventure 01→05 | PRACTICE (side quest): a fun break, no build; keep but move after module 6 | PRACTICE |

Thin (20, all deepened above): every 01 and early 03/04 lesson gets a second code step. Cold rebuilds:
`sizes.human_size`, `cli` v1, `compare`, `registry`, `organizer`, `tidy`, `dupes`, `test_tidy`.

---

### 2.4 typescript → Homebase

**Artifact.** *Homebase*, a browser start page the learner sets as their new-tab page: greeting and clock,
focus timer, task board (from p01), bookmarks with folders, notes, `/` quick search, keyboard shortcuts, weekly
chart, optional sync with Sidekick's API. TypeScript modules (`node` kind). Template: `serve.mjs` (zero-dependency
static server that strips types with `module.stripTypeScriptTypes` from Node 23.2+, plus `/api/notes` saving to
`data/`), `index.html`, `styles.css`, `src/main.ts` bootstrap with stubs. Run: `node serve.mjs` → open
`http://localhost:5173`.

| Lesson | Piece | Status |
|---|---|---|
| 01-javascript-basics/01-hello-and-variables | first code step: `src/widgets/greeting.ts` "Good morning, <name>"; final: the label swap → greeting format | NEW build, CHANGE, DEEPEN |
| 01/02-values-and-equality | `src/values.ts`: `describe` → normalise stored values | CHANGE, DEEPEN |
| 01/03-numbers-and-strings | `src/parse.ts`: `parseMinutes("25m")` | CHANGE, DEEPEN |
| 01/04-functions | `src/format.ts`: formatter factories (time, counts) | CHANGE, DEEPEN |
| 01/05-boss | `src/widgets/clock.ts`: clock + date line | CHANGE |
| 02-objects-and-arrays/01-objects-and-destructuring | `src/bookmarks.ts`: bookmark model | CHANGE, DEEPEN |
| 02/02-spread-rest-and-json | `src/settings.ts`: safe settings loader | CHANGE |
| 02/03-array-methods | `src/bookmarks.ts` += search and folder counts | CHANGE |
| 02/04-sorting-map-and-set | `src/search.ts`: word index for `/` quick search | CHANGE |
| 02/05-boss | `src/bookmarks.ts` += `byFolder` | CHANGE |
| 03-functions-and-scope/01-closures | `src/timer.ts`: stopwatch closure | CHANGE, DEEPEN |
| 03/02-this-and-arrows | `src/timer.ts` += focus timer object (stepper) | CHANGE |
| 03/03-higher-order-functions | `src/validate.ts`: composed form validators | CHANGE |
| 03/04-modules-and-immutability | `src/state.ts`: immutable nested updates | CHANGE |
| 03/05-boss | `src/activity.ts`: event-log transform pipeline | CHANGE |
| 04-async/01-the-event-loop | PRACTICE: ordering puzzle, nothing to keep | PRACTICE, DEEPEN |
| 04/02-callbacks-to-promises | `src/net/load.ts` | CHANGE |
| 04/03-async-await | `src/net/retry.ts` | CHANGE |
| 04/04-parallel-and-timers | `src/net/timeout.ts` | CHANGE, DEEPEN |
| 04/05-fetch | `src/net/sidekick.ts`: load today's tasks from Sidekick's API with fallback | CHANGE |
| 04/06-boss | `src/net/jobs.ts`: per-widget deadlines | CHANGE |
| 05-typescript-types/01..06 | `src/guards.ts`, `src/api-types.ts`, `src/model.ts`, `src/sort.ts`, `src/reducer.ts`, `src/summary.ts` (one per lesson, in order) | CHANGE; 04-generics DEEPEN |
| 06-classes-and-patterns/01-classes | `src/widgets/widget.ts`: base `Widget` | CHANGE |
| 06/02-private-fields-and-getters | `src/prefs.ts`: validated preferences | CHANGE |
| 06/03-interfaces-and-composition | `src/widgets/registry.ts` | CHANGE |
| 06/04-errors | `src/errors.ts`: `loadConfig` with `cause` | CHANGE |
| 06/05-boss | `src/store.ts`: app store on the typed emitter | CHANGE |
| 07-the-dom-and-the-browser/01-the-dom-tree | `src/render/list.ts`: escape + render | CHANGE |
| 07/02-events-and-bubbling | `src/keys.ts`: keyboard shortcuts (`/`, `n`, `t`) | CHANGE |
| 07/03-forms | `src/forms/add-task.ts` | CHANGE |
| 07/04-fetch-render-and-storage | `src/storage.ts`: safe `localStorage` | CHANGE |
| 07/05-boss | `src/widgets/bookmarks-page.ts`: add from form and persist | CHANGE |
| **NEW 07/045-wire-it-up** (before the boss) | `src/main.ts`: real `document` wiring (graded against a small fake DOM in the template). **Milestone: open it in your browser** | NEW |
| 08-toward-react-and-next/01..06 | `src/ui/components.ts`, `src/ui/derived.ts`, `src/ui/h.ts`, `api/notes.ts` (route handler served by `serve.mjs`), `src/ui/classes.ts`, `src/pages/home.ts` | CHANGE |
| p01-task-board 01→05 | `src/board/types.ts`, `reducer.ts`, `selectors.ts`, `history.ts`, `persist.ts` (carry) | CHANGE (build markers), DEEPEN stages (n=4) |

Cold rebuilds: `format.ts`, `bookmarks.byFolder`, `state.ts`, `net/retry.ts`, `reducer.ts`, `store.ts`, `keys.ts`.

---

### 2.5 datascience → Money Lens

**Artifact.** *Money Lens*: `python -m moneylens bank.csv` loads the learner's own bank export (column mapping
in `moneylens.toml` for their bank), cleans and deduplicates overlapping exports, categorises merchants, and writes
`out/report.html` with charts and plain-language findings: where the money goes, unusual days, trend, "is this
month really worse?", a next-month forecast and an auto-categoriser. Python with pandas, NumPy, matplotlib
(`python` kind). Template: `moneylens/__main__.py`, `moneylens/html.py` (stub), `sample/bank.csv` (synthetic),
`moneylens.toml`. Why: personal finance is the dataset everybody owns and cares about.

| Lesson | Piece | Status |
|---|---|---|
| 01-thinking-with-data/01-the-workflow | first code step: `moneylens/banner.py`; final: `findings.py` headline finding | NEW build, CHANGE, DEEPEN |
| 01/02-tidy-data | `tidy.py`: messy statement lines → tidy rows | CHANGE |
| 01/03-types-of-variables | `load.py`: load with the right dtypes | CHANGE |
| 01/04-why-vectorise | `summary.py`: vectorised totals | CHANGE |
| 01/05-first-look | `profile.py` | CHANGE |
| 01/06-boss | `findings.py` += "Groceries take 23% of spend" | CHANGE |
| 02-numpy/01-arrays-vs-lists | `daily.py`: daily spend array summary | CHANGE |
| 02/02-dtypes-and-shape | `calendar.py`: `as_grid` → weeks × days heatmap grid | CHANGE |
| 02/03-indexing-and-masks | `amounts.py`: clean amount masks | CHANGE |
| 02/04-broadcasting | `budget.py`: budget vs actual by broadcasting | CHANGE |
| 02/05-aggregation-and-axis | `calendar.py` += weekly report with NaN days | CHANGE |
| 02/06-random-and-speed | `simulate.py`: savings Monte Carlo ("will I reach the goal?") | CHANGE |
| 02/07-boss | `calendar.py` += biggest days | CHANGE |
| 03-pandas-foundations/01..07 | `ledger.py`, `profile.py` v2, `select.py`, `enrich.py` (month, weekday, is_income), `top.py` (top merchants), `recategorise.py` (user overrides, copy-on-write), `signs.py` (debit/credit conventions) | CHANGE; 01, 03, 05, 06 DEEPEN |
| 04-cleaning-data/01..06 | `clean.py`, `dedupe.py` (overlapping exports), `types.py` (dd/mm/yyyy, `1.234,56`), `merchants.py` (`AMZN MKTP*123` → Amazon), `checks.py`, `pipeline.py` | CHANGE |
| 05-grouping-and-joining/01..06 | `by_category.py`, `share.py`, `grid.py` (month × category), `budget.py` v2 (merge budgets), `combine.py` (several accounts), `cube.py` | CHANGE; 03 DEEPEN |
| 06-time-series/01..06 | `timeindex.py`, `monthly.py`, `alerts.py` (spike days), `growth.py` (MoM, YoY), `timezones.py` (card timestamps), `trend.py` | CHANGE; 05 DEEPEN |
| 07-visualisation/01..06 | `charts.py` grows: monthly line, box per category, small multiples, stacked bars, `chart_for`, then `dashboard.py` 2 × 2 | CHANGE |
| 08-statistics/01..07 | `typical.py` (median/IQR month), `shape.py`, PRACTICE 03-sampling-and-clt (simulation only), `insights.py` (within-group correlation), `insights.py` += bootstrap CI, `experiment.py` ("did my no-spend month work?" permutation test), `verdict.py` | CHANGE |
| 09-first-models/01..07 | `model/prepare.py`, `model/forecast.py`, `model/select.py`, `model/categorise.py` (kNN on description features), `model/threshold.py` (auto-assign only when confident), `model/segments.py` (k-means), boss `model/personas.py` | CHANGE |
| p01-sales-analysis 01→06 | re-theme to the spending report: `report.py` end to end; **NEW stage 07-the-html-report** writes `out/report.html` (base64 PNG charts) | CHANGE, NEW |
| p02-predict-house-prices 01→05 | re-theme to "Forecast next month": `model/forecast.py` final with baseline | CHANGE (re-theme) |

Gaps: HTML output, bank column mapping (`tomllib`), reading a real file path. Cold rebuilds: `load.py`,
`calendar.as_grid`, `enrich.py`, `pipeline.py`, `grid.py`, `alerts.py`, `dashboard.py`, `experiment.py`, `forecast.py`.

---

### 2.6 sql → Sidekick SQL

**Artifact.** `sidekick-sql` (`sql` kind): the hand-written schema and the reporting layer over Sidekick's
SQLite database, plus a warehouse that imports a Toggl/Clockify/Jira CSV export. Files: `schema/*.sql`,
`reports/*.sql`, `checks/*.sql`, `ops/*.sql`, `warehouse/*.sql`, and a template `build.sql` that `.read`s them in
order, plus `demo.sql` sample data. Run: `sqlite3 demo.db < build.sql` then `sqlite3 demo.db < reports/standup.sql`,
or point at `%USERPROFILE%\.sidekick\sidekick.db`. Sidekick maps the views with EF Core `ToView`.

Every lesson keeps its case world (Larkspur, Avalon Spokes, St. Wren's, Pixelforge, Starfall, Harbor Lights):
they are the best attention device in the dojo. **One new final code step per lesson** runs against Sidekick's
schema (`setup` = `demo.sql`) and becomes the piece.

| Module | Lessons → pieces (in order) |
|---|---|
| 01-select-basics | 01 `reports/all-tasks.sql` · 02 `reports/open-by-due.sql` · 03 `reports/task-labels.sql` · 04 `checks/missing-estimates.sql` (NULL logic) · 05-boss `reports/today.sql` |
| 02-aggregation | 01 `reports/minutes-total.sql` · 02 `reports/minutes-by-project.sql` · 03 `reports/heavy-projects.sql` (HAVING) · 04 `reports/daily-scorecard.sql` (CASE pivot) · 05-boss `reports/standup.sql` |
| 03-joins | 01 `reports/time-by-project.sql` · 02 `checks/tasks-without-time.sql` (anti-join) · 03 `reports/task-detail.sql` (subtask self join) · 04 `reports/week-grid.sql` (calendar × projects) · 05-boss `reports/timesheet.sql` |
| 04-subqueries-and-ctes | 01 `reports/above-average-days.sql` · 02 `checks/projects-with-overdue.sql` · 03 `reports/project-league.sql` · 04 `reports/subtask-tree.sql` (recursive rollup) · 05-boss `reports/calendar.sql` (recursive date series) |
| 05-window-functions | 01 `reports/top-tasks.sql` · 02 `reports/top-per-project.sql` · 03 `reports/weekly-running.sql` · 04 `reports/day-over-day.sql` · 05-boss `reports/focus-trend.sql` |
| 06-modifying-data | 01 `ops/log-time.sql` (named parameters) · 02 `ops/close-done.sql` · 03 `ops/purge-archived.sql` · 04 `ops/daily-rollup.sql` (UPSERT in a transaction) · 05-boss `ops/carry-over.sql` |
| 07-designing-schemas | 01 `schema/001_core.sql` · 02 `schema/002_constraints.sql` · 03 `schema/003_tags.sql` (junction instead of CSV) · 04 `schema/004_views.sql` + ALTER · 05-boss `schema/005_audit.sql` (**gap: triggers**, add a card and step) |
| 08-performance | 01 `schema/010_indexes.sql` · 02 `checks/plans.sql` (EXPLAIN QUERY PLAN expectations) · 03 covering index for standup (append to 010) · 04 SARGable rewrite of `reports/today.sql` (replace) · 05-boss `perf/dashboard.sql` |
| 09-real-world | 01 `reports/by-weekday.sql` · 02 `reports/labels-json.sql` (JSON metadata column) · 03 `ops/dedupe-imports.sql` · 04 `checks/quality.sql` + `reports/streaks.sql` (gaps and islands) · 05-boss `checks/orphans.sql` |
| p01-analytics-warehouse | re-theme Inkwell & Ivy sales export → a time-tracker CSV export: 01 `warehouse/01_staging.sql` · 02 `02_load.sql` + reconcile · 03 `03_star.sql` · 04 `04_views.sql` · 05 `05_indexes.sql` + dashboard |

Gaps: the `sqlite3` shell (`.read`, `.import`, `.param set`, `.mode box`): one new lesson
`09-real-world/045-the-sqlite3-shell` (learn cards + file-mode step for `build.sql`, 3.4), triggers (07/05).
SQL is not thin; no merges. Cold rebuilds: `standup.sql` (end of 02), `timesheet.sql` (03), `subtask-tree.sql`
(04), `top-per-project.sql` (05), `daily-rollup.sql` (06), `001_core.sql` (07), `streaks.sql` (09).

---

### 2.7 efcore → contributes `Sidekick.Data` to Sidekick

**Pieces** go to `csharp/sidekick` under `src/Sidekick.Data/` (cross-track, 3.2). The database is
`%USERPROFILE%\.sidekick\sidekick.db`; graded runs use a fresh folder as today. Practice worlds (cinema, kitchen,
hotel, blog, help desk) stay for variety; the final step maps Sidekick.

| Lesson | Piece | Status |
|---|---|---|
| 01-first-context/01-what-an-orm-is | `SidekickDb.cs` v0: `DbSet<TaskItem>` | CHANGE |
| 01/02-entities-and-conventions | `Entities/TaskEntity.cs` following conventions | CHANGE |
| 01/03-creating-and-saving | `TaskRepository.cs`: add, mark done, list open | CHANGE |
| 01/04-seeing-the-sql | `Diagnostics.cs`: `sk --sql` logs executed commands | CHANGE, DEEPEN (L2) |
| 01/05-boss | `Entities/Note.cs` + note search (the Notebook boss is already Sidekick-shaped) | CHANGE |
| 02-modelling/01-keys-and-required | `Entities/Project.cs` with a natural key (`Code`) | CHANGE |
| 02/02-annotations-and-fluent-api | `Configurations/*.cs` (`IEntityTypeConfiguration`) | CHANGE |
| 02/03-enums-conversions-owned | `Status` conversion, `Duration` value converter, owned `Estimate` | CHANGE |
| 02/04-indexes-and-constraints | unique project code, check `minutes >= 0` | CHANGE |
| 02/05-boss | the complete model | CHANGE |
| 03-relationships/01..05 | Project → Tasks; Tasks ↔ Tags (skip navigations); `Queries/ProjectReport.cs`; delete rules (restrict when time is logged); `TimeEntry` + `Queries/Digest.cs` (standup) | CHANGE |
| 04-querying/01..05 | `Queries/TaskDto.cs` projections; `Queries/Search.cs` optional filters + paging; fix a client-evaluated query; compiled `ByTag` + `AsNoTracking`; `Queries/Like.cs`. **Review: plugs `FilterCompiler` from csharp 08/08 into `Where`** | CHANGE |
| 05-change-tracking-and-saving/01..06 | bump estimates; disconnected edits (`Edit.cs`); `MoveTime` in a transaction; `Version` concurrency token; `Archive` with `ExecuteUpdate`/`ExecuteDelete`; boss nightly purge | CHANGE |
| 06-migrations-and-real-apps/01..05 | `Migrations/0001_Initial.cs`, `0002_Estimates.cs` (by hand); seed projects and tags; `Sidekick.Web` `AddDbContext` (web+efcore); `tests/TestDatabase.cs`; boss "claim a task" endpoint safe under concurrency | CHANGE |
| 07-performance/01..05 | standup in one command (N+1); project page with split queries; `(Status, Due)` index; keyset paging of history; boss history shelf | CHANGE; 02 DEEPEN |
| p01-library-api 01→06 | re-theme Library API → **Sidekick API on EF Core**: replaces `src/Sidekick.Web/Program.cs` (contributor order puts efcore after csharp) | CHANGE (re-theme), DEEPEN (n=4: one review step each) |

EF Core must agree with `sidekick-sql/schema/001_core.sql`: a step in 06/01 compares `GenerateCreateScript()`
with the SQL track's tables. Cold rebuilds: `SidekickDb` (01), model config (02), `Digest` (03), `Search` (04),
`MoveTime` (05), `0001_Initial` (06), keyset paging (07).

---

### 2.8 networking → netdoc

**Artifact.** `netdoc`, a .NET global tool for when "the network" is blamed:

```text
netdoc cidr 10.20.0.0/22          network, broadcast, first/last host, count, mask, wildcard
netdoc split 10.0.0.0/16 /24      netdoc plan 10.0.0.0/22 web=100 db=20 ops=10   (VLSM)
netdoc route-for 8.8.8.8          longest prefix match over `route print` / `ip route`
netdoc dns example.com MX         real query over UDP 53, TTLs, CNAME chain
netdoc http https://site          status, caching verdict, cookie flags, CORS, HSTS, Alt-Svc
netdoc tls site:443               chain, SANs, expiry (shares code with Keystone)
netdoc trace host / mtu host      traceroute with Ping TTL; path MTU with DontFragment
netdoc scan host 1-1024           TCP connect scan of your own hosts, drift against an inventory
netdoc fw rules.txt tcp 10.0.0.5 443     netdoc logs access.log     netdoc sshd-audit sshd_config
```

C# (`dotnet-console`); pieces are pure parsers and calculators graded with fixtures; the template's `Program.cs`
uses real `Dns`, `UdpClient`, `TcpClient`, `SslStream`, `Ping`.

| Lesson | Piece | Status |
|---|---|---|
| 01-foundations/01-addresses-and-ports | `src/Ip.cs`: `IsIPv4`, `ParseEndpoint` | CHANGE |
| 01/02-tcp-udp-and-layers | `src/Ports.cs`: well-known ports, `netdoc port 5432` | CHANGE |
| 01/03-packet-capture | `src/Capture/Handshake.cs`: read `tcpdump -n` lines | CHANGE |
| 01/04-boss | `src/Listeners.cs`: parse `netstat -ano` and `ss -tlnp`, reachability | CHANGE |
| 02-ipv4-and-subnetting/01-binary-and-octets | `src/Ipv4.cs` | CHANGE, DEEPEN |
| 02/02-masks-and-cidr | `src/Cidr.cs`: `NetworkOf`, mask ↔ prefix | CHANGE, DEEPEN |
| 02/03-host-ranges | `Cidr.Info` → `netdoc cidr` (**milestone: first run**) | CHANGE |
| 02/04-subnetting-a-block | `src/Split.cs` | CHANGE, DEEPEN |
| 02/05-vlsm | `src/Plan.cs` | CHANGE |
| 02/06-summarisation | `src/Summarize.cs` | CHANGE |
| 02/07-ipv6-basics | `src/Ipv6.cs` | CHANGE |
| 02/08-boss | `src/Aggregate.cs` | CHANGE |
| 03-lans/01-arp-and-local-delivery | `src/NextHop.cs` + parse `arp -a` | CHANGE |
| 03/02 to 03/05-boss | PRACTICE: switch, VLAN and DHCP simulations teach the model; a developer tool does not need them | PRACTICE |
| 04-routing-and-nat/01-routing | `src/Routes.cs`: `netdoc route-for` | CHANGE |
| 04/02-dynamic-routing | `Routes.Choose` | CHANGE |
| 04/03, 04/04, 04/05-boss | PRACTICE (NAT models: netlab 05-nat covers it live; shortest path: DSA) | PRACTICE |
| 05-transport/01-tcp-in-depth | PRACTICE (congestion window model) | PRACTICE |
| 05/02-tcp-states | `src/Sockets.cs`: `netdoc sockets` | CHANGE |
| 05/03-udp-icmp-mtu | `src/Trace.cs` over an `IPinger` seam | CHANGE |
| 05/04-boss | `src/Mtu.cs` | CHANGE |
| 06-dns/01-records | `src/Dns/Records.cs` | CHANGE |
| 06/02-resolution-and-ttl | `src/Dns/Cache.cs` | CHANGE |
| **NEW 06/025-dns-on-the-wire** | `src/Dns/Wire.cs`: build a query, parse an answer with name compression | NEW |
| 06/03-boss | `src/Dns/Diff.cs`: `netdoc dns-diff` | CHANGE |
| 07-http/01..05 | `Http/RawRequest.cs`, `Http/RawResponse.cs`, `Http/Verdicts.cs` (cache, cookies, CORS), `Verdicts.AltSvc`, boss `Http/Client.cs` (raw HTTP/1.1 over a stream seam) | CHANGE |
| 08-tls-and-security/01..03 | `Tls/Hsts.cs`, `Tls/Verify.cs`, boss `Http/MixedContent.cs` | CHANGE |
| 09-edge/01 | PRACTICE (balancer: Relay builds a real one) | PRACTICE |
| 09/02..04 | `Fw/Rules.cs`, `Ssh/Forward.cs`, boss `CanReach.cs` | CHANGE |
| 10-security-basics/01..05 | `Scan.cs` (planner + drift; real scan only of listed hosts, consent prompt) DEEPEN; `Fw/Iptables.cs`; `Logs/Scanners.cs`; `Ssh/Audit.cs` DEEPEN; boss `netdoc incident` | CHANGE |

Practice share 9 of 47 (19%). Field tests: netlabs 01, 04-dns, 06-port-scanning, 07-firewall, 09-log-analysis,
10-ssh-hardening mount the published tool. Cold rebuilds: `Cidr.Info`, `Routes.Choose`, `Dns/Wire`,
`RawRequest`, `Fw/Iptables`.

---

### 2.9 pki + crypto → Keystone

**Artifact.** `ks`, the learner's own local CA and secret toolkit. Real files under `%USERPROFILE%\.keystone`
(`ca/root.crt`, encrypted `ca/root.key.pem`, `issued/`, `crl.pem`, `vault.json`). It issues the `localhost`
certificates used for HTTPS in Sidekick, Gatekeeper and Relay, diagnoses live servers and encrypts files. Pieces
take `IClock` and `ICaStore` (memory in tests, folder for real): the fixed 2030 dates become test fixtures only.

| PKI lesson | Piece | Status |
|---|---|---|
| 01-foundations/01..05 | `Sign.cs` (`ks sign/verify`), `SelfSigned.cs`, `Inspect.cs` (`ks inspect`), `Pem.cs`, boss `Convert.cs` | CHANGE |
| 02-chains-of-trust/01..04 | `Chain/Order.cs`, `Chain/Issuer.cs`, `Chain/Validate.cs`, boss `ks verify --bundle --root` | CHANGE |
| 03-when-trust-breaks/01..04 | `Diagnose.cs`, `HostMatch.cs`, `ClientAuth.cs`, boss `ks doctor --fleet` | CHANGE |
| **NEW 03/035-crls-for-real** | `Ca/Crl.cs` (`CertificateRevocationListBuilder`) | NEW |
| 04-hands-on-dotnet/01..04 | `Ca/Root.cs` (`ks ca init`), `Ca/Issue.cs`, `Ca/Export.cs`, boss end to end (**milestone: your first real localhost cert**) | CHANGE |
| **NEW 04/035-keys-at-rest** | `Ca/KeyStore.cs`: encrypted PKCS#8 PEM, passphrase | NEW |
| 05-in-the-field/01..08 | `Fingerprint.cs` (DEEPEN), `ks ca sign request.csr`, `Pfx.cs`, `Capture.cs` (`ks fetch host:443` + pinning), `KeyMatch.cs` (DEEPEN), `Trust.cs` (prints, or with `--apply` runs, `Import-Certificate -CertStoreLocation Cert:\CurrentUser\Root`), `OpensslErrors.cs`, boss `ks doctor host:443` | CHANGE |
| p01-mini-ca 01→05 | `ks ca` command loop persisted through `ICaStore` with a real clock (carry) | CHANGE |
| p02-chain-doctor 01→04 | `ks doctor --scenario file` sharing `Diagnose` | CHANGE |

| Crypto lesson (contributes `src/Crypto`, `src/Vault`) | Piece | Status |
|---|---|---|
| 01-foundations/01..06 | `ks hash`, `ks b64/hex` (DEEPEN), `Crypto/Encoding.cs`, PRACTICE 04 (pad reuse), `ks rand` + `ks apikey`, boss `ks sessionid/pin` | CHANGE |
| 02-hashing-and-macs/01..06 | PRACTICE 01; `ks hash --algo` with name prefix; `ks hmac` + `ks webhook-verify` (GitHub `X-Hub-Signature-256`); constant-time verify; `Crypto/Kdf.cs`; boss tamper seals | CHANGE |
| 03-symmetric-encryption/01..06 | PRACTICE 01, 02; `NonceSource.cs`; `SealedBox.cs` → `ks encrypt/decrypt file` (**milestone: first real use**); ChaCha20-Poly1305; PRACTICE boss | CHANGE |
| 04-asymmetric/01..07 | `ks keygen`; `Exchange.cs`; `ks seal --to bob.pub` (hybrid); `ks sign` (append to `Sign.cs`); `ks audit-key`; PRACTICE 06; boss signed and sealed | CHANGE |
| 05-in-practice/01..06 | `SealedBox` reuse; `Vault/Envelope.cs`; `Vault/KeySource.cs` (fail closed; env var or DPAPI `ProtectedData`); PRACTICE 04; fix the signer; boss `ks vault rotate` | CHANGE |
| 06-attacks-and-the-future/01..05 | `ks entropy`; PRACTICE 02; versioned vault formats; `ks pq-inventory`; PRACTICE boss | CHANGE |
| p01-encrypted-vault 01→05 | `ks vault init/unlock/put/get/list/share/rotate/export`, 600 000 iterations and random salt in the real build (tests keep 1 000) | CHANGE |

Cold rebuilds: `Inspect`, `Validate`, `HostMatch`, `Ca/Issue`, `Capture`, `SealedBox`, `Envelope`.

---

### 2.10 git → gitkit

**Artifact.** `gk` (.NET global tool) plus `hooks/commit-msg`, `hooks/pre-commit`, `hooks/pre-push` (tiny `sh`
shims that Git for Windows runs: `exec gk lint-msg "$1"`) and a `gitconfig` of aliases. Install:
`git config --global core.hooksPath ~/.gitkit/hooks` and `include.path ~/.gitkit/gitconfig`. Pieces parse **real
git output** (`--porcelain=v1`, `log --format`, `reflog`, `rev-list --parents`) given as fixtures; the template
runs git through an `IGit` seam.

| Lesson | Piece | Status |
|---|---|---|
| 01-foundations/01-three-areas | `Status.cs`: `gk st` from porcelain output | CHANGE |
| 01/02-add-commit-log | `Log.cs`: `gk lg` | CHANGE, DEEPEN |
| 01/03-diff | `Diff.cs`: `gk diff a b` | CHANGE |
| 01/04-ignore-and-messages | `Lint.cs` + `hooks/commit-msg` (**milestone: your hook rejects a bad message**) | CHANGE |
| 01/05-boss | `Review.cs` + `hooks/pre-push` | CHANGE |
| **NEW 01/045-your-git-toolkit** | `Git.cs`: `IGit`, `ProcessStartInfo.ArgumentList`, exit codes | NEW |
| 02-history-and-undo/01..06 | `Refs.cs` (`.git/HEAD`, `packed-refs`); `gitconfig` aliases (file step); `Undo.cs` advisor (DEEPEN); `gitconfig` += `amend`, `fixup`; `Rescue.cs` from real reflog (DEEPEN); boss revert-series plan | CHANGE |
| 03-branching-and-merging/01..06 | `Graph.cs`; `MergeBase`; `Merge3.cs`; `Todo.cs` as `GIT_SEQUENCE_EDITOR` (`gk autosquash`); `gk backport`; boss `gk incoming` | CHANGE |
| 04-remotes-and-collaboration/01..05 | `gk sync`; `gk push-check`; `pushf = push --force-with-lease` (DEEPEN); `Version.cs` (`gk next-version`); boss `gk release` | CHANGE |
| 05-under-the-hood/01..04 | `gk hash-object` (DEEPEN); `gk cat` with `ZLibStream` (gap card); `gk dedupe-stats`; boss `gk fsck-lite` | CHANGE |
| 06-rescue-and-pro-tips/01..06 | `gk where`; `Bisect.cs` driving `git bisect run`; `gk pickaxe`; `Secrets.cs` + `hooks/pre-commit`; `gk scrub-plan` (DEEPEN); boss `gk incident` | CHANGE |
| p01-team-day 01→05 | `gk branch`, `gk resolve ours/theirs/both file`, `gk autosquash`, `gk backport`, `gk rescue` | CHANGE |

Cold rebuilds: `Lint`, `Rescue`, `MergeBase`, `Version`, `hash-object`, `Secrets`. Field test: a new netlab
"git rescue" (broken repo + the learner's `gk`).

---

### 2.11 linux + editors → Dotfiles

**Artifact.** `dotfiles/` (`shell` kind): `install.sh` (idempotent symlinks), `bash/bashrc`, `aliases.sh`,
`functions.sh`, `env.sh`, `lib/common.sh` (`log`, `die`, `need`), `bin/*`, `cron/crontab.example`,
`systemd/*.service|timer`, `ssh/config.example`, `vim/vimrc`, `vim/ftplugin/*.vim`, `nano/nanorc`,
`git/editor.gitconfig`, `editorconfig`. Runs in WSL, Git Bash, containers and every server the learner logs into.
**Bash steps** (3.4) run in the netlabs toolbox image; today's C# models stay as earlier practice steps.

| Lesson | Piece | Status |
|---|---|---|
| 01-navigating/01..03 | `aliases.sh` (`..`, `mkcd`, `cdp`), `bin/ff`, boss `bin/bigdirs` | CHANGE |
| 02-files-and-text/01..03 | `bin/logtail` (DEEPEN), `bin/topips`, boss `bin/anonymise` | CHANGE |
| 03-permissions-and-users/01..03 | `bin/perm`, umask in `env.sh` + `bin/mkprivate` (DEEPEN), boss `bin/permaudit` | CHANGE |
| 04-processes-and-services/01..03 | `bin/killtree`, `systemd/backup.service|timer` + `crontab.example`, boss `bin/jerr` | CHANGE |
| 05-scripting/01..03 | `lib/common.sh`, `bin/retry` + strict-mode header (DEEPEN), boss `bin/backup` + `bin/rotate-logs` | CHANGE |
| 06-networking-tools/01..03 | `ssh/config.example` + `bin/ssh-keysetup`, `bin/ports`, boss `bin/hostcheck` | CHANGE |
| 07-distributions/01..05 | `bin/whatami` grows (append) over five lessons: kernel/libc, family, LTS, recommendation, EOL | CHANGE |
| 08-packages-and-system/01..06 | `bin/pkg` wrapper, `pkg compare-versions`, `pkg detect`, `bin/svc` (systemctl/OpenRC), PRACTICE 05 (base images: Shipyard), boss `bin/fw` | CHANGE |
| editors 01-nano/01..04 | `nano/nanorc`, `env.sh` += `EDITOR`/`VISUAL`/`GIT_EDITOR`; 01 DEEPEN | CHANGE |
| editors 02-vim-survival/01..04 | `vim/vimrc` v0 safe defaults; PRACTICE 03 | CHANGE |
| editors 03-vim-motions/01..04 | `vimrc` += search and number options (append) | CHANGE |
| editors 04-vim-editing-language/01..05 | leader mappings, `ftplugin/yaml.vim`, saved `:s` mappings | CHANGE |
| editors 05-vim-for-real/01..05 | full `vimrc`, split mappings, `git/editor.gitconfig` (vimdiff); PRACTICE boss | CHANGE |

Gaps: real keystrokes. Add netlab **23-vim-gym** (edit tasks checked by file state, learner's `vimrc` mounted).
Linux netlabs 11 to 22 mount `dotfiles/` at `/root/.dotfiles` before the mission. Cold rebuilds: `bigdirs`,
`topips`, `permaudit`, `retry`, `whatami`, `vimrc` from memory.

---

### 2.12 auth → Gatekeeper

**Artifact.** A local identity server for development (`dotnet-web`, `:5080`): login pages, cookie sessions
with CSRF, PBKDF2 with upgrade, TOTP, lockout; JWT HS256/RS256 with JWKS and OIDC discovery; auth code + PKCE
(Homebase), client credentials (Relay), refresh rotation with reuse detection, hashed API keys (`sk`).

| Module | Lessons → pieces |
|---|---|
| 01-foundations | `Access.cs` (DEEPEN) · `Passwords.cs` hash (DEEPEN) · verify + rehash · `Throttle.cs` + **NEW step** `Totp.cs` · boss `LoginService.cs` |
| 02-sessions-and-cookies | `Sessions.cs` · cookie login · CSRF · rotate/revoke · boss login UI |
| 03-jwt-in-depth | `Jwt/Codec.cs` · `Claims.cs` · `Hs256.cs` · `Rs256.cs`/ES256 · `Validator.cs` · `Jwks.cs` + `Denylist.cs` · boss `Tokens/RefreshStore.cs` |
| 04-oauth2-and-oidc | `Oauth/AuthorizeUrl.cs` · PKCE at `/token` · client credentials · discovery document · boss complete login |
| 05-in-aspnet-core | `Principal.cs` · bearer middleware · handler + policies · boss locked-down admin API |
| 06-api-security | hashed API keys with scopes · ownership checks (BOLA) · CORS for Homebase · `Redact.cs` · boss structured scrubbing |
| p01-secure-the-api 01→05 | the `Program.cs` spine (carry); each stage gets a review step (n=4) |

Cold rebuilds: `Passwords`, `Hs256` + `Validator`, PKCE, bearer middleware.

---

### 2.13 integration → Relay

**Artifact.** A gateway in front of Sidekick and Gatekeeper (`dotnet-web`, `:8088`), routes in `relay.json` with
Camel-style URIs; header policy, JSON transforms, OpenAPI validation and `--mock`, contract diff, error contract
with trace ids, deadlines, retries, breaker, idempotency, JWKS validation, rate limits, products, `/metrics`.

| Module | Lessons → pieces |
|---|---|
| 01-the-big-picture | PRACTICE 01 · `Gateway/Decide.cs` · `Onboarding.cs` (DEEPEN) · PRACTICE 04 · boss `relay cost` |
| 02-enterprise-integration-patterns | `Exchange.cs` · `Routing/Router.cs` · `Eip/Aggregator.cs` · `Eip/Idempotent.cs` + `WireTap.cs` · `Broker/MemoryBroker.cs` · boss `Eip/Pipeline.cs` |
| 03-camel-routes | `Config/EndpointUri.cs` · `Expr/Simple.cs` · `Routing/Match.cs` · `Proxy/HeaderPolicy.cs` · `Transform/JsonMap.cs` · `relay lint` · boss `Engine.cs` |
| 04-contracts-and-validation | `OpenApi/Operations.cs` · `relay --mock` · `OpenApi/SchemaValidator.cs` · `relay contract-test` · `relay diff` · boss contract gate |
| 05-errors-and-resilience | `Errors/Contract.cs` · `Errors/Map.cs` · `Resilience/Deadline.cs` · `Retry.cs` · `Breaker.cs` + idempotency + trace ids · boss `Errors/Trace.cs` |
| 06-api-management | `Auth/Policy.cs` · `Catalog/ManagedApi.cs` · token endpoint · `RateLimit/TokenBucket.cs` · `Catalog/Products.cs` · boss `relay usage` |
| 07-delivery-and-operations | PRACTICE 01 · `Ops/Placeholders.cs` · PRACTICE 03 · `/metrics` + `relay trace` · boss onboarding gate |
| p01-mini-integration-platform 01→08 | `Relay.Web/Program.cs` spine (carry); stage 1 backends become `samples/backends` |

Cold rebuilds: `Router`, `HeaderPolicy`, `SchemaValidator`, `Breaker`, `TokenBucket`.

---

### 2.14 design → Herald

**Artifact.** `herald send "Build passed" --to console,file,teams`: channels, retry/rate-limit/logging decorators,
quiet hours, templates, config. Used by Dotfiles' `bin/backup`, Shipyard CI and Sidekick reminders. **Story:**
the learner inherits `notify.cs`, a 400-line legacy monolith (template); each final step refactors one part of it
into a real file. The katas stay as practice steps.

| Module | Lessons → pieces |
|---|---|
| 01-readable-code | `Defaults.cs` · `Message/Format.cs` · `Cli/Args.cs` (DEEPEN) · delete speculation → `Channels/ConsoleChannel.cs` (DEEPEN) · boss split `Program.cs` |
| 02-solid | render vs send · `IChannel` · honest contracts · `IBatchChannel` · `ISender` seam · boss Teams without edits |
| 03-coupling-and-cohesion | `Routing.cs` · composition · `Recipient` · `WebhookUrl`/`QuietHours` · `Delivery` states · boss paused subscriptions |
| 04-patterns | `ChannelFactory` · decorators · events + `SlackAdapter` · `WebhookChannel` · `MessageBuilder` · boss `Hub.cs` |
| 05-testable-code | `IClock` (DEEPEN) · doubles · CLI vs core · `Policy.Decide` · `tests/HeraldTests.cs` · boss `herald schedule` |
| 06-refactoring | feature envy · extract `Config` · `Email` · polymorphic priorities · boss ship (**installed**) |

---

### 2.15 dsa → Seek

**Artifact.** `seek index ~/source/repos`, ranked `seek "query"` with snippets, `seek file` (fuzzy), `seek dupes`,
`seek deps` / `build-order` / `cycles` / `path` over `.csproj` and `package.json`, `seek diff`.

| Module | Lessons → pieces |
|---|---|
| 01-complexity | PRACTICE 01-03 · `Text/InPlace.cs` · boss `seek bench` |
| 02-linear-structures | `Core/GrowList.cs` · `Core/Links.cs` · `Query/Parser.cs` (stack) · `Walk/Queue.cs` · PRACTICE boss |
| 03-hashing | `Core/Fnv.cs` · `Index/TermMap.cs` · dedupe · term frequency · boss `Cache/Lru.cs` |
| 04-searching-and-sorting | `Postings.LowerBound` · PRACTICE 02 · `MergePostings` · stable ranking (DEEPEN) · PRACTICE boss |
| 05-trees | PRACTICE 01 · `seek tree` · PRACTICE 03 · `Rank/TopK.cs` · boss merge shards |
| 06-graphs | `Graph/ProjectGraph.cs` · `seek path` · `seek cycles` · `seek build-order` · PRACTICE 05, boss |
| 07-techniques | intersection · `Text/Snippet.cs` · PRACTICE 03 · `Text/Fuzzy.cs` · PRACTICE 05 · boss `seek diff` |

Practice share 11 of 37 (30%), over the 20% rule and accepted for DSA: classic algorithms are worth drilling on
their own. Say so in the track intro.

---

### 2.16 docker + cicd + kubernetes → Shipyard

**Artifact.** `ship/` (new kind `infra`): Dockerfiles for Sidekick, Gatekeeper and Relay, `.dockerignore`,
`compose.yaml` (plus postgres and a `tools` profile), `.env.example`, `scripts/*.ps1`,
`.github/workflows/ci.yml|release.yml`, `k8s/base`, `k8s/overlays/dev|prod`. Run:
`docker compose -f ship/compose.yaml up --build`, then `kubectl apply -k ship/k8s/overlays/dev` on Docker Desktop.
**Every final step becomes a real file** (file steps, 3.4). The graders reuse the parsers and linters today's
lessons ask learners to write (their reference solutions become the checks). "Run it for real" runs
`docker build`, `docker compose config` and `kubectl apply --dry-run=client` locally.

| Track / module | Lessons → pieces |
|---|---|
| docker 01-why-containers | PRACTICE 01, 02 · `scripts/dev.ps1 ps/logs` · `dev.ps1 db` (port, env, volume) · boss `scripts/doctor.ps1` |
| docker 02-images-and-dockerfiles | `sidekick/Dockerfile` v1 → v5 across 01-05 (ENTRYPOINT, cache order + `.dockerignore`, multi-stage, non-root + HEALTHCHECK) · boss **cold**: `gatekeeper/Dockerfile` from blank |
| docker 03-data-and-networking | volume for `/data` · networks · connection strings by env · boss `scripts/backup-volume.ps1` |
| docker 04-compose | `compose.yaml` v1 → v5 (healthchecks, `.env` + profiles (DEEPEN), full platform, waits that can pass) |
| docker 05-production-practices | logging + health · secrets · `deploy.resources` + `scripts/scan.ps1` · `scripts/why-crash.ps1` · boss `scripts/stats.ps1` |
| docker p01-containerize-an-app | re-theme TodoApi → Sidekick.Web; stages produce the real Dockerfile and compose versions |
| cicd 01-concepts | PRACTICE 01 (DEEPEN) · `scripts/ci-local.ps1` · boss cleanup that always runs |
| cicd 02-github-actions | `ci.yml` v1 → v3 (matrix + cache, docker build) · boss `needs` graph |
| cicd 03-testing-in-pipelines | coverage gate script (DEEPEN) · flaky retry policy (DEEPEN) · boss shard matrix |
| cicd 04-release-strategies | `release.yml` with `gk next-version` · `compose.canary.yaml` · `scripts/rollback.ps1` (DEEPEN) · PRACTICE boss |
| cicd 05-security-and-quality | job `permissions` (DEEPEN) · SHA-pinned actions + `dependabot.yml` · boss `scripts/audit.ps1` |
| cicd p01-pipeline-for-an-app | `ci.yml` complete, converted from `Console.WriteLine` YAML to file steps |
| kubernetes 01-the-big-picture | PRACTICE 01 (DEEPEN) · `namespace.yaml` · `scripts/kctx.ps1` · PRACTICE boss |
| kubernetes 02-workloads | labels · `deployment.yaml` · `backup-cronjob.yaml` · PRACTICE boss |
| kubernetes 03-networking | `service.yaml` · `ingress.yaml` · `networkpolicy.yaml` · PRACTICE boss |
| kubernetes 04-config-and-storage | `configmap.yaml` + `secret.example.yaml` · mounted config · `pvc.yaml` + postgres StatefulSet · boss `configMapGenerator` |
| kubernetes 05-reliability | requests/limits · probes · HPA + PDB · PRACTICE boss |
| kubernetes 06-operating-it | `scripts/triage.ps1` · `rbac.yaml` · overlays · PRACTICE boss |
| kubernetes p01-deploy-an-app | assemble `k8s/` for Sidekick + postgres |

Cold rebuilds: Dockerfile (docker 02 boss), compose (04), `ci.yml` (cicd 02), deployment + service (k8s 03).

---

### 2.17 Choose your dream: 4 to 5 curated dreams per track

A learner should not be forced into one product. Each track offers **4 to 5 dreams**. They are **themes over one
shared architecture**: the lessons teach the same concepts, the pieces fill the same roles (same file skeleton,
same seams, same tests' shape), and each dream supplies its own domain: names, sample data, flavour text, banner,
finished-product description and, only where wording is not enough, its own prompt/starter/solution/tests for a
build step (3.7). The artifacts described in 2.1 to 2.16 are each track's **flagship dream** (first in the list,
the default) and define the skeleton. Cost control: 70 to 80% of build steps differ only by vocabulary
(`lexicon`, 3.7); only boss and project steps usually need a full variant.

| Track | Dreams (★ = flagship, sets the skeleton) | Shared skeleton (roles) |
|---|---|---|
| fundamentals | ★ **Delve** dungeon crawler · **Star Trader** (fly between planets, buy low sell high, fuel maths) · **Pocket Pet** (a virtual pet that gets hungry, plays mini-games, ages) · **Quiz Show** (rounds, lifelines, prize ladder, high scores) · **Farm Days** (plant, water, harvest, sell at market, seasons) | banner, stats, integer maths, shop/change, rules, game loop, map/board render, recursive generator (maze / galaxy / family tree / quiz tree / field), save code, high scores, own tests |
| csharp | ★ **Sidekick** developer assistant · **Money Tracker** (accounts, expenses, budgets, monthly report, web dashboard) · **Pantry** (home inventory, expiry dates, recipes you can cook now, shopping list) · **Study Buddy** (courses, study sessions, spaced-repetition reminders, streaks) · **Corner Shop** (a small shop backend: products, stock, orders, receipts, REST API) | `Core/Model/Item`, `Entry` record, `Journal`, `Reports/*`, `IStore`, `Commands`, `Shell`, `Result`, `FilterCompiler`, `JsonFileStore`, `Web/Program.cs` |
| python | ★ **Butler** Downloads tidier · **Photo Archivist** (sort photos into `YYYY/MM`, find duplicates, rename by date) · **Music Librarian** (organise music files, build `.m3u` playlists, find gaps) · **Backup Buddy** (incremental backups with rotation, verify, restore, undo) · **Notes Indexer** (Markdown notes: tags, backlinks, search, daily note) | config, sizes/names, rules, actions protocol, walk generator, registry decorator, organiser, journal/undo, dupes, CLI, tests |
| typescript | ★ **Homebase** start page · **Kanban** (boards, columns, drag order, undo) · **Recipe Book** (recipes, scaling, shopping list) · **Habit Tracker** (habits, streak calendar, stats) · **Portfolio** (your projects gallery with filters, contact form, theme) | model, settings, search index, store/emitter, reducer, render, forms, storage, fetch client, components, page |
| datascience | ★ **Money Lens** (bank export) · **Listening Lens** (your Spotify streaming-history export: top artists, listening clock, mood seasons, "Wrapped" in March) · **Fitness Lens** (Strava/Garmin/Google Fit export: pace trends, PR forecast) · **Energy Lens** (smart-meter CSV: usage by hour, anomalies, bill forecast) · **Any CSV** (bring a dataset, the report adapts) | load/types, clean/dedupe, enrich, group/pivot, time index, alerts, charts, dashboard, experiment, forecast, categoriser, HTML report |
| sql | ★ **Sidekick SQL** · **Money Ledger** (bank import, categories, budgets) · **Game Library** (your games, play sessions, achievements) · **Home Inventory** (rooms, items, warranties, receipts) · **League Manager** (teams, fixtures, results, tables) | `schema/001..005`, `reports/*`, `checks/*`, `ops/*`, `warehouse/*` |
| efcore | follows the learner's C# dream (Sidekick.Data, Money.Data, Pantry.Data, StudyBuddy.Data, Shop.Data) | `Db`, entities, configurations, queries, migrations, perf |
| networking | ★ **netdoc** developer diagnostics · **Home Network Watch** (who is on my network, open-port drift, DNS checks) · **Homelab Planner** (VLSM address plan + firewall rules + docs) · **Site Health Checker** (DNS/HTTP/TLS checks for your websites, a daily report) · **Security Sentinel** (scan, log analysis, firewall and sshd audits) | ip/cidr, plan, routes, sockets, trace/mtu, DNS wire, HTTP verdicts, TLS, firewall, scan, logs, ssh audit |
| pki (+crypto) | ★ **Keystone** CA + toolkit · **Homelab CA** (certificates for NAS, router, Pi services, with a trust guide per device) · **Secure Drop** (encrypt files to friends' keys, signed) · **Password Vault** (vault-first, CA as the second act) · **Release Signer** (sign your builds and verify downloads) | sign/inspect/pem, chain, diagnose, CA root/issue/export/CRL, capture/doctor, sealed box, hybrid seal, vault |
| git | ★ **gitkit** · **Release Captain** (semver, changelog, tags, release notes) · **Repo Doctor** (rescue, fsck, find lost work) · **Team Guard** (hooks and policy for a team repo) · **Git X-ray** (reads `.git` and draws the commit graph and objects) | status/log/diff, lint + hooks, refs/graph, merge-base/merge3, rescue, version, objects, secrets |
| linux (+editors) | ★ **Dotfiles** · **Homelab Server Kit** (set up a Pi/VPS: users, ssh, firewall, services) · **Dev Box Bootstrap** (one script sets up a new WSL machine) · **On-call Toolkit** (log hunting, process and disk triage) · **Backup & Monitor** (backups, rotation, health pings, cron/systemd) | aliases/functions, `lib/common.sh`, `bin/*` roles, units/cron, ssh config, `vimrc`/`nanorc`, `install.sh` |
| auth | ★ **Gatekeeper** dev identity server · **Family Portal** (household app: logins, roles, kids' accounts) · **App Login Kit** (drop-in auth for your own C# app) · **API Key Service** (issue, scope and rotate keys) · **Homelab SSO** (one login for your self-hosted apps) | passwords, sessions, JWT, OAuth/OIDC endpoints, middleware, API keys, redaction |
| integration | ★ **Relay** gateway · **Webhook Hub** (receive GitHub/Stripe webhooks, verify, route, retry, replay) · **Smart Home Bridge** (normalise device APIs, transforms, rate limits) · **Shop Integrations** (order → invoice, stock, email, with DLQ) · **API Sync Bot** (keep two APIs in step, idempotent) | exchange, router, transforms, contracts, errors, resilience, auth policy, rate limit, spine |
| design | ★ **Herald** notifier · **Pricing Engine** (rules, discounts, taxes for a shop) · **Text Toolbox** (pluggable text transforms CLI) · **Report Builder** (data → Markdown/HTML/CSV reports) | the legacy-monolith story with the same refactoring steps |
| dsa | ★ **Seek** code search · **Route Planner** (bus/metro graph, fastest route) · **Puzzle Solver** (mazes, sudoku, word search) · **Autocomplete & Spellcheck** · **Mini Index** (a tiny key-value store with an index) | structures, hashing, search/sort, heaps, graphs, DP |
| docker / cicd / kubernetes | ★ **Ship Sidekick** (your C# dream) · **Ship your web app** (Homebase or your TS dream) · **Ship your bot** (Python dream as a scheduled container) · **Self-hosted stack** (your app + a git server + an uptime monitor + reverse proxy) · **Game night server** (a game server container with backups and limits) | Dockerfiles, compose, scripts, workflows, k8s base and overlays |

Rules: (1) A dream is chosen when a track starts (suggested by the profile, 3.8) and can be changed later; pieces
are stored per dream, so switching keeps both. (2) Contributor tracks follow the owner's dream where it exists
(EF Core follows C#; Shipyard ships whichever apps exist). (3) Every dream must pass `dojo validate` with its
reference solutions assembled into a runnable artifact. (4) Write the flagship first; add a dream only when its
lexicon, sample data and preview are written.

## 3. Mechanism spec (for the engine)

Already implemented (`server/Builds.cs`, `server/Content.cs`): `build` markers with `artifact`, `file`, `title`,
`mode` (`replace` | `append`) and `transform`; `artifacts` in `track.json` with `id`, `title`, `summary`, `kind`,
`template`, `run`; assembling in teaching order; export to a Code space without overwriting learner edits; zip;
validation. Everything below is **additive** to that format.

### 3.1 `track.json`

```json
{
  "title": "C#", "language": "csharp", "...": "...",
  "dreams": [
    {
      "id": "sidekick",
      "title": "Sidekick",
      "pitch": "Your own developer assistant: tasks, timers, standups and a dashboard you open every morning.",
      "tags": ["productivity", "web", "data"],
      "preview": {
        "type": "terminal",
        "frames": [ { "cmd": "sk", "out": ["  ____  _     _      _    _ ...", "Good morning, Hassan."] },
                    { "cmd": "sk standup", "out": ["Yesterday: ...", "Today: ..."] } ],
        "image": "previews/sidekick-dashboard.png"
      },
      "lexicon": { "Item": "Task", "item": "task", "Items": "Tasks", "items": "tasks", "Entry": "TimeEntry", "app": "Sidekick", "cmd": "sk" },
      "artifact": {
        "id": "sidekick",
        "title": "Sidekick",
        "summary": "sk CLI + dashboard + API",
        "kind": "dotnet-web",
        "template": { "Sidekick.slnx": ["..."], "src/sk/sk.csproj": ["..."], "src/Sidekick.Core/Duration.cs": ["// stub ..."] },
        "run": "dotnet run --project src/sk -- today",
        "install": ["dotnet pack src/sk -o nupkg", "dotnet tool install -g sk --add-source nupkg"],
        "contributors": ["csharp", "efcore"],
        "checks": [ { "title": "It builds", "cmd": "dotnet build" }, { "title": "Standup works", "cmd": "dotnet run --project src/sk -- standup --demo", "expectContains": "Yesterday" } ],
        "reveal": {
          "headline": "By the end of this topic you will have built Sidekick.",
          "features": [ { "id": "banner", "label": "Banner and greeting" }, { "id": "standup", "label": "sk standup" }, { "id": "web", "label": "Dashboard + API" } ],
          "layers": ["CLI", "Core", "Reports", "Storage", "Web"],
          "parts": [ { "id": "banner", "label": "Banner", "layer": "CLI", "files": ["src/sk/Banner.cs"] },
                     { "id": "duration", "label": "Duration.Format", "layer": "Core", "files": ["src/Sidekick.Core/Duration.cs"] } ],
          "flow": [["banner", "duration"]],
          "milestones": [ { "id": "first-run", "label": "sk runs", "after": "csharp/03-methods-and-collections/06-boss" },
                          { "id": "installed", "label": "Installed as a global tool", "after": "csharp/08-advanced/10-ship-sk" } ]
        }
      }
    }
  ],
  "artifacts": [ "... optional: artifacts not tied to a dream, as today ..." ]
}
```

- `dreams[0]` is the flagship and default. `artifacts` (today's field) stays valid; a dream's `artifact` is
  registered exactly like an entry of `artifacts` (so `Builds.Check` and export need no new path). Artifact ids
  stay unique across all tracks; the dream's artifact id is the dream id.
- `kind` adds `"infra"` (files and scripts, exported into an `empty` space) to `Builds.Kinds`.
- `contributors` (optional, owner track only): tracks allowed to add pieces, and the order their pieces are
  applied after the owner's (today pieces sort by lesson key; a contributor's `replace` of the same file must win
  over the owner's, e.g. EF Core's `Sidekick.Web/Program.cs`).
- `install` and `checks` drive the "Run it for real" button: `checks` run in the exported Code space on the
  learner's machine (never during grading), each shown as a row.
- `reveal` drives the dream reveal and the progress visual (3.6). `parts[].files` link visual parts to build files.

### 3.2 `build` on a code step

```json
"build": {
  "artifact": "sidekick",                  // or "csharp/sidekick" from a contributor track; "@dream" = the learner's chosen dream of the owner track
  "file": "src/Sidekick.Core/Duration.cs",
  "title": "Duration formatter",
  "mode": "replace",                       // replace | append (existing)
  "transform": ["namespace Sidekick.Core;", "", "public static partial class Duration", "{", "{{CODE}}", "}"],
  "part": "duration",                      // reveal part this lights (default: the part whose files include `file`)
  "uses": ["src/Sidekick.Core/Text.cs"],   // NEW: earlier pieces compiled/imported with this step's code (interleaved review)
  "stub": ["public static partial class Duration { public static string Format(int s) => throw new NotImplementedException(\"Earn this in C# 1.3\"); }"],
  "try": "sk today",                       // NEW: command shown after passing; runs the assembled artifact in its Code space
  "unlocks": "Your banner now shows how long you worked yesterday."   // NEW: one line for the celebration toast
}
```

- **`artifact` resolution**: bare id → this track's artifact; `track/id` → another track's artifact (must list
  this track in `contributors`); `@dream` (or `track/@dream`) → the artifact of the dream the learner chose.
- **`uses`**: when grading, the engine adds the learner's latest passing version of each listed file (after its
  own `transform`) to the compilation (C#: extra source file; Python: module beside `main.py`; TypeScript:
  sibling module; SQL: executed after `setup`). If the learner has no passing version, it uses the reference
  `solution` of the step that builds that file and shows "using the reference version of Text.cs" in the results.
  `dojo validate` always uses reference solutions.
- **`stub`**: what the assembled artifact contains for this file while the piece is unearned, so the template
  always compiles and runs. Default: the file is omitted (allowed only for files nothing else references).
- **Stored piece record** (UI): `{ artifact, file, mode, lesson, step, code, passedAt, assisted, cold, dream }`.
  `assisted` = the last hint was revealed; `cold` = passed in a cold step. Export marks stubbed files with a header
  comment and lists them in the export result (`stubbed: [...]`).
- **Ordering**: owner pieces by lesson key, then contributors in `contributors` order, then by lesson key.

### 3.3 Template conventions

Templates hold everything that is not a lesson piece: project files, the host (`Program.cs`, `__main__.py`,
`serve.mjs`), real adapters for the seams, README with run/install, sample data, and stubs. Hosts call pieces
only through stable names so a stub and a real piece are interchangeable. Real-world adapters (clock, file
system root under `%USERPROFILE%`, `HttpClient`, `Process`, sockets) live only in the template.

### 3.4 New step capabilities needed by the plan

| Capability | Spec | Needed by |
|---|---|---|
| **File steps** (`"mode": "file"`) | The editor holds a plain file (`"fileType": "dockerfile" \| "yaml" \| "bash" \| "powershell" \| "ini" \| "vim" \| "gitconfig" \| "json" \| "sql"`, used for highlighting). Grading: a C# (or the track language) `template` in which the token `{{TEXT}}` is replaced by the learner's file as a raw string literal, plus `require`/`forbid` on the text (string contents not stripped). The build saves the text verbatim. | Docker, CI/CD, Kubernetes, git `gitconfig`, Linux units, editors' `vimrc`/`nanorc`, SQL `build.sql` |
| **Bash runner** (`"language": "bash"` on a step or track) | Runs the learner's script with `docker run --rm -i --network none --memory 256m -v <tmp>:/work -w /work dojo-toolbox bash main.sh` (the netlabs toolbox image), `tests` with `stdin`/`expect`/`expectContains`, plus a `"setup"` script that creates fixture files first and a `"check"` script run after (exit 0 = pass, stdout lines = rows). Requires Docker; if it is not running the step says so and offers the file-step fallback grading. | Linux, Dotfiles dreams |
| **Cold steps** (`"cold": true` on a code step or a whole lesson) | Empty editor (starter ignored), no hints, no carry, no "show solution", no Try-it on the lesson's learn cards while the step is open. Same tests as the referenced piece (`"coldOf": "<lesson key>#<step>"` copies tests/template from there so they never drift). Passing sets `cold: true` on the stored piece. | Every module |
| **Review tag** (`"review": ["csharp/01-first-steps/03-numbers-and-math"]` on any step) | Marks interleaved review; counts toward the "skills kept fresh" stat and feeds the review queue when failed. | Every module from 2 on |
| **Field-test link** (`"lab": "netlabs/<id>"`, `"mount": "@artifact"` on a learn card) | Opens the live lab with the learner's exported artifact mounted read-only at `/root/<artifact-id>`. | Networking, Linux, Git, Keystone |

### 3.5 Gates and pacing (`module.json` and server)

```json
{ "title": "Methods and collections", "summary": "...",
  "gate": { "boss": { "minStars": 2 }, "cold": ["csharp/03-methods-and-collections/055-cold-rebuild"], "unlocks": "next" } }
```

- A module is **proven** when its boss has ≥ `minStars` and every listed cold lesson/step passed. The next
  module's lessons other than the first stay locked until then (Free roam overrides, but pieces from unproven
  modules show as "not yet proven").
- **Rush detector** (server-side, from progress events): completion time < 40% of `minutes` with ≥ 1 hint, or a
  boss passed only after revealing the last hint → enqueue the module's cold step in tomorrow's review.
- **Re-proof**: the review queue (1, 3, 7, 14 days) includes cold steps of finished modules. A failed re-proof
  dims the part in the dream panel until it passes again.
- **Depth lint** in `dojo validate`: warn when a non-boss, non-project lesson has < 8 steps, < 2 code steps
  (SQL: < 3), or a final solution under 8 non-blank lines; warn when a track's build ratio (lessons with a build
  ÷ lessons) is under 80% without `"practiceReason"` on the practice lessons.

### 3.6 Dream reveal and "your dream so far" (UI requirements)

1. **Dream picker** when a track is opened for the first time: 4 to 5 dream cards (title, pitch, preview, tags,
   "recommended for you" badge from the profile). Choosing is one click; "change dream" lives on the track page.
2. **Dream reveal** right after choosing (and replayable): full-width page that shows the finished artifact
   working: a `terminal` preview plays its `frames` like a typed session; an `image` preview shows a screenshot;
   a `web` preview embeds the finished reference build in an iframe (the reference artifact assembled from
   solutions, served read-only). Then the feature list, the milestones, and "Start building: your first piece is
   the banner".
3. **"Your dream so far" panel**, persistent on the track map and on every lesson page (collapsible): the
   `reveal.layers`/`parts` drawn like project blueprints. Each part is *dim* (unearned, stub in place), *lit*
   (passed), *dashed* (assisted or not yet proven), *glowing* (just earned). Hover shows the file, the lesson that
   builds it and the `try` command. A progress ring shows parts earned ÷ total and the next milestone.
4. **Lesson card chip**: "Builds: Duration formatter → `sk today`" on the map and at the top of the lesson.
5. **On pass of a build step**: toast with `unlocks`, the part animates from dim to lit, "Try it" runs `try` in
   the exported Code space and shows the output, "See what changed" shows the file diff against the stub or the
   previous version.
6. **Milestone moments** (`first-run`, `first-real-use`, `installed`, `shipped`): a full-screen moment the first
   time, with the exact command to run on their own machine.
7. **"Run it for real"** button on the panel: export to the Code space (existing endpoint), then run `checks`
   with live rows; offer `install` commands.
8. Cross-track parts carry a small badge of the contributing topic ("from EF Core").

### 3.7 Dream variants on build steps

```json
{
  "type": "code", "title": "Format a {{item}}'s duration",
  "prompt": "Write `static string Format(int seconds)` for {{app}} ...",
  "starter": "...", "solution": "...", "template": ["{{CODE}}", "Dojo.Eq(\"3725 s\", \"1h 02m 05s\", Format(3725));"],
  "build": { "artifact": "@dream", "file": "src/{{App}}.Core/Duration.cs", "title": "Duration formatter" },
  "variants": {
    "pantry":  { "file": "src/Pantry.Core/Freshness.cs", "title": "Days-until-expiry formatter",
                 "prompt": "...", "starter": "...", "solution": "...", "template": ["..."] },
    "corner-shop": { "title": "Opening-hours formatter" }
  }
}
```

- **Lexicon substitution first**: tokens `{{key}}` in `title`, `prompt`, `starter`, `solution`, `template`,
  `tests`, `explain`, `hints`, learn-card `body` and `build.file`/`title` are replaced from the chosen dream's
  `lexicon` (missing key = left as is and reported by `dojo validate`). This covers most steps.
- **`variants[dreamId]`** overrides any of `prompt`, `starter`, `solution`, `tests`, `template`, `require`,
  `forbid`, `hints`, `explain`, `title`, `file`, `transform`, `stub`, `try`, `unlocks` for that dream; unspecified
  fields fall back to the step's own (after lexicon substitution).
- Learn cards may carry `"variants": { "<dreamId>": { "body": [...] } }` for flavour text.
- `dojo validate` runs every step once per dream that the track declares (reference solutions after
  substitution), then assembles each dream's artifact from its references and builds it (`dotnet build`,
  `python -m py_compile`, `node --check`, `sqlite3 :memory: < build.sql`, `bash -n`, compose `config` when
  Docker is available).

### 3.8 Onboarding questionnaire and learner profile

**Questionnaire** (first launch, 7 questions, under two minutes, every answer editable later in Profile):

| # | Question | Answers |
|---|---|---|
| 1 | What brings you here? | Get a first developer job / switch career · Get better at my current job · Build things for myself (hobby) · Pass an interview or certification |
| 2 | How much have you programmed? (per area: Programming, Web, Data, DevOps/Linux, Security) | Never · A little (tutorials) · I use it at work · Confident |
| 3 | Time per day | 10 min · 20 min · 45 min · 1 h or more |
| 4 | Which excite you? (pick up to 3) | Games · Data and charts · Websites and apps · Automating chores · Security and privacy · Servers and infrastructure · Money and productivity tools |
| 5 | How do you learn best? | Seeing it move (visual) · Trying things (hands-on) · Reading it properly first |
| 6 | Which language do you use or want? | C# · Python · JavaScript/TypeScript · No idea yet |
| 7 | Where will you run things? | Windows only · Windows + Docker Desktop · WSL/Linux too |

**Profile schema** (`.state/profile.json`):

```json
{
  "version": 1,
  "goal": "career" ,                       // career | upskill | hobby | interview
  "levels": { "programming": 0, "web": 0, "data": 0, "devops": 0, "security": 0 },   // 0 never .. 3 confident
  "minutesPerDay": 20,
  "interests": ["games", "automation"],    // games | data | web | automation | security | infra | productivity
  "style": "hands-on",                     // visual | hands-on | reading
  "language": "csharp",                    // csharp | python | typescript | unsure
  "environment": "windows-docker",         // windows | windows-docker | wsl
  "path": ["fundamentals", "csharp", "git", "sql", "efcore", "docker"],
  "dreams": { "fundamentals": "delve", "csharp": "sidekick" },
  "pacing": { "dailyGoalXp": 60, "newLessonsPerDay": 2, "gateStrictness": "standard" },
  "createdAt": "2026-11-25T09:00:00Z"
}
```

**Mapping rules** (deterministic, in `server/Profile.cs`; the learner sees the result and can reorder):

1. **Language first.** `language` (or, if `unsure`: games/productivity → csharp; data/automation → python;
   web → typescript) picks the programming track. If `levels.programming == 0`, prepend `fundamentals`.
2. **Interest → topic sequence** appended after the language track (deduplicated, order kept):

| Interest | Adds |
|---|---|
| games | dsa, design |
| data | sql, datascience (python learners) or sql, efcore (C# learners) |
| web | typescript (if not the language), networking (HTTP modules), auth |
| automation | linux + editors, git, python (if not the language) |
| security | networking, pki, crypto, auth |
| infra | linux + editors, networking, docker, cicd, kubernetes |
| productivity | git, sql, efcore (C#) |

3. **Goal adjusts.** `career` inserts `git` right after the language track and `docker` before the end;
   `upskill` moves topics where `levels` ≥ 2 to the end and marks their early modules "test out" (a cold check
   per module unlocks it); `interview` adds `dsa` second and `design` third; `hobby` caps the path at 4 topics.
4. **Placement.** For each area with level ≥ 2, the first module of the matching tracks offers "Test out": the
   module's cold rebuild and boss; passing marks the module proven and credits its pieces with reference code
   (shown as "placed", dashed until the learner rebuilds them or a later `uses` passes).
5. **Dream per topic.** For each track in the path, score its dreams: +2 per matching tag in `interests`,
   +1 when the dream reuses an artifact already chosen (Shipyard ships the C# dream), −1 for `environment:
   windows` when the dream needs Docker (Linux/Docker/Shipyard dreams get a Docker-setup prelude instead).
   Highest score is suggested; ties → flagship. Suggested, never forced.
6. **Pacing.** `dailyGoalXp = minutesPerDay × 3`; `newLessonsPerDay = max(1, minutesPerDay / 12)`, capped at 4;
   the dashboard asks "review first" when the review queue holds more than 10 minutes. `hobby` uses
   `gateStrictness: "relaxed"` (boss ≥ 1 star, cold check still required); `career`/`interview` use `"standard"`.
7. **Style.** `visual`: learn cards open their trace/LINQ visualisers automatically and dream previews favour
   animation; `hands-on`: the first code step of each lesson moves before the second learn card where the
   content allows (a lesson may mark `"reorderable": true`), labs are suggested earlier; `reading`: learn cards
   show their optional "Go deeper" sections expanded. Content does not fork by style.

Endpoints: `GET/PUT /api/profile`, `POST /api/profile/recommend` (answers → path, dreams, pacing, with the rule
that fired for each choice so the UI can explain "because you like automation").

## 4. Rollout

### Wave 1 (biggest impact, user priorities): C#, PKI (+crypto later), Networking, Linux (+editors), Git

| Track | Lessons touched | New lessons | Why first |
|---|---|---|---|
| csharp (Sidekick, flagship only) | 66 module lessons (final step) + 8 Tasks API stages (light) + 15 expense/log stages (markers + seams) = ~89 | 3 (05/06 dates, 08/10 ship-sk, cold rebuild per module ×9 as short lessons) | The flagship; every other wave hangs on it |
| pki (Keystone) | 34 (all) | 2 + 5 cold | Shortest path to a tool used weekly (`ks ca issue localhost`) |
| networking (netdoc) | 38 (9 practice untouched) | 1 + 5 cold | `netdoc cidr/dns/http` are daily tools; field tests already exist |
| linux + editors (Dotfiles) | 29 + 19 | 1 netlab (vim gym) + 6 cold | Needs file steps + bash runner (engine); content is mostly new final steps |
| git (gitkit) | 37 | 1 + 6 cold | Hooks make the artifact visible in every repo the learner touches |

Engine work for wave 1: dreams with a single (flagship) dream, `uses`, `stub`, `try`, `contributors`, cold steps,
gates, the reveal and dream panel, file steps, bash runner. Lexicon/variants can come in wave 2.
Also: a 1-hour quick win alongside wave 1, **fundamentals → Delve** (22 lessons, small, first impression for
absolute beginners).

### Wave 2: SQL + EF Core (Sidekick data), Data science, Integration, Crypto, onboarding + second dreams

- sql: 50 lessons get one new final step each + 1 new lesson (~51 changes); efcore: 42 (all).
- datascience: 69 (2 practice) + 1 new stage; integration: 45 (4 practice); crypto: 33 (8 practice).
- Onboarding questionnaire and profile mapping; lexicon + variants; the second dream for C#, Python and
  data science (Money Tracker, Photo Archivist, Listening Lens).

### Wave 3: Python, TypeScript, Auth, Design, DSA, Docker + CI/CD + Kubernetes, Shelfwise re-theme, remaining dreams

- python 51 (+1 new), typescript 47 (+1 new), auth 36, design 34, dsa 26 (11 practice), docker 26, cicd 19,
  kubernetes 21, Shelfwise 32 stages re-themed to Sidekick. Then dreams 3 to 5 per track, cheapest first
  (lexicon-only dreams).

Total: about 760 of 852 lessons get a changed or new final code step; about 30 new lessons plus one
short cold-rebuild lesson per module. No merges: thin lessons are deepened in place, which keeps ids and progress
stable. Never rename lesson ids during the rollout (progress in `.state/progress.json` is keyed by them): new
lessons take ids that sort into place, e.g. `045-dates-and-time` between `04-...` and `05-boss`, and cold
rebuilds are `N5-cold-rebuild` lessons placed just before the boss (e.g. `055-cold-rebuild` before `06-boss`).

## 5. Implementation notes: fundamentals → Delve (deviations from 2.1)

Delve is built (flagship dream only, `tracks/fundamentals/track.json`); assembled from the reference solutions it
builds and plays all five floors. Differences from the table in 2.1:

- **One partial class.** Every piece is `static` members of `static partial class Delve.Game` (transform adds
  `using System.Text; namespace Delve;`), so pieces call each other directly; a forbid rule rejects non-`static`
  functions. `src/Engine.cs` (template) holds state, turns, fights, the shop and the score file.
- **Files split instead of shared.** `Rules.cs` became `src/Rules.cs` (`CanOpenDoor`, `IsMonster`, `IsItem`, 02/01),
  `src/Bounds.cs` (`IsOutsideMap`, `IsWall`, 02/02) and `src/Moves.cs` (`MoveOutcome`, 02/03); `Maze.Reachable` is
  `src/MazeReach.cs` (`CountReachable`). Replace pieces of one file in different lessons would overwrite each other,
  and append cannot coexist with the template stub.
- **No party.** Delve has one hero, so "split loot" (01/04) and "min/max/avg party HP" (04/01) were dropped: the shop
  is `ToCopper`/`Coins`/`Change` (1g = 20s, 1s = 12c) and the HUD is `Bar` + `Hud` (reusing `Level` and `Coins`).
- **Pieces chosen to fit the game:** 01/02 `Damage` (armour blocks one point per full three, capped) + `Level`/`XpToNext`;
  01/03 `Heal` (via `long`) + `Percent` (away-from-zero rounding); 03/02 `GameLoop(maxTurns)` calling the engine's
  `Turn`; 04/02 `ClimbStory` (recursive story of the climb, printed on victory); 04/04 iterative `CountReachable`
  with an explicit `Stack<int>` (recursive version shown on a card); 04/05 base-32 save codes with a check digit;
  05/01 `Fight` prints its trace table; 05/05 the existing spiral is the key's map reveal, plus a cold
  **Ship Delve** step (`src/Play.cs`). The template's `Play` stub plays floor 1 only.
- **Stubs keep it playable at every stage** (e.g. `Carve` stub = one open hall, `Render` stub lists open directions,
  `GameLoop` stub takes one command), so "Try it" means something from lesson 1.
- **Cold rebuilds** are lessons `035-cold-rebuild` (modules 1-3) and `045-cold-rebuild` (module 4), with
  `"cold": true`, `"coldOf"` (1-based) and their own copy of the checks; module 1 got one too (Damage). Every
  `module.json` has `"gate": { "requires": ["boss"], "minStars": 2, "cold": [...] }`.
- **Interleaved review** is tagged with `"review"` and done by reference copies of earlier pieces in the grading
  template, not `uses`: C# `uses` compiles the earlier piece as a separate file, and its members are private to
  `Delve.Game`, so the learner's top-level functions cannot call it. Making `uses` work for C# needs the engine to
  compile the step's code inside its own `transform` (or the class to expose members) when `uses` is present.
- One dream only, so `dojo validate` warns "declare 4 or 5"; Star Trader, Pocket Pet, Quiz Show and Farm Days remain.

## 6. Implementation notes: C# → Sidekick (deviations from 2.2)

What shipped differs from section 2.2 and section 3 in these ways (engine format as committed in d832c04):

- **One project, one class.** Sidekick is a single `dotnet-console` project (`sk.csproj` at the root, packed as
  the tool `Sidekick.Dojo` with command `sk`), not the `Sidekick.slnx` + `Core`/`sk`/`Web` solution. Every piece
  is wrapped by its `transform` into `namespace Sidekick; static partial class Sk { ... }`: learner functions become
  members of `Sk` and learner types become nested types, so one transform works for methods and types and stubs
  can be swapped file by file. Cross-piece calls are written `Sk.Name(...)` (valid in the grader and in the app).
  The one exception is `Core/Linq/Batching.cs` (an extension class must be top level). Paths are `Cli/...` and
  `Core/...` instead of `src/sk/...` and `src/Sidekick.Core/...`. The web dashboard/API stays for the p01 re-theme.
- **Modules 1-2 pieces are method bodies.** Learners do not know methods yet, so the transform wraps their
  statements into a fixed signature (`static string FormatMinutes(int minutes) { string result = ""; ...; return result; }`)
  and the grading template mirrors it exactly. Lesson 1's first code step builds `Cli/Banner.cs`.
- **Stubs live in the template** (`tracks/csharp/track.json`, generated): every piece file has a stub with the same
  names that throws `NotBuiltYetException("<module> > <lesson>")`; the host catches it and says which lesson builds
  the command, or falls back. The host only touches type members that exist from a type's first version
  (`TaskItem.Id/Title/LoggedMinutes/IsRunning`), so the app builds at every one of the 62 lesson prefixes
  (checked). Later-version members are reached through later pieces (e.g. `AddTask` sets `Tag`/`Project`).
- **Interleaved review uses given code, not `uses`.** Each review step's template carries the reference version
  of the earlier pieces it calls (functions as `internal static` members of a `static partial class Sk`, types
  verbatim) and is tagged `"review": [...]`. `build.uses` is not set, for two reasons: (1) a used piece plus the
  given copy would define the same members twice; (2) after its transform a piece's methods are *private* members of
  `static partial class Sk` (top-level local functions carry no access modifier), so grader code calling `Sk.X(...)`
  cannot reach a used piece. Before switching to `uses`, the engine must compile used C# pieces with their members
  visible to the step (for example a grading-only transform that adds `internal`), and the given copies must be
  removed in the same edit.
- **Cold rebuilds are short lessons** (`055-cold-rebuild` etc., one per module, before the boss) whose code step
  carries `"cold": true` and `"coldOf"`; module.json carries `"gate"`. Both are authored to section 3.4/3.5 and are
  inert until the engine reads them. Cold steps build no piece.
- **Only the flagship dream is declared**, so `dojo validate` warns "declare 4 or 5"; the engine has no
  "coming soon" form for the four alternatives, so they are not listed.
- **Persistence is a JSON snapshot** (`%USERPROFILE%\.sidekick\sidekick.json`, overridable with `SIDEKICK_HOME`):
  the template owns `Snapshot`/`TaskData`; `JsonFileStore` (07/01) also owns the `TaskItem` ↔ `TaskData` mapping.
  Before 07/01 the app keeps data for one run only and says so; `--demo` works on sample data from 04/08 on.
- Reference pieces and the generator live outside the repo (scratchpad `sk-gen`); the track.json template is
  generated from them. Proof of the assembled artifact: build the template plus every lesson's build-step
  solution (transformed), then run `sk --demo`, `sk standup --demo`, a real add/start/stop/done/persist cycle,
  `dotnet pack` and `dotnet tool install`.
- **Fixes collected from the module conversion** (applied to the lessons, the reference pieces and every given copy):
  `TaskItem.Label` formats the due date as `Due is DateOnly d ? $" (due {d:ddd d MMM})" : ""`; `Report.Render` and
  `Standup` join lines with `"
"` instead of `StringBuilder.AppendLine` (which writes `
` on Windows and broke
  exact comparisons); `WordCount` (03/01) uses a loop, not LINQ, because LINQ comes in module 6; the host's
  `sk focus` parses its argument with the learner's `TryParseMinutes`/`ParseHours`.
- **Streak rule (09/06):** a streak counts workdays. Saturday and Sunday are ignored: weekend activity neither adds
  to a streak nor breaks it (Fri, Sat, Mon, Tue = 3; Sat and Sun alone = 0; on a Sunday the current streak counts
  back from Friday). The first version let a Saturday entry break a Friday-to-Monday run; tests now cover it.
- Bodies in modules 1-2 avoid constructs not yet taught (no ternary before it appears, no LINQ before module 6), so
  some piece bodies are longer than the idiomatic version.
- Proof (wave 1): the artifact assembled from every lesson's build-step solution builds with 0 warnings, runs every
  command on `--demo` data and on a real data folder (add/start/log/stop/done persist across runs, `sync`,
  `selftest`, `shell`), packs to `Sidekick.Dojo.1.0.0.nupkg` and installs with `dotnet tool install --tool-path`.
