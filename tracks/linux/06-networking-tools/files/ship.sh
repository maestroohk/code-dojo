# Boss step 2: a built site to ship to a "server" (a folder, since this machine has no network).
set -e -o pipefail
mkdir -p ~/site/css ~/site/img ~/site/.cache ~/remote/srv/www ~/out
echo '<h1>Shop</h1>' > ~/site/index.html
echo '<h1>About</h1>' > ~/site/about.html
echo 'body { margin: 0 }' > ~/site/css/site.css
head -c 20000 /dev/urandom > ~/site/img/logo.png
head -c 50000 /dev/urandom > ~/site/.cache/build-cache.bin
echo 'old page' > ~/remote/srv/www/old.html
