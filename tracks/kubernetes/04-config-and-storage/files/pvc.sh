# Lesson 3 (and its cold rebuild): a "database" pod that keeps its data in an emptyDir, which dies with the pod.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: notes, labels: {app: notes}}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: notes}}
  template:
    metadata: {labels: {app: notes}}
    spec:
      containers:
        - name: notes
          image: busybox:1.37
          command: ["sh", "-c", "touch /data/notes.txt; echo \"notes: $(wc -l < /data/notes.txt) notes on disk\"; exec sleep 1d"]
          volumeMounts: [{name: data, mountPath: /data}]
      volumes:
        - name: data
          emptyDir: {}
EOF
ready deploy/notes
