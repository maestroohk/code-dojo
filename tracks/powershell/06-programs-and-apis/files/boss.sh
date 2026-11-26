# Boss: a health check monitoring cannot trust, a report that reads one page, and a token that will not authenticate.
set -e -o pipefail
bash "$DOJO_FILES/api.sh"
cat > ~/scripts/services.json <<'EOF'
[
  { "name": "orders",  "url": "http://127.0.0.1:8091/health" },
  { "name": "billing", "url": "http://127.0.0.1:8092/health" },
  { "name": "search",  "url": "http://127.0.0.1:8093/health" },
  { "name": "notify",  "url": "http://127.0.0.1:8094/health" }
]
EOF
cat > ~/scripts/Test-ServiceHealth.ps1 <<'EOF'
# Test-ServiceHealth.ps1: run every minute by the monitoring agent, which pages on-call when the exit code is not 0.
param([string] $ConfigPath = "$PSScriptRoot/services.json")
$services = Get-Content -Raw $ConfigPath | ConvertFrom-Json
foreach ($s in $services) {
    $r = Invoke-RestMethod -Uri $s.url
    "$($s.name) $($r.status)"
}
EOF
cat > ~/scripts/urgent-report.ps1 <<'EOF'
# urgent-report.ps1: how many urgent tickets are there? Posted to the team channel every morning.
$token = (Get-Content -Raw "$HOME/.config/ops/api-token").Trim()
$headers = @{ Authorization = "Bearer $token" }
$tickets = (Invoke-RestMethod -Uri 'http://127.0.0.1:8088/api/tickets' -Headers $headers -TimeoutSec 10).items
"urgent: $(@($tickets | Where-Object priority -eq 'urgent').Count)"
EOF
cat > ~/scripts/ticket-count.ps1 <<'EOF'
# ticket-count.ps1: total number of tickets, for the capacity dashboard.
$token = Get-Content -Raw "$HOME/.config/ops/api-token"
$headers = @{ Authorization = "Bearer $token" }
$uri = 'http://127.0.0.1:8088/api/tickets'
$all = while ($uri) { $p = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 10; $p.items; $uri = $p.next }
"tickets: $(@($all).Count)"
EOF
