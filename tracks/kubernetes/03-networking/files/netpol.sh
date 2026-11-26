# Lesson 3: web, api and a stray debug pod in one namespace, with no network policies at all.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/apps.sh"
kubectl create namespace shop >/dev/null
web shop api 2
kubectl -n shop expose deploy api --port=80 >/dev/null
client shop web
client shop debug
kubectl -n shop rollout status deploy/api --timeout=120s >/dev/null
kubectl -n shop wait --for=condition=Ready pod/web pod/debug --timeout=120s >/dev/null
