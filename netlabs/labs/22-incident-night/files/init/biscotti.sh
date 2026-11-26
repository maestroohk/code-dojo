# Mission 22: incident night. Four faults, one shop.
for f in shop-supervisor shopctl thumbnailer; do
  tr -d '\r' < "/lab/bin/$f" > "/usr/local/bin/$f"; chmod 755 "/usr/local/bin/$f"
done
mkdir -p /srv/shop/bin /etc/shop /var/log/shop
tr -d '\r' < /lab/bin/shop-api > /srv/shop/bin/shop-api; chmod 755 /srv/shop/bin/shop-api
useradd -r -d /srv/shop -s /usr/sbin/nologin shop
mkdir -p /srv/shop/data/sessions
chown -R shop:shop /srv/shop/data
for i in $(seq 1 40); do echo "2026-11-24 2$((i % 4)):$((10 + i)):00 order $((5000 + i)) 6 x ginger-snap" ; done > /srv/shop/data/orders.log
chown shop:shop /srv/shop/data/orders.log

# Fault 1: someone "secured" the config so well that the app can't read it.
printf '# Byte & Biscuit shop\n# The runbook says the shop listens on port %s\nport = %s0\nflavour_of_the_day = jammy-dodger\n' "$DOJO_PORT" "$DOJO_PORT" > /etc/shop/shop.conf
# (Fault 2 is in that file too: the port has one zero too many.)
chown root:root /etc/shop/shop.conf; chmod 600 /etc/shop/shop.conf

# Fault 3: a crash dump that filled the data disk.
head -c 40M /dev/urandom > "/srv/shop/data/core.$DOJO_COREPID" 2>/dev/null
chown shop:shop "/srv/shop/data/core.$DOJO_COREPID"

cat > /root/PAGER.txt <<TXT
*** PAGE *** 02:47  shop.bytebiscuit.example  CRITICAL
  - https://shop/health: connection refused (port $DOJO_PORT)
  - load average high on biscotti
  - disk /srv/shop/data 100% full
Runbook: shopctl status, logs in /var/log/shop/. The shop runs as user "shop" on port $DOJO_PORT.
TXT

# Fault 4: a CPU hog.
cd /
setsid nohup setpriv --reuid=shop --regid=shop --init-groups /usr/local/bin/thumbnailer >/dev/null 2>&1 &
/usr/local/bin/shopctl start >/dev/null
