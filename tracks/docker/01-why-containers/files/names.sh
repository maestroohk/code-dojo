# Lesson 1: the Engine holds alpine:3.24 and busybox:1.37, plus an old tag nobody uses any more.
. "$DOJO_FILES/lib.sh"
docker tag busybox:1.37 shop/old:latest
