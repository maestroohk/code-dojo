# Mission 14: a deploy that fails with "permission denied" in four different ways.
set -e
groupadd deployers
useradd -m -s /bin/bash deploy
useradd -m -s /bin/bash gary
useradd -m -s /bin/bash intern

mkdir -p /etc/app /srv/app/releases
printf 'db_user=biscuits\ndb_password=Cust4rd-Cr34m-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')" > /etc/app/secret.conf
chown root:root /etc/app/secret.conf
chmod "$DOJO_MODE" /etc/app/secret.conf

cat > /srv/app/deploy.sh <<'SH'
#!/bin/bash
# Deploys the biscuit shop. Run as the deploy user.
set -e
echo "Reading secrets..."
grep -q db_password /etc/app/secret.conf
echo "Writing release..."
date '+release built %F %T' > /srv/app/releases/latest.txt
echo "Deployed! Biscuits are go."
SH
chown root:root /srv/app/deploy.sh
chmod 644 /srv/app/deploy.sh
chown "$DOJO_OWNER:$(id -gn "$DOJO_OWNER")" /srv/app/releases
chmod 755 /srv/app/releases

cat > /srv/app/deploy.log <<'LOG'
[Fri 17:02] deploy@jammie$ /srv/app/deploy.sh
-bash: /srv/app/deploy.sh: Permission denied
[Fri 17:03] deploy@jammie$ bash /srv/app/deploy.sh
grep: /etc/app/secret.conf: Permission denied
[Fri 17:05] gary: "I'll just chmod 777 everything" -- Brenda: "GARY, NO."
[Fri 17:06] gary has left the building
LOG

cat > /usr/local/bin/restart-oven <<'SH'
#!/bin/bash
if [ "$(id -u)" -ne 0 ]; then echo "restart-oven: only root may restart the oven" >&2; exit 1; fi
echo "Oven restarted. It smells of fresh biscuits."
SH
chmod 755 /usr/local/bin/restart-oven
