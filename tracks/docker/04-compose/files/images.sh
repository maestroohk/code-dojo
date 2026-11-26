# The shop's images for the Compose scenarios (sourced after lib.sh). All built from busybox:1.37, offline.
#   shop/web:1.0   HTTP on 80, GET / says "web 1.0"
#   shop/api:VER   HTTP on 8000 once it has reached the database at $DB_HOST:5432 (it exits 1 if it cannot)
#   shop/db:17     a PostgreSQL stand-in: takes 4 s to start, then answers on 5432; keeps its data in /var/lib/db
app shop/web:1.0 web 1.0

for ver in 1.0 1.1; do
  d="/opt/dojo/build/shop-api-$ver"; mkdir -p "$d/www"
  echo "api $ver" > "$d/www/index.html"; echo ok > "$d/www/health"
  cat > "$d/api.sh" <<EOF
#!/bin/sh
echo "api $ver: connecting to \${DB_HOST:-db}:5432"
if ! nc -w 2 "\${DB_HOST:-db}" 5432 </dev/null 2>/dev/null | grep -q ready; then
  echo "api $ver: ERROR database \${DB_HOST:-db}:5432 is not accepting connections" >&2
  exit 1
fi
echo "api $ver: connected, listening on :8000"
exec httpd -f -p 8000 -h /www
EOF
  build "shop/api:$ver" <<'EOF'
FROM busybox:1.37
COPY www/ /www/
COPY api.sh /api.sh
EXPOSE 8000
CMD ["sh", "/api.sh"]
EOF
done

d=/opt/dojo/build/shop-db-17; mkdir -p "$d"
cat > "$d/db.sh" <<'EOF'
#!/bin/sh
echo "db: starting, data directory /var/lib/db"
mkdir -p /var/lib/db; [ -f /var/lib/db/PG_VERSION ] || { echo 17 > /var/lib/db/PG_VERSION; echo "db: initialised a new, empty database"; }
sleep 4
echo "db: ready to accept connections on 5432"
touch /tmp/ready
exec nc -lk -p 5432 -e echo "PostgreSQL 17 ready"
EOF
build shop/db:17 <<'EOF'
FROM busybox:1.37
COPY db.sh /db.sh
EXPOSE 5432
CMD ["sh", "/db.sh"]
EOF
