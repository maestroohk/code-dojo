# Boss 2: a Deployment with the default rollout knobs, about to get a new version.
. "$DOJO_FILES/lib.sh"
kubectl create deployment checkout --image=traefik/whoami:v1.11 --replicas=4 >/dev/null
ready deploy/checkout
