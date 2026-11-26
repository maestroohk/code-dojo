# Boss 2: six containers in six states. Read them with docker ps filters and docker inspect.
. "$DOJO_FILES/lib.sh"
app shop/web:1.0 web 1.0
docker run -d --name web shop/web:1.0 >/dev/null
docker run -d --name api --restart always busybox:1.37 sh -c 'echo "api: cannot read /run/secrets/db_password" >&2; exit 1' >/dev/null
docker run -d --name db --memory 16m --memory-swap 16m busybox:1.37 sh -c 'echo "db: warming the cache"; tail /dev/zero' >/dev/null
docker run -d --name proxy --health-cmd 'wget -qO- http://localhost:81/ >/dev/null || exit 1' \
  --health-interval 1s --health-retries 2 --health-timeout 1s busybox:1.37 httpd -f -p 80 >/dev/null
docker run --name job busybox:1.37 echo "invoices sent" >/dev/null
docker run -d --init --name worker busybox:1.37 sh -c 'echo "worker: started"; sleep 1; kill -9 $$' >/dev/null
docker wait db worker >/dev/null
for i in $(seq 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' proxy)" = unhealthy ] && break; sleep 0.5; done
for i in $(seq 40); do [ "$(docker inspect -f '{{.RestartCount}}' api)" -ge 2 ] && break; sleep 0.5; done
