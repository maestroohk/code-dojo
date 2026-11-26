# Lesson 1: a Deployment the learner can watch being corrected.
. "$DOJO_FILES/lib.sh"
kubectl create deployment web --image=traefik/whoami:v1.11 --replicas=3 --port=80 >/dev/null
ready deploy/web
