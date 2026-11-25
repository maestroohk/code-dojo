# Mission 11: Gary's treasure trail on a fresh server.
set -e
cat > /root/WELCOME.txt <<'TXT'
Welcome to Byte & Biscuit, new sysadmin!

Your predecessor, Gary, left in a hurry (something about a llama farm).
He did not write documentation. He wrote CLUES.

  - His handbook lives in /opt/biscuit/handbook
  - His home directory is /home/gary (he loved hiding things)
  - The oven controller writes to /var/log/oven.log
  - He swore the spare server-room key file is "somewhere under /srv"

Good luck. Biscuits are in the kitchen.
  -- Brenda, CTO
TXT

# The handbook: a random number of chapters, plus a subfolder that is not a chapter.
mkdir -p /opt/biscuit/handbook/drafts
i=1
while [ "$i" -le "$DOJO_CHAPTERS" ]; do
  printf 'Chapter %s\nRule %s: never let the oven go above 230C.\n' "$i" "$i" > "/opt/biscuit/handbook/chapter-$i.txt"
  i=$((i + 1))
done
echo "half-finished thoughts" > /opt/biscuit/handbook/drafts/maybe-chapter.txt

# Gary's home: the Wi-Fi password is in a dotfile.
useradd -m -s /bin/bash gary
printf 'shopping list:\n- biscuits\n- more biscuits\n' > /home/gary/todo.txt
printf 'Nothing to see here.\n' > /home/gary/README
printf '# Gary'"'"'s secret notes. Do NOT tell Brenda.\nwifi_password = %s\n' "$DOJO_FLAG" > /home/gary/.secret-wifi
chown -R gary:gary /home/gary

# A long oven log: the last line holds the final temperature.
python3 - <<'PY'
import os, random
temp = os.environ["DOJO_TEMP"]
with open("/var/log/oven.log", "w") as f:
    f.write("oven=BigBertha model=Toastmaster-3000 log started\n")
    for i in range(5000):
        f.write(f"tick {i:05d} temperature: {random.randint(150, 230)}C fan=on\n")
    f.write(f"shutdown: final temperature: {temp}C. goodnight.\n")
PY

# The spare key, buried somewhere under /srv among decoys.
for d in /srv/archive/2019/q3/misc /srv/archive/2021/old-stuff /srv/backups/do-not-open /srv/media/cat-videos /srv/projects/biscuit-ai/tmp /srv/www/assets/img; do
  mkdir -p "$d"
  echo "nothing here, keep looking" > "$d/notes.txt"
done
echo "decoy" > /srv/archive/2021/old-stuff/spare-key.bak
echo "decoy" > /srv/media/spare-keyboard.txt
mkdir -p "$DOJO_KEYDIR"
echo "KEY-$(echo "$DOJO_FLAG" | tr -dc 'a-f0-9')" > "$DOJO_KEYDIR/spare-key"
