# Boss step 2: log files of different sizes and ages under ~/srv, for find -size / -mtime / -name.
set -e -o pipefail
mk() {   # mk PATH KB DAYS_AGO
  mkdir -p "$(dirname "$1")"
  head -c "$(($2 * 1024))" /dev/zero | tr '\0' 'x' > "$1"
  touch -d "$3 days ago" "$1"
}
s=~/srv
mk "$s/api/logs/api.log" 2600 1
mk "$s/api/logs/api.log.1" 3100 9
mk "$s/api/logs/api.log.2" 1800 16
mk "$s/api/logs/requests.log" 4000 12
mk "$s/web/logs/access.log" 1500 20
mk "$s/web/logs/error.log" 40 30
mk "$s/web/logs/old/access-2030.log" 2200 300
mk "$s/web/static/huge-video.mp4" 5000 60
mk "$s/batch/out/report.csv" 1300 40
mk "$s/batch/logs/batch.log" 900 45
mk "$s/batch/logs/nightly.LOG" 1700 20
mk "$s/batch/logs/debug.log" 1100 3
