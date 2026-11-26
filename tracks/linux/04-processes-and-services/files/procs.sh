# Lesson 1 (and its cold rebuild): real background processes for ps, pgrep and kill.
# Each program is a script in /usr/local/bin, so its process name (comm) is the script's name.
set -e -o pipefail
cat > /usr/local/bin/report-worker <<'EOF'
#!/bin/bash
# A worker that waits for jobs.
while :; do sleep 300 & wait $!; done
EOF
cat > /usr/local/bin/stuck-export <<'EOF'
#!/bin/bash
# Saves its progress when asked to stop politely (SIGTERM). SIGKILL gives it no chance to.
trap 'echo "clean shutdown: progress saved" >> /home/learner/export.log; kill $! 2>/dev/null; exit 0' TERM
echo "export started" >> /home/learner/export.log
while :; do sleep 300 & wait $!; done
EOF
cat > /usr/local/bin/noisy-logger <<'EOF'
#!/bin/bash
# Ignores SIGTERM: only SIGKILL stops it.
trap '' TERM
while :; do sleep 300 & wait $!; done
EOF
chmod 755 /usr/local/bin/report-worker /usr/local/bin/stuck-export /usr/local/bin/noisy-logger
touch /home/learner/export.log && chown learner: /home/learner/export.log
for i in 1 2 3; do runuser -u learner -- setsid -f /usr/local/bin/report-worker >/dev/null 2>&1 < /dev/null; done
runuser -u learner -- setsid -f /usr/local/bin/stuck-export >/dev/null 2>&1 < /dev/null
runuser -u learner -- setsid -f /usr/local/bin/noisy-logger >/dev/null 2>&1 < /dev/null
sleep 0.5
