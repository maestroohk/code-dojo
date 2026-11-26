# Boss step 1: a web app tree that failed a security scan (symbolic chmod fixes).
set -e -o pipefail
s=~/site
mkdir -p "$s/bin" "$s/conf" "$s/uploads" "$s/public"
printf '#!/bin/bash\necho start\n' > "$s/bin/start.sh"
printf '#!/bin/bash\necho stop\n' > "$s/bin/stop.sh"
echo 'listen 8080' > "$s/conf/app.conf"
echo 'level=info' > "$s/conf/logging.conf"
echo 'hi' > "$s/public/index.html"
chmod 644 "$s/bin/"*.sh
chmod 666 "$s/conf/"*.conf
chmod 777 "$s/uploads"
chmod 640 "$s/public/index.html"
