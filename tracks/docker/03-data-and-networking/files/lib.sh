# Shared helpers for this module's Docker scenarios (sourced by the other scripts here). They run as root in the
# learner's home against the step's own Docker Engine (Docker-in-Docker: a real dockerd with no network, so images
# come from the pre-seeded alpine:3.24 and busybox:1.37, or are built here from them).
set -e -o pipefail
dojo-docker-up

# Private notes for the checks, outside the learner's home.
note() { mkdir -p /opt/dojo/state; printf '%s\n' "$2" > "/opt/dojo/state/$1"; chmod 644 "/opt/dojo/state/$1"; }

# build TAG : build the Dockerfile given on stdin, quietly, as TAG. The context is /opt/dojo/build/<TAG>, so a
# scenario can put files there first.
build() {
  local dir="/opt/dojo/build/${1//[\/:]/-}"
  mkdir -p "$dir"; cat > "$dir/Dockerfile"
  docker build -q -t "$1" "$dir" >/dev/null
}

# app TAG NAME VERSION [PORT] : a tiny HTTP service on busybox httpd. GET / says "NAME VERSION", GET /health says ok.
app() {
  local dir="/opt/dojo/build/${1//[\/:]/-}"
  mkdir -p "$dir/www"
  echo "$2 $3" > "$dir/www/index.html"; echo ok > "$dir/www/health"
  build "$1" <<DOCKERFILE
FROM busybox:1.37
COPY www/ /www/
EXPOSE ${4:-80}
CMD ["httpd", "-f", "-v", "-p", "${4:-80}", "-h", "/www"]
DOCKERFILE
}

mkdir -p ~/answers
