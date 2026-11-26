# Lesson 1: a ~/.ssh with a real key pair, a config in the wrong order, and permissions ssh refuses.
set -e -o pipefail
mkdir -p ~/.ssh
ssh-keygen -q -t ed25519 -N '' -C 'learner@laptop' -f ~/.ssh/id_deploy
cat > ~/.ssh/config <<'EOF'
# Defaults for every host
Host *
    User root
    ServerAliveInterval 30

Host web1
    HostName 10.0.0.5
    User deploy
EOF
chmod 755 ~/.ssh
chmod 666 ~/.ssh/config
chmod 644 ~/.ssh/id_deploy
