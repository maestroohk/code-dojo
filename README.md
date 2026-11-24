# code-dojo

A local, gamified workbench for learning to program. The first track is C#, from `Console.WriteLine` to expression trees: 8 modules, 50 lessons, 125 coding exercises.

Everything runs on your machine. Your code is compiled and executed for real, and graded by hidden tests.

## Run it

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download).

```
dojo.cmd
```

It builds on first run, then opens `http://localhost:8378`. The server listens on `127.0.0.1` only.

## What is in it

- **Exercise types:** quiz, predict the output, drag lines into order, drag tokens into gaps, drag to match, drag into buckets, write code, fix the bug.
- **Projects:** multi-stage builds where your code carries forward from stage to stage. The Tasks API project is a real ASP.NET Core service: each check starts your program as a web server on a private port and tests it over HTTP.
- **Typing practice:** every code sample in a lesson has "Type it" (retype it, with a live check of where you went wrong) and "Try it" (edit and run it). Ordering and fill-the-gap puzzles can be answered by typing instead of dragging.
- **Game layer:** XP and levels, a daily goal and streak, combo bonuses, up to three stars per lesson, achievements, and hints that cost a little XP.
- **Practice:** questions you get wrong come back after 1, 3, 7 and 14 days.
- **Playground:** a scratchpad that runs any C# you type.
- **Boss challenges** at the end of every module.

The first lesson of every module is open, so you can start at your level. Profile has a "Free roam" switch to unlock everything.

Progress is saved to `.state/progress.json`.

## Layout

```
server/   ASP.NET Core app: compiles learner code with Roslyn, runs it in a separate process, grades it
ui/       the web app (plain ES modules, no build step, works offline)
tracks/   the lessons, one JSON file each
```

## Adding lessons or a language

Lessons are plain JSON files under `tracks/`. Nothing is registered anywhere: drop a file in and refresh. The format is described in [tracks/AUTHORING.md](tracks/AUTHORING.md).

After any content change, run the self-test. It runs every reference solution through the real grader and checks every predict-the-output answer:

```
dojo.cmd validate
dojo.cmd validate --puzzles
```
