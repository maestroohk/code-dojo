# Entry point of the gateway container: wait for the shared project folder, then start Kong
# in DB-less mode. The whole configuration is the file /work/kong/kong.yml.
until [ -f /work/.seeded ]; do sleep 0.3; done
exec /docker-entrypoint.sh kong docker-start