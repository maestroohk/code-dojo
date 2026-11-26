# Triage lesson: a few long-running programs, one of which holds a lot of memory.
set -e -o pipefail
cat > /usr/local/bin/cache-warmer <<'EOF'
#!/usr/bin/python3
# Holds about 150 MB and sleeps: the memory hog of this scenario.
import time
blob = bytearray(150 * 1024 * 1024)
for i in range(0, len(blob), 4096):
    blob[i] = 1
while True:
    time.sleep(300)
EOF
cat > /usr/local/bin/api-server <<'EOF'
#!/usr/bin/python3
import time
blob = bytearray(20 * 1024 * 1024)
for i in range(0, len(blob), 4096):
    blob[i] = 1
while True:
    time.sleep(300)
EOF
cat > /usr/local/bin/metrics-agent <<'EOF'
#!/bin/bash
while :; do sleep 300 & wait $!; done
EOF
chmod 755 /usr/local/bin/cache-warmer /usr/local/bin/api-server /usr/local/bin/metrics-agent
for p in api-server cache-warmer metrics-agent; do runuser -u learner -- setsid -f "/usr/local/bin/$p" >/dev/null 2>&1 < /dev/null; done
sleep 1.5
