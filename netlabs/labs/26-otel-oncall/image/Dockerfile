# The shop's two .NET services (one project, APP_ROLE picks the role). Built on the .NET 10 SDK image so the
# shop can be edited and rebuilt inside the lab (the on-call fix-and-redeploy loop). Docker Compose builds it
# the first time the lab starts: it restores the OpenTelemetry and Npgsql packages, so it needs the internet
# once. After that the lab runs offline, rebuilds included (--no-restore).
FROM mcr.microsoft.com/dotnet/sdk:10.0
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_gcServer=0 DOTNET_GCConserveMemory=5 DOTNET_TieredPGO=0 ASPNETCORE_URLS=http://+:8080
WORKDIR /app
COPY image/app/labapp.csproj image/app/Program.cs src/
RUN dotnet restore src/labapp.csproj \
 && dotnet build src/labapp.csproj -c Release -o out --no-restore -nologo -v:q -m:1 -nodeReuse:false -p:UseSharedCompilation=false \
 && touch /app/.built
COPY image/app-run.sh /usr/local/bin/app-run
RUN sed -i 's/\r$//' /usr/local/bin/app-run && chmod +x /usr/local/bin/app-run \
 && printf '%s\n' "PS1='\[\e[1;32m\]\h\[\e[0m\]:\w# '" "alias ll='ls -la'" >> /root/.bashrc
ENTRYPOINT ["/usr/local/bin/app-run"]
