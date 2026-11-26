# Lesson 3: a few Deployments across namespaces for a jsonpath report, and one that is still rolling out.
. "$DOJO_FILES/lib.sh"
for ns in shop payments; do kubectl create namespace $ns >/dev/null; done
kubectl -n shop create deployment web --image=traefik/whoami:v1.11 --replicas=2 >/dev/null
kubectl -n shop create deployment cart --image=traefik/whoami:v1.11 >/dev/null
kubectl -n payments create deployment ledger --image=busybox:1.37 --replicas=3 -- sleep 1d >/dev/null
kubectl -n shop rollout status deploy/web --timeout=120s >/dev/null
kubectl -n shop rollout status deploy/cart --timeout=120s >/dev/null
kubectl -n payments rollout status deploy/ledger --timeout=120s >/dev/null
cat > ~/search.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: search, namespace: shop, labels: {app: search}}
spec:
  replicas: 2
  selector: {matchLabels: {app: search}}
  template:
    metadata: {labels: {app: search}}
    spec:
      containers:
        - name: search
          image: busybox:1.37
          command: ["sh", "-c", "sleep 8; touch /tmp/ready; exec sleep 1d"]
          readinessProbe: {exec: {command: [test, -f, /tmp/ready]}, periodSeconds: 1}
EOF
