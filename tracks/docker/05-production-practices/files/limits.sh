# Lesson 3, step 1: a batch job running with no limits at all, next to a service that needs its share.
. "$DOJO_FILES/lib.sh"
docker run -d --name batch busybox:1.37 sh -c 'echo "batch: crunching invoices"; exec sleep 1d' >/dev/null
docker run -d --name api busybox:1.37 httpd -f -p 80 >/dev/null
note batch-id "$(docker inspect -f '{{.Id}}' batch)"
