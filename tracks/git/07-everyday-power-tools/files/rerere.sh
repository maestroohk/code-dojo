# Lesson 4: the same conflict has to be resolved twice: merging a long-running feature into main and into release.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write src/Limits.cs "class Limits" "{" "    int MaxItems = 50;" "}"
commit "Start the shop"
git branch release/3.2
git switch -q -c feature/bulk
write src/Limits.cs "class Limits" "{" "    int MaxItems = 500; // bulk orders" "}"
commit "Allow bulk orders"
git switch -q main
write src/Limits.cs "class Limits" "{" "    int MaxItems = 100;" "}"
commit "Raise the item limit"
git switch -q release/3.2
write src/Limits.cs "class Limits" "{" "    int MaxItems = 100;" "}"
commit "Raise the item limit (3.2)"
git switch -q main