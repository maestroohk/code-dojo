# Lesson 3, step 2: last night's image scans as Trivy JSON reports, and an empty CI gate script.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/ci/reports
report() {  # report FILE then lines of ID|PACKAGE|INSTALLED|FIXED|SEVERITY
  local f="$1"; shift
  printf '%s\n' "$@" | jq -R -s '
    split("\n") | map(select(length > 0) | split("|")) |
    { SchemaVersion: 2, ArtifactName: "registry.example.com/shop/api:1.4", ArtifactType: "container_image",
      Results: [ { Target: "registry.example.com/shop/api:1.4 (alpine 3.24.1)", Class: "os-pkgs", Type: "alpine",
        Vulnerabilities: map({ VulnerabilityID: .[0], PkgName: .[1], InstalledVersion: .[2],
                               FixedVersion: (if .[3] == "" then null else .[3] end), Severity: .[4] }) } ] }' > "$f"
}
report ~/ci/reports/api.json \
  'CVE-2026-1001|openssl|3.5.1-r0|3.5.4-r0|CRITICAL' \
  'CVE-2026-1002|busybox|1.37.0-r18||HIGH' \
  'CVE-2026-1003|zlib|1.3.1-r2|1.3.1-r3|MEDIUM' \
  'CVE-2026-1004|curl|8.14.1-r0|8.14.1-r2|HIGH' \
  'CVE-2026-1005|musl|1.2.5-r9||LOW'
report ~/ci/reports/web.json \
  'CVE-2026-2001|busybox|1.37.0-r18||CRITICAL' \
  'CVE-2026-2002|zlib|1.3.1-r2|1.3.1-r3|MEDIUM'
cat > ~/ci/gate.sh <<'EOF'
#!/bin/sh
# Usage: gate.sh REPORT.json
# TODO: print "ID: upgrade PACKAGE to FIXED" for every HIGH or CRITICAL finding that has a fix, and exit 1 if any.
echo "gate: not implemented"
EOF
chmod +x ~/ci/gate.sh
