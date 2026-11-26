# Boss 3: four services with memory limits; two of them live close to theirs. Memory written to /dev/shm counts
# against the container's limit, so each one holds a steady amount.
. "$DOJO_FILES/lib.sh"
hold() {  # hold NAME LIMIT_MB HOLD_MB
  docker run -d --name "$1" --memory "${2}m" --memory-swap "${2}m" --shm-size 256m busybox:1.37 \
    sh -c "dd if=/dev/zero of=/dev/shm/data bs=1M count=$3 2>/dev/null; echo '$1: up'; exec sleep 1d" >/dev/null
}
hold api 64 48
hold worker 64 56
hold cache 128 8
hold web 64 2
for c in api worker cache web; do for i in $(seq 20); do docker logs "$c" 2>/dev/null | grep -q up && break; sleep 0.25; done; done
