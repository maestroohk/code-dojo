# Stage 2: the API and the database run; nothing can reach either by name yet.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/stages.sh"
stage_deployment
stage_db
kubectl -n todo run shell --image=busybox:1.37 -- sleep 1d >/dev/null
wait_all
kubectl -n todo wait --for=condition=Ready pod/shell --timeout=120s >/dev/null
