# Lesson 2 (and its cold rebuild): two team namespaces; CI needs an identity that can deploy to shop, nothing more.
. "$DOJO_FILES/lib.sh"
kubectl create namespace shop >/dev/null
kubectl create namespace payments >/dev/null
kubectl -n shop create deployment web --image=traefik/whoami:v1.11 >/dev/null
kubectl -n shop create secret generic db --from-literal=password=example-only >/dev/null
