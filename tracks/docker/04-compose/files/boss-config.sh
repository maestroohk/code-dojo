# Boss 1: a compose.yaml that Compose refuses to load, with a password a teammate wanted to hard-code.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/shop
cat > ~/shop/compose.yaml <<'EOF'
services:
  web:
    image: shop/web:1.0
    ports:
      - "8080:80"
    networks: [frontend]

  api:
    environment:
      DB_HOST: db
      DB_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD must be set (in .env, never in this file)}
    networks: [front, back]
    depends_on:
      db:
        condition: service_healthy

  db:
    image: shop/db:17
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/ready"]
      interval: 1s
      retries: 20
    networks: [back]

networks:
  front:
  back:
EOF
echo "# the staging database password is in the team vault: example-staging-pw" > ~/shop/NOTES.md
