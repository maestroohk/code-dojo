# Lesson 2, step 2: a container with no shell (whoami is a single static binary) to look inside anyway.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: edge, labels: {app: edge}}
spec:
  shareProcessNamespace: false
  containers:
    - name: edge
      image: traefik/whoami:v1.11
      args: ["--port=7311", "--name=edge"]
EOF
ready pod/edge
