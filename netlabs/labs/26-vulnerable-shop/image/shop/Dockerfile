# The shop host: the .NET 10 SDK (to rebuild the learner's edits), git, gitleaks and sqlite3.
# Building the image restores and compiles a stub of the app once, so every NuGet package (and the Razor
# compiler) is already in the image: shop-rebuild works with no network at all.
FROM mcr.microsoft.com/dotnet/sdk:10.0
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git gitleaks sqlite3 jq curl iputils-ping procps less nano \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1442 --create-home --shell /usr/sbin/nologin shopsvc \
 && printf '%s\n' "PS1='\[\e[1;34m\]shop\[\e[0m\]:\w# '" "alias ll='ls -la'" >> /root/.bashrc
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 NUGET_XMLDOC_MODE=skip
COPY files/app/Shop.csproj /opt/warm/Shop.csproj
RUN cd /opt/warm \
 && printf '%s\n' 'var b = WebApplication.CreateBuilder(args);' 'b.Services.AddRazorPages();' 'var a = b.Build();' 'a.MapRazorPages();' 'a.Run();' > Program.cs \
 && mkdir Pages && printf '%s\n' '@page' '<p>@Html.Raw("warm")</p>' > Pages/Index.cshtml \
 && dotnet publish -c Release -o /tmp/warm-out -nologo -p:UseAppHost=false \
 && rm -rf /opt/warm /tmp/warm-out
WORKDIR /root
