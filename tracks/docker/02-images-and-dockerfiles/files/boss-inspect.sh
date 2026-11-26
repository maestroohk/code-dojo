# Boss 1: a vendor's image with no Dockerfile in sight. Everything to know is in its config and history.
. "$DOJO_FILES/lib.sh"
d=/opt/dojo/build/vendor-reporting-3.2; mkdir -p "$d"
printf '%s\n' '#!/bin/sh' 'echo "reporting 3.2 on :${PORT}"' 'exec httpd -f -p "$PORT" -h /srv' > "$d/run.sh"
build vendor/reporting:3.2 <<'EOF'
FROM busybox:1.37
RUN echo "machine registry.example.com login ci password hunter2-example" > /root/.netrc \
 && echo "fetched the report templates" > /srv.log \
 && rm /root/.netrc
RUN adduser -D -u 4100 reports && mkdir -p /srv && echo reports > /srv/index.html
COPY run.sh /usr/local/bin/run-reporting
ENV PORT=9100 LOG_LEVEL=warn
EXPOSE 9100
USER reports
ENTRYPOINT ["sh", "/usr/local/bin/run-reporting"]
CMD ["--daily"]
EOF
