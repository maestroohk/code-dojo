# Module 5: the team's LogTools functions as a .psm1 in a git repo, a folder of logs with known ages.
set -e -o pipefail
mkdir -p ~/src/LogTools/tests ~/logs/archive ~/answers /opt/dojo/state
cat > ~/src/LogTools/LogTools.psm1 <<'EOF'
# LogTools.psm1: find and remove old log files.

function Get-Cutoff {
    # Private helper: the date before which a file counts as old.
    param([int] $Days)
    (Get-Date).AddDays(-$Days)
}

function Get-OldLog {
    <#
    .SYNOPSIS
        Lists the files in a folder that were last changed more than -Days days ago.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [ValidateRange(1, 3650)] [int] $Days = 30
    )
    $cutoff = Get-Cutoff $Days
    Get-ChildItem -LiteralPath $Path -File | Where-Object LastWriteTime -lt $cutoff
}

function Remove-OldLog {
    <#
    .SYNOPSIS
        Deletes the piped files that were last changed more than -Days days ago. Supports -WhatIf.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory, ValueFromPipeline)] [System.IO.FileInfo] $File,
        [ValidateRange(1, 3650)] [int] $Days = 30
    )
    begin { $cutoff = Get-Cutoff $Days }
    process {
        if ($File.LastWriteTime -lt $cutoff -and $PSCmdlet.ShouldProcess($File.FullName, 'Remove old log')) {
            Remove-Item -LiteralPath $File.FullName
        }
    }
}
EOF
cd ~/logs/archive
for spec in "app-1.log 5" "app-2.log 20" "app-3.log 31" "app-4.log 45" "app-5.log 90"; do
  set -- $spec; echo "log $1" > "$1"; touch -d "$2 days ago" "$1"
done
cd ~/src/LogTools && git init -q && git add -A && git commit -qm "LogTools: first version" >/dev/null
