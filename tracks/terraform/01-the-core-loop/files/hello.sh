# Lesson 1: ~/infra/hello, a first configuration. "hello.sh applied" also runs init and apply, as if a teammate
# had already created it, and notes the server name so a check can tell whether it was replaced.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/infra/hello
cat > ~/infra/hello/main.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
}

# A name for the new web server, picked once and then remembered in the state.
resource "random_pet" "server" {
  length    = 2
  separator = "-"
}

# The server's message of the day. A local file stands in for any real object (a bucket, a DNS record):
# the workflow is exactly the same.
resource "local_file" "motd" {
  filename        = "${path.module}/out/motd.txt"
  content         = "Welcome to ${random_pet.server.id}.example.com\n"
  file_permission = "0644"
}

output "server_name" {
  value = random_pet.server.id
}
EOF
if [ "${1:-}" = applied ]; then
  tfinit ~/infra/hello
  tfapply ~/infra/hello
  note pet "$(cd ~/infra/hello && terraform output -raw server_name)"
fi
