# The real OpenTelemetry Collector (contrib distribution) on a small Alpine base, so the node has a shell and
# the learner can run `otelcol-contrib validate` and read its logs there. collector-run keeps it running and
# restarts it when /work/collector/config.yaml changes (the Collector has no hot reload of its own).
FROM otel/opentelemetry-collector-contrib:0.166.0 AS otel
FROM alpine:3.20
COPY --from=otel /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY image/collector-run.sh /usr/local/bin/collector-run
RUN sed -i 's/\r$//' /usr/local/bin/collector-run && chmod +x /usr/local/bin/collector-run \
 && apk add --no-cache curl >/dev/null 2>&1 || true
ENV GOMEMLIMIT=150MiB
ENTRYPOINT ["/usr/local/bin/collector-run"]
