# Boss step 1: a batch job whose parent forked children that forked grandchildren, and an unrelated UI to keep.
set -e -o pipefail
cat > /usr/local/bin/batch-runner <<'EOF'
#!/bin/bash
for i in 1 2 3; do /usr/local/bin/batch-child & done
wait
EOF
cat > /usr/local/bin/batch-child <<'EOF'
#!/bin/bash
sleep 3000 & sleep 3000 &
wait
EOF
cat > /usr/local/bin/batch-ui <<'EOF'
#!/bin/bash
while :; do sleep 300 & wait $!; done
EOF
chmod 755 /usr/local/bin/batch-runner /usr/local/bin/batch-child /usr/local/bin/batch-ui
runuser -u learner -- setsid -f /usr/local/bin/batch-ui >/dev/null 2>&1 < /dev/null
runuser -u learner -- setsid -f /usr/local/bin/batch-runner >/dev/null 2>&1 < /dev/null
sleep 0.5
mkdir -p /opt/dojo/state
pgrep -x batch-runner > /opt/dojo/state/batch-pid
chmod 644 /opt/dojo/state/batch-pid
