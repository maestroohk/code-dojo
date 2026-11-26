# Lesson 3: a GitOps-style manifest, and a live object that someone has changed by hand with kubectl edit/scale.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/gitops
cat > ~/gitops/api.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: api, labels: {app: api}}
spec:
  replicas: 3
  selector: {matchLabels: {app: api}}
  template:
    metadata: {labels: {app: api}}
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.11
          args: ["--name=api-from-git"]
EOF
kubectl apply --server-side --field-manager=gitops -f ~/gitops/api.yaml >/dev/null
kubectl rollout status deploy/api --timeout=120s >/dev/null
# An on-call engineer scaled it by hand during an incident, and the change was never put back in Git.
kubectl scale deploy api --replicas=5 >/dev/null
kubectl patch deploy api --field-manager=night-shift --type=merge -p '{"spec":{"replicas":5}}' >/dev/null
