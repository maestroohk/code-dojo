#!/bin/bash
# Reference package-manager detector (lesson 3's answer), used by the checks and installed for the boss.
# pkgmgr-ref FILE: apt, dnf, yum, zypper, pacman, apk, nix or unknown.
f=${1:-/etc/os-release}
read -r id ver like < <(ID= VERSION_ID= ID_LIKE=; . "$f"; echo "${ID:-} ${VERSION_ID:-0} ${ID_LIKE:-}")
major=${ver%%.*}
for w in $id $like; do
  case ${w,,} in
    debian|ubuntu) echo apt; exit ;;
    fedora) echo dnf; exit ;;
    rhel|centos|rocky|almalinux) if [ "$major" -lt 8 ] 2>/dev/null; then echo yum; else echo dnf; fi; exit ;;
    amzn) if [ "$ver" = 2 ]; then echo yum; else echo dnf; fi; exit ;;
    opensuse*|sles|suse) echo zypper; exit ;;
    arch) echo pacman; exit ;;
    alpine) echo apk; exit ;;
    nixos) echo nix; exit ;;
  esac
done
echo unknown
