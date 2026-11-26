# Lesson 2 (and its cold rebuild): a healthy app that its own liveness probe keeps killing.
. "$DOJO_FILES/lib.sh"
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
          image: traefik/whoami:v1.11
          ports: [{name: http, containerPort: 80}]
          livenessProbe:
            httpGet: {path: /healthz, port: 8080}
            periodSeconds: 2
            failureThreshold: 2
EOF
until_true 90 sh -c "kubectl get pods -l app=api -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' | grep -q '[1-9]'"
