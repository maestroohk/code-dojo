# Lesson 2, step 1: the cart in namespace shop calls the payments Service, which lives in namespace payments.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/apps.sh"
kubectl create namespace shop >/dev/null
kubectl create namespace payments >/dev/null
web payments payments 2
kubectl -n payments expose deploy payments --port=80 >/dev/null
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: cart, namespace: shop, labels: {app: cart}}
spec:
  replicas: 1
  selector: {matchLabels: {app: cart}}
  template:
    metadata: {labels: {app: cart}}
    spec:
      containers:
        - name: cart
          image: busybox:1.37
          env: [{name: PAYMENTS_URL, value: "http://payments/"}]
          command: ["sh", "-c", "while true; do if wget -qO- -T 2 \"$PAYMENTS_URL\" >/dev/null 2>&1; then echo \"cart: payments OK at $PAYMENTS_URL\"; else echo \"cart: ERROR cannot reach $PAYMENTS_URL\" >&2; fi; sleep 3; done"]
EOF
kubectl -n payments rollout status deploy/payments --timeout=120s >/dev/null
kubectl -n shop rollout status deploy/cart --timeout=120s >/dev/null
