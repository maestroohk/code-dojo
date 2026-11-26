# Boss 2: the morning after a deploy. Three of four containers are down, each for its own reason.
. "$DOJO_FILES/lib.sh"
app shop/web:2.0 web 2.0
d=/opt/dojo/build/shop-mailer-1.0; mkdir -p "$d"
printf '%s\n' '#!/bin/sh' 'echo "mail-relay 1.0: relaying on :2525"' 'exec nc -lk -p 2525 -e echo "220 mail.example.com ESMTP"' > "$d/mail-relay"
build shop/mailer:1.0 <<'EOF'
FROM busybox:1.37
COPY mail-relay /usr/local/bin/mail-relay
RUN chmod +x /usr/local/bin/mail-relay
CMD ["mail-relay"]
EOF
# The thumbnailer needs about 24 MB of working memory while it loads its cache.
d=/opt/dojo/build/shop-thumbnails-1.0; mkdir -p "$d"
printf '%s\n' '#!/bin/sh' 'echo "thumbnails: loading the image cache"' 'cache=$(head -c 24000000 /dev/zero | tr "\0" x)' \
  'echo "thumbnails: ready (${#cache} bytes cached)"' 'exec sleep 1d' > "$d/run.sh"
build shop/thumbnails:1.0 <<'EOF'
FROM busybox:1.37
COPY run.sh /run.sh
CMD ["sh", "/run.sh"]
EOF
docker run -d --name thumbnails --memory 16m --memory-swap 16m shop/thumbnails:1.0 >/dev/null
# Someone overrode the image's command with an old one.
docker run -d --name mailer shop/mailer:1.0 smtp-relay --port 2525 >/dev/null 2>&1 || true   # cannot start: stays "Created"
# httpd without -f goes to the background, and the container's main process ends.
docker run -d --name status busybox:1.37 httpd -p 80 >/dev/null
docker run -d --name web -p 8080:80 shop/web:2.0 >/dev/null
docker wait thumbnails status >/dev/null
