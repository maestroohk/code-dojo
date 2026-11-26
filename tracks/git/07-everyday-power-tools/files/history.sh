# Lesson 1: a busy team repo with several branches on the server, including a teammate's branch to review.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
write src/Cart.cs "class Cart" "{" "    decimal Total() => 0m;" "}"
commit "Start the shop" "Marco Rossi"
write src/Order.cs "class Order {}"
commit "Add orders" "Marco Rossi"
git switch -q -c priya/free-shipping
write src/Shipping.cs "class Shipping" "{" "    decimal Cost(decimal total) => total >= 50 ? 0 : 4.99m;" "}"
commit "Free shipping over 50" "Priya Shah"
write src/Shipping.cs "class Shipping" "{" "    // Threshold agreed with sales, see SHOP-120." "    decimal Cost(decimal total) => total >= 50 ? 0 : 4.99m;" "}"
commit "Explain the shipping threshold" "Priya Shah"
git switch -q main
write src/Cart.cs "class Cart" "{" "    decimal Total() => Math.Round(Subtotal(), 2);" "}"
commit "Round the cart total" "Sam Okafor"
note round "$(git rev-parse HEAD)"
git switch -q -c release/3.1
write CHANGELOG.md "# 3.1"
commit "Start the 3.1 changelog" "Marco Rossi"
git switch -q main
write docs/api.md "# API" "GET /orders"
commit "Document the orders API" "Lee Chen"
git tag -a v3.2.0 -m "Release 3.2.0"
write src/Cart.cs "class Cart" "{" "    // Totals are rounded half away from zero (finance rule F-7)." "    decimal Total() => Math.Round(Subtotal(), 2, MidpointRounding.AwayFromZero);" "}"
commit "Round half away from zero" "Sam Okafor"
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop