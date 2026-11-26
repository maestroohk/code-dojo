nohup python3 /lab/services/warehouse.py >/dev/null 2>/var/log/warehouse.err &
printf '%s\n' "echo 'Warehouse API on :9000. Its log: /var/log/warehouse.log'" >> /root/.bashrc