# Boss 2: a multi-stage Dockerfile that a teammate "tidied up" and broke.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/tool/src
printf '%s\n' '#!/bin/sh' 'echo "tool $(cat /opt/tool/VERSION) ok"' > ~/tool/src/tool.sh
echo 1.0 > ~/tool/src/VERSION
cat > ~/tool/Dockerfile <<'EOF'
# Stage 1: assemble the tool
FROM alpine:3.24 AS build
WORKDIR /src
COPY src/ .
RUN mkdir -p /out && cp tool.sh VERSION /out/ && chmod +x /out/tool.sh

# Stage 2: run the checks
FROM build AS build
RUN sh /out/tool.sh >/dev/null

# Stage 3: the small final image
FROM busybox:1.37
COPY --from=builder /out/ /opt/tool/
CMD ["/opt/tool/tool.sh"]
EOF
