# Boss: integration day. feature/search (wip commits, conflicts with main) and feature/filters stacked on it.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write src/Search.cs "class Search" "{" "    int Limit = 10;" "    string Sort = \"name\";" "}"
write src/Menu.cs "class Menu" "{" "    string[] Items = { \"Home\", \"Cart\" };" "}"
write README.md "# Shop"
commit "Start the shop"
git switch -q -c feature/search
write src/Search.cs "class Search" "{" "    int Limit = 25;" "    string Sort = \"name\";" "}"
commit "Raise the search limit" "Sam Okafor"
write src/Menu.cs "class Menu" "{" "    string[] Items = { \"Home\", \"Search\", \"Cart\" };" "}"
commit "Add search to the menu" "Sam Okafor"
write src/Search.cs "class Search" "{" "    int Limit = 25;" "    string Sort = \"relevance\";" "}"
commit "Sort search by relevance" "Sam Okafor"
note search-tip "$(git rev-parse HEAD)"
git switch -q -c feature/filters
write src/Filters.cs "class Filters" "{" "    string[] By = { \"price\" };" "}"
commit "Add price filter" "Priya Shah"
write src/Filters.cs "class Filters" "{" "    string[] By = { \"price\", \"brand\" };" "}"
commit "Add brand filter" "Priya Shah"
git switch -q main
write src/Search.cs "class Search" "{" "    int Limit = 20;" "    string Sort = \"name\";" "}"
commit "Lower the search limit for mobile"
write src/Menu.cs "class Menu" "{" "    string[] Items = { \"Home\", \"Cart\", \"Help\" };" "}"
commit "Add help to the menu"
write README.md "# Shop" "Run with dotnet run."
commit "Explain how to run"
note main-start "$(git rev-parse HEAD)"