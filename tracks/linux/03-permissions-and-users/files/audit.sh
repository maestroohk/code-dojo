# Boss step 3: a server tree to audit with find -perm, then fix.
set -e -o pipefail
r=~/srv
mkdir -p "$r/www/uploads" "$r/app/certs" "$r/app/bin" "$r/home/ops/.ssh" "$r/logs"
echo hi > "$r/www/index.html";            chmod 644 "$r/www/index.html"
echo x > "$r/www/uploads/avatar.png";     chmod 666 "$r/www/uploads/avatar.png"
chmod 777 "$r/www/uploads"
echo key > "$r/app/certs/server.key";     chmod 644 "$r/app/certs/server.key"
echo crt > "$r/app/certs/server.pem";     chmod 640 "$r/app/certs/server.pem"
echo 'API_TOKEN=not-real' > "$r/app/.env"; chmod 604 "$r/app/.env"
printf '#!/bin/sh\n' > "$r/app/bin/run.sh"; chmod 755 "$r/app/bin/run.sh"
echo k > "$r/home/ops/.ssh/id_ed25519";    chmod 600 "$r/home/ops/.ssh/id_ed25519"
echo k > "$r/home/ops/.ssh/authorized_keys"; chmod 664 "$r/home/ops/.ssh/authorized_keys"
echo log > "$r/logs/app.log";             chmod 646 "$r/logs/app.log"
# What the scan should find, kept outside the learner's home (the fixes change the live answer).
mkdir -p /opt/dojo/state
find "$r" -perm -o+w | sort > /opt/dojo/state/world-writable
find "$r" \( -name '*.key' -o -name '*.pem' -o -name '.env' -o -path '*/.ssh/*' \) -perm /077 | sort > /opt/dojo/state/secrets
chmod 644 /opt/dojo/state/*