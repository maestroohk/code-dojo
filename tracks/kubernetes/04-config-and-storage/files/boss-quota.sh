# Boss 2: a team namespace with a quota; a Deployment that cannot create its pods.
. "$DOJO_FILES/lib.sh"
kubectl create namespace reports >/dev/null
apply <<'EOF'
apiVersion: v1
kind: ResourceQuota
metadata: {name: team-quota, namespace: reports}
spec:
  hard:
    requests.cpu: "1"
    requests.memory: 1Gi
    limits.memory: 2Gi
    persistentvolumeclaims: "2"
    requests.storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: renderer, namespace: reports, labels: {app: renderer}}
spec:
  replicas: 3
  selector: {matchLabels: {app: renderer}}
  template:
    metadata: {labels: {app: renderer}}
    spec:
      containers:
        - name: renderer
          image: busybox:1.37
          command: ["sleep", "1d"]
          resources:
            requests: {cpu: 500m, memory: 512Mi}
            limits: {memory: 1Gi}
EOF
until_true 60 sh -c "kubectl -n reports get rs -l app=renderer -o jsonpath='{.items[0].status.conditions[0].reason}' | grep -q FailedCreate"
