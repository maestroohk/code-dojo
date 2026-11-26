# Stage 1: your clone is a day old; overnight a teammate pushed to main. You already started editing.
. "$DOJO_FILES/team.sh"
teammate shop
write docs/checkout.md "# Checkout" "How a basket becomes an order."
commit "Document the checkout flow" "Priya Shah"
git push -q origin main
note main "$(git rev-parse main)"
cd ~/shop
write src/Coupon.cs "class Coupon" "{" "    public int Percent;" "}"
write src/Cart.cs "class Cart" "{" "    Coupon? coupon;" "    decimal Total()" "    {" "        var total = Subtotal();" "        return total + 4.99m;" "    }" "}"
write README.md "# Shop" "Welcome to the checkout service."