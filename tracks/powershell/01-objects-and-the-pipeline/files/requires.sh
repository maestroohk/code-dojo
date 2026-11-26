# Lesson 1, step 2: a script that only works in PowerShell 7 (it uses ?? and ForEach-Object -Parallel).
set -e -o pipefail
mkdir -p ~/scripts ~/logs/old
for n in 1 2 3; do echo "line $n" > ~/logs/old/app.$n.log; done
cat > ~/scripts/rotate.ps1 <<'EOF'
# rotate.ps1: compresses old app logs, several at a time.
param($Path)
$Path = $Path ?? "$HOME/logs/old"
Get-ChildItem -Path $Path -Filter *.log | ForEach-Object -Parallel {
    Compress-Archive -Path $_.FullName -DestinationPath "$($_.FullName).zip" -Force
} -ThrottleLimit 2
"ok: rotated $((Get-ChildItem -Path $Path -Filter *.zip).Count) logs"
EOF
