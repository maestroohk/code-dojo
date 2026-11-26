# Lesson 2, step 2 (and its cold rebuild): the Gateway API CRDs, a Gateway owned by the platform team, and two
# Services that need routes. (No gateway controller runs here: the API server validates and stores the routes.)
DOJO_CLUSTER_ARGS=--gateway-api
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/apps.sh"
kubectl create namespace shop >/dev/null
web shop web 1
web shop api 1
kubectl -n shop expose deploy web --port=80 >/dev/null
kubectl -n shop expose deploy api --port=80 >/dev/null
apply <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata: {name: example}
spec:
  controllerName: example.com/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {name: public, namespace: shop}
spec:
  gatewayClassName: example
  listeners:
    - {name: http, protocol: HTTP, port: 80}
EOF
