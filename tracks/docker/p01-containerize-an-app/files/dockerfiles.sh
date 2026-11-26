# Shared by the project's .NET scenarios (sourced after lib.sh and repo.sh): the .dockerignore from stage 1 and
# the Dockerfiles each later stage starts from.
printf '%s\n' '**/bin/' '**/obj/' '.git' '.vs' 'tests/' 'docs/' '*.md' 'secrets*.json' 'appsettings.Development.json' > ~/todo/.dockerignore

naive_dockerfile() {
  cat > ~/todo/Dockerfile <<'EOF'
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app
WORKDIR /app
ENTRYPOINT ["dotnet", "TodoApi.dll"]
EOF
}

multistage_dockerfile() {
  cat > ~/todo/Dockerfile <<'EOF'
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src
COPY TodoApi.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS final
WORKDIR /app
COPY --from=build /app/publish .
EXPOSE 8080
ENTRYPOINT ["dotnet", "TodoApi.dll"]
EOF
}

# Build the multi-stage image as todo:2 (about a minute the first time: dotnet restore and publish).
build_todo() {
  echo "dojo: building the TodoApi image with the .NET 10 SDK (about a minute)..."
  docker build -q -t todo:2 ~/todo >/dev/null
  echo "dojo: TodoApi image todo:2 is built."
}
