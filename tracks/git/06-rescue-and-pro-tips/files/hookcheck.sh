# Check the team's shared pre-commit hook from a fresh clone of the learner's branch, like a teammate would get it.
set -e
cd ~/shop
[ "$(git config core.hooksPath)" = .githooks ] || { echo "core.hooksPath is not set to .githooks in ~/shop"; exit 1; }
git cat-file -e HEAD:.githooks/pre-commit 2>/dev/null || { echo ".githooks/pre-commit is not committed"; exit 1; }
[ "$(git ls-tree HEAD .githooks/pre-commit | cut -c1-6)" = 100755 ] || { echo ".githooks/pre-commit is committed without the executable bit (chmod +x, then git add again)"; exit 1; }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
git clone -q ~/shop "$t/c" && cd "$t/c" && git config core.hooksPath .githooks
echo 'key = "AKIAEXAMPLE7Q2LMN4ZP"' > leak.txt && git add leak.txt
if git commit -q -m "leak" >/dev/null 2>&1; then echo "a commit with an AKIA... key went through: the hook did not stop it"; exit 1; fi
git reset -q && rm leak.txt
echo 'nothing secret' > ok.txt && git add ok.txt
git commit -q -m "harmless" >/dev/null 2>&1 || { echo "a harmless commit was refused: the hook blocks too much"; exit 1; }
echo "the hook blocks the key and lets a normal commit through"
