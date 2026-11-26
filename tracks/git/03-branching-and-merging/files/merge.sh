# Lesson 2: one branch that can fast-forward (docs) and one that has diverged (feature/search).
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop"
write src/Cart.cs "class Cart {}"
commit "Start the shop"
write src/Order.cs "class Order {}"
commit "Add orders"
git switch -q -c feature/search
write src/Search.cs "class Search {}"
commit "Add search" "Sam Okafor"
write src/Search.cs "class Search { int Limit = 20; }"
commit "Limit search results" "Sam Okafor"
git switch -q main
note base "$(git rev-parse HEAD)"
write src/Cart.cs "class Cart { decimal Total; }"
commit "Track cart total"
git switch -q -c docs
write docs/setup.md "# Setup" "dotnet run"
commit "Document setup" "Priya Shah"
git switch -q main