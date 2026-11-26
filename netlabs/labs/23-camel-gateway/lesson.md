# Live Camel + gateway lab

You join the integration team of a small lighting wholesaler. Partner shops send orders to one public API. Behind it, an integration route sends **physical** orders to the warehouse and charges **digital** orders at a payments partner. The stack is real software, not a simulation:

| Host | What runs there |
|---|---|
| **client** | a partner shop. It sits on the `edge` network and can only reach the gateway. |
| **gateway** | **Kong**, an API gateway, in DB-less mode: one YAML file is its whole configuration. |
| **camel** | **Apache Camel** (Camel JBang), running YAML routes in dev mode. |
| **warehouse**, **payments** | the backends, on the `backend` network. |
| **ops** | your workstation. It shares the project folder `/work` with camel and the gateway. |

```
client --> gateway :8000 --> camel :8080 --+--> warehouse :9000
                                           +--> payments  :9100
```

Right now almost nothing works. You will trace messages, fix the route, make it survive bad input and a flaky partner, and then lock down the gateway.

**First start:** it downloads about 400 MB (the Kong and Camel JBang images) and builds a Camel image with every jar inside, so it can take a few minutes. After that the lab is offline: its networks have no way out to the internet. While it runs it uses about 500 MB of memory (Camel may grow to 768 MB), so stop the lab when you take a break.

## The project folder

Everything you edit is on **ops**, in `/work`:

```
/work/camel/routes/orders.camel.yaml   the Camel routes (save = live reload)
/work/camel/dead-letter/               parked failed messages (task 6)
/work/kong/kong.yml                    the gateway configuration
/work/logs/camel.log                   Camel's log
/work/logs/gateway-access.log          every request the gateway proxied
```

Edit with `nano` (Ctrl+O saves, Ctrl+X quits). Keep a second terminal open on ops with `tail -f /work/logs/camel.log`: after each save you see `Routes reloaded`, or the error that stopped the reload. Keep all routes in that one file: live reload handles one file well, but gets confused when you add or delete route files. If reload ever gets stuck (for example `duplicate route id`), run `camel-restart` on the **camel** host: Camel starts again from the files in a few seconds.

The gateway does not watch its file. Run `gw-apply` on ops: it sends `kong.yml` to Kong's admin API. Kong checks the whole file first; if anything is wrong it keeps the old configuration and tells you why. The admin API listens only on the backend network, so a partner can never reach it.

## Camel in one minute

A route is **from** an endpoint, then a list of **steps**:

```yaml
- route:
    id: receive-order
    from:
      uri: platform-http:/orders      # an HTTP endpoint
      steps:
        - log: "received ${headers}"  # ${...} is the Simple language
        - unmarshal: { json: {} }     # JSON text -> a map, so ${body[type]} works
        - choice:                     # content-based router
            when:
              - simple: "${body[type]} == 'digital'"
                steps:
                  - to: direct:payments   # call another route
```

Each message (an **exchange**) carries a **body** and **headers**. Headers travel with the message from step to step until you remove them. That is the root of the most common Camel bug (task 2).

On the camel host, the Camel CLI shows the running integration: `camel get route` (routes and message counts), `camel get health`, `camel log` and `camel trace`.

## Kong in one minute

```yaml
services:                 # a backend Kong can call
  - name: orders
    url: http://camel:8080/orders
    routes:               # which requests go there
      - name: orders
        paths: [ /api/orders ]
    plugins:              # policies on this service
      - name: key-auth
consumers:                # who may call (task 9)
  - username: corner-shop
```

The gateway is where cross-cutting rules live: who may call (authentication), how often (rate limits), and what passes in and out (header masking). The route behind it then only does integration work.

## Tracing tips

- Every hop has its own log. Camel knows **that** a call failed; only the backend knows **why**.
- The warehouse and the payments partner keep a record of what they received: from ops, `curl -s warehouse:9000/_audit/A-1001 | jq` or `curl -s payments:9100/_audit/D-3001 | jq`. Use it to see the exact body and headers that arrived.
- `curl -i` shows status and headers; `curl -v` shows the request too.

The lab checks your work by sending its own test orders, so you can click **Check** as often as you like.
