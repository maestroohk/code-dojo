# Boss 2: a Service with no external exposure that you need to look at from your own machine.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/apps.sh"
kubectl create namespace payments >/dev/null
web payments ledger 1 9000
kubectl -n payments expose deploy ledger --port=80 --target-port=9000 >/dev/null
kubectl -n payments rollout status deploy/ledger --timeout=120s >/dev/null
note ledger-pod "$(kubectl -n payments get pods -l app=ledger -o jsonpath='{.items[0].metadata.name}')"
