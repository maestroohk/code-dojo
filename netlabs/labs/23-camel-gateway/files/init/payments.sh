nohup python3 /lab/services/payments.py >/dev/null 2>/var/log/payments.err &
printf '%s\n' "echo 'Payments partner on :9100. Its log: /var/log/payments.log'" >> /root/.bashrc