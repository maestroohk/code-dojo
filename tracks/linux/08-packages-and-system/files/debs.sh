# Lesson 1: two .deb files built on the spot with dpkg-deb, as a vendor would ship them. No network needed.
set -e -o pipefail
build() {   # build NAME VERSION DEPENDS
  local root; root=$(mktemp -d)
  mkdir -p "$root/DEBIAN" "$root/usr/local/bin" "$root/usr/share/doc/$1"
  cat > "$root/DEBIAN/control" <<EOF
Package: $1
Version: $2
Architecture: all
Maintainer: Shop Team <team@example.com>
Depends: $3
Section: utils
Priority: optional
Description: $1 for the shop
 A small tool the shop team ships as a package.
EOF
  printf '#!/bin/sh\necho "%s %s: ok"\n' "$1" "$2" > "$root/usr/local/bin/$1"
  chmod 755 "$root/usr/local/bin/$1"
  echo "$1 $2" > "$root/usr/share/doc/$1/README"
  dpkg-deb --build --root-owner-group "$root" ~/pkgs/"$1_$2_all.deb" >/dev/null
  rm -rf "$root"
}
mkdir -p ~/pkgs
build hello-shop 1.0-1 "jq (>= 1.6)"
build shop-report 2.1-1 "shop-lib (>= 2.0), jq"
