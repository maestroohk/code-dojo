#!/usr/bin/env python3
# Module 6 checks against the lesson API's own data. Usage: checks.py open-tickets
import csv, os, sys
sys.path.insert(0, os.path.dirname(__file__))

def tickets():
    pri = ["low", "normal", "high", "urgent"]
    st = ["open", "open", "closed", "open", "pending"]
    return [{"id": 1000 + i, "title": f"Ticket {1000 + i}: " + ["disk full", "cert expiring", "login slow", "backup failed",
             "VPN drops", "printer offline", "queue backlog"][i % 7], "priority": pri[(i * 3) % 4], "status": st[i % 5]}
            for i in range(47)]

if sys.argv[1] == "open-tickets":
    p = os.path.expanduser("~/answers/open-tickets.csv")
    if not os.path.exists(p): sys.exit("~/answers/open-tickets.csv does not exist yet")
    rows = list(csv.DictReader(open(p, encoding="utf-8-sig")))
    cols = list(rows[0].keys()) if rows else []
    if cols != ["Id", "Title", "Priority"]: sys.exit(f"columns are {cols}, expected Id, Title, Priority")
    want = [(str(t["id"]), t["title"], t["priority"]) for t in tickets() if t["status"] == "open"]
    got = [(r["Id"], r["Title"], r["Priority"]) for r in rows]
    if sorted(got) == sorted(want): print(f"ok: {len(got)} open tickets"); sys.exit(0)
    ids = {g[0] for g in got}
    if len(got) < len(want) and all(int(i) < 1020 for i in ids):
        sys.exit(f"{len(got)} rows, all from the first page: the API has {len(want)} open tickets across 3 pages")
    sys.exit(f"{len(got)} rows; expected the {len(want)} tickets whose status is 'open', from all pages")
