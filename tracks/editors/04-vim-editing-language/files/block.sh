# Lesson 3: three dangerous lines in a deploy script to comment out (lines 4 to 6).
set -e -o pipefail
mkdir -p /opt/dojo/state
cat > ~/deploy.sh <<'EOF'
#!/bin/bash
set -euo pipefail
echo "deploying $1"
rm -rf /srv/app/cache
rm -rf /srv/app/tmp
rm -rf /srv/app/logs
systemctl restart app
EOF
chmod +x ~/deploy.sh
sed '4,6s/^/# /' ~/deploy.sh > /opt/dojo/state/deploy.expected
chmod 644 /opt/dojo/state/deploy.expected
