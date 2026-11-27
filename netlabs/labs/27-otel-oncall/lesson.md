# Live OpenTelemetry on-call lab

It is your on-call week for a small online shop. Two .NET 10 services, a database, and a full observability stack, all real: the services are instrumented with the **OpenTelemetry .NET SDK**, everything they emit goes over **OTLP** to an **OpenTelemetry Collector**, and the Collector sends traces to **Jaeger**, metrics to **Prometheus** and logs to **Loki**. **Grafana** shows all three. A load generator plays the customers (about three requests a second). Things are wrong; your job is to find out what from the telemetry, fix it, and prove the fix with the same telemetry.

```
 customers (loadgen on ops)
        |
        v
  +-----------+   HTTP + traceparent   +-------------+
  |   shop    | ---------------------> |  inventory  |      both: OpenTelemetry SDK
  |  :8080    |                        |   :8080     |      traces, metrics, logs
  +-----------+                        +-------------+
        \  SQL (Npgsql)                   /  SQL
         +-------> postgres:5432 <-------+
        \                                 /
         +--- OTLP gRPC :4317 / HTTP :4318 +
                         |
                 +---------------+
                 |   collector   |  receivers -> processors -> exporters
                 +---------------+
                  /      |       \
           OTLP  /       | :8889  \  OTLP/HTTP
         jaeger:4317  prometheus   loki:3100/otlp
           traces      metrics        logs
                  \      |       /
                   +-- grafana --+
```

## Open the real UIs in your browser

| Tool | Address | Use it for |
|---|---|---|
| Grafana | http://127.0.0.1:33000 | the *Shop: RED overview* dashboard; **Explore** for PromQL, traces and LogQL |
| Jaeger | http://127.0.0.1:36686 | search traces by service, operation, tags (`error=true`), duration |
| Prometheus | http://127.0.0.1:39090 | the expression browser, **Alerts**, **Status → Targets** |

They listen on 127.0.0.1 only. Grafana opens without a login (anonymous editor, lab only).

## The same from the terminal (ops)

```
promq 'PROMQL'                         instant query, one line per series (curl + jq on /api/v1/query)
spans SERVICE [SECONDS] [OPERATION]    one line per span from Jaeger's API v3 (OTLP JSON); --json for jq
curl -sG http://loki:3100/loki/api/v1/query_range --data-urlencode 'query={service_name="shop"} |= "failed"' | jq
curl -s http://prometheus:9090/api/v1/rules | jq     loaded rules and alert states
curl -X POST http://prometheus:9090/-/reload         load edited rule files
```

On the **prometheus** node: `promtool check rules FILE`, `promtool query instant http://localhost:9090 'up'`. On the **collector** node: `otelcol-contrib validate --config=/work/collector/config.yaml`.

## What you can change, and how it deploys

| File | Node | Saving it... |
|---|---|---|
| `/work/config/shop.env`, `/work/config/inventory.env` | ops (shared) | restarts that service with the new `OTEL_*` settings |
| `/app/src/Program.cs` | shop | rebuilds the shop (`/work/logs/shop-build.log`) and redeploys it if the build passes |
| `/work/collector/config.yaml` | ops (shared) | validates the config, then restarts the Collector (`/work/logs/collector.log`) |
| `/work/prometheus/rules/*.yml` | ops (shared) | nothing until you `curl -X POST http://prometheus:9090/-/reload` |

Service logs are in `/work/logs/` (`shop.log`, `inventory.log`, `collector.log`, `loadgen.log`).

## How the names map

OpenTelemetry names use dots; Prometheus names use underscores and add the unit and `_total` / `_bucket` suffixes. The SDK's `http.server.request.duration` histogram (seconds) becomes `http_server_request_duration_seconds_bucket`, `_sum` and `_count`, with labels `http_route`, `http_request_method`, `http_response_status_code`, and `job` set from `service.name`. In Loki, resource attributes become labels (`service_name`), and `trace_id` / `span_id` are structured metadata you filter with `| trace_id="..."`.

The lab checks your work by asking the real backends, so press **Check** as often as you like. Changes take a few seconds to show up (export every 5 s, scrape every 5 s). Stop the lab when you take a break: it frees about 800 MB of memory.
