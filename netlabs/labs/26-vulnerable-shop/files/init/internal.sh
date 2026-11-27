#!/bin/bash
# The shop's internal neighbours: metadata (169.254.169.254), cdn.shop.example and payments.internal.
nohup python3 -u /lab/services/internal.py 169.254.169.254 10.66.2.40 >> /var/log/internal.log 2>&1 &
printf '%s\n' "echo 'Internal services (metadata, cdn, payments). Requests they got: tail -n 20 /var/log/internal.log'" >> /root/.bashrc
exec sleep infinity
