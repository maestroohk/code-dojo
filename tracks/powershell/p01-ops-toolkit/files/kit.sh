# Project: OpsKit, the team's daily-chores module. Sets up the module skeleton (one function per file, like WinOps),
# a file share with departments, a scanner inbox, and a month of expenses. Stage N also gets the reference
# solutions of stages 1..N-1 (KIT_STAGE=N), so every stage can be done on its own.
set -e -o pipefail
mkdir -p ~/src/OpsKit/Public ~/src/OpsKit/tests ~/reports ~/answers /opt/dojo/state
cat > ~/src/OpsKit/OpsKit.psm1 <<'EOF'
# OpsKit.psm1: loads every public function from Public/*.ps1 and exports them.
$public = Get-ChildItem -Path (Join-Path $PSScriptRoot 'Public') -Filter *.ps1
foreach ($file in $public) { . $file.FullName }
Export-ModuleMember -Function $public.BaseName
EOF
python3 - <<'EOF'
import os, random, time
home = os.path.expanduser("~")
now = time.time()
def mk(p, size, age):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(b"x" * size)
    os.utime(p, (now - age * 86400, now - age * 86400))
# The department share: sizes chosen so the ranking is clear.
share = {"Finance": [(f"q{i}.xlsx", 3_000_000 + i * 1000) for i in range(4)],
         "Engineering": [(f"build/artifact{i}.zip", 9_000_000) for i in range(3)] + [("specs/design.docx", 400_000)],
         "Sales": [("leads.csv", 250_000), ("deck.pptx", 6_500_000)],
         "HR": [("policies.pdf", 120_000)],
         "Shared": []}
for dept, files in share.items():
    os.makedirs(os.path.join(home, "share", dept), exist_ok=True)
    for name, size in files:
        mk(os.path.join(home, "share", dept, name), size, 10)
# The scanner inbox: files named by the scanner, dated by when they were scanned.
for i, (age_days, hour) in enumerate([(30, 9), (30, 9), (12, 14), (3, 8), (1, 17)]):
    p = os.path.join(home, "scans", f"scan{i + 1:04d}.pdf")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(b"%PDF-1.7 scan " + str(i).encode())
    t = time.mktime(time.strptime("2026-11-26 00:00", "%Y-%m-%d %H:%M")) - age_days * 86400 + hour * 3600 + i * 60
    os.utime(p, (t, t))
open(os.path.join(home, "scans", "README.txt"), "w").write("Scanner drops PDFs here.\n")
# A month of expenses, exported from the finance system.
rnd = random.Random(5)
depts = ["Engineering", "Finance", "Sales", "HR"]
cats = ["Travel", "Software", "Hardware", "Training"]
lines = ["Date,Department,Category,Amount,Currency"]
for d in range(1, 31):
    for _ in range(rnd.randint(1, 3)):
        lines.append(f"2026-11-{d:02d},{rnd.choice(depts)},{rnd.choice(cats)},{rnd.randint(20, 2400)}.{rnd.randint(0, 99):02d},EUR")
open(os.path.join(home, "expenses-2026-11.csv"), "w").write("\n".join(lines) + "\n")
EOF
cp -a ~/scans /opt/dojo/state/scans && chmod -R a+rwX /opt/dojo/state
stage=${KIT_STAGE:-1}
for f in Get-FolderUsage Rename-ScanByDate New-ExpenseReport; do
  printf 'function %s {\n    throw "%s is not written yet"\n}\n' "$f" "$f" > ~/src/OpsKit/Public/$f.ps1
done
[ "$stage" -gt 1 ] && cp "$DOJO_FILES/ref/Get-FolderUsage.ps1" ~/src/OpsKit/Public/
[ "$stage" -gt 2 ] && cp "$DOJO_FILES/ref/Rename-ScanByDate.ps1" ~/src/OpsKit/Public/
[ "$stage" -gt 3 ] && cp "$DOJO_FILES/ref/New-ExpenseReport.ps1" ~/src/OpsKit/Public/
true
