# Module 6 REST scenarios: the ticket API on :8088, three services with /health on :8091-8093, and an API token
# the way ops hands it out (a file only you can read). Waits until every port answers.
set -e -o pipefail
mkdir -p ~/answers ~/scripts ~/.config/ops /opt/dojo/state
echo "dojo-tk-7f3a9c2e51b84d06" > /opt/dojo/state/api-token
chmod 644 /opt/dojo/state/api-token
cp /opt/dojo/state/api-token ~/.config/ops/api-token
chmod 600 ~/.config/ops/api-token
echo ok > /opt/dojo/state/billing-health; chmod 666 /opt/dojo/state/billing-health
start() { setsid -f python3 "$DOJO_FILES/api.py" "$@" > /dev/null 2>&1 < /dev/null; }
start 8088 tickets; start 8091 orders; start 8092 billing; start 8093 search
for port in 8088 8091 8092 8093; do
  for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/stats" && break; sleep 0.1; done
done
