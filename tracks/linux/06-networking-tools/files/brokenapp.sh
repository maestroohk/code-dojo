# Boss step 1: the orders app is "down". It listens on the wrong port, and once that is fixed its data file is unreadable.
set -e -o pipefail
mkdir -p ~/app/data
cat > ~/app/server.py <<'EOF'
#!/usr/bin/python3
# The orders app: reads app.env (PORT, BIND), serves /healthz and /api/orders.
import http.server, json, os, sys, traceback
here = os.path.dirname(os.path.abspath(__file__))
env = dict(l.strip().split("=", 1) for l in open(os.path.join(here, "app.env")) if "=" in l and not l.startswith("#"))
class H(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = body.encode()
        self.send_response(code); self.send_header("Content-Type", "text/plain"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/healthz":
            return self.reply(200, "ok\n")
        if self.path == "/api/orders":
            try:
                with open(os.path.join(here, "data", "orders.json")) as f:
                    return self.reply(200, json.dumps(json.load(f)) + "\n")
            except Exception:
                print("ERROR /api/orders: " + traceback.format_exc().strip().splitlines()[-1], file=sys.stderr, flush=True)
                return self.reply(500, "internal error\n")
        self.reply(404, "not found\n")
    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), file=sys.stderr, flush=True)
print(f"listening on {env['BIND']}:{env['PORT']}", file=sys.stderr, flush=True)
http.server.ThreadingHTTPServer((env["BIND"], int(env["PORT"])), H).serve_forever()
EOF
cat > ~/app/app.env <<'EOF'
# The load balancer and every client expect port 8080.
BIND=127.0.0.1
PORT=8081
EOF
cat > ~/app/start.sh <<'EOF'
#!/bin/bash
# Starts the orders app in the background; its log goes to ~/app/app.log.
cd "$(dirname "$0")"
setsid -f ./server.py >> app.log 2>&1 < /dev/null
EOF
cat > ~/app/stop.sh <<'EOF'
#!/bin/bash
pkill -f "app/server.py" || true
EOF
echo '[{"id": 1, "item": "mug"}, {"id": 2, "item": "teapot"}]' > ~/app/data/orders.json
chmod 755 ~/app/server.py ~/app/start.sh ~/app/stop.sh
chown -R learner: ~/app
chmod 000 ~/app/data/orders.json
runuser -u learner -- ~/app/start.sh
sleep 1
