# Live RabbitMQ lab

You are on call for a small online shop. Its services talk through RabbitMQ, and on Monday morning several things are quietly wrong. Everything here is real software: a RabbitMQ 4.4 broker with the management and Prometheus plugins, a publisher and three consumers written with a real AMQP client.

| Host | What runs there |
|---|---|
| **rabbit** | the broker. `rabbitmqctl`, `rabbitmqadmin` (v2, talks to the HTTP API) and `rabbitmq-diagnostics` are here. |
| **ops** | your workstation: `curl` and `jq` against the management API, the services' settings in `/work/apps`, their logs in `/work/logs`. |
| **apps** | the shop's services: `shop` publishes, `billing`, `payments` and `email` (two instances) consume. |

```
shop --> [orders  topic] --order.*.created--> billing  (quorum)  --> billing worker
     |                  \--order.shipped----> shipping (quorum)      (nobody reads it yet)
     |                   \-order.*.created--> audit    (classic)
     +--> [notifications direct] --email----> email    (classic)  --> email worker x2
     +--> (default exchange) ---------------> payments (classic)  --> payments worker
          [orders.dlx]   --> orders.dlq      [payments.dlx] --> payments.dlq
```

## Look before you touch

```
rabbitmqctl list_queues name type messages_ready messages_unacknowledged consumers
rabbitmqctl list_exchanges name type
rabbitmqctl list_bindings source_name destination_name routing_key
rabbitmqctl list_consumers queue_name consumer_tag ack_required prefetch_count
rabbitmqctl list_policies
```

- **ready** = waiting for a consumer. Growing ready means consumers are too slow, or gone.
- **unacknowledged** = delivered, not yet acked. Stuck unacked means a consumer is hoarding (prefetch) or never acks.
- **consumers 0** on a queue that should be read is an incident on its own.

## The HTTP API (what the management UI and your monitoring use)

From **ops**, with guest/guest (allowed from other hosts only because this is a lab):

```
curl -s -u guest:guest http://rabbit:15672/api/queues | jq '.[] | {name, messages_ready, messages_unacknowledged, consumers}'
curl -s -u guest:guest http://rabbit:15672/api/queues/%2F/email | jq '.message_stats.deliver_get_details.rate'
```

`%2F` is the URL-encoded default virtual host `/`. `rabbitmqadmin` on **rabbit** wraps the same API:
`rabbitmqadmin list queues`, `rabbitmqadmin declare queue --name x --type quorum --durable true`,
`rabbitmqadmin publish message --exchange orders --routing-key order.eu.created --payload '{}'`,
`rabbitmqadmin get messages --queue x --count 5 --ack-mode ack_requeue_true`.

## Changing the services

Each consumer reads `/work/apps/<name>.env` (queue, prefetch, what to do on an error, instances). Saving the file restarts that service within two seconds, like a redeploy. Follow it with `tail -f /work/logs/<name>.log`.

## Policies, not arguments

Queue and exchange arguments are fixed when the object is declared: redeclaring with different arguments fails with `PRECONDITION_FAILED`. Settings such as a dead-letter exchange, an alternate exchange, a message TTL or a delivery limit can also come from a **policy** (`rabbitmqctl set_policy NAME PATTERN DEFINITION --apply-to queues|exchanges`), which you can add, change and remove on a live system. That is what operators use.

The lab checks your work by asking the broker (and in one task by restarting it), so press **Check** as often as you like. Stop the lab when you take a break: it frees about 250 MB of memory.
