# Module 3 scenarios. The argument picks one:
#   inputs   ~/infra/notify: untyped, unvalidated variables and a tfvars file per environment
#   hosts    ~/infra/hosts: a map of servers to turn into a hosts file and outputs
#   sites    ~/infra/sites: three sites made with count, applied (file times noted for the checks)
#   shifted  the same, after "blog" was removed from the list (for the plan card)
#   release  ~/infra/release: a release zip built by archive_file with hand-written source blocks
#   certs    ~/infra/certs: a CA key and an API key that should rotate
#   checks   ~/infra/edge: a deploy that needs guard rails and a certificate that expires soon
. "$DOJO_FILES/lib.sh"
mode=${1:-inputs}
versions() {
  cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local   = { source = "hashicorp/local", version = "~> 2.9" }
    random  = { source = "hashicorp/random", version = "~> 3.9" }
    tls     = { source = "hashicorp/tls", version = "~> 4.4" }
    time    = { source = "hashicorp/time", version = "~> 0.14" }
    archive = { source = "hashicorp/archive", version = "~> 2.8" }
  }
}
EOF
}
case $mode in
  inputs)
    mkdir -p ~/infra/notify && cd ~/infra/notify && versions
    cat > variables.tf <<'EOF'
variable "env" {}

variable "replicas" {
  default = 2
}

variable "alert_emails" {}

variable "smtp_password" {}
EOF
    cat > main.tf <<'EOF'
resource "local_file" "notify" {
  filename = "${path.module}/out/${var.env}/notify.yaml"
  content = yamlencode({
    environment = var.env
    replicas    = var.replicas
    alerts      = var.alert_emails
  })
}

resource "local_sensitive_file" "smtp" {
  filename = "${path.module}/out/${var.env}/smtp.env"
  content  = "SMTP_PASSWORD=${var.smtp_password}\n"
}
EOF
    cat > prod.tfvars <<'EOF'
env           = "prod"
replicas      = 3
alert_emails  = ["oncall@example.com", "platform@example.com"]
smtp_password = "smtp-Prod-7f3K9q"
EOF
    tfinit .
    ;;
  hosts)
    mkdir -p ~/infra/hosts && cd ~/infra/hosts && versions
    cat > variables.tf <<'EOF'
variable "servers" {
  type = map(object({
    ip   = string
    role = string
  }))
  default = {
    web-1   = { ip = "10.20.1.11", role = "web" }
    web-2   = { ip = "10.20.1.12", role = "web" }
    db-1    = { ip = "10.20.2.21", role = "db" }
    cache-1 = { ip = "10.20.3.31", role = "cache" }
    web-3   = { ip = "10.20.1.13", role = "web" }
  }
}
EOF
    printf '# Your resources and outputs go here.\n' > main.tf
    tfinit .
    ;;
  sites|shifted)
    mkdir -p ~/infra/sites && cd ~/infra/sites && versions
    cat > main.tf <<'EOF'
variable "sites" {
  type    = list(string)
  default = ["blog", "docs", "shop"]
}

# One nginx server block per site.
resource "local_file" "site" {
  count    = length(var.sites)
  filename = "${path.module}/out/sites/${var.sites[count.index]}.conf"
  content  = "server { server_name ${var.sites[count.index]}.example.com; root /srv/${var.sites[count.index]}; }\n"
}
EOF
    tfinit .
    tfapply .
    note docs "$(stat -c %Y out/sites/docs.conf)"
    note shop "$(stat -c %Y out/sites/shop.conf)"
    printf 'Ticket WEB-77: the blog moves to a SaaS platform. Remove it from the list.\n' > TICKET.txt
    if [ "$mode" = shifted ]; then sed -i 's/\["blog", "docs", "shop"\]/["docs", "shop"]/' main.tf; fi
    ;;
  release)
    mkdir -p ~/infra/release && cd ~/infra/release && versions
    cat > main.tf <<'EOF'
locals {
  release_files = {
    "VERSION"           = "2.3.0\n"
    "config/app.yaml"   = "log_level: info\nport: 8080\n"
    "config/flags.yaml" = "new_checkout: false\n"
  }
}

data "archive_file" "release" {
  type        = "zip"
  output_path = "${path.module}/out/release.zip"

  source {
    content  = "2.3.0\n"
    filename = "VERSION"
  }
  source {
    content  = "log_level: info\nport: 8080\n"
    filename = "config/app.yaml"
  }
  source {
    content  = "new_checkout: false\n"
    filename = "config/flags.yaml"
  }
}

output "release_sha256" {
  value = data.archive_file.release.output_sha256
}
EOF
    tfinit .
    ;;
  certs)
    mkdir -p ~/infra/certs && cd ~/infra/certs && versions
    cat > main.tf <<'EOF'
# The internal certificate authority's key. Every internal certificate is signed with it:
# losing it means re-issuing and re-trusting everything.
resource "tls_private_key" "ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P384"
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 87600
  allowed_uses          = ["cert_signing", "crl_signing"]
  subject {
    common_name  = "Example Internal CA"
    organization = "Example Ltd"
  }
}

# The partner API key. Security policy: rotate at least every 90 days.
resource "random_password" "partner_api_key" {
  length  = 40
  special = false
}

output "ca_cert_pem" {
  value = tls_self_signed_cert.ca.cert_pem
}
EOF
    tfinit .
    tfapply .
    note ca "$(terraform state show -no-color tls_private_key.ca | sed -n 's/^ *id *= *"\(.*\)"/\1/p')"
    ;;
  checks)
    mkdir -p ~/infra/edge && cd ~/infra/edge && versions
    cat > main.tf <<'EOF'
variable "env" {
  type = string
}

variable "replicas" {
  type = number
}

resource "terraform_data" "deploy" {
  input = {
    env      = var.env
    replicas = var.replicas
  }
}

resource "tls_private_key" "edge" {
  algorithm = "ED25519"
}

# The edge proxy's certificate. Someone set a short validity "for testing".
resource "tls_self_signed_cert" "edge" {
  private_key_pem       = tls_private_key.edge.private_key_pem
  validity_period_hours = 240
  allowed_uses          = ["digital_signature", "server_auth"]
  dns_names             = ["shop.example.com"]
  subject {
    common_name = "shop.example.com"
  }
}

# The list of app servers, published by the platform team's service registry.
data "local_file" "upstreams" {
  filename = pathexpand("~/shared/upstreams.json")
}

resource "local_file" "edge_conf" {
  filename = "${path.module}/out/edge.conf"
  content  = join("", [for u in jsondecode(data.local_file.upstreams.content).upstreams : "server ${u};\n"])
}
EOF
    mkdir -p ~/shared
    printf '{"upstreams": ["10.20.1.11:8080", "10.20.1.12:8080"]}\n' > ~/shared/upstreams.json
    printf 'env      = "prod"\nreplicas = 3\n' > prod.tfvars
    tfinit .
    terraform apply -input=false -auto-approve -no-color -var-file=prod.tfvars >/dev/null
    ;;
esac
