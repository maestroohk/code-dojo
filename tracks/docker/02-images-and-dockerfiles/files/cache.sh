# Lesson 3: a project whose Dockerfile copies everything before the slow dependency install.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/shop/src
printf '%s\n' json-parser 1.4.2 http-client 3.0.1 logger 2.2.0 | paste - - > ~/shop/deps.txt
cat > ~/shop/install-deps.sh <<'EOF'
#!/bin/sh
# Stands in for "dotnet restore" / "npm ci": slow, and only depends on the dependency list.
set -e
mkdir -p /deps
while read -r name version; do
  echo "installing $name $version"; sleep 1
  echo "$version" > "/deps/$name"
done < "$1"
date +%s%N > /deps/stamp
EOF
cat > ~/shop/src/app.sh <<'EOF'
#!/bin/sh
echo "app ready ($(ls /deps | grep -vc stamp) packages)"
EOF
cat > ~/shop/Dockerfile <<'EOF'
FROM alpine:3.24
WORKDIR /app
COPY . .
RUN sh install-deps.sh deps.txt
CMD ["sh", "src/app.sh"]
EOF
