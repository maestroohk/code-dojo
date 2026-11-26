# Lesson 2: one container created but never started, one that already ran and exited.
. "$DOJO_FILES/lib.sh"
docker create --name web busybox:1.37 httpd -f -p 80 >/dev/null
note web-id "$(docker inspect -f '{{.Id}}' web)"
docker run --name old busybox:1.37 echo "nightly export done" >/dev/null
