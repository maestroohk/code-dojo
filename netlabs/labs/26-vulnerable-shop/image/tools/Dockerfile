# Attacker, admin bot and internal services of the vulnerable-shop lab. Everything comes from Debian 13
# packages, installed when Docker Compose builds the image the first time the lab starts (it needs the
# internet once). After that the lab runs offline: its networks have no way out.
#   attacker: curl, jq, python3, sqlmap, hydra
#   bot:      a real headless Chromium, driven by Selenium (chromium-driver, python3-selenium)
FROM debian:trixie-slim
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash curl jq python3 python3-requests sqlmap hydra \
      chromium chromium-driver python3-selenium fonts-dejavu-core \
      iproute2 iputils-ping dnsutils netcat-openbsd procps less nano ca-certificates file \
 && rm -rf /var/lib/apt/lists/* \
 && chromium --version && chromedriver --version && python3 -c "import selenium; print('selenium', selenium.__version__)" \
 && printf '%s\n' "PS1='\[\e[1;32m\]\h\[\e[0m\]:\w# '" "alias ll='ls -la'" >> /root/.bashrc
WORKDIR /root
