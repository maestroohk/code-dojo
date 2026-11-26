# Boss step 1: the skeleton of rotate-logs, waiting for its option parsing.
set -e -o pipefail
mkdir -p ~/bin
cat > ~/bin/rotate-logs <<'EOF'
#!/bin/bash
# rotate-logs [-n] [-k DAYS] DIR
#   -n       dry run: print what would be done, change nothing
#   -k DAYS  compress .log files older than DAYS days (default 7)
set -euo pipefail

# TODO: parse -n and -k DAYS with getopts, take DIR as the one positional argument,
#       and print the settings exactly like this:  dir=/var/log/app keep=7 dry_run=0
#       Anything wrong (unknown option, -k without a value, no DIR): a usage line on stderr, exit 2.
echo "dir=? keep=? dry_run=?"
EOF
chmod 755 ~/bin/rotate-logs
