# Lesson 2: a healthy Deployment, then a release with a mistyped image tag that gets stuck halfway.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: api, labels: {app: api}}
spec:
  replicas: 4
  selector: {matchLabels: {app: api}}
  strategy: {rollingUpdate: {maxSurge: 1, maxUnavailable: 1}}
  template:
    metadata: {labels: {app: api}}
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.11
          args: ["--name=api-v1"]
EOF
ready deploy/api
kubectl annotate deploy api kubernetes.io/change-cause="v1: first release" >/dev/null
kubectl set image deploy/api api=traefik/whoami:v1.11.1 >/dev/null
kubectl annotate deploy api kubernetes.io/change-cause="v2: upgrade whoami" --overwrite >/dev/null
until_true 60 sh -c "kubectl get pods -l app=api -o jsonpath='{.items[*].status.containerStatuses[0].state.waiting.reason}' | grep -Eq 'ErrImagePull|ImagePullBackOff'"
