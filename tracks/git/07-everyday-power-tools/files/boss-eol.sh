# Boss: a mixed repo with shell scripts, PowerShell scripts and images, all committed with whatever endings people had.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/tools
printf '#!/bin/bash\r\necho build\r\n' > build.sh
printf '#!/bin/bash\necho test\n' > test.sh
chmod +x build.sh test.sh
printf 'Write-Host "deploy"\n' > deploy.ps1
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' > logo.png
write README.md "# Tools"
commit "Add the team tools" "Ana Silva"