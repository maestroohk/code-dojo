# Lesson 2, step 1: the API starts as soon as the database container starts, which is before it is ready.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/stack
cat > ~/stack/compose.yaml <<'EOF'
services:
  db:
    image: shop/db:17

  api:
    image: shop/api:1.0
    environment:
      DB_HOST: db
    depends_on:
      - db
EOF
