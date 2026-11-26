# Module 8: the team's WinOps module, laid out the usual way (one public function per file under Public/), with the
# Pester tests that define each function. The Windows-only cmdlets are mocked in the tests, so it all runs on Linux.
set -e -o pipefail
mkdir -p ~/src/WinOps/Public ~/src/WinOps/tests
cat > ~/src/WinOps/WinOps.psm1 <<'EOF'
# WinOps.psm1: loads every public function from Public/*.ps1 (one function per file) and exports them.
$public = Get-ChildItem -Path (Join-Path $PSScriptRoot 'Public') -Filter *.ps1
foreach ($file in $public) { . $file.FullName }
Export-ModuleMember -Function $public.BaseName
EOF
for f in Get-LowDisk Get-FailedLogon Register-NightlyCleanup; do
  printf 'function %s {\n    throw "%s is not written yet"\n}\n' "$f" "$f" > ~/src/WinOps/Public/$f.ps1
done
cp "$DOJO_FILES"/tests/*.Tests.ps1 ~/src/WinOps/tests/
