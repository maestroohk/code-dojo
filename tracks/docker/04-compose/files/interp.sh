# Lesson 3, step 1: a compose file driven by variables, and no .env yet.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/shop
cat > ~/shop/compose.yaml <<'EOF'
services:
  db:
    image: shop/db:17

  api:
    image: shop/api:${API_TAG:-1.0}
    environment:
      DB_HOST: db
      LOG_LEVEL: ${LOG_LEVEL:-info}
    ports:
      - "127.0.0.1:${API_PORT:?set API_PORT in .env}:8000"
    depends_on:
      - db
    restart: on-failure
EOF
