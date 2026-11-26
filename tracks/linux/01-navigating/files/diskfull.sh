# Boss step 3: a /var-like tree where one folder holds the bytes and another holds thousands of tiny files.
set -e -o pipefail
v=~/var
mkdir -p "$v/log/app" "$v/cache/sessions" "$v/lib/db" "$v/tmp" "$v/spool/mail"
head -c $((24 * 1024 * 1024)) /dev/zero > "$v/log/app/app.log.1"
head -c $((3 * 1024 * 1024)) /dev/zero > "$v/log/app/app.log"
head -c $((9 * 1024 * 1024)) /dev/zero > "$v/lib/db/data.db"
head -c $((1024 * 1024)) /dev/zero > "$v/tmp/upload.part"
echo "mail" > "$v/spool/mail/root"
# 4000 tiny session files: little space, many inodes. Half are stale.
cd "$v/cache/sessions"
for i in $(seq 1 2000); do echo s > "sess_old_$i"; done
touch -d '20 days ago' sess_old_*
for i in $(seq 1 2000); do echo s > "sess_new_$i"; done
touch -d '1 day ago' sess_new_*
