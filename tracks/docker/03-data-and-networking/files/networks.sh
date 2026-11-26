# Lesson 2: three containers on the default bridge, where names do not resolve and everyone can reach everyone.
. "$DOJO_FILES/lib.sh"
# busybox nc stands in for PostgreSQL: it answers every connection on 5432 with a greeting.
docker run -d --name db busybox:1.37 nc -lk -p 5432 -e echo "PostgreSQL 17 ready" >/dev/null
docker run -d --name api busybox:1.37 sleep 1d >/dev/null
docker run -d --name metrics busybox:1.37 sleep 1d >/dev/null
note api-id "$(docker inspect -f '{{.Id}}' api)"
note db-id "$(docker inspect -f '{{.Id}}' db)"
