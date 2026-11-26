# Lesson 1: an API image with a health endpoint but no HEALTHCHECK. It takes 3 seconds to start.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/api/www
echo ok > ~/api/www/health
echo "orders api 1.2" > ~/api/www/index.html
cat > ~/api/start.sh <<'EOF'
#!/bin/sh
echo "orders api 1.2: warming up"
sleep 3
echo "orders api 1.2: listening on :8000, health at /health"
exec httpd -f -p 8000 -h /www
EOF
cat > ~/api/Dockerfile <<'EOF'
FROM busybox:1.37
COPY www/ /www/
COPY start.sh /start.sh
EXPOSE 8000
CMD ["sh", "/start.sh"]
EOF
