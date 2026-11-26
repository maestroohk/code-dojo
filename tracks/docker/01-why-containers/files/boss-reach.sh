# Boss 1: the API is "up" but nobody can reach it: wrong container port, and it listens on its own loopback.
. "$DOJO_FILES/lib.sh"
d=/opt/dojo/build/shop-api-2.0; mkdir -p "$d/www"
echo ok > "$d/www/health"; echo "shop api 2.0" > "$d/www/index.html"
printf '%s\n' 'addr="${BIND:-127.0.0.1}:${PORT:-8000}"' 'echo "api 2.0 listening on $addr (set BIND and PORT to change it)"' \
  'exec httpd -f -v -p "$addr" -h /www' > "$d/start.sh"
build shop/api:2.0 <<'EOF'
FROM busybox:1.37
COPY www/ /www/
COPY start.sh /start.sh
EXPOSE 8000
CMD ["sh", "/start.sh"]
EOF
docker run -d --name api -p 8080:80 shop/api:2.0 >/dev/null
