# Lesson 2 (and its cold rebuild): a team folder, a second user, and a report to share with her.
set -e -o pipefail
groupadd -f devs
id ana >/dev/null 2>&1 || useradd -m -s /bin/bash ana
usermod -aG devs learner
chmod 755 /home/learner
mkdir -p ~/team ~/reports
printf 'region,total\nnorth,10\n' > ~/reports/q3.csv
chmod 600 ~/reports/q3.csv
