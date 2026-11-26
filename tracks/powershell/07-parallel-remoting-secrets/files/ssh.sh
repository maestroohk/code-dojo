# Module 7 remoting scenarios: sshd with the PowerShell subsystem on this machine, reachable as web01 and web02,
# a key for the learner, and app logs on the "servers". Remoting over SSH is the real thing; both names just
# happen to point at the same machine.
set -e -o pipefail
grep -q ' web01' /etc/hosts || echo '127.0.0.1 web01 web02' >> /etc/hosts
mkdir -p /run/sshd
touch /var/log/sshd.log && chmod 644 /var/log/sshd.log
/usr/sbin/sshd -E /var/log/sshd.log
mkdir -p ~/.ssh /srv/logs/app
chmod 700 ~/.ssh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C 'learner@dojo' -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub > ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
for i in $(seq 1 50); do ssh-keyscan -t ed25519 localhost web01 web02 > ~/.ssh/known_hosts 2>/dev/null && [ -s ~/.ssh/known_hosts ] && break; sleep 0.1; done
cd /srv/logs/app
for spec in "api-1.log 3" "api-2.log 12" "api-3.log 40" "api-4.log 75" "worker.log 1" "worker.log.1 33"; do
  set -- $spec; echo "log $1" > "$1"; touch -d "$2 days ago" "$1"
done
chown -R learner:learner /srv/logs
rm -rf /opt/dojo/state/srvlogs && mkdir -p /opt/dojo/state && cp -a /srv/logs/app /opt/dojo/state/srvlogs && chmod -R a+rX /opt/dojo/state
mkdir -p ~/answers ~/scripts
