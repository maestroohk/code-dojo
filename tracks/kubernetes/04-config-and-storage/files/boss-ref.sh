# Boss 1: a new release references a ConfigMap key and a Secret that are not there.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata: {name: billing-config}
data:
  CURRENCY: EUR
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: billing, labels: {app: billing}}
spec:
  replicas: 1
  selector: {matchLabels: {app: billing}}
  template:
    metadata: {labels: {app: billing}}
    spec:
      containers:
        - name: billing
          image: busybox:1.37
          env:
            - name: CURRENCY
              valueFrom: {configMapKeyRef: {name: billing-config, key: CURRENCY}}
            - name: INVOICE_PREFIX
              valueFrom: {configMapKeyRef: {name: billing-config, key: INVOICE_PREFIX}}
            - name: STRIPE_KEY
              valueFrom: {secretKeyRef: {name: billing-secrets, key: stripe-key}}
          command: ["sh", "-c", "echo \"billing: $INVOICE_PREFIX invoices in $CURRENCY (key of ${#STRIPE_KEY} characters)\"; exec sleep 1d"]
EOF
until_true 60 sh -c "kubectl get pods -l app=billing -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' | grep -q CreateContainerConfigError"
