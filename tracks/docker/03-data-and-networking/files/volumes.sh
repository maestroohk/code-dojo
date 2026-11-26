# Lesson 1: a "database" container that keeps its orders in its own writable layer: one docker rm away from loss.
. "$DOJO_FILES/lib.sh"
docker run -d --name db busybox:1.37 sh -c \
  'mkdir -p /data && printf "%s\n" "order 1001: 2 mugs" "order 1002: 1 shirt" "order 1003: 4 stickers" > /data/orders.txt && exec sleep 1d' >/dev/null
for i in $(seq 20); do docker exec db test -s /data/orders.txt 2>/dev/null && break; sleep 0.25; done
mkdir -p ~/config
echo "retention_days=30" > ~/config/shop.conf
