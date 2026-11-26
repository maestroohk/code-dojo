# Boss: the shop namespace on a very bad night. Six seeded faults across three tickets; each ticket's setup calls
# one function.
. "$DOJO_FILES/lib.sh"
kubectl create namespace shop >/dev/null
k() { kubectl -n shop "$@"; }

ticket1() {  # CrashLoopBackOff from a missing ConfigMap key, and an OOMKilled worker.
  apply <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata: {name: orders-config, namespace: shop}
data: {QUEUE: orders}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: orders, namespace: shop, labels: {app: orders}}
spec:
  replicas: 1
  selector: {matchLabels: {app: orders}}
  template:
    metadata: {labels: {app: orders}}
    spec:
      containers:
        - name: orders
          image: busybox:1.37
          envFrom: [{configMapRef: {name: orders-config}}]
          command: ["sh", "-c", "[ -n \"$PAYMENTS_URL\" ] || { echo 'orders: FATAL PAYMENTS_URL is not configured' >&2; exit 1; }; echo \"orders: ready, payments at $PAYMENTS_URL\"; exec sleep 1d"]
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: resizer, namespace: shop, labels: {app: resizer}}
spec:
  replicas: 1
  selector: {matchLabels: {app: resizer}}
  template:
    metadata: {labels: {app: resizer}}
    spec:
      containers:
        - name: resizer
          image: busybox:1.37
          command: ["sh", "-c", "echo 'resizer: loading'; buf=$(head -c 40000000 /dev/zero | tr '\\0' x); echo \"resizer: ready (${#buf} bytes)\"; exec sleep 1d"]
          resources: {requests: {memory: 32Mi}, limits: {memory: 32Mi}}
EOF
  until_true 90 sh -c "kubectl -n shop get pods -l app=resizer -o jsonpath='{.items[0].status.containerStatuses[0].lastState.terminated.reason}' | grep -q OOMKilled"
}

ticket2() {  # ImagePullBackOff from a tag typo, and a Service whose selector matches nothing.
  apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: catalog, namespace: shop, labels: {app: catalog}}
spec:
  replicas: 2
  selector: {matchLabels: {app: catalog}}
  template:
    metadata: {labels: {app: catalog, tier: api}}
    spec:
      containers: [{name: catalog, image: "traefik/whoami:1.11", args: ["--name=catalog"]}]
---
apiVersion: v1
kind: Service
metadata: {name: catalog, namespace: shop}
spec:
  selector: {app: catalog-api}
  ports: [{port: 80, targetPort: 80}]
EOF
  k run shell --image=busybox:1.37 -- sleep 1d >/dev/null
  until_true 60 sh -c "kubectl -n shop get pods -l app=catalog -o jsonpath='{.items[*].status.containerStatuses[0].state.waiting.reason}' | grep -Eq 'ErrImagePull|ImagePullBackOff'"
  k wait --for=condition=Ready pod/shell --timeout=120s >/dev/null
}

ticket3() {  # A bad rollout to undo, and a Pending pod from an oversized request.
  apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: checkout, namespace: shop, labels: {app: checkout}}
spec:
  replicas: 3
  selector: {matchLabels: {app: checkout}}
  strategy: {rollingUpdate: {maxSurge: 1, maxUnavailable: 0}}
  template:
    metadata: {labels: {app: checkout}}
    spec:
      containers:
        - name: checkout
          image: traefik/whoami:v1.11
          args: ["--name=checkout-v1"]
          readinessProbe: {httpGet: {path: /health, port: 80}, periodSeconds: 2}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: reports, namespace: shop, labels: {app: reports}}
spec:
  replicas: 1
  selector: {matchLabels: {app: reports}}
  template:
    metadata: {labels: {app: reports}}
    spec:
      containers:
        - name: reports
          image: busybox:1.37
          command: ["sh", "-c", "echo 'reports: up'; exec sleep 1d"]
          resources: {requests: {cpu: "64", memory: 128Mi}}
EOF
  k rollout status deploy/checkout --timeout=120s >/dev/null
  # v2 moved its health endpoint, so its pods never become ready and the rollout stalls.
  k patch deploy checkout --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args","value":["--name=checkout-v2"]},{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/healthz"}]' >/dev/null
  until_true 60 sh -c "kubectl -n shop get events --field-selector reason=FailedScheduling -o name | grep -q ."
  sleep 4
}

"ticket$1"
