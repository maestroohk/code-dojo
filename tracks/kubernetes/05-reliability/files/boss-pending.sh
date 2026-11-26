# Boss 1: a Deployment whose pods have never been scheduled.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: search, labels: {app: search}}
spec:
  replicas: 2
  selector: {matchLabels: {app: search}}
  template:
    metadata: {labels: {app: search}}
    spec:
      containers:
        - name: search
          image: busybox:1.37
          command: ["sh", "-c", "echo 'search: index loaded'; exec sleep 1d"]
          resources:
            requests: {cpu: 250m, memory: 64Gi}
            limits: {memory: 64Gi}
EOF
until_true 60 sh -c "kubectl get events --field-selector reason=FailedScheduling -o name | grep -q ."
