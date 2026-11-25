# Mission 15: a server full of misbehaving processes.
for f in cookie-miner oven-watchdog gary-backup crumb-collector oven-sim; do
  tr -d '\r' < "/lab/bin/$f" > "/usr/local/bin/$f"
  chmod 755 "/usr/local/bin/$f"
done
cd /
setsid nohup /usr/local/bin/oven-watchdog >/dev/null 2>&1 &
setsid nohup /usr/local/bin/gary-backup >/dev/null 2>&1 &
setsid nohup /usr/local/bin/crumb-collector >/dev/null 2>&1 &
setsid nohup /usr/local/bin/oven-sim >/dev/null 2>&1 &
sleep 2
