# Lesson 2 (and its cold rebuild): a monitoring script whose pipeline hides a failure.
set -e -o pipefail
mkdir -p ~/jobs ~/logs
printf 'INFO start\nERROR db timeout\nINFO retry\nERROR db timeout\nERROR payment declined\nINFO done\n' > ~/logs/app.log
printf 'INFO start\nINFO done\n' > ~/logs/quiet.log
cat > ~/jobs/count-errors.sh <<'EOF'
#!/bin/bash
# Usage: count-errors.sh LOGFILE
# Writes the number of ERROR lines to ~/errors.txt, then prints "done".
# The alerting job trusts this number, so a missing log must make the script FAIL, not report 0.
log=$1
grep ERROR $log | wc -l > ~/errors.txt
echo "done"
EOF
chmod 755 ~/jobs/count-errors.sh
