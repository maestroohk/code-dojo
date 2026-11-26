# Lesson 1, step 8: the parameterised disk-usage script (the previous step's result), still without help or -Verbose.
set -e -o pipefail
bash "$DOJO_FILES/data.sh"
cat > ~/scripts/Get-DiskUsage.ps1 <<'EOF'
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string] $Path,

    [ValidateRange(1, 100)]
    [int] $Top = 10,

    [ValidateSet('KB', 'MB', 'GB')]
    [string] $Unit = 'MB'
)

$divisor = @{ KB = 1KB; MB = 1MB; GB = 1GB }[$Unit]
Get-ChildItem -LiteralPath $Path -Recurse -File |
    Sort-Object Length -Descending |
    Select-Object -First $Top |
    Select-Object Name, @{ Name = 'Size'; Expression = { [math]::Round($_.Length / $divisor, 1) } }
EOF
