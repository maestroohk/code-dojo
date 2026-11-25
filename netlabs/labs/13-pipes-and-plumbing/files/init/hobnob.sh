# Mission 13: a day of order logs and a noisy report script.
python3 /lab/gen_orders.py
tr -d '\r' < /lab/bake-report > /usr/local/bin/bake-report
chmod 755 /usr/local/bin/bake-report
