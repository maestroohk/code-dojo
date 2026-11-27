#!/bin/sh
# Runs the Collector with /work/collector/config.yaml. When the file changes it is validated first
# (otelcol-contrib validate); a valid config restarts the Collector, an invalid one is reported in
# /work/logs/collector.log and the running Collector keeps its old config, as a careful deploy would.
CFG=/work/collector/config.yaml
LOG=/work/logs/collector.log
mkdir -p /work/logs
until [ -f "$CFG" ]; do sleep 1; done
PID=
start() {
  cp "$CFG" /tmp/running.yaml
  otelcol-contrib --config=/tmp/running.yaml >> "$LOG" 2>&1 &
  PID=$!
  echo "$(date +%T) collector-run: started with the current config (pid $PID)" >> "$LOG"
}
start
stamp=$(stat -c %Y "$CFG")
while true; do
  sleep 2
  s=$(stat -c %Y "$CFG" 2>/dev/null)
  if [ "$s" != "$stamp" ]; then
    stamp=$s
    if otelcol-contrib validate --config="$CFG" > /tmp/validate.txt 2>&1; then
      echo "$(date +%T) collector-run: config changed and is valid, restarting" >> "$LOG"
      kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
      start
    else
      { echo "$(date +%T) collector-run: config changed but is INVALID, keeping the old one:"; cat /tmp/validate.txt; } >> "$LOG"
    fi
  elif ! kill -0 "$PID" 2>/dev/null; then
    echo "$(date +%T) collector-run: the Collector stopped, starting it again" >> "$LOG"
    sleep 2
    start
  fi
done
