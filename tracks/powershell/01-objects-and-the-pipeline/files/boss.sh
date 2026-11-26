# Boss: three reports a teammate wrote, each one quietly wrong. The data is the module's usual tree plus a sales export.
set -e -o pipefail
bash "$DOJO_FILES/data.sh"
mkdir -p ~/scripts ~/reports
cat > ~/data/sales.csv <<'EOF'
Customer,Orders,Revenue
Northwind Traders,41,9500
Contoso Pharmacy,12,104000
Fabrikam Bikes,88,12000
Tailspin Toys,5,870
Adventure Works,63,23500
Wide World Importers,19,98000
Litware Labs,7,1150
EOF
cat > ~/scripts/big-files.ps1 <<'EOF'
# big-files.ps1: lists files over a size limit, biggest first. Runs every morning from the ops scheduler.
param([string] $Path = "$HOME/data", [long] $Over = 5MB)

$big = Get-ChildItem -Path $Path -Recurse -File | Where-Object { $_.Lenght -gt $Over }
"$(@($big).Count) files over $($Over / 1MB) MB"
$big | Sort-Object Length -Descending | ForEach-Object { '{0,10:N0} KB  {1}' -f ($_.Length / 1KB), $_.FullName }
EOF
cat > ~/scripts/top-customers.ps1 <<'EOF'
# top-customers.ps1: the three customers with the most revenue, for the weekly sales mail.
$sales = Import-Csv -Path "$HOME/data/sales.csv"
$sales | Sort-Object Revenue -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Customer): $($_.Revenue)" }
EOF
cat > ~/scripts/export-report.ps1 <<'EOF'
# export-report.ps1: customers and revenue as a CSV for finance. Finance says the file is "full of nonsense".
Import-Csv -Path "$HOME/data/sales.csv" |
    Format-Table Customer, Revenue |
    Export-Csv -Path "$HOME/reports/revenue.csv"
EOF
