# Shared helpers for this module's Kubernetes scenarios (sourced by the other scripts here). They run as root in the
# learner's home, in a container with its own one-node Kubernetes cluster (k3s, started here by dojo-cluster; no
# network, so pods run the pre-seeded busybox:1.37 and traefik/whoami:v1.11 images).
set -e -o pipefail
dojo-cluster up ${DOJO_CLUSTER_ARGS:-}

# Private notes for the checks, outside the learner's home.
note() { mkdir -p /opt/dojo/state; printf '%s\n' "$2" > "/opt/dojo/state/$1"; chmod 644 "/opt/dojo/state/$1"; }

# apply : kubectl apply the YAML given on stdin, quietly.
apply() { kubectl apply -f - >/dev/null; }

# ready KIND/NAME... : wait until Deployments are rolled out (or pods are Ready).
ready() {
  local o
  for o in "$@"; do
    case $o in
      deploy/*|deployment/*|statefulset/*|daemonset/*) kubectl rollout status "$o" --timeout=120s >/dev/null ;;
      *) kubectl wait --for=condition=Ready "$o" --timeout=120s >/dev/null ;;
    esac
  done
}

# until_true SECONDS CMD... : retry a command until it succeeds (for states that take a moment, like a crash loop).
until_true() {
  local n=$(( $1 * 4 )); shift
  until "$@" >/dev/null 2>&1; do n=$((n - 1)); [ $n -gt 0 ] || { echo "dojo: timed out waiting for: $*" >&2; return 1; }; sleep 0.25; done
}

mkdir -p ~/answers
echo "dojo: setting up the scenario..."
