# Lesson 3: a copy job whose catch block never runs, and an import that fails on one bad record.
set -e -o pipefail
mkdir -p ~/scripts ~/reports/out ~/share/reports ~/data ~/answers
for n in sales stock returns; do echo "id,value" > ~/reports/out/$n.csv; done
cat > ~/scripts/copy-reports.ps1 <<'EOF'
# copy-reports.ps1: copies tonight's reports to the share. The scheduler alerts when the script exits non-zero.
param(
    [string] $Source = "$HOME/reports/out",
    [string] $Target = "$HOME/share/reports"
)
try {
    Copy-Item -Path (Join-Path $Source '*.csv') -Destination $Target
    Write-Output "copied reports to $Target"
}
catch {
    Write-Output "FAILED to copy reports: $_"
    exit 1
}
EOF
cat > ~/data/orders.json <<'EOF'
[
  { "Id": 1, "Customer": "Northwind", "Amount": 120.00 },
  { "Id": 2, "Customer": "Contoso", "Amount": 75.50 },
  { "Id": 3, "Customer": "Fabrikam", "Amount": 300.00 },
  { "Id": 4, "Customer": "Tailspin", "Amount": 12,50 },
  { "Id": 5, "Customer": "Litware", "Amount": 42.00 },
  { "Id": 6, "Customer": "Adventure Works", "Amount": 250.00 }
]
EOF
cat > ~/scripts/import-orders.ps1 <<'EOF'
# import-orders.ps1: totals the day's orders from the web shop export.
param([string] $Path = "$HOME/data/orders.json")
$ErrorActionPreference = 'Stop'
$orders = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
$total = ($orders | Measure-Object -Property Amount -Sum).Sum
"orders: $($orders.Count), total: $total"
EOF
