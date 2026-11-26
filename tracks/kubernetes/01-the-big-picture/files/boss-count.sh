# Boss 1: three namespaces of pods in assorted phases.
. "$DOJO_FILES/lib.sh"
for ns in shop payments batch; do kubectl create namespace $ns >/dev/null; done
kubectl -n shop create deployment web --image=traefik/whoami:v1.11 --replicas=3 >/dev/null
kubectl -n payments create deployment api --image=traefik/whoami:v1.11 --replicas=2 >/dev/null
for n in 1 2 3; do kubectl -n batch run "export-$n" --image=busybox:1.37 --restart=Never -- sh -c "echo export $n done" >/dev/null; done
kubectl -n batch run import --image=busybox:1.37 --restart=Never -- sh -c 'echo "import: bad file" >&2; exit 2' >/dev/null
kubectl -n payments run ledger --image=busybox:1.37 --overrides='{"spec":{"containers":[{"name":"ledger","image":"busybox:1.37","command":["sleep","1d"],"resources":{"requests":{"cpu":"500"}}}]}}' >/dev/null
kubectl -n shop rollout status deploy/web --timeout=120s >/dev/null
kubectl -n payments rollout status deploy/api --timeout=120s >/dev/null
until_true 60 sh -c "[ \$(kubectl -n batch get pods --field-selector=status.phase!=Pending,status.phase!=Running -o name | wc -l) -eq 4 ]"
