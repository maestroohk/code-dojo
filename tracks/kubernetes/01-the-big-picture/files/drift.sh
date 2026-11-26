# Lesson 2: the desired state lives in ~/api.yaml, but someone scaled the live Deployment by hand (drift).
. "$DOJO_FILES/lib.sh"
cat > ~/api.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels: {app: api}
spec:
  replicas: 2
  selector:
    matchLabels: {app: api}
  template:
    metadata:
      labels: {app: api}
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.11
          ports: [{containerPort: 80}]
EOF
kubectl apply -f ~/api.yaml >/dev/null
kubectl scale deployment api --replicas=4 >/dev/null
ready deploy/api
