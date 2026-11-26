# Boss 1: a slow-starting service whose healthcheck gives up before it is ready, so it is marked unhealthy forever
# (an orchestrator would kill and restart it in a loop).
. "$DOJO_FILES/lib.sh"
d=/opt/dojo/build/shop-search-3.1; mkdir -p "$d/www"
echo ok > "$d/www/health"
cat > "$d/start.sh" <<'EOF'
#!/bin/sh
echo "search 3.1: building the index (takes about 8 s)"
sleep 8
echo "search 3.1: index ready, listening on :9200"
exec httpd -f -p 9200 -h /www
EOF
build shop/search:3.1 <<'EOF'
FROM busybox:1.37
COPY www/ /www/
COPY start.sh /start.sh
CMD ["sh", "/start.sh"]
EOF
docker run -d --name search --health-cmd 'wget -qO- http://localhost:9200/health || exit 1' \
  --health-interval 1s --health-timeout 1s --health-retries 3 shop/search:3.1 >/dev/null
for i in $(seq 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' search)" = unhealthy ] && break; sleep 0.25; done
