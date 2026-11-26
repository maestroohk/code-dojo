# Lesson 3 (and its cold rebuild): a one-replica StatefulSet with a volume per pod.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: v1
kind: Service
metadata: {name: db}
spec:
  clusterIP: None
  selector: {app: db}
  ports: [{port: 5432}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db}
spec:
  serviceName: db
  replicas: 1
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: db}}
    spec:
      containers:
        - name: db
          image: busybox:1.37
          command: ["sh", "-c", "echo \"I am $(hostname)\" > /data/whoami; exec sleep 1d"]
          volumeMounts: [{name: data, mountPath: /data}]
  volumeClaimTemplates:
    - metadata: {name: data}
      spec:
        accessModes: [ReadWriteOnce]
        resources: {requests: {storage: 100Mi}}
EOF
kubectl rollout status statefulset/db --timeout=180s >/dev/null
