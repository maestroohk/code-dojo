# Lesson 1, step 2: a helper script whose function names use made-up verbs.
set -e -o pipefail
bash "$DOJO_FILES/find.sh"
cat > ~/scripts/tools.ps1 <<'EOF'
# tools.ps1: small helpers the team dot-sources into their sessions.
function Fetch-Report {
    param([string] $Name = 'daily')
    "report: $Name"
}

function Delete-OldLogs {
    param([string] $Path = "$HOME/logs", [int] $Days = 30)
    Get-ChildItem -Path $Path -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-$Days)
}

function Make-Folder {
    param([string] $Name)
    "would create $Name"
}

Fetch-Report -Name weekly
Make-Folder -Name archive
EOF
