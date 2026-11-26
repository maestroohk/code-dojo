# Boss: three WinOps functions with the bugs from three tickets, and the tests that pin the right behaviour down.
set -e -o pipefail
bash "$DOJO_FILES/winops.sh"
cp "$DOJO_FILES"/tests-boss/*.Tests.ps1 ~/src/WinOps/tests/
cat > ~/src/WinOps/Public/Get-RebootHistory.ps1 <<'EOF'
function Get-RebootHistory {
    <#
    .SYNOPSIS
        Who restarted this server in the last -Days days, and why (event 1074).
    #>
    [CmdletBinding()]
    param([ValidateRange(1, 365)] [int] $Days = 7)
    $filter = @{ LogName = 'System'; ProviderName = 'User32'; Id = 1074; StartTime = (Get-Date).AddDays($Days) }
    Get-WinEvent -FilterHashtable $filter -ErrorAction SilentlyContinue |
        Sort-Object TimeCreated |
        ForEach-Object {
            [pscustomobject]@{ Time = $_.TimeCreated; User = $_.Properties[6].Value; Comment = $_.Properties[5].Value }
        }
}
EOF
cat > ~/src/WinOps/Public/Register-ReportTask.ps1 <<'EOF'
function Register-ReportTask {
    <#
    .SYNOPSIS
        Registers the morning report as a scheduled task.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $ScriptPath)
    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-File $ScriptPath"
    $trigger = New-ScheduledTaskTrigger -Daily -At '06:00'
    Register-ScheduledTask -TaskName 'Morning report' -Action $action -Trigger $trigger -User 'NT AUTHORITY\SYSTEM' -Force
}
EOF
cat > ~/src/WinOps/Public/Set-AgentConfig.ps1 <<'EOF'
function Set-AgentConfig {
    <#
    .SYNOPSIS
        Turns the monitoring agent on or off in the registry.
    #>
    param([Parameter(Mandatory)] [bool] $Enabled)
    $key = 'HKLM:\SOFTWARE\Contoso\Agent'
    New-ItemProperty -Path $key -Name Enabled -PropertyType String -Value "$([int]$Enabled)" -Force
}
EOF
cat > ~/src/WinOps/TICKETS.md <<'EOF'
OPS-3101  "Reboot report is always empty, but we restarted SRV-APP01 twice this week."
OPS-3107  "Morning report task: Last Run Result 0x1. Running the script by hand in pwsh works.
           The script lives in 'C:\Ops Scripts\' and uses the ?? operator."
OPS-3112  "Set-AgentConfig on a new server: 'Cannot find path HKLM:\SOFTWARE\Contoso\Agent because it does not
           exist'. On an old server it 'worked' but the agent still ignores Enabled."
EOF
