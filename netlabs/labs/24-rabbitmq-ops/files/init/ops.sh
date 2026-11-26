# ops is your workstation. It waits for the broker, declares the shop's topology through the
# management HTTP API (with the mistakes this lab is about), copies the service settings to /work,
# installs the helper commands, then tells the apps container it can start.
set -e
mkdir -p /work/apps /work/logs
for f in /lab/bin/*; do tr -d '\r' < "$f" > "/usr/local/bin/$(basename "$f")"; chmod +x "/usr/local/bin/$(basename "$f")"; done
for f in /lab/apps/*.env; do tr -d '\r' < "$f" > "/work/apps/$(basename "$f")"; done
echo "${DOJO_DLQN:-40}" > /work/.dlqn
chmod -R a+rwX /work

API=http://rabbit:15672/api
until curl -s -m2 -u guest:guest -o /dev/null -w '%{http_code}' $API/overview | grep -q 200; do sleep 1; done
put() { curl -s -m5 -u guest:guest -H 'content-type: application/json' -X PUT "$API/$1" -d "$2" >/dev/null; }
bind() { curl -s -m5 -u guest:guest -H 'content-type: application/json' -X POST "$API/bindings/%2F/e/$1/q/$2" -d "{\"routing_key\":\"$3\"}" >/dev/null; }

put exchanges/%2F/orders        '{"type":"topic","durable":true}'
put exchanges/%2F/notifications '{"type":"direct","durable":true}'
put exchanges/%2F/orders.dlx    '{"type":"fanout","durable":true}'
put exchanges/%2F/payments.dlx  '{"type":"fanout","durable":true}'

put queues/%2F/billing      '{"durable":true,"arguments":{"x-queue-type":"quorum","x-dead-letter-exchange":"orders.dlx"}}'
put queues/%2F/shipping     '{"durable":true,"arguments":{"x-queue-type":"quorum"}}'
put queues/%2F/orders.dlq   '{"durable":true,"arguments":{"x-queue-type":"quorum"}}'
put queues/%2F/payments     '{"durable":true,"arguments":{"x-queue-type":"classic"}}'
put queues/%2F/payments.dlq '{"durable":true,"arguments":{"x-queue-type":"quorum"}}'
put queues/%2F/email        '{"durable":true,"arguments":{"x-queue-type":"classic"}}'
put queues/%2F/audit        '{"durable":true,"arguments":{"x-queue-type":"classic"}}'

bind orders billing  'order.*.created'
bind orders shipping 'order.shipped'
bind orders audit    'order.*.created'
bind orders.dlx orders.dlq ''
bind payments.dlx payments.dlq ''
bind notifications email 'email'

printf '%s\n' "cd /work" "echo 'Broker API: http://rabbit:15672/api (guest/guest)   Service settings: /work/apps/*.env   Logs: /work/logs'" >> /root/.bashrc
touch /work/.seeded
