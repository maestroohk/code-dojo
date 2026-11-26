# Stage 3: start again from the naive Dockerfile; the learner writes the multi-stage one.
DOJO_SEEDS="dotnet-sdk dotnet-aspnet"
echo "dojo: loading the .NET 10 SDK and ASP.NET Core images into this machine's Docker Engine..."
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/repo.sh"
. "$DOJO_FILES/dockerfiles.sh"
naive_dockerfile
