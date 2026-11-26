BeforeAll {
    # Get-CimInstance only exists on Windows. On the Linux build agent, a stub with the same name and parameters
    # stands in for it, so it can be mocked.
    if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
        function global:Get-CimInstance { [CmdletBinding()] param($ClassName, $Filter, $ComputerName, $CimSession) }
    }
    Import-Module "$HOME/src/WinOps/WinOps.psm1" -Force
}

Describe 'Get-LowDisk' {
    BeforeEach {
        Mock Get-CimInstance -ModuleName WinOps {
            @(
                [pscustomobject]@{ DeviceID = 'C:'; Size = 127GB; FreeSpace = 9GB; DriveType = 3 }
                [pscustomobject]@{ DeviceID = 'D:'; Size = 500GB; FreeSpace = 300GB; DriveType = 3 }
                [pscustomobject]@{ DeviceID = 'E:'; Size = 200GB; FreeSpace = 22GB; DriveType = 3 }
            )
        }
    }
    It 'asks CIM for local fixed disks only' {
        $null = Get-LowDisk
        Should -Invoke Get-CimInstance -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $ClassName -eq 'Win32_LogicalDisk' -and $Filter -match 'DriveType\s*=\s*3'
        }
    }
    It 'returns the disks below 15 percent free by default' {
        (Get-LowDisk).Drive | Should -Be @('C:', 'E:')
    }
    It 'reports free space in GB and percent, rounded to one decimal' {
        $c = Get-LowDisk | Where-Object Drive -eq 'C:'
        $c.FreeGB | Should -Be 9
        $c.PercentFree | Should -Be 7.1
    }
    It 'honours -BelowPercent' {
        (Get-LowDisk -BelowPercent 10).Drive | Should -Be 'C:'
    }
    It 'passes -ComputerName on to CIM' {
        $null = Get-LowDisk -ComputerName 'fs01.corp.example.com'
        Should -Invoke Get-CimInstance -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $ComputerName -eq 'fs01.corp.example.com' }
    }
}
