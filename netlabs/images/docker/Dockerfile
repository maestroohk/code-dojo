# The image for Docker "terminal" lesson steps (server/TermSteps.cs, netlabs/images/docker/dojo-step.json):
# a real Docker Engine running inside the step's own container (Docker-in-Docker). The container is privileged
# (dockerd needs it) but has no network at all, so nothing can be pulled: the images the lessons use are
# pre-seeded below as tarballs and loaded into the inner engine when the step starts (dojo-docker-up).
# Built on first use, once.

# 1. The base images the scenarios build FROM and run, fetched once at build time as plain image tarballs.
FROM quay.io/skopeo/stable:v1.20 AS seed
RUN mkdir -p /seed \
 && skopeo copy --retry-times 3 docker://docker.io/library/alpine:3.24 docker-archive:/seed/alpine.tar:alpine:3.24 \
 && skopeo copy --retry-times 3 docker://docker.io/library/busybox:1.37 docker-archive:/seed/busybox.tar:busybox:1.37

# 2. The learner's machine: the official Docker-in-Docker image (Engine 29, Compose and Buildx plugins) plus
#    the everyday shell tools, and a non-root learner in the docker group.
FROM docker:29-dind
RUN apk add --no-cache bash bash-completion sudo coreutils grep sed findutils procps util-linux-misc \
      less vim nano git curl jq tree file ncurses tzdata \
 && addgroup -S docker 2>/dev/null; adduser -D -s /bin/bash learner \
 && addgroup learner docker && addgroup learner wheel \
 && echo 'learner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/learner && chmod 440 /etc/sudoers.d/learner \
 && mkdir -p /opt/dojo/files /opt/dojo/seed

COPY --from=seed /seed/ /opt/dojo/seed/
COPY dojo-bashrc dojo-docker-up dojo-entry /usr/local/lib/dojo/
RUN sed -i 's/\r$//' /usr/local/lib/dojo/* \
 && install -m 755 /usr/local/lib/dojo/dojo-docker-up /usr/local/bin/dojo-docker-up \
 && install -m 755 /usr/local/lib/dojo/dojo-entry /usr/local/bin/dojo-entry \
 && for home in /root /home/learner; do echo '. /usr/local/lib/dojo/dojo-bashrc' >> $home/.bashrc; done \
 && echo '[ -f ~/.bashrc ] && . ~/.bashrc' > /home/learner/.bash_profile && chown learner:learner /home/learner/.bash*

# BuildKit's progress as plain lines: the in-page terminal is line based.
ENV LANG=C.UTF-8 PAGER=cat BUILDKIT_PROGRESS=plain DOCKER_CLI_HINTS=false COMPOSE_PROGRESS=plain COMPOSE_ANSI=never
WORKDIR /home/learner
ENTRYPOINT ["dojo-entry"]
CMD ["sleep", "infinity"]
