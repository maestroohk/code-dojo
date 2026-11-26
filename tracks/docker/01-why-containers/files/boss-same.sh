# Boss 3: one image under several names, a different one that looks similar, and leftovers from builds.
. "$DOJO_FILES/lib.sh"
app shop/api:1.4 api 1.4
docker tag shop/api:1.4 shop/api:latest
docker tag shop/api:1.4 registry.example.com/shop/api:1.4
app shop/api:1.5 api 1.5
docker tag shop/api:1.5 shop/api:stable
app shop/api:dev api dev
# Someone tried a few builds without -t: each one left an untagged (dangling) image behind.
for n in 1 2 3; do
  d=/opt/dojo/build/try-$n; mkdir -p "$d"; echo "experiment $n" > "$d/index.html"
  printf '%s\n' 'FROM busybox:1.37' 'COPY index.html /www/' > "$d/Dockerfile"
  docker build -q "$d" >/dev/null
done
