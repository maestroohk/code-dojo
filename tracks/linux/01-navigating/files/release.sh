# Lesson 1 (and its cold rebuild): a deploy folder with releases and a "current" symlink, like Capistrano-style deploys.
set -e -o pipefail
app=~/srv/app
mkdir -p "$app/releases/2031-03-10/config" "$app/releases/2031-03-12/config" "$app/shared"
echo "v1.4.0" > "$app/releases/2031-03-10/VERSION"
echo "v1.5.0" > "$app/releases/2031-03-12/VERSION"
printf 'port=8080\nlog_dir=../shared/logs\n' > "$app/releases/2031-03-12/config/app.conf"
printf 'port=8080\n' > "$app/releases/2031-03-10/config/app.conf"
printf 'DB_PASSWORD=not-a-real-secret\n' > "$app/releases/2031-03-12/.env"
printf 'built by ci run 4411\n' > "$app/releases/2031-03-12/.deployed-by"
echo "hello" > "$app/releases/2031-03-12/index.html"
ln -sfn releases/2031-03-12 "$app/current"
