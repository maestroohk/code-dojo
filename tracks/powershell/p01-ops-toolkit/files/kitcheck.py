#!/usr/bin/env python3
# Project checks for OpsKit, computed from the scenario's own data. Usage: kitcheck.py usage|usage-html|scans|expenses|expenses-html
import csv, json, os, re, shutil, subprocess, sys, tempfile, time
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_EVEN

home = os.path.expanduser("~")

def pwsh(code):
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-c", "Import-Module ~/src/OpsKit/OpsKit.psm1 -Force; " + code],
                       capture_output=True, text=True, timeout=25)
    return r.stdout.strip(), r.stderr.strip()

def objects(code):
    out, err = pwsh(code + " | ConvertTo-Json -Depth 3 -AsArray")
    try:
        return json.loads(out)
    except Exception:
        sys.exit("the function did not run: " + (err or out)[-500:])

what = sys.argv[1]
if what == "usage":
    got = objects("Get-FolderUsage -Path ~/share")
    want = []
    for d in os.listdir(os.path.join(home, "share")):
        files = [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(home, "share", d)) for f in fs]
        size = sum(os.path.getsize(f) for f in files)
        want.append({"Folder": d, "Files": len(files), "SizeMB": round(size / 1048576, 1)})
    want.sort(key=lambda x: -x["SizeMB"])
    norm = [{"Folder": g.get("Folder"), "Files": g.get("Files"), "SizeMB": g.get("SizeMB")} for g in got]
    if norm != want:
        sys.exit(f"Get-FolderUsage -Path ~/share returned {norm}\nexpected {want}")
    print("ok", [(w["Folder"], w["SizeMB"]) for w in want])
elif what == "usage-html":
    p = os.path.join(home, "reports", "share-usage.html")
    if not os.path.exists(p): sys.exit("~/reports/share-usage.html does not exist yet")
    h = open(p, encoding="utf-8-sig").read()
    if "<table>" not in h or "<title>Share usage</title>" not in h: sys.exit("the report should be an HTML page titled 'Share usage' with a table (ConvertTo-Html -Title 'Share usage')")
    for d in ["Engineering", "Finance", "Sales", "HR", "Shared"]:
        if f"<td>{d}</td>" not in h: sys.exit(f"the table has no row for {d}")
    print("ok")
elif what == "scans":
    tmp = tempfile.mkdtemp(); d = os.path.join(tmp, "scans")
    shutil.copytree("/opt/dojo/state/scans", d)   # copytree keeps the times (copy2)
    want = sorted(time.strftime("%Y-%m-%d_%H%M_", time.localtime(os.path.getmtime(os.path.join(d, f)))) + f
                  for f in os.listdir(d) if f.endswith(".pdf")) + ["README.txt"]
    want.sort()
    pwsh(f"Rename-ScanByDate -Path '{d}' -WhatIf")
    if sorted(os.listdir(d)) != sorted(os.listdir("/opt/dojo/state/scans")): sys.exit("-WhatIf renamed files: it must change nothing")
    out, err = pwsh(f"@(Rename-ScanByDate -Path '{d}').Count")
    if sorted(os.listdir(d)) != want: sys.exit(f"after a run the folder holds {sorted(os.listdir(d))}\nexpected {want}")
    if out.splitlines()[-1:] != ["5"]: sys.exit(f"the function should output the 5 renamed files, it output {out[-200:]!r}")
    pwsh(f"Rename-ScanByDate -Path '{d}'")
    if sorted(os.listdir(d)) != want: sys.exit(f"a second run renamed files again: {sorted(os.listdir(d))}")
    print("ok", want[:2], "...")
elif what in ("expenses", "expenses-html"):
    rows = list(csv.DictReader(open(os.path.join(home, "expenses-2026-11.csv"))))
    tot = defaultdict(Decimal); n = defaultdict(int)
    for r in rows: tot[r["Department"]] += Decimal(r["Amount"]); n[r["Department"]] += 1
    want = sorted(({"Department": d, "Items": n[d], "Total": float(tot[d])} for d in tot), key=lambda x: -x["Total"])
    out = os.path.join(tempfile.mkdtemp(), "report.html")
    got = objects(f"New-ExpenseReport -Path ~/expenses-2026-11.csv -OutFile '{out}' -Title 'Expenses 2026-11'")
    norm = [{"Department": g.get("Department"), "Items": g.get("Items"), "Total": float(g.get("Total"))} for g in got]
    if what == "expenses":
        if norm != want: sys.exit(f"New-ExpenseReport returned {norm}\nexpected {want}")
        print("ok", [(w["Department"], w["Total"]) for w in want])
    else:
        if not os.path.exists(out): sys.exit("New-ExpenseReport did not write the -OutFile")
        h = open(out, encoding="utf-8-sig").read()
        if "<title>Expenses 2026-11</title>" not in h: sys.exit("the page title should be the -Title ('Expenses 2026-11'): with ConvertTo-Html -Head, put <title> in the head yourself")
        if "<table>" not in h: sys.exit("the report has no table")
        for w in want:
            if f"<td>{w['Department']}</td>" not in h: sys.exit(f"no row for {w['Department']}")
        pwsh(f"New-ExpenseReport -Path ~/expenses-2026-11.csv -OutFile '{out}.whatif' -WhatIf | Out-Null")
        if os.path.exists(out + ".whatif"): sys.exit("-WhatIf wrote the report file: it must write nothing")
        print("ok")
else:
    sys.exit("unknown check")
