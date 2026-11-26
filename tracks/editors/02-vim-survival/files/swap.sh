# Boss: an SSH session dropped mid-edit. Vim's swap file holds the unsaved lines (E325 next time).
set -e -o pipefail
mkdir -p ~/notes /opt/dojo/state && cd ~/notes
printf '%s\n' '# On-call notes' '' '- 02:10 disk alert on db1' > oncall.md
printf '%s\n' '# On-call notes' '' '- 02:10 disk alert on db1' '- 02:25 rotated /var/log/app, 40 GB freed' > /opt/dojo/state/oncall.expected
chmod 644 /opt/dojo/state/oncall.expected
# Edit in a real Vim, force the swap file to disk (:preserve), then kill Vim the way a dropped session does.
( sleep 20 | vim -Nes -c 'normal! Go- 02:25 rotated /var/log/app, 40 GB freed' -c preserve oncall.md ) >/dev/null 2>&1 &
for i in $(seq 100); do [ -s .oncall.md.swp ] && break; sleep 0.1; done
sleep 0.5
pkill -9 -x vim
sleep 0.2
test -f .oncall.md.swp
