# Stage 3: wired up; a migration job needs its database settings from a ConfigMap and a Secret.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/stages.sh"
stage_deployment
stage_db
stage_services
cat > ~/k8s/migrate.yaml <<'EOF'
apiVersion: batch/v1
kind: Job
metadata: {name: todo-migrate, namespace: todo}
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: busybox:1.37
          envFrom:
            - configMapRef: {name: todo-config}
            - secretRef: {name: todo-db-credentials}
          command: ["sh", "-c", "nc -w 3 \"$Db__Host\" 5432 </dev/null | grep -q ready || { echo \"migrate: cannot reach $Db__Host:5432\" >&2; exit 1; }; echo \"migrate: Host=$Db__Host;Database=$Db__Name;Username=$Db__Username;Password=*** (${#Db__Password} chars): 3 migrations applied\""]
EOF
wait_all
