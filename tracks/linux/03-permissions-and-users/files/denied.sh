# Boss step 2: "bob gets Permission denied, ana does not". The cause is a group and a directory's x bit.
set -e -o pipefail
groupadd -f devs
for u in ana bob eve; do id "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"; done
usermod -aG devs ana
mkdir -p /srv/app
echo 'db_host: db.example.com' > /srv/app/config.yml
chown root:devs /srv/app/config.yml
chmod 640 /srv/app/config.yml
chown ana:root /srv/app
chmod 750 /srv/app
