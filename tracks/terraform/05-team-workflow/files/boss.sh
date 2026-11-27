# Boss: ~/infra/web-envs, one root module, a backend config file and a tfvars file per environment, states on the
# team's state server. Stages (the argument):
#   1  dev is applied; prod has a tfvars file but no backend config yet
#   2  both applied; ci/testdata holds three real plan JSONs for the gate script
#   3  both applied; a saved plan of PR 41 (replicas 3 -> 4) is waiting, but another change was applied after it
. "$DOJO_FILES/lib.sh"
stage=${1:-1}
dojo-tfstate start
mkdir -p ~/infra/web-envs/envs ~/infra/web-envs/ci && cd ~/infra/web-envs
cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
  backend "http" {}
}
EOF
cat > main.tf <<'EOF'
variable "env" {
  type = string
}

variable "replicas" {
  type = number
}

resource "random_pet" "web" {
  prefix = var.env
  length = 2
}

resource "terraform_data" "deploy" {
  input = {
    env      = var.env
    replicas = var.replicas
  }
}

resource "local_file" "conf" {
  filename = "${path.module}/out/${var.env}/web.conf"
  content  = "name=${random_pet.web.id}\nreplicas=${var.replicas}\n"
}
EOF
backend_file() { # $1 = env
  printf 'address        = "http://127.0.0.1:8300/state/web-%s"\nlock_address   = "http://127.0.0.1:8300/state/web-%s"\nunlock_address = "http://127.0.0.1:8300/state/web-%s"\n' "$1" "$1" "$1"
}
backend_file dev > envs/dev.tfbackend
printf 'env      = "dev"\nreplicas = 1\n' > envs/dev.tfvars
printf 'env      = "prod"\nreplicas = 3\n' > envs/prod.tfvars
cat > README.md <<'EOF'
# web-envs

One root module, one state per environment:

    terraform init -reconfigure -backend-config=envs/<env>.tfbackend
    terraform plan -var-file=envs/<env>.tfvars -out=tfplan
    terraform apply tfplan
EOF
up() { # $1 = env
  terraform init -reconfigure -input=false -no-color -backend-config="envs/$1.tfbackend" >/dev/null
  terraform apply -input=false -auto-approve -no-color -var-file="envs/$1.tfvars" >/dev/null
}
up dev
note dev-serial "$(curl -fsS http://127.0.0.1:8300/state/web-dev | jq .serial)"
if [ "$stage" -ge 2 ]; then
  backend_file prod > envs/prod.tfbackend
  up prod
fi
if [ "$stage" = 2 ]; then
  # Three real plans for the gate: create-only (a new env), update-only (a new deploy setting), destructive (a rename).
  mkdir -p ci/testdata /tmp/gate && cp versions.tf main.tf /tmp/gate/ && cd /tmp/gate
  sed -i '/backend "http" {}/d' versions.tf
  terraform init -input=false -no-color >/dev/null
  terraform plan -input=false -no-color -var env=qa -var replicas=1 -out=p >/dev/null && terraform show -json p > ~/infra/web-envs/ci/testdata/new-env.json
  terraform apply -input=false -auto-approve -no-color -var env=qa -var replicas=1 >/dev/null
  sed -i 's/    replicas = var.replicas/    replicas = var.replicas\n    owner    = "platform"/' main.tf
  terraform plan -input=false -no-color -var env=qa -var replicas=1 -out=p >/dev/null && terraform show -json p > ~/infra/web-envs/ci/testdata/add-owner.json
  terraform plan -input=false -no-color -var env=staging -var replicas=1 -out=p >/dev/null && terraform show -json p > ~/infra/web-envs/ci/testdata/rename-env.json
  cd ~/infra/web-envs && rm -rf /tmp/gate
fi
if [ "$stage" = 3 ]; then
  # PR 41 was planned yesterday and is waiting to be applied...
  sed -i 's/replicas = 3/replicas = 4/' envs/prod.tfvars
  terraform plan -input=false -no-color -var-file=envs/prod.tfvars -out=ci/pr-41.tfplan >/dev/null
  # ...but this morning the hotfix pipeline applied PR 43 (an extra setting) to prod first.
  sed -i 's/    replicas = var.replicas/    replicas = var.replicas\n    log_level = "warn"/' main.tf
  terraform fmt >/dev/null
  sed -i 's/replicas = 4/replicas = 3/' envs/prod.tfvars
  terraform apply -input=false -auto-approve -no-color -var-file=envs/prod.tfvars >/dev/null
  sed -i 's/replicas = 3/replicas = 4/' envs/prod.tfvars
  cat > ci/NOTES.txt <<'EOF'
PR 41 (prod: 3 -> 4 replicas) was approved and merged yesterday; its saved plan is ci/pr-41.tfplan.
PR 43 (log_level = "warn") was merged and applied to prod by the hotfix pipeline this morning.
Apply PR 41 to prod.
EOF
fi
note prod-serial "$(curl -fsS http://127.0.0.1:8300/state/web-prod 2>/dev/null | jq .serial 2>/dev/null || echo none)"
