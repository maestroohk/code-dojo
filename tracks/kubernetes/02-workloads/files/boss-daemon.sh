# Boss 3: a log agent DaemonSet that runs on zero nodes: a nodeSelector nobody matches, and a tainted node.
. "$DOJO_FILES/lib.sh"
kubectl taint node dojo dedicated=observability:NoSchedule >/dev/null
apply <<'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata: {name: log-agent, namespace: kube-system}
spec:
  selector: {matchLabels: {app: log-agent}}
  template:
    metadata: {labels: {app: log-agent}}
    spec:
      nodeSelector: {node-role.example.com/logging: "true"}
      containers:
        - name: agent
          image: busybox:1.37
          command: ["sh", "-c", "echo 'log-agent: shipping /var/log'; exec sleep 1d"]
EOF
sleep 2
