# Lessons 2 and later: LogTools with its manifest (lesson 1's result) and starter test files.
set -e -o pipefail
bash "$DOJO_FILES/src.sh"
pwsh -NoProfile -NonInteractive -c "New-ModuleManifest -Path ~/src/LogTools/LogTools.psd1 -RootModule LogTools.psm1 -ModuleVersion 1.0.0 -FunctionsToExport Get-OldLog, Remove-OldLog -CmdletsToExport @() -VariablesToExport @() -AliasesToExport @() -Author 'Ops team' -Description 'Find and remove old log files.' -PowerShellVersion 7.4 -CompatiblePSEditions Core"
cat > ~/src/LogTools/tests/Get-OldLog.Tests.ps1 <<'EOF'
BeforeAll {
    Import-Module "$PSScriptRoot/../LogTools.psd1" -Force
}

Describe 'Get-OldLog' {
    # Write your tests here.
}
EOF
cat > ~/src/LogTools/tests/Remove-OldLog.Tests.ps1 <<'EOF'
BeforeAll {
    Import-Module "$PSScriptRoot/../LogTools.psd1" -Force
}

Describe 'Remove-OldLog' {
    # Write your tests here.
}
EOF
cd ~/src/LogTools && git add -A && git commit -qm "Manifest and test files" >/dev/null
