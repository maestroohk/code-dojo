# Lesson 2, step 1 (and the cold rebuild): CrashLoopBackOff from a ConfigMap key that was renamed.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata: {name: api-config}
data:
  DATABASE_HOST: db.shop.svc.cluster.local
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: api, labels: {app: api}}
spec:
  replicas: 1
  selector: {matchLabels: {app: api}}
  template:
    metadata: {labels: {app: api}}
    spec:
      containers:
        - name: api
          image: busybox:1.37
          envFrom: [{configMapRef: {name: api-config}}]
          command: ["sh", "-c", "echo 'api 2.4 starting'; [ -n \"$DB_HOST\" ] || { echo 'api: FATAL missing setting DB_HOST' >&2; exit 1; }; echo \"api: using database $DB_HOST\"; exec sleep 1d"]
EOF
until_true 90 sh -c "kubectl get pods -l app=api -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' | grep -q '[2-9]'"
