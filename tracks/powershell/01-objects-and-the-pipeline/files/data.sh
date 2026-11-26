# Module 1 scenarios: a folder tree of logs and exports with known sizes and ages, and a request log as CSV.
# Everything is deterministic (fixed sizes, fixed dates relative to now), so checks can recompute the answers.
set -e -o pipefail
mkdir -p ~/answers ~/scripts
python3 - <<'EOF'
import os, random, time
home = os.path.expanduser("~")
now = time.time()
day = 86400
def mk(rel, size, age_days):
    p = os.path.join(home, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write((b"x" * 63 + b"\n") * (size // 64) + b"y" * (size % 64))
    t = now - age_days * day
    os.utime(p, (t, t))
files = [
    ("logs/api/api-2026-11-20.log", 912_384, 6), ("logs/api/api-2026-11-13.log", 2_404_352, 13),
    ("logs/api/api-2026-11-06.log", 1_748_992, 20), ("logs/web/access.log", 5_242_880, 1),
    ("logs/web/error.log", 18_432, 1), ("logs/web/access.log.1", 4_718_592, 8),
    ("logs/jobs/nightly.log", 65_536, 2), ("logs/jobs/nightly.log.1", 61_440, 9),
    ("logs/jobs/README.txt", 812, 40), ("data/exports/customers.csv", 3_145_728, 3),
    ("data/exports/orders-2026-10.csv", 7_340_032, 27), ("data/exports/orders-2026-11.csv", 6_291_456, 1),
    ("data/backup/db-2026-11-01.bak", 10_485_760, 26), ("data/backup/db-2026-11-15.bak", 11_534_336, 12),
    ("data/tmp/upload-3f9a.part", 524_288, 33), ("data/tmp/upload-77c1.part", 262_144, 35),
    ("data/notes.md", 2_048, 5),
]
for rel, size, age in files:
    mk(rel, size, age)

# The request log: one row per request, like an export from a load balancer.
rnd = random.Random(42)
paths = [("/api/orders", 120, 40), ("/api/orders/{id}", 45, 15), ("/api/customers", 310, 90), ("/health", 3, 1),
         ("/api/search", 840, 300), ("/login", 95, 30)]
weights = [30, 25, 10, 20, 8, 7]
lines = ["Time,Method,Path,Status,Ms"]
t0 = 1764230400  # 2025-11-27 08:00 UTC: fixed, so the file is the same every time
for i in range(400):
    path, mean, spread = rnd.choices(paths, weights)[0]
    method = "POST" if path == "/login" or (path == "/api/orders" and rnd.random() < .3) else "GET"
    status = rnd.choices([200, 201, 204, 304, 400, 401, 404, 500, 503], [60, 6, 3, 8, 5, 4, 6, 5, 3])[0]
    if path == "/health": status = 200
    ms = max(1, int(rnd.gauss(mean, spread)))
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0 + i * 17))
    lines.append(f"{ts},{method},{path},{status},{ms}")
os.makedirs(os.path.join(home, "data"), exist_ok=True)
with open(os.path.join(home, "data", "requests.csv"), "w") as f:
    f.write("\n".join(lines) + "\n")
EOF
