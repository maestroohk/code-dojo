# Lesson 3: a merge history, plus an experiment branch deleted with -D (its commit is now unreachable).
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop"
commit "A: start"
write a.txt a
commit "B: cart"
git switch -q -c side
write side.txt d
commit "D: side work"
write side.txt e
commit "E: more side work"
git switch -q main
write c.txt c
commit "C: orders"
GIT_AUTHOR_DATE="@1736000000 +0000" GIT_COMMITTER_DATE="@1736000000 +0000" git merge -q --no-ff -m "M: merge side" side
git branch -q -d side
git switch -q -c experiment
write exp.txt "a promising idea"
commit "X: promising experiment"
note lost "$(git rev-parse HEAD)"
git switch -q main
git branch -q -D experiment
# The reflog would still find it; make it truly unreachable, as on a fresh clone or after the reflog expired.
git reflog expire --expire=now --all