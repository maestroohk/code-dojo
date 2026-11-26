# Boss 1: a busy namespace after a bad morning. The events say what happened to whom.
. "$DOJO_FILES/lib.sh"
kubectl create namespace shop >/dev/null
apply <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: cart, namespace: shop}
spec:
  containers: [{name: cart, image: "traefik/whoami:v1.11"}]
---
apiVersion: v1
kind: Pod
metadata: {name: images, namespace: shop}
spec:
  containers: [{name: images, image: "registry.example.com/shop/images:2.0"}]
---
apiVersion: v1
kind: Pod
metadata: {name: reports, namespace: shop}
spec:
  nodeSelector: {disktype: ssd}
  containers: [{name: reports, image: "busybox:1.37", command: ["sleep", "1d"]}]
---
apiVersion: v1
kind: Pod
metadata: {name: search, namespace: shop}
spec:
  containers:
    - name: search
      image: traefik/whoami:v1.11
      readinessProbe: {httpGet: {path: /ready, port: 9999}, periodSeconds: 2}
---
apiVersion: v1
kind: Pod
metadata: {name: mailer, namespace: shop}
spec:
  containers: [{name: mailer, image: "busybox:1.37", command: ["sh", "-c", "echo 'mailer: no SMTP host' >&2; exit 1"]}]
EOF
until_true 90 sh -c "kubectl -n shop get events -o jsonpath='{.items[*].reason}' | grep -q BackOff && kubectl -n shop get events -o jsonpath='{.items[*].reason}' | grep -q Unhealthy && kubectl -n shop get events -o jsonpath='{.items[*].reason}' | grep -q FailedScheduling"
