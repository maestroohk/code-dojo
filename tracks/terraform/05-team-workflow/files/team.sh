# Module 5 scenarios. The argument picks one:
#   workspaces  ~/infra/api: a config that names things after terraform.workspace, applied in "default" only
#   ci          ~/infra/shop-repo: a repo whose CI (make ci) fails: formatting, validate and tflint
#   policy      ~/infra/policy-demo: two real saved plans as JSON (one safe, one destructive) and an empty policy/
#   upgrade     ~/infra/api pinned to random ~> 3.7.0 (lock file at 3.7.2), in Git
#   replace     ~/infra/deploy: a deploy key that leaked, applied
. "$DOJO_FILES/lib.sh"
mode=${1:-workspaces}
versions() { # $1 = random constraint
  cat > versions.tf <<EOF
terraform {
  required_version = ">= 1.10"
  required_providers {
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    random = { source = "hashicorp/random", version = "${1:-~> 3.9}" }
    tls    = { source = "hashicorp/tls", version = "~> 4.4" }
  }
}
EOF
}
case $mode in
  workspaces|upgrade)
    mkdir -p ~/infra/api && cd ~/infra/api
    if [ "$mode" = upgrade ]; then versions '~> 3.7.0'; else versions; fi
    cat > main.tf <<'EOF'
locals {
  env = terraform.workspace
}

resource "random_pet" "api" {
  length = 2
  prefix = local.env
}

resource "local_file" "api_conf" {
  filename = "${path.module}/out/${local.env}/api.conf"
  content  = "name=${random_pet.api.id}\nreplicas=${local.env == "prod" ? 3 : 1}\n"
}
EOF
    tfinit . && tfapply .
    if [ "$mode" = upgrade ]; then
      printf '.terraform/\n*.tfstate\n*.tfstate.*\ntfplan\n*.tfplan\nout/\nTICKET.txt\n' > .gitignore
      printf 'DEP-12: move to the current hashicorp/random 3.9 (3.7 is out of support). Keep the API name.\n' > TICKET.txt
      git init -q . && git add -A && git commit -qm "API config"
      note pet "$(terraform state show -no-color random_pet.api | sed -n 's/^ *id *= *"\(.*\)"/\1/p')"
    fi
    ;;
  ci)
    mkdir -p ~/infra/shop-repo/modules/notify ~/infra/shop-repo/envs/prod && cd ~/infra/shop-repo
    cat > Makefile <<'EOF'
# What CI runs on every pull request. Run it locally before you push: make ci
TF ?= terraform

ci: fmt validate lint

fmt:
	$(TF) fmt -recursive -check -diff

validate:
	cd envs/prod && $(TF) init -backend=false -input=false -no-color >/dev/null && $(TF) validate -no-color

lint:
	tflint --recursive --no-color

.PHONY: ci fmt validate lint
EOF
    cat > .tflint.hcl <<'EOF'
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
EOF
    cat > modules/notify/main.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local = { source = "hashicorp/local", version = "~> 2.9" }
  }
}

variable "env" {
  type        = string
  description = "Deployment environment."
}

variable "channels" {
  type        = list(string)
  description = "Where alerts go."
}

variable "retention_days" {
  description = "How long alert history is kept."
}

resource "local_file" "notify" {
  filename = "${path.root}/out/${var.env}/notify.json"
  content = jsonencode({
    env = var.env
      channels = var.channels
  })
}

output "file" {
  description = "The rendered notification config."
  value       = local_file.notify.filename
}
EOF
    cat > envs/prod/main.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local = { source = "hashicorp/local", version = "~> 2.9" }
  }
}

module "notify" {
  source         = "../../modules/notify"
  env            = "prod"
  channels       = ["#oncall", "#platform"]
  retention_days = 30
}

output "notify_file" {
  description = "Where the notification config is written."
  value       = module.notify.filenme
}
EOF
    git init -q . && printf '.terraform/\n*.tfstate*\n*.tfplan\ntfplan\nout/\n' > .gitignore && git add -A && git commit -qm "Notify module and prod env"
    ;;
  policy)
    mkdir -p ~/infra/policy-demo/policy ~/infra/policy-demo/plans && cd ~/infra/policy-demo
    mkdir -p /tmp/pd && cd /tmp/pd && versions
    cat > main.tf <<'EOF'
resource "random_password" "db" {
  length  = 24
  special = false
}

resource "tls_private_key" "api" {
  algorithm = "ED25519"
}

resource "local_file" "motd" {
  filename        = "${path.module}/out/motd.txt"
  content         = "hello\n"
  file_permission = "0644"
}
EOF
    tfinit . && tfapply .
    sed -i 's/hello/hello, world/' main.tf
    terraform plan -input=false -no-color -out=safe.tfplan >/dev/null
    terraform show -json safe.tfplan > ~/infra/policy-demo/plans/safe.json
    # The bad pull request: rotates the DB password, removes the API key, and opens up a file.
    sed -i 's/length  = 24/length  = 32/; s/file_permission = "0644"/file_permission = "0666"/' main.tf
    sed -i '/resource "tls_private_key" "api"/,/^}/d' main.tf
    terraform plan -input=false -no-color -out=bad.tfplan >/dev/null
    terraform show -json bad.tfplan > ~/infra/policy-demo/plans/bad.json
    cd ~/infra/policy-demo && rm -rf /tmp/pd
    cat > README.md <<'EOF'
# Plan policies

CI runs `conftest test plans/<pr>.json --policy policy/` on the JSON of every pull request's plan.
Write the team's rules in `policy/plan.rego` (package `main`, `deny` rules).
EOF
    ;;
  replace)
    mkdir -p ~/infra/deploy && cd ~/infra/deploy && versions
    cat > main.tf <<'EOF'
resource "random_pet" "server" {
  length = 2
}

# The key the deploy pipeline uses to log in to the servers.
resource "tls_private_key" "deploy" {
  algorithm = "ED25519"
}

resource "local_file" "authorized_keys" {
  filename        = "${path.module}/out/authorized_keys"
  content         = tls_private_key.deploy.public_key_openssh
  file_permission = "0600"
}

resource "local_file" "motd" {
  filename = "${path.module}/out/motd.txt"
  content  = "Welcome to ${random_pet.server.id}.example.com\n"
}
EOF
    tfinit . && tfapply .
    note key "$(terraform state show -no-color tls_private_key.deploy | sed -n 's/^ *id *= *"\(.*\)"/\1/p')"
    note pet "$(terraform state show -no-color random_pet.server | sed -n 's/^ *id *= *"\(.*\)"/\1/p')"
    note motd "$(stat -c %Y out/motd.txt)"
    printf 'SEC-301: the deploy private key was pasted into a public chat. Rotate it now. Nothing else may change.\n' > TICKET.txt
    ;;
esac
