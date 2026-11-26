# Lesson 3 (and its cold rebuild): a namespace with healthy pods, a finished job, and three that are not ready
# for three different reasons.
. "$DOJO_FILES/lib.sh"
kubectl create namespace shop >/dev/null
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: shop}
spec:
  replicas: 2
  selector: {matchLabels: {app: web}}
  template:
    metadata: {labels: {app: web}}
    spec:
      containers: [{name: web, image: "traefik/whoami:v1.11"}]
---
apiVersion: v1
kind: Pod
metadata: {name: api, namespace: shop, labels: {app: api}}
spec:
  containers:
    - name: api
      image: traefik/whoami:v1.11
      readinessProbe: {httpGet: {path: /ready, port: 8081}, periodSeconds: 2}
---
apiVersion: v1
kind: Pod
metadata: {name: worker, namespace: shop, labels: {app: worker}}
spec:
  containers:
    - name: worker
      image: busybox:1.37
      command: ["sh", "-c", "echo 'worker: QUEUE_URL is not set' >&2; exit 1"]
---
apiVersion: v1
kind: Pod
metadata: {name: report, namespace: shop, labels: {app: report}}
spec:
  restartPolicy: Never
  containers: [{name: report, image: "busybox:1.37", command: ["sh", "-c", "echo report sent"]}]
---
apiVersion: v1
kind: Pod
metadata: {name: search, namespace: shop, labels: {app: search}}
spec:
  containers:
    - name: search
      image: busybox:1.37
      command: ["sleep", "1d"]
      resources: {requests: {memory: 200Gi}}
EOF
kubectl -n shop rollout status deploy/web --timeout=120s >/dev/null
until_true 60 sh -c "kubectl -n shop get pod worker -o jsonpath='{.status.containerStatuses[0].restartCount}' | grep -q '[1-9]'"
until_true 60 sh -c "kubectl -n shop get pod report -o jsonpath='{.status.phase}' | grep -qx Succeeded"
