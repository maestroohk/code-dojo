# Lesson 1: two Deployments with no requests or limits at all (BestEffort: first to be evicted).
. "$DOJO_FILES/lib.sh"
kubectl create deployment api --image=traefik/whoami:v1.11 >/dev/null
kubectl create deployment worker --image=busybox:1.37 -- sleep 1d >/dev/null
ready deploy/api deploy/worker
