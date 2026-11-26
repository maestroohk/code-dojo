# A shop service that consumes one queue. Its settings come from /work/apps/<name>.env:
#   QUEUE      the queue it consumes
#   PREFETCH   basic.qos prefetch count (0 = unlimited)
#   ON_ERROR   requeue (nack, requeue=true) | reject (nack, requeue=false: dead-letter it)
#   WORK_MS    how long one message takes
# A message whose body is not valid JSON fails. Every outcome is logged to /work/logs/<name>.log.
import json, os, sys, time
import pika

name, instance = sys.argv[1], sys.argv[2]
cfg = {}
for line in open(f"/work/apps/{name}.env"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip()
queue = cfg.get("QUEUE", name)
prefetch = int(cfg.get("PREFETCH", "10") or 0)
on_error = cfg.get("ON_ERROR", "reject").lower()
work = int(cfg.get("WORK_MS", "20")) / 1000.0
log = open(f"/work/logs/{name}.log", "a", buffering=1)

def say(text):
    log.write(f"{time.strftime('%H:%M:%S')} {name}-{instance} {text}\n")

def handle(ch, method, props, body):
    try:
        msg = json.loads(body)
    except ValueError:
        if on_error == "requeue":
            time.sleep(0.3)
            ch.basic_nack(method.delivery_tag, requeue=True)
            say(f"FAILED to parse message {props.message_id} (redelivered={method.redelivered}): nack, requeue=true")
        else:
            ch.basic_nack(method.delivery_tag, requeue=False)
            say(f"FAILED to parse message {props.message_id}: nack, requeue=false (dead-lettered if the queue has a DLX)")
        return
    time.sleep(work)
    ch.basic_ack(method.delivery_tag)
    say(f"processed {msg.get('orderId') or msg.get('id') or props.message_id}")

while True:
    try:
        conn = pika.BlockingConnection(pika.ConnectionParameters("rabbit", heartbeat=30,
            credentials=pika.PlainCredentials("guest", "guest"), client_properties={"connection_name": f"{name}-{instance}"}))
        ch = conn.channel()
        ch.basic_qos(prefetch_count=prefetch)
        ch.basic_consume(queue, handle, auto_ack=False, consumer_tag=f"{name}-{instance}")
        say(f"consuming {queue} with prefetch {prefetch}, on error: {on_error}")
        ch.start_consuming()
    except Exception as e:
        say(f"connection lost ({type(e).__name__}); reconnecting in 3 s")
        time.sleep(3)
