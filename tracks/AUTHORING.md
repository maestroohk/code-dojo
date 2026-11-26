# Writing lessons

A track is a folder. Nothing is registered anywhere: drop files in and refresh.

```
tracks/
  csharp/
    track.json                    { "title", "language", "tagline", "category", "icon", "order" }
    01-first-steps/
      module.json                 { "title", "summary" }
      01-hello-world.json         a lesson
      06-boss.json                a lesson with "kind": "boss"
```

Folder and file names are lowercase letters, digits and dashes, and sort in teaching order.
`tracks/csharp/01-first-steps/01-hello-world.json` is the reference lesson: it uses every step type.

After any change run the self-test. It lints every step and runs every reference solution
through the real grader:

```
dojo validate                     everything
dojo validate 03-methods          only keys containing this text
dojo validate --puzzles           also hunt for unfair drag puzzles (slow)
```

`--puzzles` takes each `order` and `blanks` step whose code runs as a program on its own, tries
the arrangements the app would mark wrong, and warns about any that compile and print the same
thing. Fix a warning by listing the arrangement in `also`, accepting the extra token, or changing
the code so only one arrangement gives the stated output. Steps whose code is a fragment or prints
nothing cannot be checked this way. Write the prompt in learner language: say "the tests", never
"the harness".

## Lesson file

```json
{
  "title": "Hello, World",
  "summary": "One sentence shown on the map.",
  "minutes": 8,
  "kind": "lesson",
  "steps": [ ... ]
}
```

`kind` is `"lesson"` (default) or `"boss"` (the challenge that closes a module).

**Multi-line text.** Any of `body`, `prompt`, `code`, `starter`, `solution`, `template`, `explain`,
`expect`, `stdin`, `expectContains` (and `answer` on a predict step) may be an array of lines
instead of one string. Prefer arrays for anything longer than one line.

**Markdown** works in `body`, `prompt`, `explain`, hints, mcq options, and match/sort labels:
`**bold**`, `*italic*`, `` `code` ``, fenced code blocks (```` ```csharp ````, ```` ```text ````),
`-` and `1.` lists, `#`/`##`/`###` headings, tables, and `> **Tip:** ...` callouts.

Every exercise step may carry `"explain"` (shown after answering) and `"hints": ["...", "..."]`
(revealed one at a time, each costs a little XP). Write hints from gentle nudge to near-answer.

## Step types

### learn — teaching card
```json
{ "type": "learn", "title": "Variables", "body": ["Markdown...", "```csharp", "int x = 5;", "```"] }
```
Keep cards short: one idea, one code sample. Follow each card with exercises that use it.

A learn card can carry a visualizer that runs for real under the text. `dojo validate` runs each one
and fails the lesson if it does not compile or run.

**`"trace"` — Code in motion.** Steps through a program line by line: the current line, every
variable (arrays and lists drawn as boxes), the call stack (recursion shows as frames) and the output.
The learner can play it, step it with ← →, and scrub backwards.
```json
{ "type": "learn", "title": "Accumulating", "body": ["..."],
  "trace": { "code": ["var sum = 0;", "for (var i = 1; i <= 4; i++)", "    sum += i;", "Console.WriteLine(sum);"], "stdin": "optional" } }
```
Top-level statements; local functions and types after them are fine. Keep it small: tracing stops after
800 steps. Deterministic, like all code.

**`"linq"` — LINQ in motion.** Runs a query with every operator tapped and replays items flowing
through each stage, showing streaming (`Where`, `Select`) against buffering (`OrderBy`, `GroupBy`).
```json
"linq": { "source": "new[] { 5, 3, 8, 1 }", "query": ".Where(n => n > 2).OrderBy(n => n)", "setup": "record Order(string Name);" }
```
`setup` is optional C# type declarations. At most 8 operators; keep sources to about a dozen items.

### mcq — multiple choice
```json
{ "type": "mcq", "prompt": "Which ...?", "code": "optional code shown under the prompt",
  "options": ["A", "B", "C"], "answer": 0, "explain": "Why." }
```
`answer` is the zero-based index of the correct option, or an array of indexes for
"select all that apply". Options are shuffled unless `"shuffle": false`.

### predict — type what the program prints
```json
{ "type": "predict", "prompt": "What does this print?", "code": ["int x = 2;", "Console.WriteLine(x * 3);"],
  "answer": "6", "accept": ["6.0"], "explain": "..." }
```
`answer` must be the exact output (case matters; trailing whitespace does not). `accept` lists
other answers to allow. `dojo validate` runs the code and fails if it does not print `answer`.
If the code reads input, give it `"stdin"`. If the code is a fragment that cannot run on its own,
add `"verify": false`.

### order — drag lines into the right order
```json
{ "type": "order", "prompt": "Arrange the lines so that ...", "lines": ["line 1", "line 2", "line 3"],
  "also": [["line 2", "line 1", "line 3"]] }
```
`lines` is the correct order; the app shuffles them. Leading spaces are kept, so indent as real code.
There must be exactly one correct order unless you list the others in `also`. Two identical lines are fine.

### blanks — drag tokens into gaps in code
```json
{ "type": "blanks", "prompt": "Complete the loop.", "code": ["for (int i = 0; i __1__ 3; i__2__)", "    Console.WriteLine(i);"],
  "blanks": ["<", "++"], "bank": ["<=", "--", "=="] }
```
`__1__`, `__2__`, ... mark the gaps; `blanks[0]` fills `__1__`. An entry may be an array of
acceptable tokens (`["<", "!="]`); the first one goes in the bank. `bank` adds wrong tokens.

### match — drag each answer onto its partner
```json
{ "type": "match", "prompt": "Match each type to a value it can hold.",
  "pairs": [["`int`", "`42`"], ["`string`", "`\"hi\"`"], ["`bool`", "`true`"]] }
```
Left sides stay put, right sides are shuffled. Right sides must be unique. 3 to 6 pairs.

### sort — drag items into buckets
```json
{ "type": "sort", "prompt": "Value type or reference type?", "buckets": ["Value type", "Reference type"],
  "items": [["`int`", 0], ["`string`", 1], ["`bool`", 0], ["`List<int>`", 1]] }
```
Each item is `[label, bucketIndex]`. 2 to 4 buckets, 4 to 8 items.

### code — write and run real code
```json
{
  "type": "code",
  "mode": "write",
  "title": "Sum to n",
  "prompt": "Markdown description of the task, with an example.",
  "starter": "what the editor starts with",
  "solution": "reference solution; `dojo validate` proves it passes",
  "hints": ["...", "..."],

  "tests":    [{ "name": "adds two numbers", "stdin": "2\n3\n", "expect": "5" }],
  "template": ["{{CODE}}", "Dojo.Eq(\"Add(2, 3)\", 5, Add(2, 3));"],
  "require":  [{ "pattern": "\\bforeach\\b", "message": "Uses a foreach loop" }],
  "forbid":   [{ "pattern": "\\.Sum\\(", "message": "Does not call Sum()" }]
}
```
`mode` is `"write"` (default) or `"fix"` (the starter is broken code to repair).

There are three ways to grade, and they combine:

1. **`tests`** — the learner writes a whole program. Each test runs it with `stdin` and compares
   what it prints to `expect` (or checks it contains `expectContains`). Trailing whitespace is
   ignored. Use this for early lessons and anything about console input/output.

2. **`template`** — a hidden harness wrapped around the learner's code. `{{CODE}}` must sit on a
   line of its own. The harness calls the helpers below; each call becomes one row in the results.
   Use this when the learner writes a method or a type rather than a program.

   C# requires top-level statements to come *before* type declarations, so:
   - learner writes **methods** (top-level functions): put `{{CODE}}` **first**, then the checks.
   - learner writes **classes, records, structs, enums, interfaces**: put the checks **first**, then `{{CODE}}`.

   Tell the learner the exact names and signatures the harness expects.

3. **`require` / `forbid`** — regexes tested against the source with comments and string contents
   removed. Each rule shows as a results row labelled with `message`.

With no `tests` and no checks in a template, the step passes when the program compiles and exits cleanly.

Harness helpers (class `Dojo`, always available):

| Call | Passes when |
|---|---|
| `Dojo.Eq("name", expected, actual)` | values are equal; sequences compare item by item |
| `Dojo.Check("name", condition, "detail shown on failure")` | the condition is true |
| `Dojo.Throws<TException>("name", () => ...)` | the action throws that exception type |
| `Dojo.Capture(() => ...)` | returns the text the action printed (use inside `Eq`) |
| `Dojo.Try("name", () => { ... })` | runs a block; an exception becomes one failed row instead of a crash |
| `await Dojo.ThrowsAsync<TException>("name", async () => ...)` | awaiting the action throws that exception type |
| `await Dojo.TryAsync("name", async () => { ... })` | async version of `Try` |

Name each check as the learner would read it: `"Add(2, 3) returns 5"`, not `"test1"`.

Things that catch authors out:

- `Dojo.Eq` needs both sides to have the same static type. To compare against a `List<int>`, write
  the expected value as `new List<int> { 2, 4 }`, not `new[] { 2, 4 }`.
- `Dojo.Try` adds no row when its body succeeds, only when it throws. Put a `Dojo.Eq` or
  `Dojo.Check` inside it.
- Harness variables share a scope with the learner's top-level code. Prefix yours (`dojoInput`)
  where a clash is plausible.
- Learner methods are top-level local functions, which C# does not allow to be overloaded. To
  exercise overloads, have the learner write a static class.
- Output comparison ignores trailing spaces on each line and blank lines at the end. Leading and
  interior spaces count.
- A `require` / `forbid` regex sees code inside the `{ }` of an interpolated string, but not the
  contents of ordinary strings or comments.
- In a table cell, write a literal pipe as `\|`.

## Topics in the learning center

Every track is a topic card on the home page. `category` (e.g. "Programming", "Security") is shown above
the title, `icon` is a short string or emoji, and `order` sorts the cards. A topic does not have to be about
a programming language: set `"language": "csharp"` anyway when its exercises run C# (the certificates topic
does, to drive `System.Security.Cryptography`).

## Projects

A project is a module whose `module.json` has `"kind": "project"`. It appears under **Projects**
instead of on the lesson map. Its lesson files are **stages** of one growing program.

```json
{ "kind": "project", "title": "Tasks API", "summary": "...",
  "level": "After module 4.", "skills": ["Minimal APIs", "Validation"] }
```

Name the folder `pNN-name` (for example `p01-tasks-api`) and the stages `01-...json`, `02-...json`.
`tracks/csharp/p01-tasks-api/01-hello-http.json` is the reference stage.

A stage is an ordinary lesson: a briefing `learn` card, a few quick steps to teach what the stage
needs, and one to three `code` steps that grow the program. Two extra fields on a `code` step:

- `"carry": true` — the editor opens with the learner's own passing code from the previous code
  step of the project, not with `starter`. Still give a `starter`: it must be exactly the previous
  code step's `solution`, so the step is solvable on its own (and it is what a learner who jumps in
  gets). Every `solution` is the whole program so far.
- `"framework": "web"` — compile against ASP.NET Core and test over HTTP (below). `"web+efcore"` adds EF Core.

Write each prompt as a small spec: the endpoints or behaviour to add, with example requests and
responses. Say what must keep working. Later stages re-test earlier behaviour.

### Web steps (`"framework": "web"`)

The learner writes a real `Program.cs` with top-level statements that ends in `app.Run();`. The
dojo starts it on a private loopback port, waits until it listens, and calls
`DojoTests.Run(HttpClient http)` from your template against the live server:

```json
"template": [
  "{{CODE}}",
  "static class DojoTests",
  "{",
  "    public static async Task Run(HttpClient http)",
  "    {",
  "        var r = await http.GetAsync(\"/health\");",
  "        DojoWeb.Status(\"GET /health responds 200 OK\", 200, r);",
  "        Dojo.Eq(\"GET /health returns ok\", \"ok\", await DojoWeb.Text(r));",
  "    }",
  "}"
]
```

`{{CODE}}` comes first and `DojoTests` after it. The learner's own types (records, classes,
interfaces) go at the bottom of their code, after `app.Run();`, which is where C# requires them.

Helpers for web tests, on top of the `Dojo` ones:

| Call | Does |
|---|---|
| `DojoWeb.Status("name", 201, response)` | one row: the status code is 201 |
| `await DojoWeb.Text(response)` | the body as text |
| `await DojoWeb.Json(response)` | the body as a `JsonElement` (default if not JSON) |
| `DojoWeb.Prop(json, "title")` | a property as a string, case-insensitive, `null` if missing; numbers and booleans come back as raw JSON text (`"1"`, `"true"`) |

`http` has the base address set, so use relative URLs. Send JSON with
`http.PostAsJsonAsync("/tasks", new { title = "x" })`, `PutAsJsonAsync`, `DeleteAsync`, or a
`StringContent` when you need to send something malformed. Add headers per request with
`new HttpRequestMessage(HttpMethod.Get, "/tasks") { Headers = { { "X-Api-Key", "secret" } } }`.

Rules for web steps:

- Implicit usings add `Microsoft.AspNetCore.Builder`, `.Http`, `.Mvc`, `.Routing`,
  `Microsoft.Extensions.DependencyInjection`, `.Hosting`, `.Logging`, `System.Net`,
  `System.Net.Http`, `System.Net.Http.Json` and `System.Text.Json`.
- Only what ships in the ASP.NET Core shared framework is available: minimal APIs, DI, middleware,
  configuration, logging, `System.Text.Json`. No other NuGet packages (no Swagger), with one exception:
  `"framework": "web+efcore"` adds EF Core with SQLite (next section). Otherwise store data in memory.
- The server starts fresh for every check, so tests must create the data they rely on and must not
  assume ids beyond what the stage's spec promises (for example "the first task created gets id 1").
- One uncaught exception in `DojoTests.Run` ends the tests with a single failed row. Guard reads
  that can fail (use `DojoWeb.Prop`, which never throws) and wrap groups in `await Dojo.TryAsync`.
- Do not test timing. Do not rely on `DateTime.Now` values, only on their presence if needed.
- The Run button is hidden on steps with a template, so the prompt should tell the learner that
  **Run checks** starts the server and calls it.

### EF Core steps (`"framework": "efcore"`)

`"framework": "efcore"` compiles a step against EF Core and SQLite (`Microsoft.EntityFrameworkCore.Sqlite`,
the version the server ships with) and makes it run; `"web+efcore"` combines it with a web step. It applies
to `code` and `predict` steps. A track can set a default for all its C# steps in `track.json`
(`"framework": "efcore"`, as `tracks/efcore` does); a step's own `framework` wins, and "Try it" on learn-card
samples uses the track default.

- Extra implicit usings: `Microsoft.EntityFrameworkCore` (+ `.ChangeTracking`, `.Diagnostics`, `.Infrastructure`,
  `.Metadata.Builders`, `.Migrations`, `.Storage.ValueConversion`), `Microsoft.Data.Sqlite`,
  `System.ComponentModel.DataAnnotations` (+ `.Schema`), and for console steps `Microsoft.Extensions.Logging`
  and `Microsoft.Extensions.DependencyInjection`.
- Every run starts in a fresh, empty folder, so `UseSqlite("Data Source=library.db")` plus
  `Database.EnsureCreated()` always starts from an empty database. Steps with several `tests` reuse the folder
  between runs: call `EnsureDeleted()` first, or prefer one template run. For a database that lives only in
  memory, keep one open `SqliteConnection("Data Source=:memory:")` and pass it to `UseSqlite(connection)`.
- To show SQL deterministically, log only executed commands (plain `LogTo(Console.WriteLine)` includes
  timings): `.LogTo((id, level) => id == RelationalEventId.CommandExecuted, e => Console.WriteLine(((CommandExecutedEventData)e).Command.CommandText.ReplaceLineEndings(" ")))`.
  `ToQueryString()` shows one query without running it. Both are fine in `predict` answers.
- Methods called inside a query must not be local functions (expression trees cannot reference them); put
  them in a `static class`. SQLite stores `decimal` as text and cannot sort by it: use `int` cents or `double`.
- In web+efcore templates, tests can count the SQL commands a request runs by subscribing to the
  `Microsoft.EntityFrameworkCore` `DiagnosticListener` (see `tracks/efcore/p01-library-api`).
- EF Core programs JIT a large library and build a model before the first query (about 1 to 1.5 s of CPU),
  so their CPU limit is 8 seconds instead of 4.
- `dotnet ef` cannot run in a step; migrations can still be written by hand (with `[DbContext]` and
  `[Migration]` attributes) and applied with `Database.Migrate()`. Ignore
  `RelationalEventId.PendingModelChangesWarning` when there is no model snapshot.

## Tracks in Python, JavaScript or TypeScript

Set `"language"` in `track.json` to `"python"`, `"javascript"` or `"typescript"`. Code steps then run
in that language with the machine's own toolchain (Python 3, Node.js; TypeScript runs through Node,
which strips the types without checking them). The step format is the same as C#:

- `tests` with `stdin` / `expect` / `expectContains`, compared the same way.
- `require` / `forbid` regexes, tested with comments removed (string contents are NOT removed here).
- `template` with `{{CODE}}`, calling the same helpers, spelled for the language:

| | Python | JavaScript / TypeScript |
|---|---|---|
| equal | `Dojo.eq("name", expected, actual)` | `Dojo.eq('name', expected, actual)` (compared as JSON, so arrays and objects work) |
| condition | `Dojo.check("name", ok, "detail")` | `Dojo.check('name', ok, 'detail')` |
| raises | `Dojo.throws("name", ValueError, lambda: f())` | `Dojo.throws('name', () => f())`, `await Dojo.throwsAsync(...)` |
| printed text | `Dojo.capture(lambda: f())` | `Dojo.capture(() => f())` |

Put `{{CODE}}` first and the checks after it. `predict` steps run in the track's language too.
The `--puzzles` alternative-answer search only runs for C#. The learner's line numbers in error
messages are correct; the one-line helper prelude is accounted for.

## The runtime

- Learner code is compiled as C# (latest) with nullable enabled, as a top-level-statements program.
- These usings are implicit: `System`, `System.Collections.Generic`, `System.IO`, `System.Linq`,
  `System.Text`, `System.Threading`, `System.Threading.Tasks`.
- Only the base class library is referenced. No NuGet packages (except EF Core for `"framework": "efcore"` steps).
- Culture is fixed to `en-US`, so number and date formatting is predictable.
- A run is stopped after 4 seconds of CPU time, or 15 seconds on the clock (the generous clock limit
  is deliberate: security scanners sometimes pause a new program for several seconds). Keep delays
  that actually elapse to 50 ms or less. When one side of a race is meant to lose and be abandoned
  or cancelled, make it long (2 seconds or more): it costs no time, and a thin margin such as 5 ms
  against 50 ms fails on a busy machine.
- Output must be deterministic: no `DateTime.Now`, no unseeded `Random`, no thread-order-dependent printing.
- Compiler errors report line numbers in the learner's own code, not the harness.

## Shape of a good lesson

- 8 to 12 steps, about 10 minutes. Never two `learn` cards in a row without an exercise between them.
- Mix the types: at least one drag-and-drop step (`order`, `blanks`, `match`, `sort`), at least one
  `predict` or `mcq`, and at least one `code` step. End on a `code` step that uses the whole lesson.
- Difficulty climbs inside the lesson: recognise, then complete, then write.
- A boss lesson is 3 to 5 `code` steps of rising difficulty that combine the module, with at most
  one short `learn` card to set the scene.
- Teach one idea per card, with a concrete example. Say why the feature exists, not only what it does.

### Learn it first: prerequisite lessons

A stage (or any lesson) may list the lessons that teach what it needs:

```json
{ "title": "Stage 5: Querying", "prereqs": ["csharp/06-generics-and-linq/03-linq-basics"], "steps": [ ... ] }
```

They show as chips above every step (a tick when already finished). Clicking one opens that lesson even
if it is still locked, with a banner and a Back to the project button that returns to the exact step the
learner left; their code is kept. Use full keys (track/module/lesson) that exist; 1 to 4 per stage.

### Blueprints

A project's `module.json` may carry a `blueprint`: the finished application's architecture. The Projects
page draws it in layers and lights each part up when the stage that builds it is finished.

```json
"blueprint": {
  "layers": ["Client", "Pipeline", "Endpoints", "Services", "Data"],
  "parts": [
    { "id": "list", "label": "GET /tasks", "layer": "Endpoints", "stage": 2, "note": "optional one-liner" }
  ],
  "flow": [["list", "store"]]
}
```

`stage` is 1-based. `flow` draws arrows between parts. A blueprint whose layers include `Endpoints` also
gets a "Run my code in the Workbench" button, which opens the learner's latest passing stage as a live app.

## Building a real artifact

Every topic can quietly assemble a real, usable artifact (a tool, a service, a script kit, a database) from the
learner's own passing code. The learner sees it as a dream on the topic page, watches its pieces light up as they
pass lessons, and finds it under **Builds** (`#/builds`), where they can open it as a Code space or download a
.zip. `tracks/git` is the reference: it builds **gitkit**, a .NET tool with real Git hooks. The full plan for every
topic is in `docs/CURRICULUM.md`.

### Declare the artifact in `track.json`

```json
"artifacts": [
  {
    "id": "gitkit",
    "title": "gitkit",
    "icon": "⎇",
    "kind": "dotnet-console",
    "pitch": "Your own Git sidekick: a command-line tool that refuses sloppy commit messages ...",
    "summary": "One line for lists.",
    "features": ["`gitkit lint-msg`: a commit-msg hook that enforces the 50/72 rules", "..."],
    "preview": { "type": "terminal", "frames": [ { "cmd": "gitkit hash-object README.md", "out": ["ce0136..."] } ] },
    "run": "dotnet run -- help",
    "template": {
      "gitkit.csproj": ["<Project Sdk=\"Microsoft.NET.Sdk\">", "..."],
      "Program.cs": ["return GitKit.Kit.Run(args);"],
      "Lint.cs": ["// a stub until the learner writes it", "..."]
    }
  }
]
```

| Field | Meaning |
|---|---|
| `id` | Unique across all tracks; 1-40 letters, digits, `-` or `_`, starting with a letter. Also the Code space name. |
| `kind` | `dotnet-console`, `dotnet-web`, `python`, `node`, `shell`, `sql`, `docs` or `infra`. Picks the kind of Code space it opens as (`shell`, `sql`, `docs`, `infra` open as plain folders). |
| `pitch`, `features`, `preview` | The dream reveal: shown big on the topic page and before the topic's first lesson, then as a compact header. `preview` may hold `frames` (a terminal session typed out), `demo` (Markdown, usually a fenced code block) and/or `image` (a path under the track folder, e.g. `assets/kit.png`; .png .jpg .gif .webp .svg). |
| `run` | How to run the finished thing; shown on the Builds page. |
| `template` | Every file that is not a lesson piece: project files, the host program, README, and a **stub for every piece** so the artifact builds and runs at every stage. Each value is a string or an array of lines. Paths are relative, use `/`, and may not use `..`, `.git` or absolute paths. |

### Mark the pieces on code steps

Any code step, in any language (C#, Python, TypeScript, SQL), can add a piece:

```json
{ "type": "code", "title": "A commit message linter", ...,
  "build": { "artifact": "gitkit", "file": "Lint.cs", "title": "Commit message linter",
             "unlocks": "gitkit lint-msg now refuses sloppy commit messages.",
             "transform": ["namespace GitKit;", "", "public static partial class Kit", "{", "    {{CODE}}", "}"] } }
```

- When the learner passes the step, their code (after `transform`) is saved as the newest version of `file`.
  Revealing the solution does not count.
- `transform` (optional) wraps the code into a real file: `{{CODE}}` marks where it goes, and when `{{CODE}}` is
  indented every line of the code gets that indent. Use it to put a learner's top-level methods into a class.
- `mode`: `replace` (default) or `append` (adds to what the template and earlier pieces left in the file).
- `stub` (optional): what the file holds until the piece is earned, when the template does not have the file.
- `unlocks` (optional): one line for the "piece added" toast.
- **Pieces grow by replacement.** Several lessons may build the same file with `replace`; pieces apply in teaching
  order (lesson key, then step), so a later lesson's version replaces an earlier one. That is intended. `dojo
  validate` only warns when two steps of the *same* lesson replace the same file, or when a `replace` wipes what
  earlier steps appended.
- The template's stub and the learner's piece must expose the same names, so the host compiles either way. In
  gitkit, `Kit.cs` calls `Lint(...)`; the stub throws "not built yet, pass lesson X" and the piece does the work.

### Dreams: let the learner choose

Instead of one fixed artifact, a track may offer 4 to 5 **dreams**: themes over one shared skeleton. The learner
picks one on the topic page (the profile from the welcome questions suggests one) and can change it later; every
dream keeps its own pieces, and pieces carry over to the new dream when its skeleton has the same file.

```json
"dreams": [
  { "id": "sidekick", "title": "Sidekick", "icon": "◆", "pitch": "...", "tags": ["productivity", "web"],
    "needs": ["docker"], "preview": { ... }, "lexicon": { "App": "Sidekick", "item": "task" },
    "artifact": { "kind": "dotnet-web", "template": { ... }, "run": "dotnet run --project src/sk" } }
]
```

- The first dream is the flagship and the default. The dream's `id` is its artifact id.
- **Coming soon**: `{ "id": "pantry", "title": "Pantry", "icon": "◇", "pitch": "...", "soon": true }` announces a
  dream that is not built yet. The picker shows it greyed out with "Coming soon"; it needs no `artifact`, is never
  suggested or chosen, and `dojo validate` skips it. A track with one real dream plus coming-soon ones does not get
  the "declare 4 or 5" warning.
- `tags` match the interests in the learner's profile; `needs: ["docker"]` lowers it for Windows-only learners.
- A build marker for the chosen dream says `"artifact": "@dream"` (or leaves `artifact` out).
- **Lexicon**: `{{key}}` in a step's title, prompt, starter, solution, template, tests, explain, hints, a learn
  card's body and `build.file` / `build.title` is replaced from the chosen dream's `lexicon`. `{{CODE}}` and unknown
  keys are left alone.
- **Variants**: when wording is not enough, a step carries `"variants": { "<dreamId>": { ... } }`. A variant
  overrides any of `prompt`, `starter`, `solution`, `tests`, `template`, `require`, `forbid`, `hints`, `explain`,
  `title`, and the piece's `file`, `transform`, `stub`, `unlocks` (or a nested `"build": { ... }`). The server
  serves and grades the version for the learner's dream, so tests always match the prompt shown.
- `dojo validate` checks every step once per dream, so every variant's reference solution must pass.

### What `dojo validate` checks

Artifact and dream ids are valid and unique, `kind` is known, template paths are safe and values are text,
preview images exist in the track folder, every marker names a declared artifact (or a dream track for `@dream`),
marker files are safe paths, variants name real dreams, and each reference solution passes for every dream.
It warns when an artifact has no pitch, no `run`, or no lesson that builds it.

### Export

"Open as a Code space" writes the template plus the learner's pieces into a space named after the artifact. The
space remembers the hash of every file it wrote. A file the learner has edited in the space since is never
overwritten: the new version is written beside it as `name.dojo-new`. "Download as .zip" gives the same files.

## Pacing: prove it, keep it

Learners must not rush through. Four fields make them prove a skill, come back to it, and see their earlier work
reused (the plan is `docs/CURRICULUM.md` 1.2 and 3.4-3.5; the engine is `server/Pacing.cs` and `ui/pacing.js`).
Every field is optional: a track without them behaves exactly as before.

### `uses`: call the learner's earlier pieces

A code step lists earlier pieces its code depends on, either inside its `build` or on the step itself (a review
step that builds nothing):

```json
{ "type": "code", "title": "Weekly report", "...": "...",
  "template": ["{{CODE}}", "Dojo.Eq(\"Report\", \"2h 05m\", Report(entries));"],
  "build": { "file": "src/Sidekick.Core/Report.cs", "uses": ["src/Sidekick.Core/Duration.cs"] } }
```

| Entry | Means |
|---|---|
| `"src/Core/Journal.cs"` | that file of the artifact this step builds (its `build.artifact`, else the learner's dream, else the track's only artifact) |
| `"gitkit:Lint.cs"` | that file of artifact `gitkit` in this track |
| `"csharp/sidekick:src/X.cs"` | that file of artifact `sidekick` in track `csharp` |
| `"csharp/@dream:src/X.cs"` | that file of whichever dream the learner builds in `csharp` |

- Lexicon tokens work in entries (`"src/{{App}}.Core/Duration.cs"`).
- When the step is checked, the learner's **current** version of each file (template, stub, then their pieces, each
  wrapped by its own step's `transform`, as the artifact assembles them) is compiled with their code: C# as an extra
  source file, Python as a module beside `main.py` (on `sys.path`), JavaScript/TypeScript as a sibling file at the
  same relative path, SQL run after the step's `setup`.
- **C#: the step's own code is wrapped too.** A C# step with `uses` and a `build.transform` is compiled the way the
  artifact compiles: the learner's code goes inside its own transform as a separate file (so members of one
  `static partial class Game` from several pieces meet), and the `template` becomes only the harness. Its
  `{{CODE}}` is left empty, so the checks call **through the wrapper**: with
  `"transform": ["namespace Delve;", "public static partial class Game", "{", "    {{CODE}}", "}"]` the template
  says `Dojo.Eq("Potion(5)", 25, Delve.Game.Potion(5));` (Sidekick: `Sidekick.Sk.Format(...)`). Members therefore
  need an access level the harness can reach (`public static` or `internal static`). The learner's code can call
  the earlier members directly (`Heal(hp)`), exactly as in the finished artifact. Compiler errors keep the learner's
  own line numbers. Add `"wrap": false` to the step to put the code at `{{CODE}}` as usual instead (then the template
  must reach the pieces by their full names).
- **`uses` replaces given copies.** Before `uses` existed, steps pasted a reference copy of earlier pieces into their
  `template` or `starter` as given code. With `uses`, delete those copies: the engine supplies the piece (the
  learner's or the reference one), and a second copy is a duplicate definition that does not compile (`dojo
  validate` reports it as "reference solution does not pass").
- A piece the learner has not earned (or only has in an older version than the one this step expects) is replaced
  by the **reference** version: the `solution` of the step that builds it, after that step's `transform`. The
  results say so ("Using the reference version of Duration.cs").
- If the learner's own piece is broken, the review fails. That is the point: fix the earlier piece.
- Rules (`dojo validate`): every entry must be built by a step **earlier in teaching order** (lesson key, then
  step), never the step's own `build.file`, and the reference solution must pass with the reference pieces.
  Pieces must compile together with the step: no top-level statements in a used C# piece, unique type names.

### `cold`: rebuild it from memory

```json
{ "type": "code", "title": "Cold rebuild: Duration.Format", "cold": true, "timeLimit": 300,
  "prompt": "Write `static string Format(int seconds)` again, from memory.", "solution": "...", "template": ["..."] }
```

- `"cold": true` on a code step (or on the lesson object, for every code step in it): the editor starts empty
  (`starter` and `carry` are ignored), hints and "Show solution" are hidden, autocomplete is off, the step cannot be
  skipped and no draft is kept. The server strips `starter`, `hints` and `solution` before the page gets the lesson;
  grading uses the full step. The UI frames it as "Cold rebuild: from memory".
- `"timeLimit"` (seconds, 10-3600, cold steps only): a gentle timer. Going over never fails the step; it counts as one
  mistake for the lesson's stars.
- `"coldOf": "csharp/02-methods/04-duration#6"` (step number counting from 1): the cold step borrows `tests`,
  `template`, `require`, `forbid`, `setup`, `check`, `stateQuery`, `framework`, `stdin`, `solution`, `uses`,
  `prompt` and `title` from that step, so the two never drift apart. Fields written on the cold step win. A
  `coldOf` step is cold automatically; passing it marks the original piece as proven from memory. It does not
  rebuild the piece (it has no `build`).
- Put one short cold step (one piece) in each module, just before the boss. Leave `hints` out: they are hidden anyway.

### `gate` in `module.json`: prove it to unlock the next module

```json
{ "title": "Methods and collections",
  "gate": { "requires": ["boss"], "minStars": 2, "cold": ["055-cold-rebuild"] } }
```

| Field | Meaning |
|---|---|
| `requires` | `"boss"` (every boss lesson of this module), lesson ids of this module, or full `"track/module/lesson"` keys. Each must be finished with at least `minStars`. |
| `minStars` | 1-3, default 1. Learners whose profile says "build things for myself" get 1 (relaxed); the cold check still counts. |
| `cold` | Lesson ids (or `"lesson#N"` for one step) whose cold steps must be passed. A lesson with no cold step counts when finished (and `dojo validate` warns). |
| `boss` | Older form: `"boss": { "minStars": 2 }` means `"requires": ["boss"], "minStars": 2`. |

- Until a module's gate is proven, **every later module** on the map stays locked (lessons already finished stay
  open). The map shows a gate card after the module: "Prove it to unlock Module 4", what is still needed, links.
- Free roam (Profile) still opens everything; the gate card then says "not yet proven".
- **Spaced re-proof**: when a gate is first proven, the module's first cold step (from `gate.cold`, else any cold step
  in the module) comes back in Practice after 3 and 10 days as "Can you still do it?". Passing within three runs
  keeps it proven; "I cannot remember it yet" or failing marks the module **rusty** (amber on the map) until a
  re-proof passes. Nothing is locked by rust.
- **Rush detector** (no field): a lesson finished in under 35% of its `minutes` while using at least
  max(2, exercises / 4) hints and answer reveals gets a kind nudge on the summary ("You moved fast: try the cold
  rebuild?"), earns no quest progress, and queues the module's cold step for tomorrow. It never blocks. So give
  every lesson an honest `minutes`.

### What `dojo validate` checks for pacing

`uses` entries resolve to a piece built earlier and the reference solution passes with the reference pieces;
`cold`, `timeLimit` and `coldOf` sit on code steps, `timeLimit` is 10-3600 and `coldOf` points at a code step; a cold
step with hints is a warning; every gate's lessons exist, a gate that asks for the boss has one, `minStars` is 1-3,
and its `cold` lessons have a cold step.

### The learner profile file

The welcome answers are kept in `.state/profile.json` (`GET`/`PUT /api/profile`) as well as in the progress file
(`state.profile`, the cache). The newer of the two wins on load. Reordering "Your path" on the home page (Reorder,
then drag or the arrows) saves `path` to the profile.
