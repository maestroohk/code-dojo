# Lesson 1, step 1: a release whose image tag has a typo (ImagePullBackOff).
. "$DOJO_FILES/lib.sh"
kubectl create deployment web --image=traefik/whoami:v1.11 --replicas=2 >/dev/null
ready deploy/web
kubectl set image deploy/web whoami=traefik/whoami:v1.1l >/dev/null
until_true 60 sh -c "kubectl get pods -l app=web -o jsonpath='{.items[*].status.containerStatuses[0].state.waiting.reason}' | grep -Eq 'ErrImagePull|ImagePullBackOff'"
