#!/bin/bash
# The attacker's workstation: curl, jq, python3, sqlmap, hydra, and a web server for payloads (`listen`).
mkdir -p /root/www
cp /lab/wordlists/top-passwords.txt /root/top-passwords.txt
printf '%s\n' "PS1='\[\e[1;31m\]attacker\[\e[0m\]:\w# '" \
  "echo 'Attacker workstation. Target: http://shop:8080 (only the lab exists). Tools: curl jq python3 sqlmap hydra listen baseline-scan'" >> /root/.bashrc
touch /tmp/ready
exec sleep infinity
