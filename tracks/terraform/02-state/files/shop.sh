# Module 2: ~/infra/shop, the shop's production config, applied. The argument picks the situation:
#   explore    applied, nothing else
#   committed  applied, and a Git repo where someone committed terraform.tfstate (with the DB password in it)
#   remote     applied with local state; the team's state server (dojo-tfstate, the "http" backend) is running
#   locked     state already on the server, and a lock left behind by a CI job that died
#   rename     applied; the team wants new resource names
#   handover   applied; the API key moves to the security team's config
#   import     applied; an admin password made by hand years ago must come under Terraform
#   drift      applied; then someone hot-fixed nginx.conf by hand and deleted robots.txt
. "$DOJO_FILES/lib.sh"
mode=${1:-explore}
mkdir -p ~/infra/shop
cd ~/infra/shop
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
cat > main.tf <<'EOF'
resource "random_pet" "server" {
  length = 2
}

# The database password: generated once, then kept in the state.
resource "random_password" "db" {
  length  = 24
  special = false
}

# The key the API signs its tokens with.
resource "tls_private_key" "api" {
  algorithm = "ED25519"
}

# The app's environment file. local_sensitive_file keeps the content out of plan output.
resource "local_sensitive_file" "app_env" {
  filename        = "${path.module}/out/app.env"
  content         = "DATABASE_URL=postgres://shop:${random_password.db.result}@db.internal.example.com:5432/shop\n"
  file_permission = "0600"
}

resource "local_file" "nginx" {
  filename = "${path.module}/out/nginx.conf"
  content  = <<-EOT
    server {
      server_name ${random_pet.server.id}.example.com;
      listen 443 ssl;
    }
  EOT
}

resource "local_file" "robots" {
  filename = "${path.module}/out/robots.txt"
  content  = "User-agent: *\nDisallow: /checkout/\n"
}

output "server_name" {
  value = random_pet.server.id
}

output "db_password" {
  value     = random_password.db.result
  sensitive = true
}
EOF
tfinit .
tfapply .
note password "$(terraform output -raw db_password)"
note pet "$(terraform output -raw server_name)"

backend() {
  cat > backend.tf <<'EOF'
terraform {
  backend "http" {
    address        = "http://127.0.0.1:8300/state/shop-prod"
    lock_address   = "http://127.0.0.1:8300/state/shop-prod"
    unlock_address = "http://127.0.0.1:8300/state/shop-prod"
  }
}
EOF
}

case $mode in
  committed)
    git init -q .
    git add versions.tf main.tf terraform.tfstate .terraform.lock.hcl
    GIT_AUTHOR_DATE='2026-11-02T10:12:00Z' GIT_COMMITTER_DATE='2026-11-02T10:12:00Z' git commit -qm "Shop infra: server, database password, API key, nginx"
    ;;
  remote)
    dojo-tfstate start
    ;;
  locked)
    dojo-tfstate start
    backend
    terraform init -migrate-state -force-copy -input=false -no-color >/dev/null
    rm -f terraform.tfstate terraform.tfstate.backup
    created=$(date -u -d '-47 minutes' +%Y-%m-%dT%H:%M:%S.000000000Z)
    curl -fsS -X LOCK http://127.0.0.1:8300/state/shop-prod -d "{\"ID\":\"3b7e1d24-8c5f-4a6e-b9d2-5f0c7a1e9b43\",\"Operation\":\"OperationTypeApply\",\"Info\":\"\",\"Who\":\"runner@ci-runner-7\",\"Version\":\"1.17.2\",\"Created\":\"$created\",\"Path\":\"\"}" >/dev/null
    note lockid 3b7e1d24-8c5f-4a6e-b9d2-5f0c7a1e9b43
    mkdir -p ~/ci
    cat > ~/ci/job-4821.log <<EOF
$created  job 4821 (deploy shop-prod) started on ci-runner-7
$created  terraform apply -input=false tfplan
$created  Acquiring state lock. This may take a few moments...
$created  local_file.robots: Destroying... [id=5f1c3c0f0c4e6b52e5d3a9c3a0c1b2d4e5f60718]
$created  local_file.robots: Destruction complete after 0s
$created  local_file.robots: Creating...
          ERROR: runner ci-runner-7 lost connection (spot instance reclaimed). Job 4821 marked failed.
EOF
    rm -f out/robots.txt
    ;;
  import)
    mkdir -p ~/legacy
    printf 'Admin password for the reporting database (set by hand, 2024):\nRpt-Admin-2024-xQ7mZ\n' > ~/legacy/wiki-page.txt
    note admin 'Rpt-Admin-2024-xQ7mZ'
    ;;
  drift)
    sed -i 's/listen 443 ssl;/listen 443 ssl;\n  client_max_body_size 20m;   # hotfix INC-2231: uploads failed/' out/nginx.conf
    rm out/robots.txt
    ;;
esac
