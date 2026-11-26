# DevOps-family audit against docs/QUALITY.md

Scope: git, linux, editors, networking, pki, docker, kubernetes, cicd, integration (all lesson titles, learn cards with their command blocks, code-step prompts and solutions, bosses; netlabs/labs/*/lab.json; ui/lab-*.js; ui/app.js lab catalogue). Date context: November 2026.

## Cross-topic findings (they apply everywhere)

- **The hands-on work is almost all C# that models a tool, not use of the tool.** Every code step in git, linux, editors, docker, kubernetes and most of networking asks for a C# function that imitates the tool (`ShortStatus`, `Reset`, `Glob`, `Wc`, `CronMatches`, a vim `Move` engine, `ParseRun`, `Rollout`, `Reconcile`, and so on). Nobody runs a single real `git`, `docker` or `kubectl` command in a graded step. This breaks rule 7 ("labs use real systems ... wherever that is possible on a laptop"), and it is possible here: netlabs already runs Docker containers.
- **Live labs are cut off from lessons.** The 12 Linux missions (netlabs/labs/11-22) and the Camel/Kong lab (23-camel-gateway) are never mentioned in tracks/linux or tracks/integration. Networking cites labs only as plain text ("> **Try it for real:** Live lab 2.", e.g. tracks/networking/04-routing-and-nat/01-routing.json), with no link, and the DNS module never cites lab 04-dns. The step runner (ui/steps.js:23) has no `lab` step type, so a lesson cannot embed or gate on a lab.
- **The visual builders are never linked from a lesson.** "Compose builder", "Kubernetes builder", "Pipeline builder", "Network builder", "Architecture builder" and the "Vim & nano trainer" (ui/app.js:158-178) appear in no lesson. Only the subnet trainer and the PKI chain lab are mentioned. So the topics' core visuals (rule 6) sit outside the learning path.
- **No module has a "senior's toolkit" card** (rule 2). A search for toolkit/cheat sheet/senior found nothing in 57 of the 62 modules reviewed. The commands exist, but they are scattered across cards.
- **The "debugging" exercises are classifiers.** Most symptom-first bosses ask for `Diagnose(string) -> label` (linux/06 `Diagnose(curlError)`, networking/09 `Read curl -v`, docker/05 `Diagnose an exit`, kubernetes/06 `Triage`). A learner who passes has never actually chased a broken system.
- **Out-of-support versions taught as current.** .NET 8 and .NET 9 both reached end of support on 10 Nov 2026, yet the Docker track and project use `sdk:9.0`/`aspnet:9.0-noble-chiseled` and CI/CD uses `8.0.x`/`9.0.x`. Meanwhile the git artifact already targets net10.0.

## Cross-topic top 15 additions, in priority order

1. **Add a `lab` step type plus a link from every module** to its live or visual lab, gated like a boss: Linux modules 01-06 to missions 11-22, networking 06-dns to lab 04, integration 03/05/06 to lab 23, docker/04 to composebuild, kubernetes to kubebuild, cicd/02 to pipebuild, editors to the vim trainer.
2. **Live Git lab** (a container holding a seeded repo plus a bare "origin"): conflict resolution, `rebase -i --autosquash`, reflog recovery, `bisect run`, a force-pushed shared branch, `add -p`. This replaces most of the C# git models.
3. **Live Docker lab** (Docker-in-Docker or rootless podman node): build a broken Dockerfile, fix cache order, `docker compose up --wait`, debug an exit 137 or OOMKilled, `docker logs --since`, `docker inspect -f`, `docker exec`, `docker system df`/`prune`.
4. **Live Kubernetes lab** using k3d or kind inside Docker: CrashLoopBackOff with `logs --previous`, ImagePullBackOff, a Service with no endpoints, OOMKilled, `rollout undo`, `kubectl debug`, `port-forward`, Pending from requests.
5. **A "senior's toolkit" card in every module**: a compact table of commands with the flags that matter (rule 2), with a drill step that has learners type them.
6. **Kubernetes debugging module**: `kubectl debug -it --image=busybox --target`, `get events --sort-by=.lastTimestamp`, `describe`, `logs -p`, `top`, `explain`, `diff`, `apply --server-side`, `wait --for=condition`, `-o jsonpath`, `-L`/`--show-labels`.
7. **Migrate .NET 8/9 to .NET 10 LTS** throughout docker and cicd, and GitHub Actions to the current majors (`actions/checkout@v5`, `setup-dotnet@v5`).
8. **Kubernetes ingress update.** ingress-nginx was retired in March 2026. Teach the Gateway API (`Gateway`, `HTTPRoute`) as primary and Ingress as legacy that you will still meet.
9. **Linux observability module**: `ip a`/`ip r`/`ip route get`, `lsof -i`/`lsof +L1`, `strace -f -p`, `df -i`, `free -h`, `vmstat 1`, `iostat -xz 1`, `dmesg -T`/OOM killer, `journalctl -u -o cat --grep`, `systemctl status|edit|daemon-reload`, systemd timers, `xargs -0`, `find -print0`, `rg`, `jq`, `tmux`. Graded in a live mission.
10. **Certificate automation and lifetimes**: ACME/certbot/cert-manager, the 200-day maximum since 15 Mar 2026 (100 days in 2027, 47 in 2029), renewal monitoring with `openssl x509 -checkend`, CT logs/crt.sh, CAA, OCSP being wound down in favour of CRLs.
11. **CI/CD failure-triage lab**: a red workflow read with `gh run view --log-failed`, `gh run rerun --failed`, `ACTIONS_STEP_DEBUG`, a flaky test, a cache-key miss, a missing permission. Plus OIDC federation (`id-token: write`), reusable workflows, composite actions, Dependabot, rulesets/merge queue, artifact attestations.
12. **Git everyday power tools**: `git log --oneline --graph --all`, `range-diff`, `rerere`, `rebase --onto`, `--update-refs` (stacked PRs), `fetch --prune`, `log -L`, `core.autocrlf`/`.gitattributes` line endings, `git switch -c x origin/x`, submodules.
13. **Messaging operations in integration**: Kafka (`kafka-consumer-groups --describe` lag, partitions/keys and ordering, offsets reset), RabbitMQ (`rabbitmqctl list_queues`, DLQ redrive), the outbox pattern, webhooks with HMAC signatures, JWT validation, W3C `traceparent`/OpenTelemetry, OpenAPI 3.1.
14. **Editors: add VS Code** (command palette, multi-cursor, Remote-SSH, Dev Containers, the debugger, `code --wait` as git editor) and make the vim lessons keystroke steps on the real emulator (ui/vim-core.js) instead of C# re-implementations.
15. **Replace C#-model code steps with real-command steps.** Either a terminal step graded against a container, or "type the exact command" predict/blanks steps checked against real output. The heaviest offenders are linux/01-05, editors/*, git/01-03 and docker/01-04.

---

## git — verdict 3/5
Strong concept coverage (reflog, autosquash, bisect run, worktrees, SSH signing, filter-repo, force-with-lease), but not one real git command is run in a graded step.

**MISSING (by how often you need it at work)**
1. A real repository to practise in. No graded `git` execution anywhere, including conflict resolution (git/03-branching-and-merging/03-conflicts.json models `Merge3` in C#).
2. `git log --oneline --graph --all --decorate`: 0 hits. It is the most-used history view.
3. `git add -p` is only mentioned (4 files), never drilled. `git restore -p` and `git stash -p` are absent.
4. `git fetch --prune`, `git branch -vv`/`--merged`, cleanup of gone branches.
5. `git rebase --onto`, `--update-refs` (stacked PRs), `git range-diff` for re-reviewing a force-pushed PR.
6. `git rerere` for repeated conflicts; `git mergetool`/VS Code merge editor; `git checkout --theirs/--ours` during a rebase (where ours and theirs are swapped).
7. Line endings: `core.autocrlf`, `.gitattributes` `* text=auto eol=lf`. Weekly pain on Windows teams; 0 hits.
8. `git log -L :Func:file`, `git blame -w -C -C`, `--ignore-revs-file` (1 mention).
9. Recovering from a teammate's force-push to a shared branch (`git reset --hard origin/x` vs `git rebase --onto`).
10. Monorepo scale: `sparse-checkout`, `--filter=blob:none`, `--depth` (single mentions only), submodules (0).
11. `gh pr create/checkout/view`, CODEOWNERS (0).

**WRONG OR OUTDATED**
- Nothing factually wrong found.
- git/06-rescue-and-pro-tips/05-secrets-in-history.json shows `git push --force --all` after filter-repo but should say that filter-repo removes the `origin` remote, which has to be re-added.

**GIMMICKS**
- git/01-foundations/02-add-commit-log.json "Print git log --oneline" (string formatting).
- git/01-foundations/03-diff.json LCS diff (algorithm trivia).
- git/p01-team-day/01-start-the-feature.json `BranchName` slugger.
- git/04-remotes-and-collaboration/05-boss.json "Release notes" string grouping.
- The core idea is fine, but modelling `ShortStatus`, `Reset` and `Resolve` in C# (git/01/01, git/02/01-03) teaches C#, not git.

**RULE GAPS**
- No live lab for git at all.
- No visual commit-graph tool: only ASCII diagrams. A DAG visualizer that animates reset, rebase and cherry-pick is missing (rule 6).
- No toolkit card in 01, 03, 05, 06, p01.
- 05-under-the-hood has no symptom-first exercise (fsck tamper detection is a model).
- Bosses are realistic stories, but they are graded as C# functions.

**TOP 5 FIXES**
1. **New netlab "24-git-day"**: seeded repo plus a bare origin plus a "teammate" script that pushes. Tasks:
   - resolve a real conflict (state check: no markers, tests pass);
   - `rebase -i --autosquash` the fixups (check that `git log` shows 2 clean commits);
   - recover a reset-away commit via reflog;
   - `git bisect run ./test.sh` (answer: the commit id);
   - `push --force-with-lease` rejected, then fixed.
   Link it from git/03, git/06 and p01.
2. **Lesson git/01 "Reading history fast"**: `log --oneline --graph --all`, `log -p -- path`, `show HEAD~2:file`, `diff --stat`, `diff --word-diff`, `shortlog -sn`. Predict steps against real output.
3. **Lesson git/04 "Keeping a branch healthy"**: `fetch --prune`, `branch -vv`, `rebase --onto`, `--update-refs`, `range-diff @{u}...HEAD`, recovery from a teammate's force-push. Boss: "your PR base was squash-merged; rebase your stacked branch onto main".
4. **Lesson git/03 "Partial staging and conflicts in practice"**: `add -p`, `restore -p`, `rerere`, `checkout --theirs` in a rebase, VS Code merge editor. Plus a toolkit card.
5. **Lesson git/06 "Line endings and attributes"**: a symptom-first step ("every line shows as changed") fixed with `.gitattributes` and `git add --renormalize .`.

## linux — verdict 3/5
Good modern choices (ss, journalctl, signed-by keyrings, strict mode), and the 12 live missions are excellent, but the lessons never point to them and teach mostly through C# re-implementations of coreutils.

**MISSING**
1. The `ip` command: `ip -br a`, `ip r`, `ip route get 1.1.1.1`. 0 hits in tracks/linux.
2. `lsof -i :8080`, `lsof +L1`, `lsof -p`. Only in labs 15/16, not in lessons.
3. Resource triage: `free -h`, `vmstat 1`, `iostat -xz 1`, `df -i` (inode exhaustion), `dmesg -T` / OOM killer, `uptime`/load. All 0.
4. `strace -f -p PID -e trace=file,network`. 0.
5. systemd beyond start/stop: `systemctl status`, `systemctl edit` (drop-ins), `daemon-reload` (1), `systemctl list-timers` plus `.timer` units with `OnCalendar` (0). cron is taught while timers are the modern default.
6. `journalctl -o cat/json`, `--grep`, `-k`, `--since/--until` together. Partly covered.
7. `xargs -0 -P`, `find -print0`, `sed -E`, `awk` beyond one-liners, `tee`, here-docs, `trap ... EXIT` cleanup, `mktemp`, `shellcheck`: 0 or near-0 in lessons.
8. `rg -n -C2 --glob`, `jq` (in only 4 files, not drilled), `tmux` (1 mention), `less +F`, `watch -n`.
9. `ssh -L/-R/-J`, `ssh-agent`/`ssh-add`, `~/.ssh/config` `IdentitiesOnly` (only `ProxyJump` is present).
10. Disks and mounts: `lsblk`, `findmnt`, `mount`, `du -xh --max-depth=1`; `ln -s` (0); `tar czf/xzf` (1).
11. ACLs (`setfacl`/`getfacl`), the setgid directory (only in lab 20), `ulimit -n` (too many open files).

**WRONG OR OUTDATED**
- tracks/linux/07-distributions/05-boss.json `PastEol` table omits Debian 13 (trixie, Aug 2025) and treats it as unknown.
- Otherwise current (apt keyrings with `Signed-By`, ss over netstat).

**GIMMICKS**
- linux/02-files-and-text/01 head/tail in C#; linux/02/02 `Wc` and `GrepCount` in C#; linux/01/02 glob matcher; linux/04/02 cron matcher.
- linux/07-distributions/01 `Describe(kernel, libc, pm)`; 02 `IsUbuntuLts`; 04 `Recommend`. The whole module is interview trivia: four lessons where one would do.
- linux/08-packages-and-system/01 `Translate` apt to pacman; 06-boss `ufw to firewalld` string translation.

**RULE GAPS**
- Modules 01-05 have live equivalents (labs 11-19) that are never linked; 06 (networking tools) and 08 (packages) have labs 20 and 21, also unlinked.
- No toolkit card in any module.
- Symptom-first debugging exists only as classifiers (06-boss `Diagnose`).
- No visual for process trees, file descriptors or permissions beyond ASCII.

**TOP 5 FIXES**
1. **Make labs 11-22 the graded finale of modules 01-06** (lab step or link plus a gate): 11/12 for navigating, 13/17 for text, 14/20 for permissions, 15/16/19 for processes, 18 for scripting, 20/21 for networking and packages. Cut the C# coreutils steps that duplicate them.
2. **New module "09-observability-and-triage"** with a live mission "the slow server": a CPU hog, an IO hog, inode exhaustion, an OOM-killed service and a deleted-but-open log. Tools: `top/htop`, `vmstat`, `iostat`, `df -i`, `dmesg -T`, `lsof +L1`, `strace -p`. Boss: write the incident note.
3. **Lesson linux/04 "systemd like an operator"**: `systemctl status/edit/cat/daemon-reload`, `Restart=`/`RestartSec`, a timer unit with `OnCalendar` and `Persistent=true`, `systemctl list-timers`. Live-graded on the packages-and-services node.
4. **Lesson linux/06 "Network from the host"**: `ip a/r`, `ip route get`, `ss -tlnp`, `lsof -i`, `curl -w`, `ssh -L/-J`, `ssh-agent`. Symptom: "service listens on 127.0.0.1 only".
5. **Lesson linux/05 "Scripts that survive review"**: `trap` cleanup, `mktemp`, here-docs, `xargs -0`, `find -print0`, `shellcheck`. Boss: fix three shellcheck findings in a real deploy script run in a lab.

## editors — verdict 2/5
Vim content is correct and thorough, but every graded step is a C# simulation of vim or nano. The real vim emulator (ui/vim-core.js, 36 challenges in ui/vim-levels.js) is not used by any lesson, and the editor most engineers use daily (VS Code) is absent.

**MISSING**
1. VS Code: command palette, Ctrl+P, multi-cursor (0 hits), go to definition / rename symbol, the integrated terminal, the debugger, Remote-SSH and Dev Containers (0), `code --wait` as `core.editor`.
2. Vim quickfix workflow: `:vimgrep`/`:grep`, `:copen`, `:cdo s///` (0). Filters `:%!jq .`, `:r !cmd`, `!ip sort` (0). `gv` (0). `*`/`#` are in the trainer but not lesson-graded.
3. `:set paste`/bracketed paste, `:set list`, `:set ff=unix` (CRLF in a shell script is a weekly server bug; 1 hit).
4. Neovim baseline (init.lua, built-in LSP): only mentioned.
5. `crontab -e`, `visudo`, `sudoedit`, `git commit` / `rebase -i` editor workflows: some exist, but none are practised end to end.

**WRONG OR OUTDATED**
- None found. The `:w !sudo tee %` advice correctly notes that neovim does not support it (05-vim-for-real/05-boss.json).

**GIMMICKS**
- editors/01-nano/01-open-save-exit.json `Describe` (^X to Ctrl+X); 01-nano/04-boss.json `DecodeBar`.
- editors/02-vim-survival/03-vi-vim-neovim.json `Identify(versionLine)`; 02-vim-survival/04-boss.json `Rescue()` key-string builder.
- editors/03-vim-motions/01 and 04-boss: implement `w/b/e` and the "Keystroke golf" optimiser in C#.
- editors/05-vim-for-real/02 `Gutter`; 05-boss `Report` of vimrc/modeline precedence.

These teach C# parsing, not editing speed.

**RULE GAPS**
- Rule 7: no step makes the learner press real keys, though an emulator exists. Rule 6: the vim trainer (ui/lab-vim.js) is unlinked.
- No toolkit card in any module.
- No symptom-first step (for example E212, a CRLF script failing with `/bin/bash^M`, or a swap-file E325) graded in the emulator.

**TOP 5 FIXES**
1. **Add a `keys` step type** that loads a buffer into ui/vim-core.js and grades the final buffer plus a keystroke budget. Convert every module's code steps to it (reuse the vim-levels challenges), and drop the C# re-implementations.
2. **New module "06-vs-code-for-real"**: palette, quick open, multi-cursor (Ctrl+D, Alt+click), rename symbol, the debugger with breakpoints and watch, Remote-SSH into a netlab node, Dev Containers. Boss: fix a bug on a remote container using only VS Code features.
3. **Lesson editors/05 "Vim with the shell"**: `:%!jq .`, `:r !date`, `:vimgrep /TODO/ **/*.cs` plus `:cdo s/x/y/ | update`, `:set ff=unix`, `:set list`.
4. **Symptom-first boss for 02**: "Git opened vim mid-rebase and you are stuck in insert mode inside `q:`", graded in the emulator.
5. **A toolkit card per module**: the 15 keystrokes a fast vim user relies on (`ciw`, `.`, `*`, `gv`, `Ctrl+V`/`I`, `:g`, `q`/`@`, `Ctrl+O`/`Ctrl+I`, `''`, `%`, `zz`).

## networking — verdict 4/5
Deep and correct (subnetting, LPM, TCP states, PMTUD, NAT, HSTS, XFF trust), 10 live labs and two builders. Weaker on the cloud-era debugging a developer does weekly.

**MISSING**
1. `dig +trace`, `dig @server +norecurse`, `resolvectl status`/`/etc/resolv.conf`, `search`/`ndots` (the Kubernetes DNS latency classic): 0. `nslookup` appears once.
2. `curl -w '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer}'`, `--resolve`/`--connect-to` (1), `-k` vs `--cacert`.
3. `mtr -rwz` (0), `ip route get` (0), `tcpdump -w` read back in Wireshark/`tshark` (0), `nc -l`/`socat` (0).
4. Connection pooling and exhaustion: ephemeral ports, keep-alive, TIME_WAIT on clients, `SocketsHttpHandler`/`HttpClient` reuse.
5. gRPC and WebSockets (0), HTTP/2 over load balancers, idle timeouts on LBs and NAT gateways.
6. Cloud networking: VPC/VNet, security groups vs NACLs, private endpoints, split-horizon DNS (0).
7. mTLS (taught in pki only), SNI routing, ECH (0).

**WRONG OR OUTDATED**
- None found.
- tracks/networking/10-security-basics/02-iptables-firewalls.json teaches iptables as primary. nftables is the default backend on current distros (1 mention). Say so explicitly and show the `nft list ruleset` equivalent.

**GIMMICKS**
- networking/01-foundations/02 `Wrap` (string encapsulation).
- networking/07-http/01 `ParseUrl` without Uri.
- networking/04-routing-and-nat/05-boss.json Dijkstra `ShortestPath` (DSA, not networking work).

**RULE GAPS**
- Lab references are plain text ("Live lab 2"), not links. The DNS module (06-dns) never references lab 04-dns. 05-transport and 07-http have no lab, though both are easy in containers (tc netem for loss; an nginx with bad cache headers).
- No toolkit card in 01-09.
- 07-http's boss is a model web server. Missing: a symptom-first "the API is slow / returns 502 behind the LB" trace using `curl -w` timings.

**TOP 5 FIXES**
1. **New lab "DNS gone wrong"** (extend 04-dns): stale TTL after cut-over, CNAME to a wrong target, `ndots:5` search-path amplification, split-horizon. Tools: `dig +trace`, `dig @ns +norecurse`, `resolvectl`. Link it from 06-dns.
2. **New lab "Where did the latency go"** with `tc netem` delay/loss, an nginx reverse proxy and a slow upstream. Tasks: break down `curl -w` timings, `ss -ti` (retransmits, rtt), `mtr`, find a 502 from an idle-timeout mismatch. Use it as the 05-transport/07-http boss.
3. **Lesson 09-edge "Connection pools and timeouts"**: keep-alive, ephemeral port exhaustion, LB idle timeout vs app keep-alive, `HttpClient` reuse. Symptom: "SocketException: address already in use".
4. **Lesson "Cloud networks in one picture"**: VPC subnets, route tables, SGs vs NACLs, NAT gateway, private endpoint plus private DNS zone. Network-builder challenges for each.
5. **Turn "Live lab N" callouts into lab steps/links**, and add an nftables card to 10/02.

## pki — verdict 4/5
The best topic here: real .NET X509 APIs, real openssl/PowerShell/keytool commands, a chain doctor, the chain lab and TLS lab 08. Gaps are automation and current CA/B Forum rules.

**MISSING**
1. ACME automation: certbot / `acme.sh` / cert-manager `Certificate`/`Issuer`, HTTP-01 vs DNS-01. 0 hits. This is how most production certificates are issued.
2. Expiry monitoring: `openssl x509 -checkend 2592000`, alerting, inventories. Plus the shrinking lifetime timeline (200 days from 15 Mar 2026, 100 in 2027, 47 in 2029).
3. Certificate Transparency (crt.sh), CAA records (0).
4. Managed key stores: Azure Key Vault / AWS ACM / HSM-backed keys (1 mention), Kubernetes TLS secrets.
5. Local dev: `mkcert`, `dotnet dev-certs https --trust` (present), step-ca for internal ACME (0).
6. Workload identity / SPIFFE (0). This is optional for a first job.

**WRONG OR OUTDATED**
- tracks/pki/p01-mini-ca/03-issuing-leaves.json: "public CAs are limited to 398 days". Since 15 Mar 2026 the CA/B Forum maximum is 200 days.
- tracks/pki/03-when-trust-breaks/03-revocation-and-mtls.json presents OCSP and stapling as the current mechanism. Let's Encrypt shut down OCSP in 2025, OCSP is now optional for public CAs, and browsers rely on CRLs/CRLite. Say so.

**GIMMICKS**
- pki/01-foundations/04-file-formats.json "PEM by hand" and 05-in-the-field/05 "PEM to DER by hand" are marginal: base64 framing that learners will never write.

**RULE GAPS**
- Lab 08-tls is not linked from pki (only from networking/08).
- No toolkit card in 01-04 or the projects (05 is effectively one).
- 04-hands-on-dotnet has no symptom-first step: add "this cert works in the browser but HttpClient fails" (missing intermediate).

**TOP 5 FIXES**
1. **New lesson pki/05 "Automated issuance with ACME"**: the ACME flow diagram, HTTP-01 vs DNS-01, certbot `certonly --webroot` / `renew --dry-run`, cert-manager `Certificate` YAML, and why short lifetimes force automation. Live lab: step-ca in Docker, issue and renew automatically, then let one expire and alert.
2. **Fix the 398-day text** and add a dated "lifetime timeline" card (200, 100, 47 days) with a code step that computes the renewal date at 2/3 of the lifetime.
3. **Update the revocation card**: CRLs/CRLite, the OCSP wind-down, and short lifetimes as de facto revocation.
4. **Lesson "Finding every certificate you own"**: crt.sh/CT, CAA, `openssl s_client` sweep plus `-checkend` across a host list. Boss: an inventory report with expiry buckets.
5. **Link lab 08-tls and the chain lab** from 02/03 as graded steps.

## docker — verdict 3/5
Content is current and production-minded (chiseled images, BuildKit secret mounts, healthcheck caveats, exit codes and OOMKilled). But no graded step runs Docker, and the compose builder is unlinked.

**MISSING**
1. A real `docker build`/`run`/`compose` exercise. None exists, although the platform runs containers.
2. Day-to-day debugging flags: `docker logs -f --since 10m --tail 100` (no `--since` anywhere), `docker compose logs -f --since`, `docker compose up --wait`, `compose config` (1), `compose run --rm` (0), `docker cp` (1), `docker top`/`diff` (0), `docker debug` (0), `nsenter` (0).
3. BuildKit cache mounts `RUN --mount=type=cache` (0), `docker buildx build --platform linux/amd64,linux/arm64` (1 mention). Apple-silicon arm64-vs-amd64 mismatch ("exec format error").
4. `docker system df`, `docker builder prune` (disk full on the dev box or CI runner).
5. `compose watch` / `develop:` (0), `docker init` (0).
6. Image signing and SBOM/provenance: `cosign`, `--sbom`/`--provenance`, Trivy/Grype CLI (0; `scout` once).
7. Hardening flags: `--read-only` (2), `--cap-drop ALL` (0), `--init`/`init: true` (0, needed for PID 1 signal handling), `restart:` policies (1).

**WRONG OR OUTDATED**
- tracks/docker/02-images-and-dockerfiles/04-multi-stage-builds.json, 05-small-and-secure-images.json and docker/p01-containerize-an-app/* teach `sdk:9.0`/`aspnet:9.0-noble-chiseled` and `net9.0`. .NET 9 left support on 10 Nov 2026; use `10.0` (LTS).
- No v1 `docker-compose` syntax and no `version:` key: good.

**GIMMICKS**
- docker/01-why-containers/02 `Simulate(lifecycle)`.
- docker/02-images-and-dockerfiles/01 `Instructions(lines)` (numbering lines) and 04 `Stages(lines)`.
- docker/02-images-and-dockerfiles/06-boss.json `Summary` ("I instructions, S stages").
- docker/p01-containerize-an-app/02 "How big is it?" (summing given numbers).
- docker/01-why-containers/01 `ParseImage` is borderline useful.

**RULE GAPS**
- Docker is the one topic where a live lab is trivially feasible and none exists.
- composebuild (11 challenges) is not linked from 04-compose.
- No toolkit card in 02-05 or p01.
- Symptom-first exists only as classifiers (05/04 `Diagnose`).
- The p01 boss ("Production readiness score") is a linter, not shipping an image.

**TOP 5 FIXES**
1. **Netlab "25-container-doctor"** (DinD node):
   - a broken Dockerfile with cache-busting `COPY . .` first (task: rebuild under N seconds);
   - an app that exits 139/137 (task: find it with `docker inspect -f '{{.State.OOMKilled}}'`);
   - an API that cannot reach `localhost:5432` (fix to the service name);
   - a compose stack whose api starts before the db (add a healthcheck plus `service_healthy`, `up --wait`);
   - a disk filled by dangling images (`system df`, `builder prune`).
2. **Make p01 real**: learners write the Dockerfile and compose.yaml for the todo API, and the grader builds them in the lab, checks the image size, `USER`, healthcheck and `curl :8080/health`. Replace C# `Review`/`Readiness`.
3. **Move to .NET 10** in every Dockerfile and fill-in step, and add a card on reading the .NET support policy.
4. **Lesson docker/02 "Faster and multi-arch builds"**: `--mount=type=cache` for NuGet/npm, `buildx --platform`, `--cache-from/--cache-to type=gha`, "exec format error" as the symptom.
5. **Link composebuild** from 04-compose as the visual for start order, networks and volumes, and add a toolkit card per module (`logs -f --since`, `exec -it`, `inspect -f`, `stats --no-stream`, `compose ps/logs/config/run --rm`).

## kubernetes — verdict 3/5
The mental models are right and well sequenced (reconcile loop, three ports, QoS, probes, PDB, RBAC can-i, Helm, GitOps, kind), with the kubebuild simulator. But the core debugging commands are thin and it never touches a real cluster.

**MISSING (by frequency at work)**
1. `kubectl describe` / `get events --sort-by=.lastTimestamp` driven triage on a real cluster. Events appear in 3 files, as text.
2. `kubectl logs -p/--previous` and `-f --since=10m -c container` (2 mentions), `kubectl logs -l app=x --max-log-requests`.
3. `kubectl debug -it pod --image=busybox --target=app` / ephemeral containers, `kubectl debug node/...`: 0.
4. `kubectl rollout status/undo/history` (1 each, never practised), `kubectl rollout restart` (2).
5. `kubectl port-forward` (1), `kubectl exec -it -- sh` (2), `kubectl cp` (0).
6. `kubectl explain` (0), `kubectl diff -f` (0), `--dry-run=client -o yaml` generators (0), `apply --server-side` (0), `kubectl wait --for=condition=Available` (0).
7. Output and selection: `-o jsonpath`/`custom-columns` (1 each), `-L`/`--show-labels`, `--sort-by` (1), `-A`, `-w`.
8. Kustomize overlays (`kubectl apply -k`): 0, despite being the default for env overlays. `helm upgrade --install --atomic`, `helm diff` (0).
9. securityContext (`runAsNonRoot`, `readOnlyRootFilesystem`, Pod Security Admission `restricted`): 0-1. `preStop` / `terminationGracePeriodSeconds` / graceful shutdown: 0. initContainers: 0.
10. Scheduling: `cordon`/`drain` (1), `topologySpreadConstraints`/affinity (1), VPA/KEDA (0).
11. External secrets (ESO/CSI): 1 mention.

**WRONG OR OUTDATED**
- tracks/kubernetes/03-networking/02-dns-and-ingress.json and p01-deploy-an-app/05-ingress-hpa-rollout.json teach Ingress with `ingressClassName: nginx` and name ingress-nginx as a default controller. ingress-nginx was retired in March 2026 (no further fixes). Teach Gateway API `Gateway`/`HTTPRoute` as primary; it is now only a parenthetical.

**GIMMICKS**
- kubernetes/01-the-big-picture/01 `Plan(desired, running)` (trivial subtraction).
- kubernetes/03-networking/04-boss.json `Spread` round-robin.
- kubernetes/04-config-and-storage/04-boss.json `Render` template (not a Kubernetes skill).
- kubernetes/01-the-big-picture/04-boss.json `Target(args, context)` is near-trivia.

**RULE GAPS**
- No live cluster although k3d/kind runs in Docker on a laptop; kind appears only in a learn card (06/03).
- kubebuild is never linked.
- No toolkit card in any module.
- Symptom-first steps are classifiers (06/01 `Triage`, 05-boss `Find OOM victims` over pasted text).
- The p01 boss lints records instead of deploying.

**TOP 5 FIXES**
1. **Netlab "26-k3d-on-call"**: a k3d cluster in Docker with 6 seeded faults:
   - CrashLoopBackOff from a missing ConfigMap key (`logs -p`, `describe`);
   - ImagePullBackOff from a tag typo;
   - a Service selector mismatch with no endpoints (`get endpointslices`);
   - OOMKilled (`describe`, then raise the limit);
   - Pending from oversize requests (events);
   - a bad rollout (`rollout undo`).
   Each is graded by cluster state.
2. **Lesson 06 "The kubectl power kit"** (toolkit card plus drills): `get -o wide -L app -A -w`, `--sort-by`, `-o jsonpath`, `explain`, `diff`, `--dry-run=client -o yaml`, `apply --server-side`, `wait`, `port-forward`, `debug --target`, `logs -p --since`.
3. **Replace Ingress-first with Gateway API** in 03/02 and p01/05: `GatewayClass`/`Gateway`/`HTTPRoute`, with a note on migrating from ingress-nginx.
4. **Lesson 05 "Graceful shutdown and safe pods"**: preStop sleep, SIGTERM handling, `terminationGracePeriodSeconds`, `securityContext` restricted profile, initContainers. Symptom: 502s during every rollout.
5. **Make p01 deploy for real** to the k3d lab with Kustomize base plus overlays, `helm upgrade --install --atomic`, and link kubebuild as the visual for each stage.

## cicd — verdict 3/5
Sound concepts (build once and promote, fail-fast, least-privilege `permissions`, pinned SHAs, expand/contract migrations, canary math) and a pipeline builder. But it uses dated action and .NET versions, and never debugs a real failing run.

**MISSING**
1. Reading and fixing a red pipeline: `gh run view --log-failed`, `gh run rerun --failed`, `gh run watch`, `ACTIONS_STEP_DEBUG`. `gh run` has 0 hits.
2. OIDC federation to a cloud (`permissions: id-token: write` plus `azure/login`/`aws-actions/configure-aws-credentials`) as the default over stored secrets (2 mentions, not built).
3. Reusable workflows (`workflow_call`, 1) and composite actions (0). Every company standardises these.
4. `GITHUB_OUTPUT`/step outputs, `GITHUB_STEP_SUMMARY`, `timeout-minutes`, `workflow_dispatch` inputs: 0-2.
5. Dependabot/Renovate config (0), rulesets/required checks/CODEOWNERS (1), merge queue `merge_group` (0).
6. Artifact attestations / SLSA provenance (`actions/attest-build-provenance`): 0. SBOM generation is described only.
7. Service containers / Testcontainers for integration tests in CI (0).
8. Other CI systems seen at Microsoft (Azure Pipelines YAML, 0) and GitLab: at least one translation card.
9. Local runs with `act` (1), `actionlint`/`zizmor` (1).

**WRONG OR OUTDATED**
- tracks/cicd/track.json tagline is "Live comfortably in a terminal." (copied from linux).
- tracks/cicd/02-github-actions/01-workflow-anatomy.json and 03-real-workflows.json, plus p01-pipeline-for-an-app/*: `actions/checkout@v4`, `actions/setup-dotnet@v4`. The current majors are v5 (Node 24 runtime). Update them.
- tracks/cicd/02-github-actions/02-matrix-cache-secrets.json matrix `['8.0.x', '9.0.x']` and `dotnet-version: '8.0.x'`: both reached end of support in Nov 2026. Use `10.0.x`.
- tracks/cicd/05-security-and-quality/02-supply-chain.json `dotnet list package --vulnerable`: still works, but .NET 10's noun-first form is `dotnet package list --vulnerable`.

**GIMMICKS**
- cicd/01-concepts/01 `NextAction(branch, testsPassed, practice)`; 01-concepts/03-boss.json `ArtifactName` and `NextEnvironment`.
- cicd/03-testing-in-pipelines/01 `SuiteShape` ("ice-cream cone") and `TotalCoverage` averaging.
- cicd/02-github-actions/04-boss.json "build your own Actions runner" (topological sort and waves). This is a DSA exercise; reading `needs:` is the work skill.

**RULE GAPS**
- pipebuild is not linked from 02.
- No toolkit card in any module.
- No symptom-first exercise starting from a real failed log (03/02 flaky detection is a set operation).
- The p01 workflow YAML is graded statically, never executed. Running it with `act` in a container, or against a local Gitea Actions runner, is feasible.

**TOP 5 FIXES**
1. **Lesson 02 "Debugging a red build"** with 5 real failure logs: a missing `permissions: packages: write` (403 on push), a cache-key miss, a `needs` output typo, a flaky test, the `pull_request` from a fork with no secrets. Steps: find the line, fix the YAML. Toolkit: `gh run view --log-failed`, `gh run rerun --failed`, step debug.
2. **Execute p01 for real**: a netlab with Gitea plus act_runner (or `act`) that runs the learner's workflow against the sample API. Grade on job results and the pushed image in a local registry.
3. **Lesson 05 "Keyless deploys with OIDC"**: an OIDC trust diagram, `id-token: write`, a federated credential subject (`repo:org/repo:environment:production`), environment protection rules. Boss: remove a long-lived secret from a workflow.
4. **Lesson 02 "Reuse at scale"**: `workflow_call` with inputs and secrets, composite actions, `GITHUB_OUTPUT`, `timeout-minutes`, Dependabot for actions and NuGet, rulesets plus merge queue.
5. **Bump versions** (checkout/setup-dotnet v5, .NET 10), fix the tagline, and link pipebuild as the visual for `needs`/environments.

## integration — verdict 4/5
Unusually practical: header leaks, the 204 trap, timeout budgets, retries only on idempotent calls, breakers, idempotency keys, trace ids, token buckets, a real ASP.NET Core platform project, and a real Camel plus Kong live lab (23). Gaps are messaging operations and the lab link.

**MISSING**
1. Broker operations: `kafka-consumer-groups --describe --group` (lag), partitions and keys for ordering, offset reset, retention. RabbitMQ `rabbitmqctl list_queues name messages consumers`, DLQ redrive. These are only concepts today (02/05).
2. The transactional outbox and inbox patterns (0): the standard fix for dual writes.
3. Webhooks done right: HMAC signature verification, replay windows, retries with `Retry-After` (webhooks 3, HMAC 0).
4. JWT validation at the gateway (`iss`/`aud`/`exp`/JWKS rotation): 0.
5. W3C `traceparent` and OpenTelemetry propagation (1 each). The lessons use a custom trace id.
6. .NET resilience in practice: `AddStandardResilienceHandler` / Polly v8 pipelines (3 mentions, not built). Jitter has 1 mention.
7. Schema evolution for events: Avro/Protobuf plus a schema registry, AsyncAPI (0). Sagas/compensation (0).
8. gRPC (0), and curl/HTTPie drills against the gateway (0).

**WRONG OR OUTDATED**
- tracks/integration/04-contracts-and-validation/01-openapi-anatomy.json uses `openapi: 3.0.3`. OpenAPI 3.1 (JSON Schema 2020-12, `type: [string, "null"]` instead of `nullable`) is the current baseline and 3.2 exists. Teach 3.1 and note the nullable change.

**GIMMICKS**
- integration/01-the-big-picture/01 `PointToPointLinks(n)` (n(n-1)/2 arithmetic).
- integration/03-camel-routes/01 `ParseEndpoint` URI parsing and 02 "A tiny Simple language" interpreter: the engine internals are less useful than writing routes against the real Camel in lab 23.
- integration/06-api-management/02 `ManagedApi` lifecycle state machine (product trivia).

**RULE GAPS**
- Lab 23-camel-gateway (11 tasks covering exactly modules 02, 03, 05 and 06) is linked from no lesson.
- The architecture builder is unlinked.
- No toolkit card in any module (curl to the gateway, `camel run --dev`, `camel get route`, `kafka-console-consumer`, `kafka-consumer-groups`).
- The 07-delivery-and-operations boss is modelled rather than run.

**TOP 5 FIXES**
1. **Link lab 23 tasks as graded steps** inside modules 02 (t3-t6), 03 (t1-t2, t5), 05 (t7) and 06 (t8-t11), and make lab completion the module gate.
2. **New lesson 02 "Running a broker"** plus a Kafka (KRaft) container in lab 23:
   - produce with keys;
   - watch ordering per partition;
   - a slow consumer builds lag (`kafka-consumer-groups --describe`);
   - a poison message goes to the DLQ and is redriven;
   - `--reset-offsets --to-datetime` replay.
3. **New lesson 05 "Outbox and idempotent consumers"**: a dual-write failure as the symptom, then an outbox table plus relay. Code step in the p01 platform.
4. **Lesson 06 "Tokens at the gateway"**: JWT anatomy, JWKS caching and key rotation, `aud` mismatch as the symptom, HMAC-signed webhooks. Switch trace ids to W3C `traceparent`.
5. **Upgrade contracts to OpenAPI 3.1** and add an AsyncAPI card for event contracts. Replace the Simple-language interpreter step with writing a real route in lab 23.
