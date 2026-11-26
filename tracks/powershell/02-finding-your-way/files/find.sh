# Module 2 scenarios: an app log, a release folder, and scripts written in a hurry.
set -e -o pipefail
mkdir -p ~/answers ~/logs ~/release/bin ~/release/config ~/scripts
python3 - <<'EOF'
import os, random
rnd = random.Random(7)
lv = ["INFO"] * 12 + ["WARN"] * 3 + ["ERROR"]
msgs = {"INFO": ["request served", "cache hit", "user signed in", "job finished"],
        "WARN": ["slow query (1.8 s)", "retrying upstream call", "disk 82% full"],
        "ERROR": ["upstream timed out after 30 s", "could not open /var/app/queue.db"]}
with open(os.path.expanduser("~/logs/app.log"), "w") as f:
    for i in range(2000):
        l = rnd.choice(lv)
        f.write(f"2026-11-26T{8 + i // 400:02d}:{(i // 7) % 60:02d}:{i % 60:02d}Z {l:5} {rnd.choice(msgs[l])} (req {1000 + i})\n")
EOF
printf 'echo "app 4.2.0"\n' > ~/release/bin/app.sh
printf '{ "port": 8080 }\n' > ~/release/config/appsettings.json
printf '# App 4.2.0\nRelease notes.\n' > ~/release/README.md
