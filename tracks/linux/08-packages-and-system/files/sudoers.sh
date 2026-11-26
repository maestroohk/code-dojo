# Lesson 4: users that need admin rights, and a teammate's sudoers drop-in that would break sudo if installed as is.
set -e -o pipefail
groupadd -f ops
for u in deploy ana; do id "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"; done
id omar >/dev/null 2>&1 || useradd -m -s /bin/bash -G ops omar
mkdir -p ~/staging
cat > ~/staging/90-ops <<'EOF'
# The ops team may run anything, without a password prompt.
%ops ALL=(ALL) NOPASWD: ALL
EOF
