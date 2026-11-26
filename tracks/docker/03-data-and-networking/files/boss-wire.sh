# Boss 2: web, api and db, all on the default bridge: no names, and the web tier can reach the database.
. "$DOJO_FILES/lib.sh"
app shop/web:1.0 web 1.0
app shop/api:1.0 "api" 1.0 5000
docker run -d --name web -p 8080:80 shop/web:1.0 >/dev/null
docker run -d --name api shop/api:1.0 >/dev/null
docker run -d --name db busybox:1.37 nc -lk -p 5432 -e echo "PostgreSQL 17 ready" >/dev/null
