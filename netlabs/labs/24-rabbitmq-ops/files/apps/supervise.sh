#!/bin/bash
# Keeps the shop's services running. Each worker reads /work/apps/<name>.env; saving that file restarts
# the worker within two seconds, so a settings change takes effect like a redeploy would.
declare -A PIDS STAMP
start() {   # name
  local name=$1 count
  count=$(grep -E '^INSTANCES=' /work/apps/$name.env | cut -d= -f2); count=${count:-1}
  PIDS[$name]=""
  for i in $(seq 1 $count); do
    python3 /lab/apps/worker.py $name $i >> /work/logs/$name.log 2>&1 &
    PIDS[$name]="${PIDS[$name]} $!"
    sleep 1
  done
  STAMP[$name]=$(stat -c %Y /work/apps/$name.env)
}
python3 /lab/apps/shop.py >> /work/logs/shop.log 2>&1 &
for n in billing payments email; do start $n; done
while true; do
  sleep 2
  for n in billing payments email; do
    s=$(stat -c %Y /work/apps/$n.env 2>/dev/null)
    alive=1; for p in ${PIDS[$n]}; do kill -0 $p 2>/dev/null || alive=0; done
    if [ "$s" != "${STAMP[$n]}" ] || [ $alive = 0 ]; then
      echo "$(date +%T) supervisor: restarting $n (settings changed or it stopped)" >> /work/logs/$n.log
      kill ${PIDS[$n]} 2>/dev/null; sleep 1
      start $n
    fi
  done
done
