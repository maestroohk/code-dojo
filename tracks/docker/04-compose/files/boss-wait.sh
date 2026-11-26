# Boss 3: `docker compose up --wait` never succeeds: the API's healthcheck can never pass.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/shop
cat > ~/shop/compose.yaml <<'EOF'
services:
  db:
    image: shop/db:17
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/ready"]
      interval: 1s
      retries: 20

  api:
    image: shop/api:1.1
    environment:
      DB_HOST: db
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 1s
      timeout: 2s
      retries: 3
      start_period: 2s

  web:
    image: shop/web:1.0
    ports:
      - "8080:80"
    depends_on:
      api:
        condition: service_healthy
EOF
