# Stage 4: the API image is built; it needs PostgreSQL next to it.
DOJO_SEEDS="dotnet-sdk dotnet-aspnet postgres"
echo "dojo: loading the .NET 10 and PostgreSQL 17 images into this machine's Docker Engine..."
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/repo.sh"
. "$DOJO_FILES/dockerfiles.sh"
multistage_dockerfile
build_todo
cat > ~/todo/compose.yaml <<'EOF'
services:
  api:
    image: todo:2
    ports:
      - "8080:8080"
EOF
