# Lesson 2: ~/infra/site, a fresh checkout of a config with a hidden dependency. The data source reads a file that
# another resource writes, but only by a literal path, so Terraform does not know it must wait: on a clean machine
# the plan fails ("no such file or directory"). It only ever worked on the laptop where build/ already existed.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/infra/site
cat > ~/infra/site/versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local = { source = "hashicorp/local", version = "~> 2.9" }
  }
}
EOF
cat > ~/infra/site/main.tf <<'EOF'
locals {
  settings = {
    site     = "shop.example.com"
    replicas = 3
    tls      = true
  }
}

# Step 1: write the site settings for the deploy tooling.
resource "local_file" "settings" {
  filename = "${path.module}/build/settings.json"
  content  = jsonencode(local.settings)
}

# Step 2: render nginx.conf from that settings file.
data "local_file" "settings" {
  filename = "${path.module}/build/settings.json"
}

resource "local_file" "nginx" {
  filename = "${path.module}/build/nginx.conf"
  content  = <<-EOT
    # generated from settings.json (sha1 ${sha1(data.local_file.settings.content)})
    server_name ${jsondecode(data.local_file.settings.content).site};
  EOT
}
EOF
tfinit ~/infra/site
