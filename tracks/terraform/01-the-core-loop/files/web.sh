# Lesson 3: ~/infra/web is applied (the "main" version), then a teammate's branch is checked out on top of it.
# Planning the branch gives every kind of change: create, update in place, replace (with a dependent that is
# replaced too), destroy, and no-ops. The plan card in the lesson is this exact plan (tracks/terraform/plans/web-review.json).
. "$DOJO_FILES/lib.sh"
mkdir -p ~/infra/web
cd ~/infra/web
cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
    tls    = { source = "hashicorp/tls", version = "~> 4.4" }
    time   = { source = "hashicorp/time", version = "~> 0.14" }
  }
}
EOF
cat > main.tf <<'EOF'
resource "random_pet" "server" {
  length = 2
}

resource "time_static" "launched" {}

# The key the deploy pipeline uses to log in.
resource "tls_private_key" "deploy" {
  algorithm = "RSA"
  rsa_bits  = 3072
}

resource "local_file" "authorized_keys" {
  filename        = "${path.module}/out/authorized_keys"
  content         = tls_private_key.deploy.public_key_openssh
  file_permission = "0600"
}

# What is deployed: the release pipeline reads this.
resource "terraform_data" "release" {
  input = {
    version = "1.4.0"
    channel = "stable"
  }
}

resource "local_file" "motd" {
  filename = "${path.module}/out/motd.txt"
  content  = "Welcome to ${random_pet.server.id}.example.com (since ${time_static.launched.rfc3339})\n"
}

resource "local_file" "banner" {
  filename = "${path.module}/out/banner.txt"
  content  = "Summer sale: 20% off everything\n"
}
EOF
tfinit ~/infra/web
tfapply ~/infra/web
git init -q . && printf '.terraform/\n*.tfstate*\n*.tfplan\nout/\n' > .gitignore && git add -A && git commit -qm "Web server: name, deploy key, release, motd, banner"
# The teammate's branch: a modern deploy key, release 1.5.0, the banner gone, a robots.txt added.
git checkout -qb feature/release-1.5
sed -i 's/algorithm = "RSA"/algorithm = "ED25519"/; /rsa_bits/d; s/version = "1.4.0"/version = "1.5.0"/' main.tf
sed -i '/resource "local_file" "banner"/,/^}/d' main.tf
cat >> main.tf <<'EOF'
resource "local_file" "robots" {
  filename = "${path.module}/out/robots.txt"
  content  = "User-agent: *\nDisallow: /checkout/\n"
}
EOF
git commit -qam "Release 1.5: ed25519 deploy key, robots.txt, end of the summer sale"
