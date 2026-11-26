# Lesson 2: one ConfigMap shared by api and worker, with settings as env vars and a whole file.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata: {name: shop-config}
data:
  LOG_LEVEL: info
  FEATURE_COUPONS: "true"
  app.json: |
    {"currency": "EUR", "pageSize": 20}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: worker, labels: {app: worker}}
spec:
  replicas: 1
  selector: {matchLabels: {app: worker}}
  template:
    metadata: {labels: {app: worker}}
    spec:
      containers:
        - name: worker
          image: busybox:1.37
          envFrom: [{configMapRef: {name: shop-config}}]
          command: ["sleep", "1d"]
EOF
ready deploy/worker
