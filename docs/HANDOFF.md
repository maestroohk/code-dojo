# Handoff: picking this up on another machine

Last updated 2026-11-26. Read this first, then `docs/CURRICULUM.md` (the plan) and `tracks/AUTHORING.md` (the content format).

## 1. Get the code

```powershell
git clone https://github.com/maestroohk/code-dojo.git
cd code-dojo
git checkout learning-center
```

`main` and `learning-center` hold the same commits. Do the work on `learning-center`, then fast-forward `main` with `git push origin learning-center:main`.

Prerequisites:
- .NET 10 SDK.
- Optional, for some languages and labs: Python 3, Node 20+, Java and Docker Desktop.
- In the app, the data science setup button creates its own Python venv.

## 2. What was pushed without full verification

The last two commits went up **before the full content check finished**, because the first machine was too heavily loaded to finish it.

| Commit | What | Checked so far |
|---|---|---|
| `Pacing: prove it, keep it` | Pacing engine: `uses`, cold steps, module gates, re-proof, rush detector, profile.json, More menu | All 341 xUnit tests pass. `validate auth`, `cicd` and `crypto` give 0 errors. `fundamentals` gave 0 errors in the author's own run. |
| `C# builds Sidekick` | The whole C# track rewritten so lessons assemble **Sidekick**, a real CLI tool (`sk`) | The author's run of `validate csharp/` gave 0 errors over 131 lessons and 312 code exercises. Sidekick, assembled from the lesson solutions, builds at all 62 stages, runs and packs. |

**Not yet verified:**
- `validate` on the remaining tracks against the new engine.
- Clicking through the new C# lessons in the browser.

## 3. Finish the verification (do this first)

Close heavy apps (Rider, other builds) first. Grading runs with CPU and wall-clock limits, so a loaded machine makes timing checks flaky. One async lesson checks cancellation timing ("jobs waiting for a slot never start once cancelled"); if it fails only under load, rerun it before you treat it as a bug.

Stop any running dojo server before building, because it locks `server/bin`.

1. Build the server:

   ```powershell
   dotnet build server
   ```

2. Run the tests:

   ```powershell
   dotnet test tests/CodeDojo.Tests
   ```

3. Validate one track at a time. This is faster to diagnose than one long run. A run from the repo root:

   ```powershell
   foreach ($t in 'fundamentals','csharp','datascience','design','docker','dsa','editors','efcore','git','integration','kubernetes','linux','networking','pki','python','sql','typescript') { "== $t"; dotnet run --project server --no-build -- validate $t | Select-String 'errors' }
   ```

Expected result: `0 errors` for every track. `csharp` gives 1 warning ("a dream is a choice: declare 4 or 5"); that is expected until more dreams are added.

If a track fails:
- Run `dotnet run --project server --no-build -- validate <track>` without the filter to see the lesson and step.
- Fix the content (or the engine, if the error is in a field described in AUTHORING.md under "Pacing: prove it, keep it").
- Commit, then push to both branches.

### 4. Click through in the browser

```powershell
dotnet run --project server
```

Open the printed URL and check the following:

**C# map**
- Each module ends with a "Prove it to unlock Module N" gate card.

**C# Module 1, first lesson**
- Its build step adds the first Sidekick piece.
- **Builds** shows Sidekick growing.

**Cold rebuild lesson** (for example *01 First steps → Cold rebuild*)
- The editor starts blank.
- There are no hints and no "Show solution".
- The timer runs.

**More ▾ menu**
- It opens Workbench, Code spaces, Databases, Playground, Features and Profile.

**Testing without touching real progress**
- Point the server at a copy of your progress:

  ```powershell
  $env:DOJO_STATE = "$env:TEMP\dojo-state-copy"
  ```

  Then run the server.

## 5. Known issues and decisions

- **`sk.exe` "Access is denied":** on the work machine, the installed tool launcher was blocked by policy. The workaround is `dotnet <tool-path>\...\sk.dll`. Try a normal local install at home, and do not install it globally unless you want to: `dotnet tool install Sidekick.Dojo --tool-path .\sk-tools --add-source <nupkg folder>`. The track's last lesson (`08/10-ship-sk`) teaches packing it.
- **C# review steps still paste earlier pieces** instead of using `uses`. Switching needs these changes, all in the same edit per step:
  - Rewrite the tests to call through `Sidekick.Sk.X`.
  - Make the pieces `internal static`.
  - Remove the pasted copies.

  See CURRICULUM.md §6.
- **Confidentiality:** the integration/ESB track teaches generalized concepts only. Never add employer names, internal service names, hosts or credentials to this public repo.
- **Untested:**
  - SQL Server and MySQL engines in Databases (these need Docker images).
  - (Next.js is now verified, see below.)
- **npm registry "blocked" on some networks:** it was IPv6, not a block. DNS gave IPv6 addresses that do not route, and .NET tried them one by one, so the dojo's 8-second check gave up while npm itself (Node tries IPv4 and IPv6 in parallel) worked. Registry calls now use `HappyEyeballs` (server/HappyEyeballs.cs). If a network still really blocks npm, the message says so and points at `npm config get registry` mirrors.
- **Next.js:** verified end to end on 2026-11-26 (Next 16.4.6): install, `next dev` with hot reload, Stop, `next build` (TypeScript errors land in Problems), `next start`. The dojo passes `--hostname 127.0.0.1` to plain `next dev` / `next start` scripts: Next blocks its hot-reload socket for any origin other than localhost or its own hostname, and the default listens on every interface.

## 6. What comes next (the plan, in order)

Per `docs/CURRICULUM.md` §4 rollout:

1. **Wave 1, continuing:**
   - PKI → **Keystone**
   - Networking → **netdoc**
   - Linux + editors → **Dotfiles**
   - Git → **gitkit**

   For each: declare the dream in track.json, add `build` steps to the lesson code steps, add a cold-rebuild lesson and a `gate` per module, then validate.
2. **Wave 2:**
   - SQL/EF Core
   - Data science (**Money Lens**)
   - Integration (**Relay**)
   - Crypto
3. **Wave 3:** the remaining topics.
4. Add 3–4 more dreams per topic (or `"soon": true` placeholders) so the onboarding picker offers 4–5 choices.
5. Keep `ui/features.js` (page `#/features`) current in the same commit as each feature.

**How the C# conversion was done.** It is the template for the remaining topics:
- One lead agent defined the artifact's file contract and reference pieces.
- Parallel helpers each converted one or two modules against that contract.
- The lead then assembled the artifact only from the lessons' own solutions, to prove the pieces really fit together.
