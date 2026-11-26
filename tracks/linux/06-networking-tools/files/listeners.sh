# Lesson 2 (and its cold rebuild): three real TCP listeners, started as the learner so ss -p shows them.
set -e -o pipefail
cat > /usr/local/bin/fake-db <<'EOF'
#!/usr/bin/python3
# Listens like a database would, on loopback only.
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 5432)); s.listen()
while True:
    time.sleep(300)
EOF
cat > /usr/local/bin/metrics-exporter <<'EOF'
#!/usr/bin/python3
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 9100)); s.listen()
while True:
    time.sleep(300)
EOF
cat > /usr/local/bin/shop-api <<'EOF'
#!/usr/bin/python3
import http.server
http.server.ThreadingHTTPServer(("127.0.0.1", 8080), http.server.SimpleHTTPRequestHandler).serve_forever()
EOF
chmod 755 /usr/local/bin/fake-db /usr/local/bin/metrics-exporter /usr/local/bin/shop-api
for p in fake-db metrics-exporter shop-api; do runuser -u learner -- setsid -f "/usr/local/bin/$p" >/dev/null 2>&1 < /dev/null; done
for i in $(seq 1 30); do [ "$(ss -Htln | wc -l)" -ge 3 ] && break; sleep 0.2; done
