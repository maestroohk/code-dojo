BeforeAll {
    # The ScheduledTasks module exists only on Windows: stubs with the real parameter names stand in for it here.
    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        function global:New-ScheduledTaskAction { [CmdletBinding()] param($Execute, $Argument, $WorkingDirectory) }
        function global:New-ScheduledTaskTrigger { [CmdletBinding()] param([switch] $Daily, $At, [switch] $Once, [switch] $AtStartup) }
        function global:New-ScheduledTaskPrincipal { [CmdletBinding()] param($UserId, $LogonType, $RunLevel) }
        function global:New-ScheduledTaskSettingsSet { [CmdletBinding()] param($ExecutionTimeLimit, [switch] $StartWhenAvailable) }
        function global:Register-ScheduledTask { [CmdletBinding(SupportsShouldProcess)] param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, [switch] $Force) }
    }
    Import-Module "$HOME/src/WinOps/WinOps.psm1" -Force
}

Describe 'Register-NightlyCleanup' {
    BeforeEach {
        Mock New-ScheduledTaskAction -ModuleName WinOps { 'action' }
        Mock New-ScheduledTaskTrigger -ModuleName WinOps { 'trigger' }
        Mock New-ScheduledTaskPrincipal -ModuleName WinOps { 'principal' }
        Mock New-ScheduledTaskSettingsSet -ModuleName WinOps { 'settings' }
        Mock Register-ScheduledTask -ModuleName WinOps { }
    }
    It 'runs the script with pwsh.exe, no profile, non-interactive, -File and the path in quotes' {
        Register-NightlyCleanup -ScriptPath 'C:\Ops Scripts\Clean-Logs.ps1'
        Should -Invoke New-ScheduledTaskAction -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $Execute -eq 'pwsh.exe' -and
            $Argument -match '(^|\s)-NoProfile(\s|$)' -and $Argument -match '(^|\s)-NonInteractive(\s|$)' -and
            $Argument -match '-File "C:\\Ops Scripts\\Clean-Logs\.ps1"'
        }
    }
    It 'runs daily at the time given (default 02:00)' {
        Register-NightlyCleanup -ScriptPath 'C:\Ops\Clean-Logs.ps1'
        Should -Invoke New-ScheduledTaskTrigger -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Daily -and ([datetime]$At).ToString('HH:mm') -eq '02:00' }
        Register-NightlyCleanup -ScriptPath 'C:\Ops\Clean-Logs.ps1' -At '03:30'
        Should -Invoke New-ScheduledTaskTrigger -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Daily -and ([datetime]$At).ToString('HH:mm') -eq '03:30' }
    }
    It 'runs as SYSTEM, elevated, without a stored password' {
        Register-NightlyCleanup -ScriptPath 'C:\Ops\Clean-Logs.ps1'
        Should -Invoke New-ScheduledTaskPrincipal -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $UserId -eq 'NT AUTHORITY\SYSTEM' -and "$LogonType" -eq 'ServiceAccount' -and "$RunLevel" -eq 'Highest'
        }
    }
    It 'stops a run that hangs for more than 2 hours' {
        Register-NightlyCleanup -ScriptPath 'C:\Ops\Clean-Logs.ps1'
        Should -Invoke New-ScheduledTaskSettingsSet -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $ExecutionTimeLimit -is [timespan] -and $ExecutionTimeLimit.TotalHours -eq 2
        }
    }
    It 'registers it under \Ops\ with all the parts' {
        Register-NightlyCleanup -ScriptPath 'C:\Ops\Clean-Logs.ps1' -TaskName 'Nightly log cleanup'
        Should -Invoke Register-ScheduledTask -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $TaskName -eq 'Nightly log cleanup' -and $TaskPath -eq '\Ops\' -and
            $Action -eq 'action' -and $Trigger -eq 'trigger' -and $Principal -eq 'principal' -and $Settings -eq 'settings'
        }
    }
    It 'supports -WhatIf' {
        Register-NightlyCleanup -ScriptPath 'C:\Ops\Clean-Logs.ps1' -WhatIf
        Should -Invoke Register-ScheduledTask -ModuleName WinOps -Times 0 -Exactly
    }
}
