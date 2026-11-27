# The image for Terraform "terraform" lesson steps (server/TermSteps.cs, tracks/terraform): Debian 13 slim with
#   Terraform 1.17 (HashiCorp, BUSL 1.1) and OpenTofu 1.13 (Linux Foundation, MPL 2.0), side by side,
#   the providers the lessons use in a filesystem mirror, because a step's container has no network at all,
#   tflint (lint) and conftest (Open Policy Agent policies on plan JSON), and
#   dojo-tfstate, a small state server speaking the "http" backend protocol (remote state and locking, offline).
# Every download is checked against the publisher's SHA256SUMS file. Built on first use, once.
FROM debian:trixie-slim

ARG TERRAFORM_VERSION=1.17.2
ARG TOFU_VERSION=1.13.10
ARG TFLINT_VERSION=0.66.0
ARG CONFTEST_VERSION=0.71.1
# Providers that need no cloud account: name/version. random has an older version too, for the upgrade lesson.
ARG PROVIDERS="local/2.9.1 random/3.9.1 random/3.7.2 null/3.3.2 tls/4.4.2 time/0.14.2 archive/2.8.1"

RUN printf '%s\n' 'path-exclude /usr/share/doc/*' 'path-include /usr/share/doc/*/copyright' \
      'path-exclude /usr/share/locale/*' 'path-exclude /usr/share/info/*' 'path-exclude /usr/share/man/*' > /etc/dpkg/dpkg.cfg.d/docker \
 && echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates bash-completion curl sudo less git vim-tiny make jq tree file unzip zip procps psmisc python3 \
 && rm -rf /var/lib/apt/lists/*

# The CLIs. HashiCorp and OpenTofu publish a SHA256SUMS file next to every release.
RUN set -e; arch=$(dpkg --print-architecture); cd /tmp \
 && get() { curl -fsSL --retry 5 -O "$1"; } \
 && get "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" \
 && get "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" \
 && grep "_linux_${arch}.zip" "terraform_${TERRAFORM_VERSION}_SHA256SUMS" | sha256sum -c - \
 && unzip -q -o "terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" terraform -d /usr/local/bin \
 && get "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.zip" \
 && get "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_SHA256SUMS" \
 && grep "tofu_${TOFU_VERSION}_linux_${arch}.zip" "tofu_${TOFU_VERSION}_SHA256SUMS" | sha256sum -c - \
 && unzip -q -o "tofu_${TOFU_VERSION}_linux_${arch}.zip" tofu -d /usr/local/bin \
 && get "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_${arch}.zip" \
 && get "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/checksums.txt" \
 && grep " tflint_linux_${arch}.zip" checksums.txt | sha256sum -c - \
 && unzip -q -o "tflint_linux_${arch}.zip" tflint -d /usr/local/bin && rm checksums.txt \
 && carch=$(case "$arch" in amd64) echo x86_64 ;; *) echo "$arch" ;; esac) \
 && get "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_${carch}.tar.gz" \
 && get "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/checksums.txt" \
 && grep " conftest_${CONFTEST_VERSION}_Linux_${carch}.tar.gz$" checksums.txt | sha256sum -c - \
 && tar -xzf "conftest_${CONFTEST_VERSION}_Linux_${carch}.tar.gz" -C /usr/local/bin conftest \
 && chmod 755 /usr/local/bin/terraform /usr/local/bin/tofu /usr/local/bin/tflint /usr/local/bin/conftest \
 && rm -rf /tmp/*

# The provider mirror, in Terraform's "unpacked" layout: <host>/<namespace>/<type>/<version>/<os_arch>/<binary>.
# OpenTofu reads the same binaries under its own registry host name (registry.opentofu.org): hard links, so they take
# no extra space (OpenTofu does not follow a symlinked host folder).
RUN set -e; arch=$(dpkg --print-architecture); mirror=/usr/local/share/terraform/plugins; cd /tmp \
 && for pv in $PROVIDERS; do \
      p=${pv%/*}; v=${pv#*/}; base="https://releases.hashicorp.com/terraform-provider-$p/$v"; \
      curl -fsSL --retry 5 -O "$base/terraform-provider-${p}_${v}_linux_${arch}.zip"; \
      curl -fsSL --retry 5 -O "$base/terraform-provider-${p}_${v}_SHA256SUMS"; \
      grep "_linux_${arch}.zip" "terraform-provider-${p}_${v}_SHA256SUMS" | sha256sum -c -; \
      dir="$mirror/registry.terraform.io/hashicorp/$p/$v/linux_${arch}"; mkdir -p "$dir"; \
      unzip -q "terraform-provider-${p}_${v}_linux_${arch}.zip" -d "$dir"; \
      rm -f /tmp/*; \
    done \
 && cp -al "$mirror/registry.terraform.io" "$mirror/registry.opentofu.org" \
 && chmod -R a+rX "$mirror"

COPY terraform.rc dojo-tfstate dojo-bashrc dojo-linerc dojo-editor /usr/local/lib/dojo/
RUN sed -i 's/\r$//' /usr/local/lib/dojo/* \
 && install -m 755 /usr/local/lib/dojo/dojo-editor /usr/local/bin/dojo-editor \
 && install -m 755 /usr/local/lib/dojo/dojo-tfstate /usr/local/bin/dojo-tfstate \
 && install -m 644 /usr/local/lib/dojo/terraform.rc /etc/terraform.rc \
 && ln -s /usr/bin/vim.tiny /usr/local/bin/vim

# The learner: a normal user with password-less sudo; Git knows who "you" are (module repos, CI layouts).
RUN useradd -m -s /bin/bash -G sudo learner \
 && echo 'learner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/learner && chmod 440 /etc/sudoers.d/learner \
 && git config --system user.name "Dojo Learner" \
 && git config --system user.email "learner@dojo.local" \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*' \
 && git config --system core.pager cat \
 && git config --system core.editor dojo-editor \
 && git config --system advice.detachedHead false \
 && mkdir -p /opt/dojo/files /opt/dojo/state \
 && for home in /root /home/learner; do echo '. /usr/local/lib/dojo/dojo-bashrc' >> $home/.bashrc; done

# CHECKPOINT_DISABLE: no version check calls. TF_CLI_CONFIG_FILE / TOFU_CLI_CONFIG_FILE: the offline mirror above.
ENV LANG=C.UTF-8 PAGER=cat GIT_PAGER=cat CHECKPOINT_DISABLE=1 \
    TF_CLI_CONFIG_FILE=/etc/terraform.rc TOFU_CLI_CONFIG_FILE=/etc/terraform.rc
WORKDIR /home/learner
CMD ["sleep", "infinity"]
