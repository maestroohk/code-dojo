# Stage 5: production-ready API behind the platform's Gateway; time to publish it and ship v2 safely.
DOJO_CLUSTER_ARGS=--gateway-api
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/stages.sh"
stage_deployment
stage_db
stage_services
stage_probes
apply <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata: {name: example}
spec: {controllerName: example.com/gateway-controller}
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {name: public, namespace: todo}
spec:
  gatewayClassName: example
  listeners: [{name: http, protocol: HTTP, port: 80}]
EOF
wait_all
