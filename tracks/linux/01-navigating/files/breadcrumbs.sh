# Boss step 1: a trail of clues across a server tree. Each clue says where to cd next, relative to its own folder.
# Decoy .clue files hold other codes, so grepping for "code" is not enough: you have to follow the trail.
set -e -o pipefail
r=~/prod7
mkdir -p "$r/etc/app" "$r/var/log/nginx" "$r/var/lib/app/state" "$r/opt/tools/bin" "$r/home/ops/.notes" "$r/srv/www/old"
cat > "$r/START.txt" <<'EOF'
Welcome to prod-7. The previous admin left a trail.
Clue 1: cd into var/log/nginx (relative to this file) and read the hidden file there.
EOF
cat > "$r/var/log/nginx/.clue" <<'EOF'
Clue 2: from here, go up two levels, then into lib/app/state, and read .clue
EOF
cat > "$r/var/lib/app/state/.clue" <<'EOF'
Clue 3: the next clue is in ../../../../opt/tools/./bin//.clue (resolve it yourself).
EOF
cat > "$r/opt/tools/bin/.clue" <<'EOF'
Clue 4: last one. It is in the hidden folder of the ops user's home: ~ops means prod7/home/ops here. File: .notes/.clue
EOF
cat > "$r/home/ops/.notes/.clue" <<'EOF'
The code is: BISCUIT-7731
EOF
echo "The code is: DECOY-1001" > "$r/srv/www/old/.clue"
echo "The code is: DECOY-2002" > "$r/etc/app/.clue"
echo "The code is: DECOY-3003" > "$r/var/lib/app/.clue"
