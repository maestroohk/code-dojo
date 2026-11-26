# Boss 3: an RBAC audit. Several bindings; one gives a workload's service account the keys to the cluster.
. "$DOJO_FILES/lib.sh"
kubectl create namespace shop >/dev/null
kubectl create namespace monitoring >/dev/null
kubectl -n shop create serviceaccount web >/dev/null
kubectl -n shop create serviceaccount deployer >/dev/null
kubectl -n monitoring create serviceaccount prometheus >/dev/null
kubectl create clusterrole metrics-reader --verb=get,list,watch --resource=pods,nodes,services,endpoints >/dev/null
kubectl create clusterrolebinding prometheus-read --clusterrole=metrics-reader --serviceaccount=monitoring:prometheus >/dev/null
kubectl -n shop create rolebinding deployer-edit --clusterrole=edit --serviceaccount=shop:deployer >/dev/null
kubectl create clusterrolebinding web-debug-tmp --clusterrole=cluster-admin --serviceaccount=shop:web >/dev/null
kubectl -n shop create rolebinding web-view --clusterrole=view --serviceaccount=shop:web >/dev/null
