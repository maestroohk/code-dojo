# Boss: ~/infra/status-page, the status page config Sam wrote. Three bugs, one per stage (the argument):
#   1  init fails: the random provider constraint asks for a version nobody has (~> 3.6.0)
#   2  plan fails: an attribute that random_pet does not have (.name instead of .id)
#   3  every plan shows a change: timestamp() in the content (the fix is a time_static resource)
. "$DOJO_FILES/lib.sh"
stage=${1:-1}
mkdir -p ~/infra/status-page
cd ~/infra/status-page
random_version='~> 3.6.0'; [ "$stage" -gt 1 ] && random_version='~> 3.9'
cat > versions.tf <<EOF
terraform {
  required_version = ">= 1.10"
  required_providers {
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    random = { source = "hashicorp/random", version = "$random_version" }
  }
}
EOF
attr=id; [ "$stage" = 2 ] && attr=name
cat > main.tf <<EOF
# The public status page: a static site the load balancer serves.
resource "random_pet" "page" {
  length = 2
}

resource "local_file" "index" {
  filename = "\${path.module}/public/index.html"
  content  = <<-EOT
    <h1>status.example.com: all systems normal</h1>
    <p>Build \${random_pet.page.$attr}</p>
    <p>Last deployed: \${timestamp()}</p>
  EOT
}
EOF
cat > README.md <<'EOF'
# status-page

    terraform init
    terraform plan -out=tfplan
    terraform apply tfplan

Works on my machine. -- Sam
EOF
if [ "$stage" -gt 1 ]; then tfinit .; fi
if [ "$stage" -gt 2 ]; then tfapply .; fi
