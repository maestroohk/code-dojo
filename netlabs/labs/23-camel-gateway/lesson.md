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

The in-page terminal is line based, so full-screen editors cannot draw in it: `nano file` or `vim file` (or **Open file…** under the terminal) opens the file in an editor on the page, with YAML highlighting, and **Save** writes it back **in place**, which is what Camel's reload needs. To edit with commands instead, work on a copy and write the result back **in place** (Camel watches the folder, and `sed -i` there would make it load sed's temporary file as a second route file: `duplicate route id`):

```
cd /work/camel/routes
cp orders.camel.yaml /tmp/orders.yaml                      # 1. work on a copy
sed -i 's/old text/new text/' /tmp/orders.yaml             # 2a. change text on a line
cat > /tmp/snippet.yaml <<'EOF'                            # 2b. or write a block of lines (end with EOF)...
        - removeHeaders:
            pattern: "*"
EOF
sed -i '/- log: "received order/r /tmp/snippet.yaml' /tmp/orders.yaml   # ...and insert it after the line that matches
cat /tmp/orders.yaml > orders.camel.yaml                   # 3. write it back in place: one clean reload
```

To add a whole new route (or the `routeConfiguration` of task 6) at the end, append straight to the file: `cat >> orders.camel.yaml <<'EOF'` ... `EOF`. `kong.yml` is not watched, so there `sed -i` and `cat >>` are fine. Keep a second terminal open on ops with `tail -f /work/logs/camel.log`: after each write you see `Routes reloaded`, or the error that stopped the reload. YAML indentation is spaces, never tabs: copy it from the lines around your change. Keep all routes in that one file: live reload handles one file well, but gets confused when you add or delete route files. If reload ever gets stuck (for example `duplicate route id`), run `camel-restart` on the **camel** host: Camel starts again from the files in a few seconds.

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
