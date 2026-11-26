BeforeAll {
    Import-Module "$HOME/src/WinOps/WinOps.psm1" -Force
}

Describe 'Set-AgentConfig' {
    BeforeEach {
        Mock Test-Path -ModuleName WinOps { $false }
        Mock New-Item -ModuleName WinOps { }
        Mock New-ItemProperty -ModuleName WinOps { }
    }
    It 'creates the key when it does not exist yet' {
        Set-AgentConfig -Enabled $true -Confirm:$false
        Should -Invoke New-Item -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Path -eq 'HKLM:\SOFTWARE\Contoso\Agent' -and $Force }
    }
    It 'writes Enabled as a DWord 1 or 0, not as a string' {
        Set-AgentConfig -Enabled $true -Confirm:$false
        Should -Invoke New-ItemProperty -ModuleName WinOps -Times 1 -Exactly -ParameterFilter {
            $Path -eq 'HKLM:\SOFTWARE\Contoso\Agent' -and $Name -eq 'Enabled' -and "$PropertyType" -eq 'DWord' -and $Value -is [int] -and $Value -eq 1 -and $Force
        }
        Set-AgentConfig -Enabled $false -Confirm:$false
        Should -Invoke New-ItemProperty -ModuleName WinOps -Times 1 -Exactly -ParameterFilter { $Value -is [int] -and $Value -eq 0 }
    }
    It 'changes nothing with -WhatIf' {
        Set-AgentConfig -Enabled $true -WhatIf
        Should -Invoke New-Item -ModuleName WinOps -Times 0 -Exactly
        Should -Invoke New-ItemProperty -ModuleName WinOps -Times 0 -Exactly
    }
}
