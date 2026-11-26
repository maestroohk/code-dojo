# Lesson 1: a dozen pods from several teams and environments, told apart only by their labels.
. "$DOJO_FILES/lib.sh"
pod() {  # pod NAME LABELS
  kubectl run "$1" --image=busybox:1.37 --labels="$2" --restart=Never -- sleep 1d >/dev/null
}
pod cart-1      app=cart,env=prod,tier=web
pod cart-2      app=cart,env=prod,tier=web
pod cart-3      app=cart,env=staging,tier=web
pod pay-1       app=payments,env=prod,tier=api
pod pay-2       app=payments,env=staging,tier=api
pod pay-3       app=payments,env=dev,tier=api
pod search-1    app=search,env=prod,tier=api
pod search-2    app=search,env=prod,tier=api,canary=true
pod report-1    app=report,env=prod,tier=batch
pod debug-1     app=debug,tier=tools
kubectl wait --for=condition=Ready pod --all --timeout=120s >/dev/null
