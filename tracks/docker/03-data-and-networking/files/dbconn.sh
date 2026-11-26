# Lesson 3 (and its cold rebuild): the API cannot reach its database. It is configured with localhost, and it is
# not on the database's network.
. "$DOJO_FILES/lib.sh"
docker network create shop >/dev/null
docker run -d --name db --network shop busybox:1.37 nc -lk -p 5432 -e echo "PostgreSQL 17 ready" >/dev/null

d=/opt/dojo/build/shop-api-3.0; mkdir -p "$d"
cat > "$d/api.sh" <<'EOF'
#!/bin/sh
echo "api 3.0 starting; database at ${DB_HOST}:${DB_PORT}"
while true; do
  if nc -w 2 "$DB_HOST" "$DB_PORT" </dev/null 2>/dev/null | grep -q ready; then
    echo "connected to ${DB_HOST}:${DB_PORT}"
  else
    echo "ERROR could not connect to ${DB_HOST}:${DB_PORT}: connection refused" >&2
  fi
  sleep 3
done
EOF
build shop/api:3.0 <<'EOF'
FROM busybox:1.37
COPY api.sh /api.sh
ENV DB_PORT=5432
CMD ["sh", "/api.sh"]
EOF
docker run -d --name api -e DB_HOST=localhost shop/api:3.0 >/dev/null
sleep 1
