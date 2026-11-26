# ops is your workstation (same image as the broker, so every Kafka CLI tool is here). On the first
# start it waits for the broker, then leaves the cluster the way the incidents in this lab need it:
#   orders            3 partitions, 600 keyed order events
#   payments          created with 1 partition (too few)
#   clicks            retention.ms=60000 by mistake: data disappears after a minute
#   customer-profiles keyed profile updates, cleanup.policy=delete
#   groups            billing (behind), analytics (caught up), shipping (stuck before a poison record)
B=kafka:9092
mkdir -p /work
printf '%s\n' "export PS1='\[\e[1;32m\]\h\[\e[0m\]:\w# '" "cd /work" \
  "echo 'Kafka CLI tools are on the PATH. Always pass --bootstrap-server kafka:9092.'" >> /root/.bashrc
for f in /lab/bin/*; do tr -d '\r' < "$f" > "/usr/local/bin/$(basename "$f")"; chmod +x "/usr/local/bin/$(basename "$f")"; done

if [ ! -f /work/.seeded ]; then
  until kafka-topics.sh --bootstrap-server $B --list >/dev/null 2>&1; do sleep 2; done
  kafka-topics.sh --bootstrap-server $B --create --topic orders --partitions 3 --replication-factor 1
  kafka-topics.sh --bootstrap-server $B --create --topic payments --partitions 1 --replication-factor 1
  kafka-topics.sh --bootstrap-server $B --create --topic clicks --partitions 2 --replication-factor 1 \
    --config retention.ms=60000 --config segment.ms=60000
  kafka-topics.sh --bootstrap-server $B --create --topic customer-profiles --partitions 1 --replication-factor 1

  # 600 order events for 40 customers, keyed by customer id so each customer's events stay in order.
  awk 'BEGIN { for (i = 1; i <= 600; i++) { c = "C-" (i * 7 % 40 + 1); printf "%s:{\"orderId\":\"A-%d\",\"customer\":\"%s\",\"amount\":%d}\n", c, 5000 + i, c, (i * 13) % 90 + 10 } }' \
    | kafka-console-producer.sh --bootstrap-server $B --topic orders --reader-property parse.key=true --reader-property key.separator=:
  awk 'BEGIN { for (i = 1; i <= 50; i++) printf "{\"paymentId\":\"P-%d\",\"amount\":%d}\n", i, i * 3 }' \
    | kafka-console-producer.sh --bootstrap-server $B --topic payments
  awk 'BEGIN { for (i = 1; i <= 300; i++) printf "{\"page\":\"/p/%d\",\"session\":\"s-%d\"}\n", i % 17, i % 23 }' \
    | kafka-console-producer.sh --bootstrap-server $B --topic clicks
  awk 'BEGIN { for (i = 1; i <= 90; i++) { c = "C-" (i % 30 + 1); printf "%s:{\"customer\":\"%s\",\"email\":\"c%d-v%d@shop.example\",\"version\":%d}\n", c, c, i % 30 + 1, int(i / 30) + 1, int(i / 30) + 1 } }' \
    | kafka-console-producer.sh --bootstrap-server $B --topic customer-profiles --reader-property parse.key=true --reader-property key.separator=:

  # analytics: fully caught up. billing: far behind. shipping: stuck just before a bad record on orders:0.
  kafka-consumer-groups.sh --bootstrap-server $B --group analytics --topic orders --reset-offsets --to-latest --execute >/dev/null
  kafka-consumer-groups.sh --bootstrap-server $B --group billing --topic orders --reset-offsets --to-offset "${DOJO_BILLOFF:-60}" --execute >/dev/null
  kafka-consumer-groups.sh --bootstrap-server $B --group shipping --topic orders --reset-offsets --to-latest --execute >/dev/null
  end0=$(kafka-get-offsets.sh --bootstrap-server $B --topic orders --partitions 0 | cut -d: -f3)
  p=${DOJO_SHIPOFF:-120}; [ "$p" -ge "$end0" ] && p=$((end0 - 5))
  kafka-consumer-groups.sh --bootstrap-server $B --group shipping --topic orders:0 --reset-offsets --to-offset $p --execute >/dev/null
  echo $p > /work/.ship-poison
  for i in 1 2 3; do
    echo "2026-11-23 0$((i + 1)):14:0$i ERROR shipping-1 orders-0@$p: JsonException: '0x00' is an invalid start of a value. LineNumber: 0 | BytePositionInLine: 0." >> /work/shipping.log
    echo "2026-11-23 0$((i + 1)):14:0$i FATAL shipping-1 unhandled exception, exiting (offset $p not committed, it will be read again on restart)" >> /work/shipping.log
  done
  group-lag billing > /work/.billing-lag
  kafka-consumer-groups.sh --bootstrap-server $B --describe --group shipping 2>/dev/null | awk '$2=="orders" && $3!=0 {print $3, $4}' > /work/.ship-others
  touch /work/.seeded
fi
exec sleep infinity
