# Boss 3: the checkout cannot reach inventory. Three things are wrong along the way: the name it uses, the
# Service's selector, and a network policy that only lets the old frontend in.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/apps.sh"
kubectl create namespace shop >/dev/null
kubectl create namespace stock >/dev/null
kubectl label namespace shop team=shop >/dev/null
web stock inventory 2
apply <<'EOF'
apiVersion: v1
kind: Service
metadata: {name: inventory, namespace: stock}
spec:
  selector: {app: inventory, tier: backend}
  ports: [{port: 80, targetPort: 80}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: inventory-ingress, namespace: stock}
spec:
  podSelector: {matchLabels: {app: inventory}}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {team: shop}}
          podSelector: {matchLabels: {app: frontend}}
      ports: [{port: 80}]
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: checkout, namespace: shop, labels: {app: checkout}}
spec:
  replicas: 1
  selector: {matchLabels: {app: checkout}}
  template:
    metadata: {labels: {app: checkout}}
    spec:
      containers:
        - name: checkout
          image: busybox:1.37
          env: [{name: INVENTORY_URL, value: "http://inventory.shop.svc.cluster.local/"}]
          command: ["sh", "-c", "while true; do if wget -qO- -T 2 \"$INVENTORY_URL\" >/dev/null 2>&1; then echo \"checkout: inventory OK at $INVENTORY_URL\"; else echo \"checkout: ERROR cannot reach $INVENTORY_URL\" >&2; fi; sleep 3; done"]
EOF
kubectl -n stock rollout status deploy/inventory --timeout=120s >/dev/null
kubectl -n shop rollout status deploy/checkout --timeout=120s >/dev/null
