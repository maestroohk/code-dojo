# The team repo at the start of the day, published to a bare origin; ~/shop is your clone.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop" "Welcom to the checkout service."
write src/Cart.cs "class Cart" "{" "    decimal Total()" "    {" "        var total = Subtotal();" "        return total + 4.99m;" "    }" "}"
commit "Start the checkout service" "Marco Rossi"
git branch release/3.1
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop