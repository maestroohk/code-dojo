# Boss 2: three workers; one keeps being OOM-killed because its limit is below its working set (~40 MB).
. "$DOJO_FILES/lib.sh"
worker() {  # worker NAME LIMIT HOLD_BYTES
  apply <<EOF
apiVersion: apps/v1
kind: Deployment
metadata: {name: $1, labels: {app: $1}}
spec:
  replicas: 1
  selector: {matchLabels: {app: $1}}
  template:
    metadata: {labels: {app: $1}}
    spec:
      containers:
        - name: worker
          image: busybox:1.37
          command: ["sh", "-c", "echo '$1: loading'; cache=\$(head -c $3 /dev/zero | tr '\\\\0' x); echo \"$1: ready (\${#cache} bytes)\"; exec sleep 1d"]
          resources:
            requests: {cpu: 50m, memory: $2}
            limits: {memory: $2}
EOF
}
worker thumbnails 32Mi 40000000
worker mailer 64Mi 1000000
worker exporter 64Mi 2000000
until_true 90 sh -c "kubectl get pods -l app=thumbnails -o jsonpath='{.items[0].status.containerStatuses[0].lastState.terminated.reason}' | grep -q OOMKilled"
