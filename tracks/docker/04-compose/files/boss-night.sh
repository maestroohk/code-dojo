# Boss 2: a stack that ran all night; the worker died at some point and nobody noticed.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/shop
d=/opt/dojo/build/shop-worker-2.3; mkdir -p "$d"
cat > "$d/worker.sh" <<'EOF'
#!/bin/sh
max="${QUEUE_MAX:-5}"
echo "worker 2.3: queue limit ${max}"
for n in 1 2 3 4 5 6 7 8; do
  if [ "$n" -gt "$max" ]; then
    echo "worker 2.3: ERROR queue full (${max} jobs): raise QUEUE_MAX" >&2
    exit 75
  fi
  echo "worker 2.3: job $n done"
done
echo "worker 2.3: idle, waiting for jobs"
exec sleep 1d
EOF
build shop/worker:2.3 <<'EOF'
FROM busybox:1.37
COPY worker.sh /worker.sh
CMD ["sh", "/worker.sh"]
EOF
cat > ~/shop/compose.yaml <<'EOF'
services:
  web:
    image: shop/web:1.0
    ports:
      - "8080:80"

  worker:
    image: shop/worker:2.3
    environment:
      QUEUE_MAX: ${QUEUE_MAX:-5}

  cache:
    image: busybox:1.37
    command: ["httpd", "-f", "-p", "6379"]
EOF
cd ~/shop && docker compose up -d >/dev/null 2>&1
for i in $(seq 40); do [ "$(docker inspect -f '{{.State.Status}}' shop-worker-1 2>/dev/null)" = exited ] && break; sleep 0.25; done
