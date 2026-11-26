# Lesson 1: the data tree, and a first draft of a disk-usage script with no parameters at all.
set -e -o pipefail
bash "$DOJO_FILES/data.sh"
cat > ~/scripts/Get-DiskUsage.ps1 <<'EOF'
# Get-DiskUsage.ps1: the biggest files under a folder. First draft: everything is hard-coded.
$Path = "$HOME/data"
$Top = 10
Get-ChildItem -Path $Path -Recurse -File |
    Sort-Object Length -Descending |
    Select-Object -First $Top |
    Select-Object Name, @{ Name = 'Size'; Expression = { [math]::Round($_.Length / 1MB, 1) } }
EOF
