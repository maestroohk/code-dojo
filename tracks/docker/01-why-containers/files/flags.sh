# Lesson 4: an image that greets with $GREETING on port 8000. The learner runs it with the right flags.
. "$DOJO_FILES/lib.sh"
d=/opt/dojo/build/shop-hello-1.0; mkdir -p "$d"
printf '%s\n' 'mkdir -p /www' 'echo "${GREETING:-Hello}" > /www/index.html' 'echo ok > /www/health' \
  'echo "hello 1.0 listening on 0.0.0.0:8000"' 'exec httpd -f -v -p 8000 -h /www' > "$d/start.sh"
build shop/hello:1.0 <<'EOF'
FROM busybox:1.37
COPY start.sh /start.sh
EXPOSE 8000
CMD ["sh", "/start.sh"]
EOF
