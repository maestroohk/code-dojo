# The image for Kubernetes "terminal" lesson steps (server/TermSteps.cs, netlabs/images/k8s/dojo-step.json):
# a real single-node Kubernetes (k3s, the CNCF-certified distribution) that runs inside the step's own container,
# with the real kubectl. The container is privileged (the kubelet needs it) but has no network: the node gets a
# dummy interface for its address, and the images the lessons run are pre-seeded below (k3s imports them at start).
# The cluster starts on demand: a scenario script that needs it runs `dojo-cluster up` (about 15-25 s); steps that
# only author YAML can use kubectl's client-side commands without it. Built on first use, once.

ARG K3S=v1.37.2-k3s1

# 1. The images pods run, fetched once at build time as image tarballs: the pod sandbox and CoreDNS that k3s
#    itself needs, busybox for scripted containers, traefik/whoami as a small HTTP app, and the local-path
#    provisioner (with its helper image) so PersistentVolumeClaims and StatefulSets get real volumes.
FROM quay.io/skopeo/stable:v1.20 AS seed
RUN mkdir -p /seed \
 && skopeo copy --retry-times 3 docker://docker.io/rancher/mirrored-pause:3.10.2 docker-archive:/seed/pause.tar:docker.io/rancher/mirrored-pause:3.10.2 \
 && skopeo copy --retry-times 3 docker://docker.io/rancher/mirrored-coredns-coredns:1.14.7 docker-archive:/seed/coredns.tar:docker.io/rancher/mirrored-coredns-coredns:1.14.7 \
 && skopeo copy --retry-times 3 docker://docker.io/library/busybox:1.37 docker-archive:/seed/busybox.tar:docker.io/library/busybox:1.37 \
 && skopeo copy --retry-times 3 docker://docker.io/traefik/whoami:v1.11 docker-archive:/seed/whoami.tar:docker.io/traefik/whoami:v1.11 \
 && skopeo copy --retry-times 3 docker://docker.io/rancher/local-path-provisioner:v0.0.37 docker-archive:/seed/local-path.tar:docker.io/rancher/local-path-provisioner:v0.0.37 \
 && skopeo copy --retry-times 3 docker://docker.io/rancher/mirrored-library-busybox:1.37.0 docker-archive:/seed/lp-busybox.tar:docker.io/rancher/mirrored-library-busybox:1.37.0

FROM rancher/k3s:${K3S} AS k3s
FROM docker:29-dind AS dind

# 2. The learner's machine.
FROM alpine:3.24
ARG K3S
RUN apk add --no-cache bash bash-completion sudo coreutils grep sed findutils procps util-linux util-linux-misc \
      iproute2 iptables ip6tables less vim nano git curl jq yq tree file ncurses tzdata ca-certificates \
 && adduser -D -s /bin/bash learner && addgroup learner wheel \
 && echo 'learner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/learner && chmod 440 /etc/sudoers.d/learner \
 && mkdir -p /opt/dojo/files /opt/dojo/seed /var/lib/rancher/k3s/agent/images /etc/rancher/k3s

COPY --from=k3s /bin/ /opt/k3s/bin/
# The official Docker-in-Docker helper: it prepares cgroups (v2 nesting) and mounts for a nested container runtime.
COPY --from=dind /usr/local/bin/dind /usr/local/bin/dind
COPY --from=seed /seed/ /opt/dojo/seed/
ADD https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml /opt/dojo/gateway-api-v1.7.0.yaml
RUN for t in k3s kubectl crictl ctr; do ln -s /opt/k3s/bin/k3s /usr/local/bin/$t; done \
 && chmod 644 /opt/dojo/gateway-api-v1.7.0.yaml \
 && echo "$K3S" > /opt/dojo/k3s-version
COPY dojo-bashrc dojo-cluster dojo-entry /usr/local/lib/dojo/
RUN sed -i 's/\r$//' /usr/local/lib/dojo/* \
 && install -m 755 /usr/local/lib/dojo/dojo-cluster /usr/local/bin/dojo-cluster \
 && install -m 755 /usr/local/lib/dojo/dojo-entry /usr/local/bin/dojo-entry \
 && for home in /root /home/learner; do echo '. /usr/local/lib/dojo/dojo-bashrc' >> $home/.bashrc; done \
 && echo 'alias k=kubectl' >> /usr/local/lib/dojo/dojo-bashrc \
 && echo '[ -f ~/.bashrc ] && . ~/.bashrc' > /home/learner/.bash_profile && chown learner:learner /home/learner/.bash*

# Containerd's snapshots and the kubelet's pod folders must not sit on the container's own overlay filesystem.
VOLUME /var/lib/rancher/k3s /var/lib/kubelet /var/lib/cni /var/log
ENV PATH=/var/lib/rancher/k3s/data/cni:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/k3s/bin:/opt/k3s/bin/aux \
    LANG=C.UTF-8 PAGER=cat KUBECONFIG=/etc/rancher/k3s/k3s.yaml KUBE_EDITOR=false
WORKDIR /home/learner
ENTRYPOINT ["dojo-entry"]
CMD ["sleep", "infinity"]
