# Boss 2: a GPU-style batch job pinned to nodes that do not exist, plus an anti-noisy-neighbour toleration missing.
. "$DOJO_FILES/lib.sh"
kubectl label node dojo pool=general >/dev/null
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: indexer, labels: {app: indexer}}
spec:
  replicas: 1
  selector: {matchLabels: {app: indexer}}
  template:
    metadata: {labels: {app: indexer}}
    spec:
      nodeSelector: {pool: batch}
      containers:
        - name: indexer
          image: busybox:1.37
          command: ["sh", "-c", "echo 'indexer: building the search index'; exec sleep 1d"]
          resources: {requests: {cpu: 100m, memory: 64Mi}}
EOF
until_true 60 sh -c "kubectl get events --field-selector reason=FailedScheduling -o name | grep -q ."
