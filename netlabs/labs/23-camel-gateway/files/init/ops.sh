# ops is your workstation. It owns the shared project folder /work, which Camel and the
# gateway also mount: copy the starting files in, install the helper commands, then tell
# the other containers they can start.
set -e
mkdir -p /work/camel/routes /work/camel/dead-letter /work/kong /work/logs
cp /lab/camel/*.yaml /work/camel/routes/
cp /lab/kong/kong.yml /work/kong/kong.yml
touch /work/logs/camel.log
chmod -R a+rwX /work
for f in /lab/bin/*; do tr -d '\r' < "$f" > "/usr/local/bin/$(basename "$f")"; chmod +x "/usr/local/bin/$(basename "$f")"; done
printf '%s\n' "cd /work" "echo 'Project folder: /work   (camel/routes, kong/kong.yml, logs/camel.log)'" >> /root/.bashrc
touch /work/.seeded