# Boss: a remote clean-up whose dry run deletes everything, a cache warmer that floods the API, and a script that
# cannot find its secret in CI.
set -e -o pipefail
bash "$DOJO_FILES/ssh.sh"
bash "$DOJO_FILES/api.sh"
python3 - <<'EOF'
import os
with open(os.path.expanduser("~/scripts/cache-urls.txt"), "w") as f:
    for i in range(1, 31):
        f.write(f"http://127.0.0.1:8088/delay?ms=1000&id=page{i:02d}\n")
EOF
cat > ~/scripts/clean-remote.ps1 <<'EOF'
# clean-remote.ps1: deletes old app logs on every web server. -DryRun shows what would go.
[CmdletBinding()]
param(
    [string[]] $Server = @('web01', 'web02'),
    [ValidateRange(1, 3650)] [int] $Days = 30,
    [switch] $DryRun
)
Invoke-Command -HostName $Server -UserName learner -ScriptBlock {
    Get-ChildItem -Path /srv/logs/app -File |
        Where-Object LastWriteTime -lt (Get-Date).AddDays(-$Days) |
        Remove-Item -WhatIf:$DryRun -Verbose
}
EOF
cat > ~/scripts/warm-cache.ps1 <<'EOF'
# warm-cache.ps1: requests every page once after a deploy, so the first customers do not wait.
$results = Get-Content "$PSScriptRoot/cache-urls.txt" | ForEach-Object -Parallel {
    try { $null = Invoke-RestMethod -Uri $_ -TimeoutSec 5; 'ok' } catch { 'failed' }
} -ThrottleLimit 30
"warmed $(@($results -eq 'ok').Count), failed $(@($results -eq 'failed').Count)"
EOF
cat > ~/scripts/ci-ticket-count.ps1 <<'EOF'
# ci-ticket-count.ps1: the capacity check the CI pipeline runs. Works on the admin's laptop, fails in CI.
$ErrorActionPreference = 'Stop'
$token = Get-Secret -Name OpsApiToken -AsPlainText
$headers = @{ Authorization = "Bearer $token" }
$uri = 'http://127.0.0.1:8088/api/tickets'
$all = while ($uri) { $p = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 10; $p.items; $uri = $p.next }
"tickets: $(@($all).Count)"
EOF
rm -f ~/.config/ops/api-token
