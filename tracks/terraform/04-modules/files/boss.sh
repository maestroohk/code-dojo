# Boss: the site module three teams want. ~/infra/platform calls it once per team with for_each. Stages:
#   1  the module (./modules/site) still has provider blocks inside, so for_each on the call fails
#   2  fixed; the module now lives in its own repo (~/src/tf-modules, origin /srv/git/tf-modules.git) at v1.0.0,
#      the platform uses it from Git, applied
#   3  stage 2 done: v1.1.0 (cert_fingerprint output) released and used, applied
set -e -o pipefail
stage=${1:-1}
. "$DOJO_FILES/modules.sh" lib
mkdir -p ~/infra/platform
cd ~/infra/platform
versions .
call() { # $1 = source
  cat > main.tf <<EOF
locals {
  team_sites = {
    checkout = "checkout.example.com"
    search   = "search.example.com"
    web      = "www.example.com"
  }
}

module "site" {
  for_each = local.team_sites
  source   = "$1"
  domain   = each.value
}
EOF
}
if [ "$stage" = 1 ]; then
  module_files modules/site
  cat > modules/site/providers.tf <<'EOF'
# Copied from the first project that used this module.
provider "tls" {}

provider "local" {}
EOF
  call ./modules/site
  exit 0
fi

# Stages 2 and 3: the module in its own repository.
mkdir -p /srv/git && git init -q --bare /srv/git/tf-modules.git
rm -rf ~/src/tf-modules && mkdir -p ~/src && git clone -q /srv/git/tf-modules.git ~/src/tf-modules 2>/dev/null
cd ~/src/tf-modules
module_files site
printf '# Changelog\n\n## v1.0.0\n- First release: TLS key, self-signed certificate, nginx server block.\n' > CHANGELOG.md
git add -A && git commit -qm "site module v1.0.0" && git tag v1.0.0
if [ "$stage" = 3 ]; then
  printf '\noutput "cert_fingerprint" {\n  description = "SHA-256 fingerprint of the site key."\n  value       = tls_private_key.site.public_key_fingerprint_sha256\n}\n' >> site/outputs.tf
  printf '# Changelog\n\n## v1.1.0\n- New output `cert_fingerprint`.\n\n## v1.0.0\n- First release: TLS key, self-signed certificate, nginx server block.\n' > CHANGELOG.md
  git commit -qam "Add cert_fingerprint output" && git tag v1.1.0
fi
git push -q origin main --tags 2>/dev/null
ref=v1.0.0; [ "$stage" = 3 ] && ref=v1.1.0
cd ~/infra/platform
call "git::file:///srv/git/tf-modules.git//site?ref=$ref"
if [ "$stage" = 3 ]; then printf 'output "fingerprints" {\n  value = { for team, s in module.site : team => s.cert_fingerprint }\n}\n' > outputs.tf; fi
tfinit . && tfapply .
for d in checkout.example.com search.example.com www.example.com; do note "nginx-$d" "$(stat -c %Y "out/$d/nginx.conf")"; done
chown -R learner:learner /srv/git
