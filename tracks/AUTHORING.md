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
- `"framework": "web"` — compile against ASP.NET Core and test over HTTP (below).

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
  configuration, logging, `System.Text.Json`. No NuGet: no EF Core, no Swagger. Store data in memory.
- The server starts fresh for every check, so tests must create the data they rely on and must not
  assume ids beyond what the stage's spec promises (for example "the first task created gets id 1").
- One uncaught exception in `DojoTests.Run` ends the tests with a single failed row. Guard reads
  that can fail (use `DojoWeb.Prop`, which never throws) and wrap groups in `await Dojo.TryAsync`.
- Do not test timing. Do not rely on `DateTime.Now` values, only on their presence if needed.
- The Run button is hidden on steps with a template, so the prompt should tell the learner that
  **Run checks** starts the server and calls it.

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
- Only the base class library is referenced. No NuGet packages.
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
