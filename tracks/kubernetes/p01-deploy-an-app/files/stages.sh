# The project's stages (sourced after lib.sh): each scenario starts from the state the previous stages left.
# The "API" is traefik/whoami (answers /health and echoes requests); the "database" a PostgreSQL stand-in on 5432.
kubectl create namespace todo >/dev/null
kubectl config set-context --current --namespace=todo >/dev/null
mkdir -p ~/k8s

stage_deployment() {
  cat > ~/k8s/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: todo-api
  namespace: todo
  labels: {app: todo-api}
spec:
  replicas: 2
  selector:
    matchLabels: {app: todo-api}
  template:
    metadata:
      labels: {app: todo-api}
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.11
          args: ["--name=todo-api-v1"]
          ports: [{name: http, containerPort: 80}]
EOF
  kubectl apply -f ~/k8s/deployment.yaml >/dev/null
}

stage_db() {
  cat > ~/k8s/db.yaml <<'EOF'
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: todo-db, namespace: todo, labels: {app: todo-db}}
spec:
  serviceName: todo-db
  replicas: 1
  selector: {matchLabels: {app: todo-db}}
  template:
    metadata: {labels: {app: todo-db}}
    spec:
      containers:
        - name: postgres
          image: busybox:1.37
          command: ["nc", "-lk", "-p", "5432", "-e", "echo", "PostgreSQL 17 ready"]
          ports: [{name: postgres, containerPort: 5432}]
EOF
  kubectl apply -f ~/k8s/db.yaml >/dev/null
}

stage_services() {
  cat > ~/k8s/services.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata: {name: todo-api, namespace: todo}
spec:
  selector: {app: todo-api}
  ports: [{name: http, port: 80, targetPort: http}]
---
apiVersion: v1
kind: Service
metadata: {name: todo-db, namespace: todo}
spec:
  selector: {app: todo-db}
  ports: [{name: postgres, port: 5432, targetPort: postgres}]
EOF
  kubectl apply -f ~/k8s/services.yaml >/dev/null
}

stage_probes() {
  kubectl -n todo patch deploy todo-api --type=strategic -p '{"spec":{"template":{"spec":{"containers":[{"name":"api",
    "resources":{"requests":{"cpu":"100m","memory":"64Mi"},"limits":{"memory":"128Mi"}},
    "readinessProbe":{"httpGet":{"path":"/health","port":"http"},"periodSeconds":2},
    "livenessProbe":{"httpGet":{"path":"/health","port":"http"},"periodSeconds":5}}]}}}}' >/dev/null
}

wait_all() {
  kubectl -n todo rollout status deploy/todo-api --timeout=120s >/dev/null
  kubectl -n todo rollout status statefulset/todo-db --timeout=120s >/dev/null 2>&1 || true
}
