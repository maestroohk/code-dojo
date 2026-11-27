# Boss: the night the deploy pipeline died. ~/infra/shop with its state on the team's state server, then:
#   1  a lock left by the dead job, and the pull request it was applying renames random_password.db (no moved block)
#   2  a colleague "fixed" a failing plan with terraform state rm random_password.db
#   3  someone re-initialised against a new, empty state key: the plan wants to create everything
set -e -o pipefail
stage=${1:-1}
bash "$DOJO_FILES/shop.sh" remote
. "$DOJO_FILES/lib.sh"
cd ~/infra/shop
cat > backend.tf <<'EOF'
terraform {
  backend "http" {
    address        = "http://127.0.0.1:8300/state/shop-prod"
    lock_address   = "http://127.0.0.1:8300/state/shop-prod"
    unlock_address = "http://127.0.0.1:8300/state/shop-prod"
  }
}
EOF
terraform init -migrate-state -force-copy -input=false -no-color >/dev/null
rm -f terraform.tfstate terraform.tfstate.backup
printf '.terraform/\n*.tfstate\n*.tfstate.*\ntfplan\n*.tfplan\nout/\n' > .gitignore
git init -q . && git add -A && GIT_AUTHOR_DATE='2026-11-20T09:00:00Z' GIT_COMMITTER_DATE='2026-11-20T09:00:00Z' git commit -qm "Shop infra on the state server"
mkdir -p ~/ci
case $stage in
  1)
    sed -i 's/"random_password" "db"/"random_password" "postgres"/; s/random_password\.db\.result/random_password.postgres.result/g' main.tf
    GIT_AUTHOR_NAME='Jo Park' GIT_AUTHOR_EMAIL='jo@example.com' git commit -qam "Rename the DB password resource to postgres (naming standard)"
    created=$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%S.000000000Z)
    curl -fsS -X LOCK http://127.0.0.1:8300/state/shop-prod -d "{\"ID\":\"9a41c2e7-55d0-4b8e-a3f6-0e2d7c9b1f85\",\"Operation\":\"OperationTypeApply\",\"Info\":\"\",\"Who\":\"runner@ci-runner-3\",\"Version\":\"1.17.2\",\"Created\":\"$created\",\"Path\":\"\"}" >/dev/null
    printf '%s  job 5102 (deploy shop-prod, commit %s) started on ci-runner-3\n%s  Acquiring state lock. This may take a few moments...\n          ERROR: runner ci-runner-3 lost connection. Job 5102 marked failed. No apply output was received.\n' \
      "$created" "$(git rev-parse --short HEAD)" "$created" > ~/ci/job-5102.log
    ;;
  2)
    terraform state rm -no-color random_password.db >/dev/null
    printf 'plan kept failing on the db password so I ran `terraform state rm random_password.db`. plan works now but wants to create a new one?? -- Jo\n' > ~/ci/notes.txt
    ;;
  3)
    sed -i 's#/state/shop-prod"#/state/shop-prod-v2"#' backend.tf
    terraform init -reconfigure -input=false -no-color >/dev/null
    printf 'trying the new state layout from the platform RFC, will finish tomorrow -- Alex\n' > ~/ci/notes.txt
    ;;
esac
note serial "$(curl -fsS http://127.0.0.1:8300/state/shop-prod | jq .serial)"
