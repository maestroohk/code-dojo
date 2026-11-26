"""Realistic, reproducible logs for this module's terminal steps (run as root by the setup, in the learner's home).

    python3 gen.py streams    ~/deploy/deploy.sh and /var/log/app/app.log           (lesson 1)
    python3 gen.py logs       ~/logs: access.log, app.log, events.jsonl, archive/  (lesson 2, cold rebuild)
    python3 gen.py incident   ~/incident: access.log, nginx.conf                    (boss)

Access logs use the format of the boss card, fields split on single spaces:
    10.0.0.7 - - [12/Mar/2031:03:01:44] "GET /api/orders HTTP/1.1" 500 312
    $1       $2 $3 $4                   $5   $6         $7        $8  $9
The heavy hitters are planted with distinct counts, so "the top N" never depends on how ties sort.
"""
import json
import os
import random
import sys

HOME = os.path.expanduser("~")
rng = random.Random(20310312)

PATHS = ["/", "/api/orders", "/api/products", "/api/cart", "/login", "/static/app.js", "/static/site.css",
         "/api/search?q=mug", "/healthz", "/api/checkout"]
WEIGHTS = [6, 22, 14, 9, 5, 8, 7, 4, 18, 3]
STATUS = [200] * 40 + [201] * 3 + [304] * 6 + [404] * 4 + [500] * 2 + [502, 503]
METHODS = {"/api/orders": ["GET", "POST"], "/api/cart": ["GET", "POST", "DELETE"], "/login": ["GET", "POST"], "/api/checkout": ["POST"]}


def stamp(i, day="12/Mar/2031", start_h=3):
    s = i * 3 + rng.randint(0, 2)
    return f"[{day}:{start_h + s // 3600 % 20:02d}:{s // 60 % 60:02d}:{s % 60:02d}]"


def ip():
    return f"10.0.{rng.randint(0, 3)}.{rng.randint(2, 250)}"


def line(i, addr, path, status, method=None):
    method = method or rng.choice(METHODS.get(path, ["GET"]))
    size = 0 if status == 304 else rng.randint(120, 9000)
    return f'{addr} - - {stamp(i)} "{method} {path} HTTP/1.1" {status} {size}'


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="\n") as f:
        f.write(text)
    os.chmod(path, mode)


def access(n, planted=()):
    """n background lines plus planted (addr, path, status, count) bursts, shuffled together."""
    rows = [(ip(), rng.choices(PATHS, WEIGHTS)[0], rng.choice(STATUS)) for _ in range(n)]
    for addr, path, status, count in planted:
        rows += [(addr, path, status)] * count
    rng.shuffle(rows)
    return "".join(line(i, *r) + "\n" for i, r in enumerate(rows))


def app_log(n):
    levels = ["INFO"] * 30 + ["DEBUG"] * 10 + ["WARN"] * 4 + ["ERROR"] * 2
    msgs = {
        "INFO": ["request served in {ms}ms", "user {u} logged in", "cache warmed ({n} keys)", "order {o} created"],
        "DEBUG": ["sql: select * from orders where id={o}", "cache hit for product {n}"],
        "WARN": ["slow query took {ms}ms", "Timeout talking to payments, retrying", "disk at {n}%"],
        "ERROR": ["payment failed for order {o}: card declined", "Timeout talking to payments, giving up", "error: could not reach redis"],
    }
    out = []
    for i in range(n):
        lvl = rng.choice(levels)
        text = rng.choice(msgs[lvl]).format(ms=rng.randint(5, 4000), u=rng.choice(USERS), n=rng.randint(1, 99), o=1000 + i)
        if lvl == "ERROR" and rng.random() < 0.3:
            text = text.replace("error:", "Error:")
        out.append(f"2031-03-12T{3 + i // 3600:02d}:{i // 60 % 60:02d}:{i % 60:02d}Z {lvl:<5} {text}")
    return "\n".join(out) + "\n"


USERS = ["alice", "bob", "chen", "dolores", "fatima", "ivan", "kofi", "nadia"]


def streams():
    write(f"{HOME}/deploy/deploy.sh", "\n".join([
        "#!/bin/bash",
        "# A pretend deploy: progress on stdout, problems on stderr.",
        "echo 'deploy: building image shop:1.4.2'",
        "echo 'warning: base image is 41 days old' >&2",
        "echo 'deploy: pushing to registry'",
        "echo 'deploy: rolling out 3 replicas'",
        "echo 'error: replica 2 failed its health check, retried' >&2",
        "echo 'deploy: done in 48s'",
        "exit 0",
    ]) + "\n", 0o755)
    write("/var/log/app/app.log", app_log(1500))


def logs():
    write(f"{HOME}/logs/access.log", access(2200, [("10.0.9.9", "/api/orders", 200, 140), ("10.0.9.9", "/healthz", 200, 60)]))
    write(f"{HOME}/logs/app.log", app_log(1800))
    events = []
    fails = {"ivan": 41, "nadia": 27, "bob": 12, "chen": 6}
    for user, count in fails.items():
        events += [{"user": user, "event": "login_failed"}] * count
    for _ in range(400):
        events.append({"user": rng.choice(USERS), "event": rng.choice(["login", "logout", "view", "purchase"])})
    rng.shuffle(events)
    write(f"{HOME}/logs/events.jsonl", "".join(json.dumps({"ts": 1931731200 + i * 7, **e, "ip": ip()}) + "\n" for i, e in enumerate(events)))
    for day in range(1, 8):
        text = app_log(120)
        if day == 5:
            text += "2031-03-05T04:12:09Z ERROR java.lang.OutOfMemoryError: Java heap space\n"
        write(f"{HOME}/logs/archive/app-2031-03-0{day}.log", text)
    write(f"{HOME}/logs/README.txt", "These are the shop's logs.\naccess.log is the web server, one request per line.\n"
          "app.log is the application, one event per line.\nevents.jsonl is one JSON object per line.\n"
          "Old app logs are in archive, one file per day.\n")


def incident():
    planted = [("10.0.7.77", "/api/checkout", 500, 61), ("10.0.7.78", "/api/checkout", 502, 44),
               ("10.0.4.12", "/api/orders", 503, 29), ("10.0.5.5", "/api/lookup?ip=203.0.113.9", 500, 14)]
    write(f"{HOME}/incident/access.log", access(1800, planted))
    write(f"{HOME}/incident/nginx.conf", "\n".join([
        "worker_processes auto;",
        "events {",
        "    worker_connections 512;",
        "}",
        "http {",
        "    access_log /var/log/nginx/access.log;",
        "    error_log /var/log/nginx/error.log debug;",
        "    upstream shop { server 10.0.1.20:8080; server 10.0.1.21:8080; }",
        "}",
    ]) + "\n")


{"streams": streams, "logs": logs, "incident": incident}[sys.argv[1]]()
