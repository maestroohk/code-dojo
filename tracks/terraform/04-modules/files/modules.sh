# Module 4 scenarios. The argument picks one:
#   extract   ~/infra/web: one site's resources in the root module, applied
#   second    the same after the extract: module "shop" from ./modules/site, applied
#   git       ~/infra/web uses the site module from the team's module repo (/srv/git/tf-modules.git) at v1.0.0,
#             and v2.0.0 has been released
#   output    ~/infra/web calls the module and wants an output the module does not have
#   boss1     a module with a provider block inside, called with for_each
#   boss2     boss1 fixed, the module in its own repo (~/src/tf-modules); the caller pins v1.0.0
#   boss3     boss2 done (v1.1.0 released and used)
. "$DOJO_FILES/lib.sh"
mode=${1:-extract}
versions() {
  cat > "$1/versions.tf" <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local = { source = "hashicorp/local", version = "~> 2.9" }
    tls   = { source = "hashicorp/tls", version = "~> 4.4" }
  }
}
EOF
}
# The site resources, for a module (var.domain) or for the root (a fixed domain).
site_resources() { # $1 = how the domain is written
  cat <<EOF
resource "tls_private_key" "site" {
  algorithm = "ED25519"
}

resource "tls_self_signed_cert" "site" {
  private_key_pem       = tls_private_key.site.private_key_pem
  validity_period_hours = 8760
  allowed_uses          = ["digital_signature", "server_auth"]
  dns_names             = [$1]
  subject {
    common_name = $1
  }
}

resource "local_file" "nginx" {
  filename = "\${path.root}/out/\${$2}/nginx.conf"
  content  = <<-EOT
    server {
      server_name \${$2};
      listen 443 ssl;
      ssl_certificate /etc/nginx/certs/\${$2}.pem;
    }
  EOT
}
EOF
}
module_files() { # $1 = folder
  mkdir -p "$1"
  site_resources 'var.domain' 'var.domain' > "$1/main.tf"
  cat > "$1/variables.tf" <<'EOF'
variable "domain" {
  type        = string
  description = "The site's domain name, for example shop.example.com."
}
EOF
  cat > "$1/outputs.tf" <<'EOF'
output "cert_pem" {
  description = "The site's TLS certificate (PEM)."
  value       = tls_self_signed_cert.site.cert_pem
}
EOF
  versions "$1"
}
note_cert() { note cert "$(cd ~/infra/web && terraform state show -no-color "$1" | sed -n 's/^ *id *= *"\(.*\)"/\1/p')"; }
# ". modules.sh lib" (from boss.sh): only the functions above.
if [ "$mode" = lib ]; then return 0; fi

mkdir -p ~/infra/web
cd ~/infra/web
versions .
case $mode in
  extract)
    site_resources '"shop.example.com"' '"shop.example.com"' | sed 's/\${"shop.example.com"}/shop.example.com/g' > main.tf
    tfinit . && tfapply . && note_cert tls_self_signed_cert.site
    ;;
  second|output)
    module_files modules/site
    printf 'module "shop" {\n  source = "./modules/site"\n  domain = "shop.example.com"\n}\n' > main.tf
    tfinit . && tfapply . && note_cert module.shop.tls_self_signed_cert.site
    if [ "$mode" = output ]; then
      cat >> main.tf <<'EOF'

# The load balancer team needs the certificate as a file.
resource "local_file" "shop_cert" {
  filename = "${path.root}/out/lb/shop.example.com.pem"
  content  = module.shop.cert_pem
}

output "shop_cert_fingerprint" {
  value = module.shop.cert_fingerprint
}
EOF
    fi
    ;;
  git)
    mkdir -p /srv/git && git init -q --bare /srv/git/tf-modules.git
    rm -rf /tmp/mods && git clone -q /srv/git/tf-modules.git /tmp/mods 2>/dev/null
    module_files /tmp/mods/site
    printf '# Changelog\n\n## v1.0.0\n- First release: TLS key, self-signed certificate, nginx server block.\n' > /tmp/mods/CHANGELOG.md
    (cd /tmp/mods && git add -A && git commit -qm "site module v1.0.0" && git tag v1.0.0)
    # v2.0.0: domain renamed to hostname, the key resource renamed (with a moved block), a new output.
    (cd /tmp/mods/site && sed -i 's/var\.domain/var.hostname/g; s/"tls_private_key" "site"/"tls_private_key" "this"/; s/tls_private_key\.site/tls_private_key.this/g' main.tf \
      && sed -i 's/variable "domain"/variable "hostname"/' variables.tf \
      && printf '\nmoved {\n  from = tls_private_key.site\n  to   = tls_private_key.this\n}\n' >> main.tf \
      && printf '\noutput "cert_fingerprint" {\n  description = "SHA-256 fingerprint of the public key."\n  value       = tls_private_key.this.public_key_fingerprint_sha256\n}\n' >> outputs.tf)
    printf '# Changelog\n\n## v2.0.0\n- BREAKING: input `domain` is now `hostname`.\n- New output `cert_fingerprint`.\n- `tls_private_key.site` is now `tls_private_key.this` (a moved block is included: nothing is replaced).\n\n## v1.0.0\n- First release: TLS key, self-signed certificate, nginx server block.\n' > /tmp/mods/CHANGELOG.md
    (cd /tmp/mods && git add -A && git commit -qm "site module v2.0.0" && git tag v2.0.0 && git push -q origin main --tags 2>/dev/null)
    chmod -R a+rX /srv/git
    printf 'module "shop" {\n  source = "git::file:///srv/git/tf-modules.git//site?ref=v1.0.0"\n  domain = "shop.example.com"\n}\n' > main.tf
    tfinit . && tfapply . && note_cert module.shop.tls_self_signed_cert.site
    ;;
esac
