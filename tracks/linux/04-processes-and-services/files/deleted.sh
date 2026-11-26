# Triage lesson: someone deleted a big log while log-shipper still has it open, so the space is not freed.
set -e -o pipefail
mkdir -p ~/var/log/shop
cat > /usr/local/bin/log-shipper <<'EOF'
#!/usr/bin/python3
# Keeps its log open forever (fd 3), like many daemons do.
import os, time
fd = os.open("/home/learner/var/log/shop/shipper.log", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
if fd != 3:
    os.dup2(fd, 3); os.close(fd)
while True:
    time.sleep(300)
EOF
chmod 755 /usr/local/bin/log-shipper
head -c $((40 * 1024 * 1024)) /dev/zero | tr '\0' 'L' > ~/var/log/shop/shipper.log
chown -R learner: ~/var
runuser -u learner -- setsid -f /usr/local/bin/log-shipper >/dev/null 2>&1 < /dev/null
sleep 1
rm ~/var/log/shop/shipper.log
echo "small" > ~/var/log/shop/orders.log
