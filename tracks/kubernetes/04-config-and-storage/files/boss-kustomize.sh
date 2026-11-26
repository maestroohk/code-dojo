# Boss 3: a Kustomize base for the shop's API, and an empty prod overlay to write.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/deploy/base ~/deploy/overlays/prod
cat > ~/deploy/base/deployment.yaml <<'EOF'
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
          command: ["sh", "-c", "echo \"api: log level $LOG_LEVEL in $ENVIRONMENT\"; exec sleep 1d"]
EOF
cat > ~/deploy/base/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [deployment.yaml]
configMapGenerator:
  - name: api-config
    literals: [LOG_LEVEL=debug, ENVIRONMENT=dev]
EOF
kubectl create namespace prod >/dev/null
