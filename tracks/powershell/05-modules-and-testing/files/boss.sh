# Boss: LogTools 1.2.0 on a red CI run, a test that calls the real API, and an install that will not load.
set -e -o pipefail
bash "$DOJO_FILES/tests.sh"
mkdir -p ~/ci
cd ~/src/LogTools
# 1.2.0: someone tightened -Days and added Send-LogSummary.
python3 - <<'EOF'
import os
p = os.path.expanduser("~/src/LogTools/LogTools.psm1")
s = open(p).read()
s = s.replace("[ValidateRange(1, 3650)] [int] $Days = 30\n    )\n    $cutoff", "[ValidateRange(1, 30)] [int] $Days = 30\n    )\n    $cutoff")
s += '''
function Send-LogSummary {
    <#
    .SYNOPSIS
        Posts how many old logs a folder has to the ops dashboard.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Path, [string] $Uri = 'https://ops.example.com/api/log-summary')
    $old = @(Get-OldLog -Path $Path)
    Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json' -Body (@{ path = $Path; oldFiles = $old.Count } | ConvertTo-Json)
}
'''
open(p, "w").write(s)
EOF
pwsh -NoProfile -NonInteractive -c "Update-ModuleManifest -Path ~/src/LogTools/LogTools.psd1 -ModuleVersion 1.2.0 -FunctionsToExport Get-OldLog, Remove-OldLog, Send-LogSummary"
cat > tests/Get-OldLog.Tests.ps1 <<'EOF'
BeforeAll {
    Import-Module "$PSScriptRoot/../LogTools.psd1" -Force
}

Describe 'Get-OldLog' {
    BeforeEach {
        foreach ($f in @{ Name = 'new.log'; Days = 2 }, @{ Name = 'mid.log'; Days = 40 }, @{ Name = 'old.log'; Days = 100 }) {
            $item = New-Item -Path "TestDrive:/$($f.Name)" -ItemType File -Force
            $item.LastWriteTime = (Get-Date).AddDays(-$f.Days)
        }
    }
    It 'returns files older than 30 days by default' {
        (Get-OldLog -Path TestDrive:/).Name | Sort-Object | Should -Be @('mid.log', 'old.log')
    }
    It 'keeps 90 days of audit logs' {
        (Get-OldLog -Path TestDrive:/ -Days 90).Name | Should -Be 'old.log'
    }
}
EOF
cat > tests/Send-LogSummary.Tests.ps1 <<'EOF'
BeforeAll {
    Import-Module "$PSScriptRoot/../LogTools.psd1" -Force
}

Describe 'Send-LogSummary' {
    It 'posts the number of old files' {
        Mock Invoke-RestMethod { }
        $old = New-Item -Path 'TestDrive:/old.log' -ItemType File -Force
        $old.LastWriteTime = (Get-Date).AddDays(-40)
        Send-LogSummary -Path TestDrive:/
        Should -Invoke Invoke-RestMethod -Times 1 -Exactly -ParameterFilter { ($Body | ConvertFrom-Json).oldFiles -eq 1 }
    }
}
EOF
git add -A && git commit -qm "LogTools 1.2.0: Send-LogSummary, stricter -Days" >/dev/null
# What the pipeline printed (the same run, done for real, cut to the interesting part).
pwsh -NoProfile -NonInteractive -c "Invoke-Pester ~/src/LogTools/tests/Get-OldLog.Tests.ps1 -Output Detailed" > ~/ci/pester-run.log 2>&1 || true
sed -i 's#/home/learner/src/LogTools#/agent/_work/7/s#g' ~/ci/pester-run.log

# A colleague's install of 1.2.0 that will not load: the folder says 1.2.0, the manifest inside says 1.1.0.
dest=~/.local/share/powershell/Modules/LogTools/1.2.0
mkdir -p "$dest"
cp ~/src/LogTools/LogTools.psm1 ~/src/LogTools/LogTools.psd1 "$dest/"
sed -i "s/ModuleVersion = '1.2.0'/ModuleVersion = '1.1.0'/" "$dest/LogTools.psd1"
