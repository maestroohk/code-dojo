# Boss: a draft sudo rule with a syntax error. Installing it as it is would break sudo for everyone.
set -e -o pipefail
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
cat > ~/deploy.sudoers <<'EOF'
# Let the deploy user restart the app, and nothing else.
deploy ALL=(root) NOPASSWD /usr/bin/systemctl restart app
EOF
