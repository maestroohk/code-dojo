# Lesson 1: the API with slow endpoints, and folders whose sizes a parallel script adds up (wrongly).
set -e -o pipefail
bash "$DOJO_FILES/api.sh"
python3 - <<'EOF'
import os
home = os.path.expanduser("~")
for d, sizes in {"eu": [1000, 2500, 300], "us": [7000, 120], "apac": [4096, 4096, 50, 9]}.items():
    os.makedirs(os.path.join(home, "shares", d), exist_ok=True)
    for i, s in enumerate(sizes):
        open(os.path.join(home, "shares", d, f"f{i}.bin"), "wb").write(b"x" * s)
EOF
cat > ~/scripts/total-size.ps1 <<'EOF'
# total-size.ps1: adds up the size of every regional share, one share per thread (the real shares are slow to scan).
$total = 0
Get-ChildItem -Path "$HOME/shares" -Directory | ForEach-Object -Parallel {
    $size = (Get-ChildItem -Path $_.FullName -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $total += $size
} -ThrottleLimit 4
"total bytes: $total"
EOF
