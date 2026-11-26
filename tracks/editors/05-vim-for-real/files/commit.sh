# Lesson 4: a staged change and a commit message draft with a typo and Git's comment lines.
. "$DOJO_FILES/lib.sh"
rm -rf ~/repo && mkdir -p ~/repo && cd ~/repo
git init -q -b main
printf 'def total(lines):\n    return sum(round(l, 2) for l in lines)\n' > invoice.py
git add -A
GIT_AUTHOR_DATE='@1764100000 +0000' GIT_COMMITTER_DATE='@1764100000 +0000' git commit -q -m "Add invoice totals"
printf 'def total(lines):\n    return round(sum(lines), 2)\n' > invoice.py
git add invoice.py
cat > ~/COMMIT_DRAFT <<'EOF'
Fxi rounding in invoice totals

Totals were rounded per line, so a 3-line invoice could be off by
a cent. Round once, on the sum.

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
EOF
