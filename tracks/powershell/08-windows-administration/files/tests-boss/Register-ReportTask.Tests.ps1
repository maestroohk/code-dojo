BeforeAll {
    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        function global:New-ScheduledTaskAction { [CmdletBinding()] param($Execute, $Argument, $WorkingDirectory) }
        function global:New-ScheduledTaskTrigger { [CmdletBinding()] param([switch] $Daily, $At, [switch] $Once, [switch] $AtStartup) }
        function global:Register-ScheduledTask { [CmdletBinding(SupportsShouldProcess)] param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, $User, [switch] $Force) }
    }
    Import-Module "$HOME/src/WinOps/WinOps.psm1" -Force
}

Describe 'Register-ReportTask' {
    BeforeEach {
        Mock New-ScheduledTaskAction -ModuleName WinOps { 'action' }
        Mock New-ScheduledTaskTrigger -ModuleName WinOps { 'trigger' }
        Mock Register-ScheduledTask -ModuleName WinOps { }
    }
    It 'runs PowerShell 7, not Windows PowerShell 5.1' {
        Register-ReportTask -ScriptPath 'C:\Ops Scripts\Send-Report.ps1'
        Should -Invoke New-ScheduledTaskAction -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Execute -eq 'pwsh.exe' }
    }
    It 'quotes the script path, which has a space' {
        Register-ReportTask -ScriptPath 'C:\Ops Scripts\Send-Report.ps1'
        Should -Invoke New-ScheduledTaskAction -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Argument -match '-File "C:\\Ops Scripts\\Send-Report\.ps1"' }
    }
    It 'cannot hang on a prompt and ignores profiles' {
        Register-ReportTask -ScriptPath 'C:\Ops Scripts\Send-Report.ps1'
        Should -Invoke New-ScheduledTaskAction -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Argument -match '-NonInteractive' -and $Argument -match '-NoProfile' }
    }
    It 'still registers the task at 06:00' {
        Register-ReportTask -ScriptPath 'C:\Ops Scripts\Send-Report.ps1'
        Should -Invoke New-ScheduledTaskTrigger -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Daily -and ([datetime]$At).ToString('HH:mm') -eq '06:00' }
        Should -Invoke Register-ScheduledTask -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $TaskName -eq 'Morning report' }
    }
}
