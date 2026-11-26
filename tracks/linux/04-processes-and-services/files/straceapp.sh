# Triage lesson: a program that fails with a useless message. strace shows which file it wanted.
set -e -o pipefail
mkdir -p ~/app
cat > ~/app/orders-worker <<'EOF'
#!/usr/bin/python3
# Reads its settings from a path nobody documented, and says nothing useful when it is missing.
import os, sys
path = os.path.join(os.path.expanduser("~"), ".config", "orders", "worker.ini")
try:
    with open(path) as f:
        text = f.read()
except OSError:
    print("orders-worker: startup failed", file=sys.stderr)
    sys.exit(1)
if "queue=" not in text:
    print("orders-worker: startup failed", file=sys.stderr)
    sys.exit(1)
print("orders-worker: ready")
EOF
chmod 755 ~/app/orders-worker
