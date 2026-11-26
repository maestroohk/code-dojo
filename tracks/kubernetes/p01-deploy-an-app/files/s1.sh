# Stage 1: a Deployment manifest someone started by hand: its selector does not match its pod labels.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/stages.sh"
cat > ~/k8s/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: todo-api
  namespace: todo
spec:
  replicas: 1
  selector:
    matchLabels: {app: todo}
  template:
    metadata:
      labels: {app: todo-api}
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.11
EOF
