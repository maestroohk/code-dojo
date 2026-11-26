# code-dojo

A local, gamified learning center. Topics are added as the need arises; today there are two:

- **C#**, from `Console.WriteLine` to expression trees, plus real projects (a REST API, a console data tool).
- **Certificates & PKI**: keys, signatures, certificate chains, trust stores, and why TLS says no.
- **Databases with EF Core**: DbContext, modelling, relationships, querying, change tracking, migrations and
  performance, run for real against SQLite, plus a Library API project (ASP.NET Core + EF Core).

Alongside the courses:

- **Labs**: sandboxes with real machinery. The certificate chain lab lets you build roots, intermediates and
  server certificates like building blocks, wire up who signs whom, and watch real `X509Chain` validation
  pass or fail, with fix-it challenges. Every lab has a visual board and a plain form view of the same model.
- **Live network labs** (Labs → Live network labs): ten hands-on networking and security labs (addressing,
  routing, packet capture, DNS, NAT, port scanning, firewalls, TLS, log analysis, SSH hardening). Each lab is
  a small network of Linux containers; open a terminal on any host right in the page, then let the lab check
  your work. Needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) running; the first visit
  offers a one-time build of the tools image. Labs live in `netlabs/labs/<id>/` (`lab.json`, `lesson.md`,
  `docker-compose.yml`, `files/`); progress is saved to `.state/netlabs.json`. The **Live Camel + gateway lab**
  (`23-camel-gateway`, under the Integration heading) runs a real Apache Camel route behind a Kong gateway; its
  first start pulls about 400 MB and builds a Camel image with the jars inside (`image/`), then runs offline.
  A lab may set `ready_seconds` (slow JVM startup) and `download` (shown before the first start).
  The **Live RabbitMQ lab** (`24-rabbitmq-ops`, rabbitmq:4.4.1-management plus a small services image built on
  the tools image) and the **Live Kafka lab** (`25-kafka-ops`, apache/kafka:4.4.0 in KRaft mode) go with the
  Messaging topic.
- **Messaging builder** (`#/labs/msgbuild`, `ui/lab-msgbuild.js`): RabbitMQ and Kafka modes on the shared board,
  driven by pure simulators (`ui/rabbitsim.js`, `ui/kafkasim.js`, tested in Node by `MsgSimTests`).
- **Workbench**: run your own ASP.NET Core apps live inside the dojo. Send them requests (JSON, forms,
  multipart file uploads, custom headers), see the response, the curl command and the C# test for it, and
  watch each request travel through *your* code: the map is drawn from your `Program.cs` (middleware, then
  endpoints) and lights up the path the request took. Run up to four apps at once; they find each other
  through `builder.Configuration["Services:<name>"]`, and the traffic view draws who called whom.
- **Project blueprints**: each project shows the architecture of the finished app, and lights up each part
  as you finish the stage that builds it.

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

## Tests

```
dotnet test
```

The server tests cover content loading, grading, the certificate lab (healthy chains and each kind of
broken one) and the Workbench (two live apps calling each other, multipart uploads, request tracing).

## Layout

```
server/   ASP.NET Core app: compiles learner code with Roslyn, runs it in a separate process, grades it;
          PkiLab.cs (certificate lab), AppHost.cs + CodeOutline.cs (Workbench),
          NetLabs.cs (live network labs: Docker lifecycle, task checks, WebSocket terminal)
netlabs/  the live network labs (labs/) and the shared lab tools image (images/toolbox)
tests/    xUnit tests for the server
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
