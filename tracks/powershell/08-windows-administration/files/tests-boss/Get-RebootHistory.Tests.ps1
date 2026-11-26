BeforeAll {
    if (-not (Get-Command Get-WinEvent -ErrorAction SilentlyContinue)) {
        function global:Get-WinEvent { [CmdletBinding()] param($FilterHashtable, $MaxEvents, $ComputerName, $LogName) }
    }
    Import-Module "$HOME/src/WinOps/WinOps.psm1" -Force

    # Event 1074 (provider User32): 0 = process, 2 = reason, 4 = shutdown type, 5 = comment, 6 = user.
    function New-FakeShutdown([datetime] $When, [string] $User, [string] $Comment) {
        $p = 0..6 | ForEach-Object { [pscustomobject]@{ Value = '' } }
        $p[0].Value = 'C:\Windows\system32\shutdown.exe (SRV-APP01)'
        $p[2].Value = 'Other (Planned)'; $p[4].Value = 'restart'; $p[5].Value = $Comment; $p[6].Value = $User
        [pscustomobject]@{ Id = 1074; TimeCreated = $When; Properties = $p }
    }
}

Describe 'Get-RebootHistory' {
    BeforeEach {
        Mock Get-WinEvent -ModuleName WinOps {
            New-FakeShutdown (Get-Date).AddDays(-1) 'CORP\asha' 'Patch Tuesday'
            New-FakeShutdown (Get-Date).AddDays(-3) 'NT AUTHORITY\SYSTEM' 'Windows Update'
        }
    }
    It 'asks for User32 event 1074 in the System log since -Days ago' {
        $null = Get-RebootHistory -Days 7
        Should -Invoke Get-WinEvent -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $FilterHashtable.LogName -eq 'System' -and $FilterHashtable.ProviderName -eq 'User32' -and $FilterHashtable.Id -eq 1074 -and
            [math]::Abs(((Get-Date).AddDays(-7) - $FilterHashtable.StartTime).TotalMinutes) -lt 5
        }
    }
    It 'reports who restarted and why, newest first' {
        $r = @(Get-RebootHistory -Days 7)
        $r.Count | Should -Be 2
        $r[0].User | Should -Be 'CORP\asha'
        $r[0].Comment | Should -Be 'Patch Tuesday'
        $r[0].Time | Should -BeGreaterThan $r[1].Time
    }
}
