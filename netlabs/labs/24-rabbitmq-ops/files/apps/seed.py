# Runs once at lab start, before the services: leaves the broker in the state of a busy Monday.
#  - orders.dlq: N orders that failed last week because of a billing bug (fixed since), waiting to be replayed
#  - email: a backlog of 2000 email jobs
#  - payments: one malformed (poison) payment message
import json, pika

n = int(open("/work/.dlqn").read().strip() or 40)
conn = pika.BlockingConnection(pika.ConnectionParameters("rabbit", credentials=pika.PlainCredentials("guest", "guest")))
ch = conn.channel()
ch.confirm_delivery()
persistent = pika.BasicProperties(delivery_mode=2, content_type="application/json")
ids = []
for i in range(n):
    oid = f"D-{2000 + i}"
    ids.append(oid)
    ch.basic_publish("", "orders.dlq", json.dumps({"orderId": oid, "region": "eu"}),
                     pika.BasicProperties(delivery_mode=2, content_type="application/json", message_id=oid,
                                          headers={"x-first-death-reason": "rejected", "x-first-death-queue": "billing"}))
open("/work/.dlq-ids", "w").write("\n".join(ids) + "\n")
for i in range(2000):
    ch.basic_publish("notifications", "email", json.dumps({"id": f"E-old-{i}", "to": "customer@shop.example"}), persistent)
ch.basic_publish("", "payments", '{"id": "POISON-7731", "orderId": "A-0999", "amount": 3',
                 pika.BasicProperties(delivery_mode=2, content_type="application/json", message_id="POISON-7731"))
conn.close()
print(f"seeded {n} dead letters, 2000 email jobs and one poison payment")
