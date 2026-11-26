# Boss step 3: three local endpoints with different answers, for a curl-based health check.
set -e -o pipefail
cat > /usr/local/bin/status-server <<'EOF'
#!/usr/bin/python3
import http.server
CODES = {"/healthz": 200, "/ready": 503, "/api/orders": 200, "/old": 301}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code = CODES.get(self.path, 404)
        self.send_response(code)
        if code == 301: self.send_header("Location", "/healthz")
        self.send_header("Content-Length", "0"); self.end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 8080), H).serve_forever()
EOF
chmod 755 /usr/local/bin/status-server
runuser -u learner -- setsid -f /usr/local/bin/status-server >/dev/null 2>&1 < /dev/null
mkdir -p ~/bin
printf '%s\n' http://127.0.0.1:8080/healthz http://127.0.0.1:8080/ready http://127.0.0.1:8080/api/orders http://127.0.0.1:9999/ > ~/urls.txt
for i in $(seq 1 30); do ss -Htln | grep -q ':8080' && break; sleep 0.2; done
