# Stage 2: the first, naive Dockerfile: one stage on the full SDK image.
DOJO_SEEDS="dotnet-sdk"
echo "dojo: loading the .NET 10 SDK image into this machine's Docker Engine..."
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/repo.sh"
. "$DOJO_FILES/dockerfiles.sh"
naive_dockerfile
