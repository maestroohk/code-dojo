# Mission 21: build two offline .deb packages for you to install.
set -e
b=/tmp/build
rm -rf "$b"
# crumbd 1.4.2
mkdir -p $b/crumbd/DEBIAN $b/crumbd/usr/sbin $b/crumbd/etc/crumbd $b/crumbd/etc/init.d
tr -d '\r' < /lab/pkg/crumbd > $b/crumbd/usr/sbin/crumbd
tr -d '\r' < /lab/pkg/crumbd.init > $b/crumbd/etc/init.d/crumbd
chmod 755 $b/crumbd/usr/sbin/crumbd $b/crumbd/etc/init.d/crumbd
printf '# crumbd configuration\nlisten = 127.0.0.1\nport = 7000\n' > $b/crumbd/etc/crumbd/crumbd.conf
cat > $b/crumbd/DEBIAN/control <<'CTL'
Package: crumbd
Version: 1.4.2
Architecture: all
Maintainer: Byte & Biscuit Ops <ops@example.com>
Depends: python3
Section: net
Priority: optional
Description: Crumb Of The Day server
 A tiny TCP service that hands every visitor one crumb of wisdom.
CTL
echo /etc/crumbd/crumbd.conf > $b/crumbd/DEBIAN/conffiles
printf '#!/bin/sh\necho "crumbd installed. Edit /etc/crumbd/crumbd.conf, then start it with: service crumbd start"\n' > $b/crumbd/DEBIAN/postinst
chmod 755 $b/crumbd/DEBIAN/postinst
# sprinkles-cli 0.9.1, which needs crumbd
mkdir -p $b/sprinkles/DEBIAN $b/sprinkles/usr/bin
tr -d '\r' < /lab/pkg/sprinkles > $b/sprinkles/usr/bin/sprinkles
chmod 755 $b/sprinkles/usr/bin/sprinkles
cat > $b/sprinkles/DEBIAN/control <<'CTL'
Package: sprinkles-cli
Version: 0.9.1
Architecture: all
Maintainer: Byte & Biscuit Ops <ops@example.com>
Depends: crumbd (>= 1.4), netcat-openbsd
Section: utils
Priority: optional
Description: Command-line client for crumbd
 Prints today's crumb of wisdom.
CTL
mkdir -p /root/packages
dpkg-deb --root-owner-group --build $b/crumbd /root/packages/crumbd_1.4.2_all.deb >/dev/null
dpkg-deb --root-owner-group --build $b/sprinkles /root/packages/sprinkles-cli_0.9.1_all.deb >/dev/null
rm -rf "$b"
