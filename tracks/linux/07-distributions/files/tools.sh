# Boss: the fleet, plus working osinfo / osfamily helpers (what lesson 3 built) and the support table.
set -e -o pipefail
bash "$DOJO_FILES/fleet.sh"
mkdir -p ~/bin
cat > ~/bin/osfamily <<'EOF'
#!/bin/bash
# osfamily [FILE]: debian, rhel, suse, arch, alpine or unknown, from ID and then the words of ID_LIKE.
set -euo pipefail
f=${1:-/etc/os-release}
read -r id like < <(ID= ID_LIKE=; . "$f"; echo "${ID:-} ${ID_LIKE:-}")
for w in $id $like; do
  case ${w,,} in
    debian|ubuntu) echo debian; exit ;;
    rhel|fedora|centos|rocky|almalinux|amzn) echo rhel; exit ;;
    suse|sles|opensuse*) echo suse; exit ;;
    arch) echo arch; exit ;;
    alpine) echo alpine; exit ;;
  esac
done
echo unknown
EOF
chmod 755 ~/bin/osfamily
# Support ends (last day of free security updates; Ubuntu: standard support), from the projects' lifecycle pages.
# A row matches a host when the ids are equal and VERSION_ID is the version, or starts with "version." (9.6 is 9).
cat > ~/fleet/support.csv <<'EOF'
id,version,ends
ubuntu,20.04,2025-05-31
ubuntu,22.04,2027-06-30
ubuntu,24.04,2029-06-30
ubuntu,25.10,2026-07-31
ubuntu,26.04,2031-06-30
debian,11,2026-08-31
debian,12,2028-06-30
debian,13,2030-06-30
rocky,9,2032-05-31
almalinux,8,2029-03-01
centos,7,2024-06-30
alpine,3.22,2027-05-01
opensuse-leap,15.6,2026-04-30
amzn,2023,2029-06-30
linuxmint,22.2,2029-04-30
fedora,43,2026-12-09
EOF
