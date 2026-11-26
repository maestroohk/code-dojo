# Lesson 2, step 2: someone added "the worker needs the API" to a stack where the API already waits for the worker.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/stack
cat > ~/stack/compose.yaml <<'EOF'
services:
  db:
    image: shop/db:17
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/ready"]
      interval: 1s
      retries: 20

  api:
    image: shop/api:1.0
    environment:
      DB_HOST: db
    depends_on:
      db:
        condition: service_healthy
      worker:
        condition: service_started

  worker:
    image: busybox:1.37
    command: ["sh", "-c", "echo 'worker: polling the queue'; exec sleep 1d"]
    depends_on:
      - api
EOF
