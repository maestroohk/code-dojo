# Lesson 2: trailing comments to strip with motions inside :normal. Full-line comments must stay.
set -e -o pipefail
mkdir -p /opt/dojo/state
cat > ~/servers.conf <<'EOF'
# primary database, see the runbook
host = db1.example.com    # moved in March
port = 5432
user = app   # service account
pool = 20 # was 10
timeout = 30s
EOF
cat > /opt/dojo/state/servers.expected <<'EOF'
# primary database, see the runbook
host = db1.example.com
port = 5432
user = app
pool = 20
timeout = 30s
EOF
chmod 644 /opt/dojo/state/servers.expected
