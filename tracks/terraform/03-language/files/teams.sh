# Boss: ~/infra/teams, one database password and env file per product team. Stages (the argument):
#   1  made with count over a list, applied; the passwords are noted so the checks can tell if any rotated
#   2  stage 1 done (for_each over a map, payments added), applied
#   3  stage 2 done (pager files for gold teams), applied
. "$DOJO_FILES/lib.sh"
stage=${1:-1}
mkdir -p ~/infra/teams && cd ~/infra/teams
cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
}
EOF
cat > main.tf <<'EOF'
variable "teams" {
  type = list(object({ name = string, tier = string, owner = string }))
  default = [
    { name = "checkout", tier = "gold", owner = "checkout-lead@example.com" },
    { name = "search", tier = "silver", owner = "search-lead@example.com" },
    { name = "web", tier = "gold", owner = "web-lead@example.com" },
  ]
}

# Each team's database password.
resource "random_password" "team_db" {
  count   = length(var.teams)
  length  = 32
  special = false
}

resource "local_sensitive_file" "team_env" {
  count    = length(var.teams)
  filename = "${path.module}/out/${var.teams[count.index].name}/db.env"
  content  = "DB_PASSWORD=${random_password.team_db[count.index].result}\n"
}
EOF
terraform fmt >/dev/null
tfinit .
tfapply .
for t in checkout search web; do note "pw-$t" "$(sed -n 's/^DB_PASSWORD=//p' out/$t/db.env)"; done
cat > TICKET.txt <<'EOF'
TEAM-41: onboard the payments team (tier gold, owner payments-lead@example.com).
Keep the team list sorted by name. The other teams' database passwords must NOT change.
EOF

stage1() {
  cat > main.tf <<'EOF'
variable "teams" {
  type = map(object({ tier = string, owner = string }))
  default = {
    checkout = { tier = "gold", owner = "checkout-lead@example.com" }
    payments = { tier = "gold", owner = "payments-lead@example.com" }
    search   = { tier = "silver", owner = "search-lead@example.com" }
    web      = { tier = "gold", owner = "web-lead@example.com" }
  }
}

# Each team's database password.
resource "random_password" "team_db" {
  for_each = var.teams
  length   = 32
  special  = false
}

resource "local_sensitive_file" "team_env" {
  for_each = var.teams
  filename = "${path.module}/out/${each.key}/db.env"
  content  = "DB_PASSWORD=${random_password.team_db[each.key].result}\n"
}
EOF
  cat > moved.tf <<'EOF'
moved {
  from = random_password.team_db[0]
  to   = random_password.team_db["checkout"]
}
moved {
  from = random_password.team_db[1]
  to   = random_password.team_db["search"]
}
moved {
  from = random_password.team_db[2]
  to   = random_password.team_db["web"]
}
moved {
  from = local_sensitive_file.team_env[0]
  to   = local_sensitive_file.team_env["checkout"]
}
moved {
  from = local_sensitive_file.team_env[1]
  to   = local_sensitive_file.team_env["search"]
}
moved {
  from = local_sensitive_file.team_env[2]
  to   = local_sensitive_file.team_env["web"]
}
EOF
}
stage2() {
  cat > pager.tf <<'EOF'
# 24x7 paging, for gold teams only.
resource "local_file" "pager" {
  for_each = { for name, t in var.teams : name => t if t.tier == "gold" }
  filename = "${path.module}/out/${each.key}/pager.yaml"
  content  = "escalation: 24x7\nowner: ${each.value.owner}\n"
}

output "pager_files" {
  value = { for name, f in local_file.pager : name => f.filename }
}
EOF
}
if [ "$stage" -ge 2 ]; then stage1; tfapply .; note pw-payments "$(sed -n 's/^DB_PASSWORD=//p' out/payments/db.env)"; fi
if [ "$stage" -ge 3 ]; then stage2; tfapply .; fi
