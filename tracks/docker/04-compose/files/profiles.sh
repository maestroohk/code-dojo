# Lesson 3, step 2 (and its cold rebuild): a stack with optional debug and one-off tool services.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/shop
cat > ~/shop/compose.yaml <<'EOF'
services:
  web:
    image: shop/web:1.0
    ports:
      - "8080:80"

  cache:
    image: busybox:1.37
    command: ["httpd", "-f", "-p", "6379"]

  debug:
    image: busybox:1.37
    command: ["sleep", "1d"]
    profiles: [debug]

  seed:
    image: busybox:1.37
    command: ["sh", "-c", "echo 'seeded 3 products' > /seed/done && cat /seed/done"]
    volumes:
      - seed-data:/seed
    profiles: [tools]

volumes:
  seed-data:
EOF
