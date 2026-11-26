# Boss step 3: rotate-logs with working options (the previous step's result), and logs of different ages.
set -e -o pipefail
mkdir -p ~/bin
cat > ~/bin/rotate-logs <<'EOF'
#!/bin/bash
# rotate-logs [-n] [-k DAYS] DIR
#   -n       dry run: print what would be done, change nothing
#   -k DAYS  compress .log files older than DAYS days (default 7)
set -euo pipefail
usage() { echo "usage: rotate-logs [-n] [-k DAYS] DIR" >&2; exit 2; }
keep=7 dry_run=0
while getopts ":nk:" opt; do
  case $opt in
    n) dry_run=1 ;;
    k) keep=$OPTARG ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || usage
dir=$1
echo "dir=$dir keep=$keep dry_run=$dry_run"

# TODO: in DIR (not below it):
#   1. delete .gz files older than 30 days
#   2. gzip .log files older than $keep days
# With -n, print each command (like "rm ./old.log.gz" or "gzip ./app.log") instead of running it.
EOF
chmod 755 ~/bin/rotate-logs
mk() { echo "$1" > "$1"; touch -d "$2 days ago" "$1"; }
mkdir -p ~/logs/app && cd ~/logs/app
mk a.log 1; mk b.log 3; mk c.log 10; mk d.log 40; mk notes.txt 40
echo e | gzip > e.log.gz; touch -d '10 days ago' e.log.gz
echo f | gzip > f.log.gz; touch -d '40 days ago' f.log.gz
# A pristine copy for the checks, so the learner's own test runs never change what is graded.
mkdir -p /opt/dojo/state/applogs && cp -a ~/logs/app/. /opt/dojo/state/applogs/
chmod -R a+rX /opt/dojo/state
