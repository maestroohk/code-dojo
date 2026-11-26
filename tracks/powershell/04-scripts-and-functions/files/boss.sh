# Boss: a sync job that hides its failures, a job that leaves its lock behind, and an error record from a ticket.
set -e -o pipefail
mkdir -p ~/scripts ~/exports ~/share/exports ~/run ~/data ~/incident ~/deploy ~/logs ~/answers /opt/dojo/state/goodexports
for n in customers orders invoices stock payroll; do echo "id,$n" > ~/exports/$n.csv; done
cp ~/exports/customers.csv ~/exports/orders.csv ~/exports/invoices.csv ~/exports/stock.csv /opt/dojo/state/goodexports/
# Nobody may read payroll.csv (mode 000), so the copy of that one file fails.
chmod 000 ~/exports/payroll.csv
chmod -R a+rX /opt/dojo/state

cat > ~/scripts/sync-exports.ps1 <<'EOF'
# sync-exports.ps1: copies the nightly exports to the finance share.
param(
    [string] $Source = "$HOME/exports",
    [string] $Target = "$HOME/share/exports"
)
$ErrorActionPreference = 'SilentlyContinue'   # "the share is flaky, don't spam the log"

$files = Get-ChildItem -Path $Source -Filter *.csv -File
foreach ($file in $files) {
    Copy-Item -LiteralPath $file.FullName -Destination $Target -Force
}
"sync complete: $($files.Count) files"
EOF

cat > ~/scripts/work.ps1 <<'EOF'
# work.ps1: the nightly work. Fails when the input has not arrived.
$ErrorActionPreference = 'Stop'
$rows = Import-Csv -LiteralPath "$HOME/data/input.csv"
"processed $(@($rows).Count) rows"
EOF
cat > ~/scripts/nightly.ps1 <<'EOF'
# nightly.ps1: makes sure only one nightly run happens at a time.
$ErrorActionPreference = 'Stop'
$lock = "$HOME/run/nightly.lock"
if (Test-Path -LiteralPath $lock) { throw "Another run is in progress (lock: $lock)" }
New-Item -ItemType File -Path $lock | Out-Null

& "$PSScriptRoot/work.ps1"

Remove-Item -LiteralPath $lock
"done"
EOF
# Last night's run failed and left its lock behind.
echo "pid 4711, started 2026-11-26T01:00:03Z" > ~/run/nightly.lock

cp "$DOJO_FILES/incident-error.txt" ~/incident/error.txt
{
  echo "# deploy.ps1: rolls out a release and records it in the deploy log."
  echo "[CmdletBinding()]"
  echo "param([string] \$Version = '4.2.0')"
  echo "\$ErrorActionPreference = 'Stop'"
  echo ""
  for i in $(seq 1 20); do echo "Write-Verbose 'step $i'"; done
  echo "function Write-DeployLog([string] \$Message) {"
  echo "    Add-Content -Path /var/log/deploy.log -Value \"\$(Get-Date -Format o) \$Message\""
  echo "}"
  echo "Write-DeployLog \"deployed \$Version\""
} > ~/deploy/deploy.ps1
