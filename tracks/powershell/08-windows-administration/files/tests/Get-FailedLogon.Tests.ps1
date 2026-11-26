BeforeAll {
    if (-not (Get-Command Get-WinEvent -ErrorAction SilentlyContinue)) {
        function global:Get-WinEvent { [CmdletBinding()] param($FilterHashtable, $MaxEvents, $ComputerName, $LogName) }
    }
    Import-Module "$HOME/src/WinOps/WinOps.psm1" -Force

    # A 4625 event as Get-WinEvent returns it: the interesting values are in .Properties, by position
    # (5 = TargetUserName, 19 = IpAddress for this event ID).
    function New-FakeLogonFailure([string] $User, [string] $Ip) {
        $props = 0..20 | ForEach-Object { [pscustomobject]@{ Value = '-' } }
        $props[5] = [pscustomobject]@{ Value = $User }
        $props[19] = [pscustomobject]@{ Value = $Ip }
        [pscustomobject]@{ Id = 4625; TimeCreated = (Get-Date).AddMinutes(-5); Properties = $props }
    }
}

Describe 'Get-FailedLogon' {
    BeforeEach {
        Mock Get-WinEvent -ModuleName WinOps {
            New-FakeLogonFailure 'svc-backup' '10.20.0.15'
            New-FakeLogonFailure 'asha' '10.20.4.33'
            New-FakeLogonFailure 'svc-backup' '10.20.0.15'
            New-FakeLogonFailure 'svc-backup' '10.20.0.16'
            New-FakeLogonFailure 'administrator' '203.0.113.50'
        }
    }
    It 'queries the Security log for event 4625 with a start time' {
        $null = Get-FailedLogon -Hours 24
        Should -Invoke Get-WinEvent -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $FilterHashtable.LogName -eq 'Security' -and $FilterHashtable.Id -eq 4625 -and
            $FilterHashtable.StartTime -is [datetime] -and
            [math]::Abs(((Get-Date).AddHours(-24) - $FilterHashtable.StartTime).TotalMinutes) -lt 5
        }
    }
    It 'summarises failures per user, most first' {
        $r = Get-FailedLogon
        $r[0].User | Should -Be 'svc-backup'
        $r[0].Count | Should -Be 3
        @($r).Count | Should -Be 3
    }
    It 'lists the source addresses per user' {
        $r = Get-FailedLogon | Where-Object User -eq 'svc-backup'
        $r.Sources | Should -Be @('10.20.0.15', '10.20.0.16')
    }
    It 'returns nothing (no error) when there are no failures' {
        Mock Get-WinEvent -ModuleName WinOps { throw [System.Exception]::new('No events were found that match the specified selection criteria.') }
        Get-FailedLogon | Should -BeNullOrEmpty
    }
}
