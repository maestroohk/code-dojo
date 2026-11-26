# Lesson 3: the API, a script that reads its token from a file, and a SecretStore already configured for
# unattended use (no password: see the lesson for what that trades away). No vault is registered yet.
set -e -o pipefail
bash "$DOJO_FILES/api.sh"
chown -R learner:learner /home/learner
runuser -u learner -- env HOME=/home/learner pwsh -NoProfile -NonInteractive -c \
  'Reset-SecretStore -Authentication None -Interaction None -Force -Confirm:$false 3>$null'
cat > ~/scripts/ticket-count.ps1 <<'EOF'
# ticket-count.ps1: total number of tickets, for the capacity dashboard. Runs as a scheduled job.
$token = (Get-Content -Raw "$HOME/.config/ops/api-token").Trim()
$headers = @{ Authorization = "Bearer $token" }
$uri = 'http://127.0.0.1:8088/api/tickets'
$all = while ($uri) { $p = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 10; $p.items; $uri = $p.next }
"tickets: $(@($all).Count)"
EOF
