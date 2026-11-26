# Live Kafka lab

You join the platform team of an online shop on a Monday. The order stream runs on Apache Kafka, and the weekend left a list of tickets. This is a real Kafka 4.4 broker in **KRaft** mode (no ZooKeeper: Kafka 4 removed it; the broker is its own controller here) and the real command-line tools.

| Host | What runs there |
|---|---|
| **kafka** | the broker and KRaft controller, listening on `kafka:9092`. Its data is in `/tmp/kafka-logs`. |
| **ops** | your workstation: every Kafka CLI tool is on the PATH (`/opt/kafka/bin`). |

```
topic orders (3 partitions)       P0 | 0 | 1 | 2 | ... | 194 |      <- append-only logs
                                  P1 | 0 | 1 | ... | 119 |
                                  P2 | 0 | 1 | 2 | 3 | ... | 284 |
consumer groups: billing (far behind), analytics (caught up), shipping (stuck on one record)
other topics:    payments (1 partition), clicks (retention 1 minute), customer-profiles (keyed)
```

This lab has one broker, so every replication factor is 1. On a real cluster: replication factor 3 and `min.insync.replicas=2`, so a write acknowledged with `acks=all` survives losing any one broker.

## The tools, and the flag you always pass

Every command needs `--bootstrap-server kafka:9092`: the address of any broker, from which the client learns the rest of the cluster.

```
kafka-topics.sh          --list | --describe [--topic t] | --create | --alter --partitions N
kafka-configs.sh         --entity-type topics --entity-name t --describe [--all] | --alter --add-config k=v | --delete-config k
kafka-console-producer.sh --topic t [--reader-property parse.key=true --reader-property key.separator=:]
kafka-console-consumer.sh --topic t [--group g] [--from-beginning] [--formatter-property print.key=true ...] [--timeout-ms N]
kafka-consumer-groups.sh --describe --group g | --all-groups ; --reset-offsets ... --dry-run | --execute
kafka-get-offsets.sh     --topic t [--time -1|-2]
kafka-log-dirs.sh        --describe
```

Kafka 4.x renamed some console-tool options: `--reader-property` (producer) and `--formatter-property` (consumer) replace `--property`, and `--command-property` replaces `--producer-property` / `--consumer-property`. The old names still work but print a deprecation warning; you will meet both in runbooks.

Each command starts a small Java program, so it takes a second or two. That is normal.

## Reading `kafka-consumer-groups.sh --describe`

```
GROUP    TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG   CONSUMER-ID  HOST  CLIENT-ID
billing  orders  0          61              195             134   -            -     -
```

- **CURRENT-OFFSET**: the next record the group will read (what it committed).
- **LOG-END-OFFSET**: the next offset that will be written to that partition.
- **LAG**: the difference, in records. Shrinking lag is healthy; growing lag is an incident.
- **CONSUMER-ID** `-`: nobody in the group is running. You can only reset the offsets of a group in that state.

The lab checks your work by asking the broker, so press **Check** as often as you like. Stop the lab when you take a break: it frees about 400 MB of memory.
