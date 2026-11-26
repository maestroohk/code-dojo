# Lesson 3: three snapshots that share file contents.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/dedup
write README "hi"
write App.cs "v1"
commit "commit 1"
write App.cs "v2"
commit "commit 2"
write App.cs "v1"
write docs/README "hi"
commit "commit 3"