# Stage 5: the multi-stage image works; now it has to pass a production review.
DOJO_SEEDS="dotnet-sdk dotnet-aspnet"
echo "dojo: loading the .NET 10 SDK and ASP.NET Core images into this machine's Docker Engine..."
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/repo.sh"
. "$DOJO_FILES/dockerfiles.sh"
multistage_dockerfile
build_todo
