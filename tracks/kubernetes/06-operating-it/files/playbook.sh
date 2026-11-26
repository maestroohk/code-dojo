# Lesson 1: a Deployment in CrashLoopBackOff after a config change dropped one environment variable.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: orders, labels: {app: orders}}
spec:
  replicas: 1
  selector: {matchLabels: {app: orders}}
  template:
    metadata: {labels: {app: orders}}
    spec:
      containers:
        - name: orders
          image: busybox:1.37
          env: [{name: ORDERS_QUEUE, value: "orders-v2"}]
          command: ["sh", "-c", "echo \"orders: starting, queue $ORDERS_QUEUE\"; [ -n \"$ORDERS_DB_HOST\" ] || { echo 'orders: FATAL ORDERS_DB_HOST is not set (expected the database Service, e.g. orders-db)' >&2; exit 1; }; echo \"orders: connected to $ORDERS_DB_HOST\"; exec sleep 1d"]
EOF
until_true 90 sh -c "kubectl get pods -l app=orders -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' | grep -q '[2-9]'"
