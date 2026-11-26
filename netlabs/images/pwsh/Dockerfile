# The image for PowerShell "terminal" lesson steps (server/TermSteps.cs, tracks/powershell): Debian 13 slim with
# the official PowerShell 7.6 LTS package from Microsoft's GitHub release (checked against its published SHA-256),
# and the modules the lessons use saved into the image, because a step's container has no network at all:
#   Pester 6 (tests), PSScriptAnalyzer (lint), SecretManagement + SecretStore (secrets), and the updatable help.
# The learner's terminal opens straight into pwsh (dojo-bashrc); checks and setup scripts are bash, as in the shell image.
# Built on first use, once.
FROM debian:trixie-slim

ARG PWSH_VERSION=7.6.10
ARG PWSH_SHA256_AMD64=81A5A944702B116EA74C88B01BA5F1F46B1CD7C42C36D85E1BAE90DE1230B4D1
ARG PWSH_SHA256_ARM64=7F88934E68E75ADE128334E57DA7C85F289266926A72B591C1524F3342891683

# Everyday tools the scenarios need (git for the git helper, python3 for small local HTTP services the REST lessons
# call over loopback, openssh-server for PowerShell remoting over SSH to this same machine).
RUN printf '%s\n' 'path-exclude /usr/share/doc/*' 'path-include /usr/share/doc/*/copyright' \
      'path-exclude /usr/share/locale/*' 'path-exclude /usr/share/info/*' 'path-exclude /usr/share/man/*' > /etc/dpkg/dpkg.cfg.d/docker \
 && echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl sudo less git jq tree file unzip zip procps psmisc iproute2 \
      python3 openssh-client openssh-server cron \
 && arch=$(dpkg --print-architecture) \
 && case "$arch" in amd64) sum=$PWSH_SHA256_AMD64 ;; arm64) sum=$PWSH_SHA256_ARM64 ;; *) echo "no PowerShell package for $arch" >&2; exit 1 ;; esac \
 && curl -fsSL --retry 5 -o /tmp/powershell.deb \
      "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell_${PWSH_VERSION}-1.deb_${arch}.deb" \
 && echo "$(echo "$sum" | tr 'A-F' 'a-f')  /tmp/powershell.deb" | sha256sum -c - \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/powershell.deb \
 && rm -f /tmp/powershell.deb \
 && rm -rf /var/lib/apt/lists/*

ENV POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    LANG=C.UTF-8 PAGER=cat GIT_PAGER=cat

# Modules for every user (/usr/local/share/powershell/Modules), pinned, from the PowerShell Gallery at build time,
# and the help files, so Get-Help -Examples works offline in the steps.
RUN pwsh -NoLogo -NoProfile -NonInteractive -Command '\
      $ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; \
      foreach ($m in @(@("Pester","6.2.0"), @("PSScriptAnalyzer","1.25.0"), @("Microsoft.PowerShell.SecretManagement","1.1.2"), @("Microsoft.PowerShell.SecretStore","1.0.6"))) { \
        Install-PSResource -Name $m[0] -Version $m[1] -Scope AllUsers -TrustRepository -Quiet }; \
      Update-Help -Scope AllUsers -UICulture en-US -Force -ErrorAction SilentlyContinue; \
      Get-Module -ListAvailable Pester, PSScriptAnalyzer, Microsoft.PowerShell.Secret* | Format-Table Name, Version' \
 && rm -rf /root/.cache /root/.local/share/powershell /tmp/* \
 && cd /usr/local/share/powershell/Modules/PSScriptAnalyzer/*/compatibility_profiles \
 && find . -type f ! -name 'win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework.json' ! -name 'ubuntu_x64_18.04_7.0.0_x64_3.1.2_core.json' -delete

# The learner: a normal user with password-less sudo. Git knows who "you" are. sshd offers the powershell
# subsystem (key logins only) for the remoting lessons; scenarios start it when they need it.
RUN useradd -m -s /bin/bash -G sudo learner \
 && echo 'learner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/learner && chmod 440 /etc/sudoers.d/learner \
 && git config --system user.name "Dojo Learner" \
 && git config --system user.email "learner@dojo.local" \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*' \
 && git config --system core.pager cat \
 && git config --system core.editor dojo-editor \
 && mkdir -p /opt/dojo/files /run/sshd \
 && ssh-keygen -A \
 && printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PubkeyAuthentication yes' \
      'Subsystem powershell /usr/bin/pwsh -sshs -NoLogo' > /etc/ssh/sshd_config.d/dojo.conf

COPY dojo-bashrc dojo-linerc dojo-editor dojo-repl.ps1 profile.ps1 /usr/local/lib/dojo/
RUN sed -i 's/\r$//' /usr/local/lib/dojo/* \
 && install -m 755 /usr/local/lib/dojo/dojo-editor /usr/local/bin/dojo-editor \
 && install -m 644 /usr/local/lib/dojo/profile.ps1 "$(pwsh -NoProfile -c '$PSHOME')/profile.ps1" \
 && for home in /root /home/learner; do echo '. /usr/local/lib/dojo/dojo-bashrc' >> $home/.bashrc; done

WORKDIR /home/learner
CMD ["sleep", "infinity"]
