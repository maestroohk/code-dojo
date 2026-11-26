# Shared by this module's scenarios (sourced after lib.sh). web NS NAME [REPLICAS] [PORT]: a whoami Deployment
# labelled app=NAME, answering "Name: NAME" on PORT (default 80).
web() {
  local ns=$1 name=$2 n=${3:-2} port=${4:-80}
  apply <<EOF
apiVersion: apps/v1
kind: Deployment
metadata: {name: $name, namespace: $ns, labels: {app: $name}}
spec:
  replicas: $n
  selector: {matchLabels: {app: $name}}
  template:
    metadata: {labels: {app: $name}}
    spec:
      containers:
        - name: $name
          image: traefik/whoami:v1.11
          args: ["--name=$name", "--port=$port"]
          ports: [{name: http, containerPort: $port}]
          readinessProbe: {httpGet: {path: /health, port: $port}, periodSeconds: 2}
EOF
}
# client NS NAME : a busybox pod to run wget/nslookup from.
client() { kubectl -n "$1" run "$2" --image=busybox:1.37 --labels="app=$2" -- sleep 1d >/dev/null; }
