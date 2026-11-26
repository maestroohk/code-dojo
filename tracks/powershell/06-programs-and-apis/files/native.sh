# Lesson 1: a backup script that trusts tar too much, and three Git repositories in different states for a helper.
set -e -o pipefail
mkdir -p ~/scripts ~/backup ~/app/config ~/app/data ~/repos ~/answers
echo '{ "port": 8080 }' > ~/app/config/app.json
echo 'id,name' > ~/app/data/customers.csv
cat > ~/scripts/backup.ps1 <<'EOF'
# backup.ps1: archives the app's config and data folders. The scheduler alerts on a non-zero exit code.
param(
    [string[]] $Folder = @("$HOME/app/config", "$HOME/app/data"),
    [string] $Target = "$HOME/backup"
)
$ErrorActionPreference = 'Stop'
$archive = Join-Path $Target "app-$(Get-Date -Format 'yyyyMMdd-HHmmss').tar.gz"
tar -czf $archive @Folder
"backup complete: $archive"
EOF
mk() { # mk NAME BRANCH: a repo with two commits on BRANCH
  git init -q -b "$2" ~/repos/$1 && cd ~/repos/$1
  echo "# $1" > README.md && git add . && git commit -qm "Initial commit"
  echo "v1" > VERSION && git add . && git commit -qm "Add VERSION"
}
mk billing main
mk portal main; git -C ~/repos/portal switch -q -c feature/sso; echo "sso" > ~/repos/portal/sso.md
echo "change" >> ~/repos/portal/README.md
mk reports release/2026.11; echo "tmp" > ~/repos/reports/notes.txt; echo "x" > ~/repos/reports/draft.md; echo "v2" > ~/repos/reports/VERSION
mkdir -p ~/repos/not-a-repo && echo "just a folder" > ~/repos/not-a-repo/readme.txt
