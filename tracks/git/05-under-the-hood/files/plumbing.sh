# Lesson 2: a small repo to build a commit in by hand, with plumbing commands only.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/lab
write README.md "# Lab"
commit "Start the lab"
note main "$(git rev-parse HEAD)"