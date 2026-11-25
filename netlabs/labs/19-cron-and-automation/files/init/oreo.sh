# Mission 19: a simulated cron daemon, Gary's old jobs and a script that only works by hand.
tr -d '\r' < /lab/bin/minicron > /usr/local/sbin/minicron
tr -d '\r' < /lab/bin/crontab > /usr/local/bin/crontab
chmod 755 /usr/local/sbin/minicron /usr/local/bin/crontab
mkdir -p /var/spool/cron/crontabs /opt/sprinkles/bin /srv/crumbs /root/backups
for i in 1 2 3 4 5; do echo "crumb $i" > /srv/crumbs/crumb-$i.txt; done

cat > /usr/local/bin/bake-report <<'SH'
#!/bin/sh
echo "$(date '+%F %T') ovens ok, 812 biscuits baked" >> /var/log/bake-report.log
SH
cat > /usr/local/bin/cleanup-crumbs <<'SH'
#!/bin/sh
# Gary's cleanup. Deletes the crumbs folder contents. ALL of them. Every weekday.
rm -rf /srv/crumbs/*
SH
cat > /opt/sprinkles/bin/sprinkle-tool <<'SH'
#!/bin/sh
echo "sprinkles synced at $(date '+%F %T')" >> "$HOME/sprinkles.txt"
echo "sprinkle-tool: 3 sprinkle colours synced"
SH
cat > /usr/local/bin/sync-sprinkles <<'SH'
#!/bin/sh
# Syncs the sprinkle colour palette. Works perfectly when Gary runs it by hand.
sprinkle-tool sync
SH
chmod 755 /usr/local/bin/bake-report /usr/local/bin/cleanup-crumbs /opt/sprinkles/bin/sprinkle-tool /usr/local/bin/sync-sprinkles
echo 'export PATH="$PATH:/opt/sprinkles/bin"' >> /root/.bashrc

cat > /tmp/gary.cron <<CRON
# m h  dom mon dow   command        (Gary, 2023: "tidy every weekday night")
30 $DOJO_HOUR * * 1-5 /usr/local/bin/cleanup-crumbs
CRON
crontab /tmp/gary.cron && rm /tmp/gary.cron
cd /
setsid nohup /usr/local/sbin/minicron >/dev/null 2>&1 &
sleep 1
