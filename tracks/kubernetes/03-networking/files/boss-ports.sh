# Boss 1: the Service has endpoints, yet connections are refused: its targetPort points at the wrong port.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/apps.sh"
web default orders 2 8080
client default shell
apply <<'EOF'
apiVersion: v1
kind: Service
metadata: {name: orders}
spec:
  selector: {app: orders}
  ports: [{name: http, port: 80, targetPort: 80}]
EOF
ready deploy/orders pod/shell
