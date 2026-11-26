# Lesson 2: a production config to change, but the change must go to a new file.
set -e -o pipefail
mkdir -p ~/conf /opt/dojo/state
cat > ~/conf/app.conf <<'EOF'
server {
    listen 80;
    server_name shop.example.com;
    root /srv/shop;
}
EOF
sha256sum ~/conf/app.conf | cut -d' ' -f1 > /opt/dojo/state/app.sha
sed 's/listen 80;/listen 8080;/' ~/conf/app.conf > /opt/dojo/state/app.conf.new
chmod 644 /opt/dojo/state/*
