# Lesson 2: a shared branch that a teammate rewrote (squashed) and force-pushed. You had one commit on top.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
commit "Start the shop" "Marco Rossi"
git switch -q -c feature/checkout
write src/Checkout.cs "class Checkout {}"
commit "Add checkout" "Priya Shah"
write src/Checkout.cs "class Checkout { void Pay() {} }"
commit "wip pay" "Priya Shah"
write src/Checkout.cs "class Checkout { void Pay() {} void Confirm() {} }"
commit "Add confirm step" "Priya Shah"
git switch -q main
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop && cd ~/shop
git switch -q feature/checkout
write src/Receipt.cs "class Receipt {}"
commit "Add receipts"
note mine "$(git rev-parse HEAD)"
# Priya squashes her three commits into one and force-pushes.
teammate shop
git switch -q feature/checkout
git reset -q --soft main
commit "Add checkout with pay and confirm steps" "Priya Shah"
git push -q --force origin feature/checkout
note new "$(git rev-parse HEAD)"
cd ~/shop