# Lesson 1: healthy pods behind a Service that has no endpoints (two mistakes in its spec).
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/apps.sh"
web default catalog 2 8080
client default shell
apply <<'EOF'
apiVersion: v1
kind: Service
metadata: {name: catalog}
spec:
  selector: {app: catalogue}
  ports: [{port: 80, targetPort: 80}]
EOF
ready deploy/catalog pod/shell
