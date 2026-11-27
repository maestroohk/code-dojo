#!/bin/bash
# The lab's checks, one function per check: bash /lab/checks/checks.sh NAME. Exit 0 = passed.
# Every check asks the real backends (Jaeger's query API, Prometheus's HTTP API) or reads the real config.
PATH=/usr/local/bin:$PATH
P95_PRODUCT='histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="shop", http_route="/api/products/{id:int}"}[1m])))'

case "$1" in
  inventory-traces)      # inventory's spans reach Jaeger again
    curl -s -m 10 http://jaeger:16686/api/v3/services | jq -e '.services | index("inventory") != null' >/dev/null &&
    jaeger-check inventory 20 'map(select(.service == "inventory")) | length > 0' ;;
  inventory-metrics)     # and its metrics reach Prometheus
    prom-check 'count(http_server_request_duration_seconds_count{job="inventory"})' 'length > 0' ;;
  sampler-config)        # inventory follows the caller's decision (parent-based, or the default, which is parent-based)
    f=/work/config/inventory.env
    s=$(tr -d '\r' < $f | grep -E '^OTEL_TRACES_SAMPLER=' | tail -1 | cut -d= -f2)
    [ -z "$s" ] || [[ "$s" == parentbased_* ]] ;;
  complete-traces)       # nearly every shop trace that called inventory now has inventory's spans in it
    jaeger-check shop 15 '[group_by(.trace)[] | select(any(.[]; .service == "shop" and .kind == 3 and .attrs["server.address"] == "inventory"))] as $t
      | ($t | length) >= 3 and ([$t[] | select(any(.[]; .service == "inventory"))] | length) >= (($t | length) * 0.9)' ;;
  cart-size)             # the checkout span carries app.cart.size as an integer
    jaeger-check shop 15 'map(select(.service == "shop" and .name == "checkout")) | length > 0
      and all(.[]; .types["app.cart.size"] == "intValue" and ((.attrs["app.cart.size"] | tonumber) >= 1))' ;;
  no-email)              # no plain email address on any checkout span (deleted or hashed by the Collector)
    jaeger-check shop 15 'map(select(.service == "shop" and .name == "checkout")) | length > 0
      and all(.[]; (.attrs["user.email"] // "") | tostring | contains("@") | not)' ;;
  burn-alert)            # the burn-rate alert is loaded, healthy, paging, with a runbook, and already pending or firing
    prom-check --api 'rules?type=alert' '[.groups[].rules[] | select(.name == "CheckoutErrorBudgetBurn")] | length == 1
      and .[0].health == "ok" and .[0].labels.severity == "page" and (.[0].annotations.runbook_url // "" | length > 0)
      and (.[0].state == "pending" or .[0].state == "firing")' ;;
  burn-windows)          # it looks at a long and a short window (inline or through recording rules)
    prom-check --api rules '[.groups[].rules[].query] | join(" ") | (test("\\[1h\\]") or test("\\[6h\\]")) and (test("\\[5m\\]") or test("\\[30m\\]"))' ;;
  noisy-alert)           # the alert that paged on every blip no longer pages
    prom-check --api 'rules?type=alert' '[.groups[].rules[] | select(.name == "ShopSlowRequest" and .labels.severity == "page")] | length == 0' ;;
  orders-exported)       # app_orders_total still exists (fixing cardinality must not delete the metric)
    prom-check 'sum(app_orders_total)' 'length > 0' ;;
  orders-cardinality)    # and is a handful of series, none per customer
    prom-check 'count(app_orders_total{app_customer_id!=""})' 'length == 0' &&
    prom-check 'count(app_orders_total)' '.[0].value[1] | tonumber <= 15' ;;
  reviews-index)         # reviews can be searched by product (run on postgres)
    n=$(psql -U shop -d shop -tAc "SELECT count(*) FROM pg_indexes WHERE tablename = 'reviews' AND indexdef ILIKE '%(product_id%'")
    [ "${n:-0}" -ge 1 ] ;;
  product-fast)          # and the product page is fast again, measured
    prom-check "$P95_PRODUCT" '.[0].value[1] | tonumber < 0.025' ;;
  *) echo "unknown check $1" >&2; exit 2 ;;
esac
