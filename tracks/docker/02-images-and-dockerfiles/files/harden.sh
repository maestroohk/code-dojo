# Lesson 5: an API image with everything a reviewer flags: lint warnings, a token baked in, root, and a .env
# file (plus Git history) copied into the image.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/api/.git
cat > ~/api/server.sh <<'EOF'
#!/bin/sh
[ -n "$API_TOKEN" ] || echo "warning: API_TOKEN is not set (pass it at run time)"
echo "api ready as $(id -un)"
EOF
printf '%s\n' 'API_TOKEN=tok_live_example_9f2c' 'DB_PASSWORD=example-only' > ~/api/.env
echo 'ref: refs/heads/main' > ~/api/.git/HEAD
cat > ~/api/Dockerfile <<'EOF'
from alpine:3.24 as Runtime
ENV API_TOKEN=tok_live_example_9f2c
WORKDIR /app
COPY . .
CMD sh server.sh
EOF
