# Boss, last step: feature/search was squash-merged into main; feature/filters was built on top of it.
. "$DOJO_FILES/boss.sh"
cd ~/shop
git merge -q --squash feature/search 2>/dev/null || true
git checkout -q --theirs src/Search.cs src/Menu.cs 2>/dev/null || true
write src/Search.cs "class Search" "{" "    int Limit = 20;" "    string Sort = \"relevance\";" "}"
write src/Menu.cs "class Menu" "{" "    string[] Items = { \"Home\", \"Search\", \"Cart\", \"Help\" };" "}"
git add -A
commit "Search: relevance sort and menu entry (#42)" "Sam Okafor"
note squashed "$(git rev-parse HEAD)"
git switch -q feature/filters