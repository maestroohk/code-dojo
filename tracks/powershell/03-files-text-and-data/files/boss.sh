# Boss: reports written by Windows PowerShell 5.1, a search that finds nothing, and a photo rename gone wrong.
set -e -o pipefail
bash "$DOJO_FILES/data.sh"
mkdir -p ~/reports ~/photos ~/scripts
python3 - <<'EOF'
import os
home = os.path.expanduser("~")
# Written by `... > weekly.txt` in Windows PowerShell 5.1: UTF-16 LE with a BOM, CRLF line ends.
reports = {
    "weekly.txt": ["Weekly ops report", "ERROR backup job failed on db01", "OK    certificates renewed", "ERROR disk 91% on fs02", "OK    patching done"],
    "daily.txt": ["Daily ops report", "OK    all green", "ERROR queue depth over 10k at 03:10"],
}
for name, lines in reports.items():
    with open(os.path.join(home, "reports", name), "wb") as f:
        f.write(b"\xff\xfe" + "\r\n".join(lines + [""]).encode("utf-16-le"))
for stamp in ["20261103_141210", "20261103_141502", "20261104_090000", "20261112_183344"]:
    open(os.path.join(home, "photos", f"IMG_{stamp}.jpg"), "wb").write(b"\xff\xd8\xff\xe0 jpeg " + stamp.encode())
open(os.path.join(home, "photos", "cover.png"), "wb").write(b"\x89PNG not a camera photo")
EOF
cat > ~/scripts/count-price-errors.ps1 <<'EOF'
# count-price-errors.ps1: how many requests were rejected with the price error, per service log.
Select-String -Path "$HOME/logs/*.log" -Pattern "price: $5.00 (USD)" |
    Group-Object Filename -NoElement |
    ForEach-Object { "$($_.Name) $($_.Count)" }
"total $(@(Select-String -Path "$HOME/logs/*.log" -Pattern "price: $5.00 (USD)").Count)"
EOF
cat > ~/scripts/rename-photos.ps1 <<'EOF'
# rename-photos.ps1: IMG_20261103_141210.jpg -> 2026-11-03_141210.jpg, so photos sort by date in any viewer.
Get-ChildItem -Path "$HOME/photos" -Filter 'IMG_*.jpg' |
    Rename-Item -NewName { $_.Name -replace '^IMG_(\d{4})(\d{2})(\d{2})_(\d{6})', "$1-$2-$3_$4" } -WhatIf
EOF
