# Boss 3: a web project with a slow install, a big logs/ folder and a busy .git, all sent as build context.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/web/src ~/web/logs ~/web/.git/objects
printf '%s\n' 'left-pad 1.3.0' 'router 5.1.0' > ~/web/packages.txt
cat > ~/web/install.sh <<'EOF'
#!/bin/sh
set -e
mkdir -p /deps
while read -r name version; do echo "installing $name"; sleep 1; echo "$version" > "/deps/$name"; done < packages.txt
date +%s%N > /deps/stamp
EOF
printf '%s\n' '#!/bin/sh' 'echo "web up with $(ls /deps | grep -vc stamp) packages"' > ~/web/src/server.sh
head -c 20000000 /dev/zero | tr '\0' 'x' | fold -w 100 > ~/web/logs/debug.log
echo 'ref: refs/heads/main' > ~/web/.git/HEAD
cat > ~/web/Dockerfile <<'EOF'
FROM alpine:3.24
WORKDIR /app
COPY . .
RUN sh install.sh
CMD ["sh", "src/server.sh"]
EOF
