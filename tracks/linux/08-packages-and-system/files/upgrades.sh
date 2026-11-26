# Boss step 2: what this machine has installed, against a (made-up) newer package index.
set -e -o pipefail
# "package version" lines, as a mirror's index would list them. Some packages appear twice (two suites).
cat > ~/available.txt <<EOF
curl 8.14.1-2+deb13u9
curl 8.14.1-2+deb13u8
jq 1.7.1-6+deb13u4
git 1:2.47.3-0+deb13u2
openssh-client 1:10.0p1-7+deb13u1
openssh-client 1:10.0p1-7+deb13u3
sudo 1.9.16p2-3+deb13u2
vim 2:9.1.1230-2+deb13u1
python3 3.13.5-1+deb13u1
not-installed-here 1.0-1
bash 5.2.37-2+b5
EOF
