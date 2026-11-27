# ops is your workstation. It copies the editable settings into /work (shared with the services), installs
# the helper commands, then starts a load generator that plays the shop's customers.
set -e
mkdir -p /work/config /work/collector /work/prometheus/rules /work/logs
for f in /lab/bin/*; do tr -d '\r' < "$f" > "/usr/local/bin/$(basename "$f")"; chmod +x "/usr/local/bin/$(basename "$f")"; done
for f in /lab/config/*.env; do tr -d '\r' < "$f" > "/work/config/$(basename "$f")"; done
tr -d '\r' < /lab/collector/config.yaml > /work/collector/config.yaml
for f in /lab/prometheus/rules/*.yml; do tr -d '\r' < "$f" > "/work/prometheus/rules/$(basename "$f")"; done
chmod -R a+rwX /work
touch /work/.seeded
setsid nohup loadgen > /work/logs/loadgen.log 2>&1 < /dev/null &
