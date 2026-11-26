# Lesson 4: a static site whose single-stage image ships its sources and build script too.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/site/src
cat > ~/site/src/index.html <<'EOF'
<!doctype html>
    <html>
      <body>
        <h1>Shop</h1>
        <p>build-marker: site 2.0</p>
      </body>
    </html>
EOF
cat > ~/site/build.sh <<'EOF'
#!/bin/sh
# The "compiler": minify every page into dist/ and pre-compress it.
set -e
mkdir -p dist
for f in src/*.html; do sed 's/^[[:space:]]*//' "$f" > "dist/$(basename "$f")"; gzip -k -f "dist/$(basename "$f")"; done
echo "built $(ls dist | wc -l) files"
EOF
cat > ~/site/Dockerfile <<'EOF'
FROM alpine:3.24
WORKDIR /app
COPY . .
RUN sh build.sh
CMD ["httpd", "-f", "-p", "80", "-h", "/app/dist"]
EOF
