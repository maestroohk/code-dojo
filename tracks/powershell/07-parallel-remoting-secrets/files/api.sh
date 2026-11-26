# Module 7 HTTP scenarios: the lesson API on 127.0.0.1:8088 (tickets with a bearer token, /delay for parallel calls),
# the token in a file (the thing lesson 3 gets rid of), and a list of endpoints to check.
set -e -o pipefail
mkdir -p ~/answers ~/scripts ~/.config/ops /opt/dojo/state
echo "dojo-tk-7f3a9c2e51b84d06" > /opt/dojo/state/api-token && chmod 644 /opt/dojo/state/api-token
cp /opt/dojo/state/api-token ~/.config/ops/api-token && chmod 600 ~/.config/ops/api-token
setsid -f python3 "$DOJO_FILES/api.py" 8088 tickets > /dev/null 2>&1 < /dev/null
for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:8088/stats && break; sleep 0.1; done
python3 - <<'EOF'
import os
with open(os.path.expanduser("~/scripts/endpoints.txt"), "w") as f:
    for i in range(1, 13):
        f.write(f"http://127.0.0.1:8088/delay?ms=1000&id=svc{i:02d}\n")
EOF
