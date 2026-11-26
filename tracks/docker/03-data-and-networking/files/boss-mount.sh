# Boss 1: a site folder to serve read-only, with scratch space that never touches the disk.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/site
printf '%s\n' '<h1>Shop status</h1>' '<p>All systems normal.</p>' > ~/site/index.html
