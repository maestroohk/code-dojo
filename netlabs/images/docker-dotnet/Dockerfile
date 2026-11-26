# The image for the Docker project steps that build a real .NET 10 app (tracks/docker/p01-containerize-an-app):
# the same Docker-in-Docker machine as netlabs/images/docker (keep the two in step), plus the .NET 10 SDK and
# ASP.NET Core runtime images and PostgreSQL 17, pre-seeded as tarballs because the step has no network.
# It is a separate image so that only learners who reach the project download the ~1 GB of .NET and Postgres images.
# dojo-docker-up loads only the seeds a scenario names (the SDK alone is ~800 MB unpacked).

FROM quay.io/skopeo/stable:v1.20 AS seed
RUN mkdir -p /seed \
 && skopeo copy --retry-times 3 docker://docker.io/library/alpine:3.24 docker-archive:/seed/alpine.tar:alpine:3.24 \
 && skopeo copy --retry-times 3 docker://docker.io/library/busybox:1.37 docker-archive:/seed/busybox.tar:busybox:1.37 \
 && skopeo copy --retry-times 3 docker://mcr.microsoft.com/dotnet/sdk:10.0-alpine docker-archive:/seed/dotnet-sdk.tar:mcr.microsoft.com/dotnet/sdk:10.0-alpine \
 && skopeo copy --retry-times 3 docker://mcr.microsoft.com/dotnet/aspnet:10.0-alpine docker-archive:/seed/dotnet-aspnet.tar:mcr.microsoft.com/dotnet/aspnet:10.0-alpine \
 && skopeo copy --retry-times 3 docker://docker.io/library/postgres:17-alpine docker-archive:/seed/postgres.tar:postgres:17-alpine

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

ENV LANG=C.UTF-8 PAGER=cat BUILDKIT_PROGRESS=plain DOCKER_CLI_HINTS=false COMPOSE_PROGRESS=plain COMPOSE_ANSI=never
WORKDIR /home/learner
ENTRYPOINT ["dojo-entry"]
CMD ["sleep", "infinity"]
