# Writing lessons

A track is a folder. Nothing is registered anywhere: drop files in and refresh.

```
tracks/
  csharp/
    track.json                    { "title", "language", "tagline" }
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
