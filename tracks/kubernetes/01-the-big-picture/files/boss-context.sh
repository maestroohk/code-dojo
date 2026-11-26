# Boss 3: one cluster, two teams' namespaces, and a kubeconfig with only the admin context in it.
. "$DOJO_FILES/lib.sh"
for ns in shop payments; do kubectl create namespace $ns >/dev/null; done
kubectl -n payments create deployment ledger --image=traefik/whoami:v1.11 --replicas=2 >/dev/null
kubectl -n shop create deployment cart --image=traefik/whoami:v1.11 >/dev/null
kubectl -n payments rollout status deploy/ledger --timeout=120s >/dev/null
# The learner gets an own copy of the kubeconfig to edit (contexts live in the file).
mkdir -p ~/.kube
cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sed -i 's/: default$/: dojo/' ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=$HOME/.kube/config' >> ~/.bashrc
