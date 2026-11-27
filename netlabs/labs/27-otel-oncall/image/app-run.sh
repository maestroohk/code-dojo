#!/bin/bash
# Keeps one service running, like a tiny deployment system:
#  - settings: /work/config/$APP_ROLE.env (KEY=VALUE lines). Saving the file restarts the service.
#  - code (shop only): /app/src/Program.cs. Saving it rebuilds; a good build replaces the running version,
#    a failed one leaves the old version running and writes the errors to /work/logs/shop-build.log.
ROLE=${APP_ROLE:-shop}
ENVF=/work/config/$ROLE.env
LOG=/work/logs/$ROLE.log
mkdir -p /work/logs
until [ -f "$ENVF" ]; do sleep 1; done
PID=

start() {
  ( set -a; . <(tr -d '\r' < "$ENVF"); set +a; exec dotnet /app/out/labapp.dll ) >> "$LOG" 2>&1 &
  PID=$!
  echo "$(date +%T) deploy: $ROLE started (pid $PID)" >> "$LOG"
}

build() {
  echo "$(date +%T) build: Program.cs changed, building..." | tee -a "$LOG" > /work/logs/$ROLE-build.log
  rm -rf /app/next
  if dotnet build /app/src/labapp.csproj -c Release -o /app/next --no-restore -nologo -v:q -m:1 -nodeReuse:false \
       -p:UseSharedCompilation=false >> /work/logs/$ROLE-build.log 2>&1; then
    echo "$(date +%T) build: succeeded, deploying the new version" | tee -a /work/logs/$ROLE-build.log >> "$LOG"
    kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
    rm -rf /app/out && mv /app/next /app/out
    start
  else
    echo "$(date +%T) build: FAILED, the previous version keeps running (see /work/logs/$ROLE-build.log)" | tee -a /work/logs/$ROLE-build.log >> "$LOG"
  fi
}

start
env_stamp=$(stat -c %Y "$ENVF")
src_stamp=$(stat -c %Y /app/src/Program.cs)
while true; do
  sleep 2
  e=$(stat -c %Y "$ENVF" 2>/dev/null)
  s=$(stat -c %Y /app/src/Program.cs 2>/dev/null)
  if [ "$ROLE" = shop ] && [ -n "$s" ] && [ "$s" != "$src_stamp" ]; then
    src_stamp=$s
    build
  elif [ "$e" != "$env_stamp" ] || ! kill -0 "$PID" 2>/dev/null; then
    env_stamp=$e
    echo "$(date +%T) deploy: restarting $ROLE (settings changed or it stopped)" >> "$LOG"
    kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
    start
  fi
done
