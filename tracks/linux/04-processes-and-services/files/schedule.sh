# Lesson 2: a crontab file with two classic mistakes, and a service that should move to a systemd timer.
set -e -o pipefail
mkdir -p ~/bin ~/units ~/backups ~/site
printf '#!/bin/bash\necho backup\n' > ~/bin/backup.sh
printf '#!/bin/bash\necho rotate\n' > ~/bin/rotate.sh
chmod 755 ~/bin/*.sh
cat > ~/jobs.cron <<'EOF'
# m   h  dom mon dow  command
30    2  *   *   1-5  /home/learner/bin/backup.sh
61    *  *   *   *    /home/learner/bin/rotate.sh
0     3  *   *   *    tar czf /home/learner/backups/site-$(date +%F).tar.gz -C /home/learner site
EOF
cat > ~/units/backup.service <<'EOF'
[Unit]
Description=Nightly backup of the shop

[Service]
Type=oneshot
ExecStart=/home/learner/bin/backup.sh
EOF
