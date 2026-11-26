# Boss 3: a dev box full of stopped containers and volumes. Some data must survive the clean-up.
. "$DOJO_FILES/lib.sh"
docker volume create pgdata >/dev/null
docker volume create reports >/dev/null
docker run --rm -v reports:/r busybox:1.37 sh -c 'echo "Q3 revenue report" > /r/q3.txt'
# The retired database: named volume for its data, an anonymous one for its cache.
docker run -d --name old-db -v pgdata:/var/lib/postgresql/data -v /cache busybox:1.37 sh -c \
  'echo "customers: 1204 rows" > /var/lib/postgresql/data/base.txt && echo warm > /cache/c && exec sleep 1d' >/dev/null
for i in $(seq 20); do docker exec old-db test -s /var/lib/postgresql/data/base.txt 2>/dev/null && break; sleep 0.25; done
docker stop -t 1 old-db >/dev/null
# Test runs that each left an anonymous volume behind.
for n in 1 2 3; do docker run --name "test-run-$n" -v /tmp/work busybox:1.37 sh -c "echo run $n > /tmp/work/out" >/dev/null; done
docker run -d --name web busybox:1.37 httpd -f -p 80 >/dev/null
