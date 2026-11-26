# Boss step 2: a build script that leaves its scratch folder behind every time it fails.
set -e -o pipefail
mkdir -p ~/bin ~/data
printf 'mug\nteapot\nmug\nspoon\nmug\nteapot\n' > ~/data/orders.txt
cat > ~/bin/build-report <<'EOF'
#!/bin/bash
# build-report INPUT OUTPUT: counts how often each line of INPUT occurs, biggest first, into OUTPUT.
set -euo pipefail
work=/tmp/build-report.$$
mkdir "$work"
sort "$1" > "$work/sorted"
uniq -c "$work/sorted" | sort -rn > "$work/counted"
cp "$work/counted" "$2"
rm -rf "$work"
EOF
chmod 755 ~/bin/build-report
