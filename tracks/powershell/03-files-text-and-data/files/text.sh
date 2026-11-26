# Lesson 3: a deploy log with US-style dates, plus the module's usual data.
set -e -o pipefail
bash "$DOJO_FILES/data.sh"
cat > ~/logs/deploy.log <<'EOF'
11/24/2026 09:02 deploy started: shop 4.1.0 by asha
11/24/2026 09:07 deploy finished: shop 4.1.0 (5 min)
11/25/2026 16:40 rollback started: shop 4.1.0 -> 4.0.3 by li
11/25/2026 16:44 rollback finished
11/26/2026 08:15 deploy started: shop 4.1.1 by asha
no date on this line: manual note from the incident channel
11/26/2026 08:19 deploy finished: shop 4.1.1 (4 min)
EOF
