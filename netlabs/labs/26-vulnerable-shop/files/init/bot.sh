#!/bin/bash
# The staff member's computer: a headless Chromium that stays signed in to the shop (see /lab/services/bot.py).
until curl -s -m 2 -o /dev/null http://shop:8080/; do sleep 1; done
nohup python3 -u /lab/services/bot.py >> /var/log/bot.log 2>&1 &
printf '%s\n' "echo 'The staff member (admin bot) runs here. What they did: tail -n 20 /var/log/bot.log'" >> /root/.bashrc
exec sleep infinity
