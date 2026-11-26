# A mixed fleet, as collected by an inventory job: ~/fleet/HOST/os-release (copied from /etc/os-release on each host)
# and ~/fleet/HOST/uname-r (the output of uname -r there). The files are the real formats of each distribution.
set -e -o pipefail
f=~/fleet
host() {   # host NAME KERNEL, then the os-release text on stdin
  mkdir -p "$f/$1"; cat > "$f/$1/os-release"; echo "$2" > "$f/$1/uname-r"
}
host web-01 6.8.0-87-generic <<'EOF'
PRETTY_NAME="Ubuntu 24.04.3 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.3 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
UBUNTU_CODENAME=noble
EOF
host web-02 6.17.0-8-generic <<'EOF'
PRETTY_NAME="Ubuntu 26.04 LTS"
NAME="Ubuntu"
VERSION_ID="26.04"
VERSION="26.04 LTS (Resolute Raccoon)"
VERSION_CODENAME=resolute
ID=ubuntu
ID_LIKE=debian
EOF
host ci-runner 6.17.0-5-generic <<'EOF'
PRETTY_NAME="Ubuntu 25.10"
NAME="Ubuntu"
VERSION_ID="25.10"
VERSION="25.10 (Questing Quokka)"
VERSION_CODENAME=questing
ID=ubuntu
ID_LIKE=debian
EOF
host legacy-api 5.15.0-160-generic <<'EOF'
PRETTY_NAME="Ubuntu 20.04.6 LTS"
NAME="Ubuntu"
VERSION_ID="20.04"
VERSION="20.04.6 LTS (Focal Fossa)"
ID=ubuntu
ID_LIKE=debian
EOF
host db-01 6.12.48+deb13-amd64 <<'EOF'
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
ID=debian
EOF
host db-02 6.1.0-40-amd64 <<'EOF'
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
EOF
host backup 5.10.0-35-amd64 <<'EOF'
PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"
NAME="Debian GNU/Linux"
VERSION_ID="11"
VERSION="11 (bullseye)"
ID=debian
EOF
host erp-01 5.14.0-570.12.1.el9_6.x86_64 <<'EOF'
NAME="Rocky Linux"
VERSION="9.6 (Blue Onyx)"
ID="rocky"
ID_LIKE="rhel centos fedora"
VERSION_ID="9.6"
PRETTY_NAME="Rocky Linux 9.6 (Blue Onyx)"
EOF
host erp-02 4.18.0-553.el8_10.x86_64 <<'EOF'
NAME="AlmaLinux"
VERSION="8.10 (Cerulean Leopard)"
ID="almalinux"
ID_LIKE="rhel centos fedora"
VERSION_ID="8.10"
PRETTY_NAME="AlmaLinux 8.10 (Cerulean Leopard)"
EOF
host old-crm 3.10.0-1160.el7.x86_64 <<'EOF'
NAME="CentOS Linux"
VERSION="7 (Core)"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="7"
PRETTY_NAME="CentOS Linux 7 (Core)"
EOF
host edge-proxy 6.12.55-0-lts <<'EOF'
NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.22.2
PRETTY_NAME="Alpine Linux v3.22"
EOF
host sap-01 6.4.0-150600.23.73-default <<'EOF'
NAME="openSUSE Leap"
VERSION="15.6"
ID="opensuse-leap"
ID_LIKE="suse opensuse"
VERSION_ID="15.6"
PRETTY_NAME="openSUSE Leap 15.6"
EOF
host batch-aws 6.1.155-176.282.amzn2023.x86_64 <<'EOF'
NAME="Amazon Linux"
VERSION="2023"
ID="amzn"
ID_LIKE="fedora"
VERSION_ID="2023"
PRETTY_NAME="Amazon Linux 2023.9.20251020"
EOF
host dev-laptop 6.14.0-34-generic <<'EOF'
NAME="Linux Mint"
VERSION="22.2 (Zara)"
ID=linuxmint
ID_LIKE="ubuntu debian"
PRETTY_NAME="Linux Mint 22.2"
VERSION_ID="22.2"
EOF
host build-box 6.17.7-arch1-1 <<'EOF'
NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
BUILD_ID=rolling
EOF
host design-ws 6.17.8-300.fc43.x86_64 <<'EOF'
NAME="Fedora Linux"
VERSION="43 (Workstation Edition)"
ID=fedora
VERSION_ID=43
PRETTY_NAME="Fedora Linux 43 (Workstation Edition)"
EOF
# The family each host belongs to, for the checks (not in the learner's home).
mkdir -p /opt/dojo/state
cat > /opt/dojo/state/families <<'EOF'
backup debian
batch-aws rhel
build-box arch
ci-runner debian
db-01 debian
db-02 debian
design-ws rhel
dev-laptop debian
edge-proxy alpine
erp-01 rhel
erp-02 rhel
legacy-api debian
old-crm rhel
sap-01 suse
web-01 debian
web-02 debian
EOF
chmod 644 /opt/dojo/state/families
