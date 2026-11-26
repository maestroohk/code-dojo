# Lesson 1: a deploy folder with the modes a hurried colleague left behind.
set -e -o pipefail
d=~/deploy
mkdir -p "$d/public/css" "$d/keys"
printf '#!/bin/bash\necho "deploying"\n' > "$d/deploy.sh"
printf 'DB_PASSWORD=not-a-real-secret\n' > "$d/config.env"
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n' > "$d/keys/id_ed25519"
echo '<h1>Shop</h1>' > "$d/public/index.html"
echo 'body{}' > "$d/public/css/site.css"
chmod 644 "$d/deploy.sh"
chmod 666 "$d/config.env"
chmod 664 "$d/keys/id_ed25519"
chmod 700 "$d/public" "$d/public/css"
chmod 600 "$d/public/index.html" "$d/public/css/site.css"
