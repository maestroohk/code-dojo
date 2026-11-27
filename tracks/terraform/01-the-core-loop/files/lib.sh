# Shared helpers for this module's Terraform scenarios (sourced by the other scripts here). They run as root in the
# learner's home, in a container with Terraform 1.17, OpenTofu 1.13 and the providers in an offline mirror
# (netlabs/images/terraform). Afterwards the home folder is handed to the learner.
set -e -o pipefail
mkdir -p ~/answers /opt/dojo/state

# Private notes for the checks, outside the learner's home.
note() { printf '%s\n' "$2" > "/opt/dojo/state/$1"; chmod 644 "/opt/dojo/state/$1"; }

# tfinit DIR / tfapply DIR: what the learner's team already ran, quietly.
tfinit() { (cd "$1" && terraform init -input=false -no-color >/dev/null); }
tfapply() { (cd "$1" && terraform apply -input=false -auto-approve -no-color >/dev/null); }
