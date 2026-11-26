# Shared start: a shop repo published to a bare origin, and the learner's clone in ~/shop.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
write src/Cart.cs "class Cart {}"
commit "Start the shop"
write src/Order.cs "class Order {}"
commit "Add orders"
git switch -q -c feature/old
write old.txt "an experiment"
commit "Old experiment"
git switch -q main
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop
cd ~/shop && git branch -q -t feature/old origin/feature/old 2>/dev/null || true