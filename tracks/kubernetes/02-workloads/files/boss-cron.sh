# Boss 2: a nightly CronJob whose last run failed; the fix has to be proven before tonight.
. "$DOJO_FILES/lib.sh"
apply <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata: {name: export-config}
data:
  TARGET: s3://reports.example.com/nightly
---
apiVersion: batch/v1
kind: CronJob
metadata: {name: nightly-export}
spec:
  schedule: "30 2 * * *"
  timeZone: Etc/UTC
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: export
              image: busybox:1.37
              envFrom: [{configMapRef: {name: export-config}}]
              command: ["sh", "-c", "[ -n \"$TARGET_URL\" ] || { echo 'export: TARGET_URL is not set' >&2; exit 1; }; echo \"exported 1204 rows to $TARGET_URL\""]
EOF
kubectl create job nightly-export-manual-1 --from=cronjob/nightly-export >/dev/null
until_true 90 sh -c "kubectl get job nightly-export-manual-1 -o jsonpath='{.status.conditions[*].type}' | grep -q Failed"
