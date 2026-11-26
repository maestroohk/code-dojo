# Lesson 3 (and its cold rebuild): a small "shop" on one host. One container crashed; the API keeps its
# settings in a file inside its container.
. "$DOJO_FILES/lib.sh"

d=/opt/dojo/build/shop-api-1.4; mkdir -p "$d/www"
printf '%s\n' 'port=8080' 'max_connections=250' 'log_level=info' > "$d/api.conf"
echo "shop api 1.4" > "$d/www/index.html"
printf '%s\n' 'echo "api 1.4 starting"' 'echo "loaded /etc/shop/api.conf"' 'echo "listening on :8080"' 'exec httpd -f -p 8080 -h /www' > "$d/run.sh"
build shop/api:1.4 <<'EOF'
FROM busybox:1.37
COPY api.conf /etc/shop/api.conf
COPY www/ /www/
COPY run.sh /run.sh
CMD ["sh", "/run.sh"]
EOF

d=/opt/dojo/build/shop-worker-1.4; mkdir -p "$d"
printf '%s\n' 'echo "worker 1.4 starting"' 'echo "connecting to queue at rabbit:5672"' \
  'echo "ERROR cannot connect to queue at rabbit:5672: connection refused" >&2' 'exit 3' > "$d/run.sh"
build shop/worker:1.4 <<'EOF'
FROM busybox:1.37
COPY run.sh /run.sh
CMD ["sh", "/run.sh"]
EOF

docker run -d --name api -p 8080:8080 shop/api:1.4 >/dev/null
docker run -d --name cache busybox:1.37 sleep 1d >/dev/null
docker run --name report busybox:1.37 echo "report sent to finance@example.com" >/dev/null
docker run -d --name worker shop/worker:1.4 >/dev/null
docker wait worker >/dev/null
