# Lesson 2: a stack that passes the database password as an environment variable.
. "$DOJO_FILES/lib.sh"
d=/opt/dojo/build/shop-billing-2.0; mkdir -p "$d"
cat > "$d/billing.sh" <<'EOF'
#!/bin/sh
# Reads DB_PASSWORD_FILE when it is set (the secret-file convention), else DB_PASSWORD.
if [ -n "$DB_PASSWORD_FILE" ]; then
  [ -r "$DB_PASSWORD_FILE" ] || { echo "billing: ERROR cannot read $DB_PASSWORD_FILE" >&2; exit 1; }
  pw=$(cat "$DB_PASSWORD_FILE"); src="file $DB_PASSWORD_FILE"
else
  pw="$DB_PASSWORD"; src="environment variable DB_PASSWORD"
fi
[ -n "$pw" ] || { echo "billing: ERROR no database password" >&2; exit 1; }
echo "billing 2.0: database password loaded from $src (${#pw} characters)"
echo "billing 2.0: log level ${Logging__LogLevel__Default:-Information}"
exec sleep 1d
EOF
build shop/billing:2.0 <<'EOF'
FROM busybox:1.37
COPY billing.sh /billing.sh
CMD ["sh", "/billing.sh"]
EOF
mkdir -p ~/billing
cat > ~/billing/compose.yaml <<'EOF'
services:
  billing:
    image: shop/billing:2.0
    environment:
      DB_PASSWORD: ${DB_PASSWORD}
EOF
printf '%s\n' 'DB_PASSWORD=s3cr3t-example-only' > ~/billing/.env
