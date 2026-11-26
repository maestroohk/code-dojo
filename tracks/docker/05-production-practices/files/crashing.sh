# Lesson 4 (and its cold rebuild): four containers that stopped, each for a different reason.
. "$DOJO_FILES/lib.sh"
# Out of memory: the cache grows past its 24 MB limit.
docker run -d --name cache --memory 24m --memory-swap 24m busybox:1.37 sh -c 'echo "cache: loading"; tail /dev/zero' >/dev/null
# Finished: started with httpd without -f, which daemonizes, so the main process returns and the container exits 0.
app shop/web:1.0 web 1.0
docker run -d --name web shop/web:1.0 httpd -p 80 -h /www >/dev/null
# A typo in the command.
docker run -d --name worker busybox:1.37 sh -c 'echo "worker: starting"; rabbit-consumer --queue orders' >/dev/null
# The app itself gives up.
docker run -d --name api busybox:1.37 sh -c 'echo "api: reading /etc/api/config.json"; echo "api: FATAL config file not found" >&2; exit 1' >/dev/null
docker wait cache web worker api >/dev/null
