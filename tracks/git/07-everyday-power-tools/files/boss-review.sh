# Boss: Priya's pull request branch, reviewed yesterday at v1, was force-pushed as v2 overnight.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
write src/Search.cs "class Search" "{" "    int Limit = 20;" "}"
commit "Start the shop" "Marco Rossi"
git switch -q -c priya/search-sort
write src/Search.cs "class Search" "{" "    int Limit = 20;" "    string Sort = \"name\";" "}"
commit "Sort search results" "Priya Shah"
write src/SearchApi.cs "class SearchApi { /* GET /search?q= */ }"
commit "Expose search over HTTP" "Priya Shah"
git switch -q main
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop
teammate shop
git switch -q priya/search-sort
git reset -q --hard main
write src/Search.cs "class Search" "{" "    int Limit = 20;" "    string Sort = \"relevance\";" "}"
commit "Sort search results" "Priya Shah"
write src/SearchApi.cs "class SearchApi { /* GET /search?q= */ }"
commit "Expose search over HTTP" "Priya Shah"
git push -q --force origin priya/search-sort
note v2 "$(git rev-parse HEAD)"