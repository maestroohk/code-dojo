# Mission 16: fill the 64 MB /srv/data filesystem.
for f in biscuit-api log-hoarder; do
  tr -d '\r' < "/lab/bin/$f" > "/usr/local/bin/$f"
  chmod 755 "/usr/local/bin/$f"
done
mkdir -p /srv/data/logs /srv/data/tmp/.cache /srv/data/media/videos /srv/data/old/backups/2019 /srv/data/orders
case "$DOJO_TOP" in
  tmp)   big=/srv/data/tmp/.cache/gary-dvd-rip.iso ;;
  media) big=/srv/data/media/videos/llama-documentary-4k.mkv ;;
  *)     big=/srv/data/old/backups/2019/full-backup-DO-NOT-DELETE.tar ;;
esac
head -c 28M /dev/zero > "$big"
echo "order 1: 12 x custard-cream" > /srv/data/orders/today.txt
python3 - <<'PY'
line = "2026-11-2{d} 03:14:15 INFO request served: 1 x jammy-dodger, delivered by drone 7\n"
for n, size in ((1, 3), (2, 3), (3, 3)):
    with open(f"/srv/data/logs/app.log.{n}", "w") as f:
        l = line.format(d=4 - n)
        f.write(l * (size * 1024 * 1024 // len(l)))
with open("/srv/data/logs/app.log", "w") as f:
    l = line.format(d=4)
    f.write(l * (14 * 1024 * 1024 // len(l)))
PY
cd /
setsid nohup /usr/local/bin/log-hoarder >/dev/null 2>&1 &
setsid nohup /usr/local/bin/biscuit-api >/dev/null 2>&1 &
sleep 2
