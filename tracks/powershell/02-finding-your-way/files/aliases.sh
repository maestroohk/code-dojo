# Lesson 2: a one-liner someone pasted into a scheduled script, written with interactive shortcuts.
set -e -o pipefail
bash "$DOJO_FILES/find.sh"
python3 - <<'EOF'
import os
home = os.path.expanduser("~")
for i, size in enumerate([4096, 900, 20480, 3000, 12288]):
    p = os.path.join(home, "logs", "archive", f"app.{i + 1}.log")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write("x" * size)
EOF
cat > ~/scripts/report-logs.ps1 <<'EOF'
# report-logs.ps1: names and sizes of the archived logs over 2 KB, biggest first.
gci ~/logs/archive | ? { $_.Length -gt 2kb } | Sort-Object Length -desc | select Name, Length | % { "$($_.Name) $($_.Length)" }
EOF
