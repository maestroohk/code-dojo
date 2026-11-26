# Check for the "survive a restart" task (runs on rabbit): count audit's messages, restart the
# RabbitMQ application, count again. A queue that keeps its messages has at least as many afterwards.
count() { rabbitmqctl -q list_queues name messages 2>/dev/null | awk '$1=="audit"{print $2}'; }
before=$(count)
[ -n "$before" ] && [ "$before" -gt 0 ] || { echo "audit is missing or empty"; exit 1; }
rabbitmqctl -q stop_app >/dev/null && rabbitmqctl -q start_app >/dev/null && rabbitmqctl -q await_startup >/dev/null || exit 1
after=$(count)
echo "audit: $before messages before the restart, ${after:-0} after"
[ -n "$after" ] && [ "$after" -ge "$before" ]
