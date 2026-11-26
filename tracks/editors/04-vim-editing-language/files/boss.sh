# Boss: an application log to triage, and an nginx site config to refactor.
set -e -o pipefail
mkdir -p /opt/dojo/state
cat > ~/app.log <<'EOF'
2026-11-26T02:00:01Z INFO  start worker=3
2026-11-26T02:00:04Z ERROR payment timeout order=1182
2026-11-26T02:00:05Z WARN  retry order=1182
2026-11-26T02:00:09Z INFO  heartbeat
2026-11-26T02:01:12Z ERROR db connection refused host=db1.example.com
2026-11-26T02:01:13Z INFO  reconnect
2026-11-26T02:02:30Z ERROR payment timeout order=1190
2026-11-26T02:03:00Z INFO  heartbeat
EOF
sha256sum ~/app.log | cut -d' ' -f1 > /opt/dojo/state/app.log.sha
grep ERROR ~/app.log > /opt/dojo/state/errors.expected

cat > ~/site.conf <<'EOF'
# site for the staging shop
# owner: web team
server {
    listen 443 ssl;
    server_name staging.example.com;
    # TODO move to the new upstream
    location /api/ {
        proxy_pass http://old_backend
    }
    location /admin/ {
        proxy_pass http://old_backend;
    }
    location /old_backend_status {
        return 204;
    }
}
EOF
cat > /opt/dojo/state/site.expected <<'EOF'
server {
    listen 443 ssl;
    server_name shop.example.com;
    location /api/ {
        proxy_pass http://api_backend;
    }
    location /admin/ {
        proxy_pass http://api_backend;
    }
    location /old_backend_status {
        return 204;
    }
}
EOF
chmod 644 /opt/dojo/state/*
