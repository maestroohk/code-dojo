# Lesson 3: LogTools with its manifest, an empty folder to serve as the team's package feed, and a script with
# the kind of problems PSScriptAnalyzer exists for.
set -e -o pipefail
bash "$DOJO_FILES/tests.sh"
mkdir -p ~/feed ~/scripts
cat > ~/scripts/Mount-ReportShare.ps1 <<'EOF'
# Mount-ReportShare.ps1: connects the reports share for the month-end job.
[CmdletBinding()]
param(
    [string] $UserName = 'svc-reports',
    [string] $Password
)
$secure = ConvertTo-SecureString $Password -AsPlainText -Force
$credential = [pscredential]::new($UserName, $secure)
$unused = 'left over from debugging'
Write-Host "would mount \\files.example.com\reports as $($credential.UserName)"
EOF
