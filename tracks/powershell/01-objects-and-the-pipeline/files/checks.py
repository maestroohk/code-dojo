#!/usr/bin/env python3
# Checks for module 1: recompute the answer from ~/data/requests.csv and compare it with the learner's CSV.
# Usage: checks.py status | slow | slow-cold   (prints what it found; exit 0 = pass)
import csv, os, sys
from collections import defaultdict

home = os.path.expanduser("~")
rows = list(csv.DictReader(open(os.path.join(home, "data", "requests.csv"))))

def read(name):
    path = os.path.join(home, "answers", name)
    if not os.path.exists(path):
        sys.exit(f"{path} does not exist yet")
    raw = open(path, encoding="utf-8-sig").read()
    if raw.lstrip().startswith("#TYPE"):
        sys.exit("The file starts with a #TYPE line: that is Windows PowerShell 5.1's Export-Csv default. Here, just Export-Csv -Path ... works.")
    out = list(csv.DictReader(raw.splitlines()))
    return out, (out and list(out[0].keys())) or []

def need_columns(cols, want):
    if cols != want:
        sys.exit(f"columns are {cols}, expected exactly {want} in that order (Select-Object picks and orders them)")

what = sys.argv[1]
if what == "status":
    got, cols = read("status.csv")
    need_columns(cols, ["Status", "Count"])
    counts = defaultdict(int)
    for r in rows: counts[r["Status"]] += 1
    if {r["Status"]: int(r["Count"]) for r in got} != counts:
        sys.exit("the counts do not match the log: " + ", ".join(f"{r['Status']}={r['Count']}" for r in got))
    nums = [int(r["Count"]) for r in got]
    if nums != sorted(nums, reverse=True):
        sys.exit("the rows are not sorted by Count, biggest first: " + ", ".join(map(str, nums)))
    print("ok:", ", ".join(f"{r['Status']}={r['Count']}" for r in got))
elif what in ("slow", "slow-cold"):
    got, cols = read("slow.csv")
    need_columns(cols, ["Path", "Requests", "AvgMs"])
    by = defaultdict(list)
    for r in rows: by[r["Path"]].append(int(r["Ms"]))
    if {r["Path"] for r in got} != set(by):
        sys.exit("expected one row per path: " + ", ".join(sorted(by)))
    for r in got:
        ms = by[r["Path"]]
        if int(r["Requests"]) != len(ms):
            sys.exit(f"{r['Path']}: Requests is {r['Requests']}, the log has {len(ms)}")
        try:
            avg = float(r["AvgMs"])
        except ValueError:
            sys.exit(f"{r['Path']}: AvgMs is '{r['AvgMs']}', not a number")
        if avg != int(avg) or abs(avg - sum(ms) / len(ms)) > 1:
            sys.exit(f"{r['Path']}: AvgMs is {r['AvgMs']}, expected the average {sum(ms) / len(ms):.2f} rounded to a whole number")
    avgs = [float(r["AvgMs"]) for r in got]
    if avgs != sorted(avgs, reverse=True):
        sys.exit("the rows are not sorted by AvgMs, slowest first")
    print("ok:", ", ".join(f"{r['Path']}={r['AvgMs']}" for r in got))
else:
    sys.exit("unknown check " + what)
