# The shared image for "terminal" lesson steps (server/TermSteps.cs): an everyday Linux workstation on
# Debian slim with the tools seniors reach for, a non-root learner with sudo, and Git with a fake identity.
# Built on first use; every terminal step starts a throwaway container from it.
FROM debian:trixie-slim

# Keep man pages (Debian slim drops them), still skip docs and translations to stay small.
RUN printf '%s\n' 'path-exclude /usr/share/doc/*' 'path-include /usr/share/doc/*/copyright' \
      'path-exclude /usr/share/locale/*' 'path-exclude /usr/share/info/*' > /etc/dpkg/dpkg.cfg.d/docker \
 && echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates bash-completion sudo less man-db manpages \
      git vim nano tmux make \
      curl jq ripgrep fd-find tree file unzip zip xz-utils bc gawk bsdextrautils \
      procps psmisc iproute2 lsof strace sysstat bind9-dnsutils openssh-client acl \
      cron systemd shellcheck \
      python3 sqlite3 \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --reinstall coreutils grep sed findutils tar gzip \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && mandb -q 2>/dev/null || true

# The learner: a normal user who can sudo without a password. Git knows who "you" are, so commits just work.
RUN useradd -m -s /bin/bash -G sudo learner \
 && echo 'learner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/learner && chmod 440 /etc/sudoers.d/learner \
 && git config --system user.name "Dojo Learner" \
 && git config --system user.email "learner@dojo.local" \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*' \
 && git config --system advice.detachedHead true \
 && git config --system color.ui auto \
 && git config --system core.pager cat \
 && git config --system core.editor dojo-editor \
 && git config --system pull.rebase false \
 && mkdir -p /opt/dojo/files

COPY dojo-editor dojo-bashrc /usr/local/lib/dojo/
RUN sed -i 's/\r$//' /usr/local/lib/dojo/* \
 && install -m 755 /usr/local/lib/dojo/dojo-editor /usr/local/bin/dojo-editor \
 && for home in /root /home/learner; do echo '. /usr/local/lib/dojo/dojo-bashrc' >> $home/.bashrc; done

ENV LANG=C.UTF-8 PAGER=cat MANPAGER=cat MANWIDTH=100 GIT_PAGER=cat SYSTEMD_PAGER=cat
WORKDIR /home/learner
CMD ["sleep", "infinity"]
