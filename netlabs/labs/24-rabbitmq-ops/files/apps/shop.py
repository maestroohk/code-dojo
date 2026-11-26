# The shop: every 2 seconds it publishes an order's events to the "orders" topic exchange, an email
# job to "notifications", and now and then a payment straight to the payments queue.
# Like many real services it publishes transient messages (delivery_mode 1): fast, but not kept by a
# classic queue when the broker restarts.
import json, sys, time
import pika

regions = ["eu", "us", "uk"]
log = open("/work/logs/shop.log", "a", buffering=1)
n = 0
while True:
    try:
        conn = pika.BlockingConnection(pika.ConnectionParameters("rabbit", heartbeat=30,
            credentials=pika.PlainCredentials("guest", "guest"), client_properties={"connection_name": "shop"}))
        ch = conn.channel()
        while True:
            n += 1
            oid = f"A-{1000 + n}"
            r = regions[n % 3]
            p = lambda mid: pika.BasicProperties(delivery_mode=1, content_type="application/json", message_id=mid)
            ch.basic_publish("orders", f"order.{r}.created", json.dumps({"orderId": oid, "region": r}), p(oid + "-created"))
            ch.basic_publish("orders", f"order.{r}.shipped", json.dumps({"orderId": oid, "region": r}), p(oid + "-shipped"))
            if n % 2 == 0:
                ch.basic_publish("orders", "order.eu.refunded", json.dumps({"orderId": f"A-{1000 + n - 7}", "amount": 12.5}), p(f"R-{n}"))
            ch.basic_publish("notifications", "email", json.dumps({"id": f"E-{n}", "to": "customer@shop.example"}), p(f"E-{n}"))
            if n % 5 == 0:
                ch.basic_publish("", "payments", json.dumps({"id": f"P-{n}", "orderId": oid, "amount": 30}), p(f"P-{n}"))
            log.write(f"{time.strftime('%H:%M:%S')} published {oid}\n")
            time.sleep(2)
    except Exception as e:
        log.write(f"{time.strftime('%H:%M:%S')} connection lost ({type(e).__name__}); reconnecting in 3 s\n")
        time.sleep(3)
