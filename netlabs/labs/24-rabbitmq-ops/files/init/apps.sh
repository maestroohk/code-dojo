# apps runs the shop's services. Wait until ops has declared the topology, seed the backlog once,
# then start the services under a small supervisor (in the background, so the container keeps going).
until [ -f /work/.seeded ]; do sleep 0.5; done
tr -d '\r' < /lab/apps/supervise.sh > /usr/local/bin/supervise && chmod +x /usr/local/bin/supervise
python3 /lab/apps/seed.py >> /work/logs/seed.log 2>&1
touch /work/.apps-up
nohup setsid /usr/local/bin/supervise > /dev/null 2>&1 &
printf '%s\n' "cd /work" "echo 'The shop services run here: ps aux | grep worker   Settings: /work/apps/*.env   Logs: /work/logs/*.log'" >> /root/.bashrc
