# Live lab: the vulnerable shop

**Lamp Shop** is a small online shop written in ASP.NET Core (.NET 10): minimal APIs, one Razor page and a SQLite database. It was written with the classic mistakes in it on purpose. You will play both sides. First you **attack** each weakness from an attacker workstation, so you see exactly what it gives away. Then you **fix** the C# source, rebuild, and the lab proves two things: the attack no longer works, and the shop still does its normal job.

## Rules of this lab

- **Everything stays inside the lab.** The shop, the staff member and the internal services are containers on Docker networks marked `internal`: they cannot reach the internet, and nothing outside Docker can reach them (no ports are published). Use these techniques only on this lab and on systems you are explicitly authorised to test. Testing someone else's site without written permission is illegal in most countries, bug bounty programmes included when you step outside their scope.
- The payloads are the classic, harmless ones (`id`, `document.cookie`, `/etc/passwd`). No malware, nothing that persists.
- All names are made up (`shop.example`, `customer.example`, `evil.example`); every key and password is generated fresh for each run.

## The hosts

| Host | What runs there |
|---|---|
| **attacker** | your attacker workstation: `curl`, `jq`, `python3`, `sqlmap`, `hydra`, `listen` (a web server for your payloads) and `baseline-scan` |
| **shop** | Lamp Shop on port 8080, running as the user `shopsvc`. Its source is in `/work/shop`; you edit it here |
| **bot** | a member of staff, always signed in, in a real headless Chromium. They read every new review and open the link in every support ticket |
| **internal** | the shop's neighbours: a cloud **metadata service** at `169.254.169.254`, the content server `cdn.shop.example`, and the payments API `payments.internal` |

```
                edge network                    backend / cloud networks
 attacker ---+--------------> shop :8080 -----+--> cdn.shop.example, payments.internal
 bot --------+                                +--> 169.254.169.254 (metadata)
```

The attacker can reach the shop and nothing else. The shop can reach the internal services. That difference is the whole point of task 11.

## Accounts

- **alice** / `wonderland`: a demo customer. Use her for the attacks.
- **bob**, **carol**: other customers (carol has a weak password: task 17).
- **admin**: the staff account the bot uses. Its password is long and random: you will not guess it, you will steal its session.

Sign in with a cookie jar and reuse it:

```
curl -i -c jar -d 'username=alice&password=wonderland' http://shop:8080/login
curl -s -b jar http://shop:8080/api/orders | jq
```

`-c jar` saves the cookies the server sets, `-b jar` sends them. `curl -i` shows status and headers, `curl -v` shows your request too. To send a payload in the query string without escaping it by hand, use `curl -G --data-urlencode 'q=...'`.

## Fixing the code

Open a terminal on **shop** (click it in the diagram). The source is a Git repository:

```
/work/shop/Program.cs        wiring only: you never need to change it
/work/shop/Orders.cs         one file per feature: Orders, Profile, Search, Account, Preview, Invoices, Tools, Auth ...
/work/shop/Pages/Product.cshtml   the product page (Razor)
/work/logs/shop.log          the shop's log
```

`nano /work/shop/Orders.cs` (or **Open file…** under the terminal) opens the file in an editor on the page, with C# highlighting. **Save** writes it back. Then run:

```
shop-rebuild
```

It compiles the project (about 5 to 15 seconds, completely offline) and restarts the shop on the new build. If the build fails, it prints the compiler errors (`Orders.cs(21,13): error CS1002: ; expected`) and the old version keeps running, so the shop is never down because of a typo. `git diff` shows what you changed; `git checkout -- Orders.cs` throws your change away.

Each task's solution is a command that copies a fixed file from `/lab/solution` and rebuilds. Read it after you have tried: the comments explain why each line is there.

## How the checks work

**Check** replays the attack with its own fresh accounts and payloads (more variants than the task text names), and then does the legitimate thing a customer would do. A fix that blocks everything fails, and so does a fix that only blocks the one payload you tried. You can click **Check** as often as you like.

The XSS check (task 8) opens a page in a real browser on **bot**, because only a browser runs scripts and enforces `HttpOnly` and Content-Security-Policy.

## What maps to what

| Tasks | Weakness | OWASP Top 10:2025 | API Top 10:2023 |
|---|---|---|---|
| 1-2 | IDOR / BOLA | A01 Broken Access Control | API1 |
| 3-4 | Mass assignment | A01 Broken Access Control | API3 |
| 5-6 | SQL injection | A05 Injection | |
| 7-8 | Stored XSS | A05 Injection | |
| 9-10 | CSRF | A01 Broken Access Control | |
| 11-12 | SSRF | A01 Broken Access Control | API7 |
| 13-14 | Path traversal | A01 Broken Access Control | |
| 15-16 | OS command injection | A05 Injection | |
| 17-18 | Brute force, no rate limit | A07 Authentication Failures | API4 |
| 19-20 | Secret in Git history | A04 Cryptographic Failures, A08 Integrity | |
| 21 | Verbose errors, missing headers | A02 Security Misconfiguration | API8 |

Memory: the lab uses about 1.5 GB while it runs (the .NET SDK and Chromium are the big ones). Stop it when you take a break; **Start** gives you a fresh shop with new secrets.
