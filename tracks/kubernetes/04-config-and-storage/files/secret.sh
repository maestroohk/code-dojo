# Lesson 1: an API that reads its database password from a Secret through env, and a password rotation.
. "$DOJO_FILES/lib.sh"
kubectl create secret generic db-credentials --from-literal=username=shop --from-literal=password='autumn-example-42' >/dev/null
apply <<'EOF'
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
          envFrom: [{secretRef: {name: db-credentials}, prefix: DB_}]
          command: ["sh", "-c", "echo \"api: connecting as $DB_username (password of ${#DB_password} characters)\"; exec sleep 1d"]
EOF
ready deploy/api
note old-pod "$(kubectl get pods -l app=api -o jsonpath='{.items[0].metadata.name}')"
