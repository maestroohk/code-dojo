"""Boss step 2: ~/incident/journal.json, an export made with `journalctl -o json` (one JSON object per line).

Fields as journald writes them: every value is a string, PRIORITY is "0" (emerg) to "7" (debug),
__REALTIME_TIMESTAMP is microseconds since the epoch.
"""
import json
import os
import random

rng = random.Random(4242)
home = os.path.expanduser("~")
os.makedirs(f"{home}/incident", exist_ok=True)
units = ["orders-api.service", "payments.service", "nginx.service", "cron.service"]
info = {
    "orders-api.service": ["GET /api/orders 200", "Order 1182 created", "Health check ok", "Cache warmed"],
    "payments.service": ["Charge accepted", "Webhook delivered", "Health check ok"],
    "nginx.service": ["reload ok", "worker started"],
    "cron.service": ["(learner) CMD (/home/learner/bin/backup.sh)"],
}
bad = [
    ("orders-api.service", "3", "Unhandled exception: connection to db.example.com:5432 refused"),
    ("payments.service", "4", "Slow response from provider: 2.4 s"),
    ("orders-api.service", "4", "Retrying db connection (attempt 2)"),
    ("orders-api.service", "2", "Connection pool exhausted, shutting down"),
    ("nginx.service", "3", "upstream timed out (110: Connection timed out) while reading response header"),
    ("orders-api.service", "3", "Startup failed: db not reachable"),
    ("payments.service", "3", "Webhook signature mismatch"),
    ("orders-api.service", "6", "Starting orders-api"),
    ("orders-api.service", "3", "Unhandled exception: connection to db.example.com:5432 refused"),
]
t = 1931000000 * 1_000_000
lines = []
for i in range(120):
    t += rng.randint(200_000, 9_000_000)
    if i % 13 == 5 and bad:
        unit, prio, msg = bad.pop(0)
    else:
        unit = rng.choice(units)
        prio, msg = "6", rng.choice(info[unit])
    lines.append({"__REALTIME_TIMESTAMP": str(t), "_HOSTNAME": "shop-1", "PRIORITY": prio,
                  "_SYSTEMD_UNIT": unit, "SYSLOG_IDENTIFIER": unit.split(".")[0], "MESSAGE": msg})
with open(f"{home}/incident/journal.json", "w") as f:
    for entry in lines:
        f.write(json.dumps(entry) + "\n")
