# Module 6 scenarios. The argument picks one:
#   branch       ~/infra/shop-prod applied from main; the branch feature/sec-88 is checked out: it rotates the DB
#                password by accident, moves the assets file into a module without a moved block, adds an alarm file
#                and updates the deploy settings
#   cycle        ~/infra/gateway: two configs that reference each other (Error: Cycle)
#   unknownkeys  ~/infra/keys: for_each over values only known after apply
#   awsjson      ~/review: the real plan JSON (and the HCL) of an AWS pull request, to review with jq
. "$DOJO_FILES/lib.sh"
mode=${1:-branch}
versions() {
  cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
    tls    = { source = "hashicorp/tls", version = "~> 4.4" }
  }
}
EOF
}
case $mode in
  branch)
    mkdir -p ~/infra/shop-prod && cd ~/infra/shop-prod && versions
    cat > main.tf <<'EOF'
locals {
  tags = { app = "shop", env = "prod" }
}

resource "random_password" "db" {
  length  = 24
  special = false
}

resource "local_sensitive_file" "db_env" {
  filename = "${path.module}/out/db.env"
  content  = "DB_PASSWORD=${random_password.db.result}\n"
}

# The assets bucket (terraform_data stands in for it: tags update in place, like an S3 bucket's).
resource "terraform_data" "assets" {
  input = { bucket = "shop-prod-assets-example", tags = local.tags }
}

resource "terraform_data" "deploy" {
  input = { version = "4.2.0", tags = local.tags }
}
EOF
    tfinit . && tfapply .
    note pw "$(sed -n 's/^DB_PASSWORD=//p' out/db.env)"
    note assets "$(terraform state show -no-color terraform_data.assets | sed -n 's/^ *id *= *"\(.*\)"/\1/p')"
    printf '.terraform/\n*.tfstate\n*.tfstate.*\ntfplan\n*.tfplan\nout/\n' > .gitignore
    git init -q . && git add -A && git commit -qm "shop-prod"
    git checkout -qb feature/sec-88
    mkdir -p modules/assets
    cat > modules/assets/main.tf <<'EOF'
variable "bucket" {
  type = string
}

variable "tags" {
  type = map(string)
}

resource "terraform_data" "bucket" {
  input = { bucket = var.bucket, tags = var.tags }
}
EOF
    cat > main.tf <<'EOF'
locals {
  tags = { app = "shop", env = "prod", cost_center = "cc-1234" }
}

# SEC-88: stronger database password
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "local_sensitive_file" "db_env" {
  filename = "${path.module}/out/db.env"
  content  = "DB_PASSWORD=${random_password.db.result}\n"
}

module "assets" {
  source = "./modules/assets"
  bucket = "shop-prod-assets-example"
  tags   = local.tags
}

resource "terraform_data" "deploy" {
  input = { version = "4.2.0", tags = local.tags }
}

# SEC-88: alert when the database is under load
resource "local_file" "db_cpu_alarm" {
  filename = "${path.module}/out/alarms/db-cpu.yaml"
  content  = "metric: CPUUtilization\nthreshold: 80\nperiods: 3\n"
}
EOF
    GIT_AUTHOR_NAME='Sam Lee' GIT_AUTHOR_EMAIL='sam@example.com' git add -A
    GIT_AUTHOR_NAME='Sam Lee' GIT_AUTHOR_EMAIL='sam@example.com' git commit -qm "SEC-88: stronger DB password, assets module, cost center tag, DB CPU alarm"
    terraform init -input=false -no-color >/dev/null
    ;;
  cycle)
    mkdir -p ~/infra/gateway && cd ~/infra/gateway && versions
    cat > main.tf <<'EOF'
# The API gateway routes to the app, and the app must know the gateway's public URL for its callbacks.
resource "local_file" "gateway" {
  filename = "${path.module}/out/gateway.conf"
  content  = "upstream ${local_file.app.filename}\nlisten https://api.example.com\n"
}

resource "local_file" "app" {
  filename = "${path.module}/out/app.conf"
  content  = "callback_base = ${regex("listen (\\S+)", local_file.gateway.content)[0]}\n"
}
EOF
    tfinit .
    ;;
  unknownkeys)
    mkdir -p ~/infra/keys && cd ~/infra/keys && versions
    cat > main.tf <<'EOF'
variable "services" {
  type    = set(string)
  default = ["billing", "orders", "search"]
}

resource "tls_private_key" "svc" {
  for_each  = var.services
  algorithm = "ED25519"
}

# One authorized_keys file per key, named after the key's fingerprint.
resource "local_file" "authorized" {
  for_each = toset([for k in tls_private_key.svc : k.public_key_fingerprint_sha256])
  filename = "${path.module}/out/keys/${replace(each.key, "/", "_")}.pub"
  content  = each.key
}
EOF
    tfinit .
    ;;
  awsjson)
    mkdir -p ~/review/aws-pr
    cp "$DOJO_FILES/aws-pr.json" ~/review/plan.json
    cp -r "$DOJO_FILES/aws-pr/before" "$DOJO_FILES/aws-pr/after" ~/review/aws-pr/
    printf 'PR 512 (shop-prod): "SEC-88: encrypt the database at rest, upgrade Postgres to 17, move the assets bucket\ninto the bucket module, add a DB CPU alarm, add the cost_center tag, resize web."\nThe CI plan JSON is ~/review/plan.json; the code before and after is in ~/review/aws-pr/.\n' > ~/review/PR.txt
    ;;
esac
