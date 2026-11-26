# Lesson 2 (and its cold rebuild): a report tool whose Dockerfile uses shell-form CMD, so arguments replace it all.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/report
cat > ~/report/report.sh <<'EOF'
#!/bin/sh
echo "report for: ${1:?which team?}"
EOF
cat > ~/report/Dockerfile <<'EOF'
FROM alpine:3.24
WORKDIR /app
COPY report.sh .
CMD sh report.sh everyone
EOF
docker build -q -t shop/report:0.9 ~/report >/dev/null
