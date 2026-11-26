#!/bin/bash
# A check, not a setup script: does this project's Dockerfile keep the slow install cached?
#   check-cache.sh PROJECT SOURCE_FILE DEPS_FILE [IGNORED_FILE]
# Builds a copy of PROJECT, then changes SOURCE_FILE (the install must stay cached, the change must reach the
# image), then DEPS_FILE (the install must run again). With IGNORED_FILE, changing it must not change the image.
# The install writes /deps/stamp, so "cached" is read from the image itself, whatever the Dockerfile looks like.
set -e -o pipefail
src="$1"; work=$(mktemp -d /tmp/check-XXXX); trap 'rm -rf "$work"' EXIT
cp -a "$src/." "$work/"; cd "$work"
tag="dojo-check/cache:$$"
build() { docker build -q -t "$tag" . 2>/tmp/check-build.log || { echo "the image does not build:"; tail -n 15 /tmp/check-build.log; exit 1; }; }
stamp() { docker run --rm --entrypoint cat "$tag" /deps/stamp; }
build >/dev/null; first=$(stamp)
if [ -n "$4" ]; then
  before=$(docker image inspect -f '{{json .RootFS.Layers}}' "$tag")
  mkdir -p "$(dirname "$4")"; echo "noise $(date +%s%N)" >> "$4"
  build >/dev/null
  [ "$(docker image inspect -f '{{json .RootFS.Layers}}' "$tag")" = "$before" ] || { echo "changing $4 changed the image layers: it is part of the build context"; exit 1; }
fi
marker="# changed $(date +%s%N)"; echo "$marker" >> "$2"; build >/dev/null
[ "$(stamp)" = "$first" ] || { echo "changing $2 ran the dependency install again"; exit 1; }
docker run --rm --entrypoint sh "$tag" -c "grep -rqF '$marker' /app" || { echo "the change to $2 is not in the image"; exit 1; }
echo "# changed" >> "$3"; build >/dev/null
[ "$(stamp)" != "$first" ] || { echo "changing $3 did not run the install again"; exit 1; }
docker rmi -f "$tag" >/dev/null 2>&1 || true
echo "cache ok"
