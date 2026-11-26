# Boss: three scripts moved from a Windows laptop to the Linux build agents, each failing in its own way.
set -e -o pipefail
bash "$DOJO_FILES/find.sh"
mkdir -p ~/scripts ~/logs/old
for f in a b c d e; do echo "$f" > ~/logs/old/$f.log; done
touch -d '3 days ago' ~/logs/old/a.log; touch -d '45 days ago' ~/logs/old/b.log; touch -d '60 days ago' ~/logs/old/c.log
touch -d '1 day ago' ~/logs/old/d.log; touch -d '90 days ago' ~/logs/old/e.log
touch -d '2 days ago' ~/logs/app.log

cat > ~/scripts/newest-logs.ps1 <<'EOF'
# newest-logs.ps1: the three most recently changed logs, newest last. Written on Windows.
ls ~/logs -Recurse -Filter *.log | sort LastWriteTime | select -Last 3 | % { $_.Name }
EOF

cat > ~/scripts/lib.ps1 <<'EOF'
# lib.ps1: shared helpers for the nightly scripts.
function Get-Greeting {
    param([string] $Team = 'ops')
    "Good night, $Team. Backups start at 01:00."
}
EOF
cat > ~/scripts/nightly.ps1 <<'EOF'
# nightly.ps1: the scheduler runs this from / every night.
& ./lib.ps1
Get-Greeting -Team platform
EOF

cat > ~/scripts/stale.ps1 <<'EOF'
# stale.ps1: finds logs nobody touched for 30 days, for the clean-up job.
function Get-StaleFile {
    param([string] $Path = "$HOME/logs/old", [int] $Days = 30)
    foreach ($file in Get-ChildItem -Path $Path -File) {
        if ($file.LastWriteTime -lt (Get-Date).AddDays(-$Days)) {
            Write-Host $file.FullName
        }
    }
}

$stale = Get-StaleFile
"Found $(@($stale).Count) stale files"
EOF
