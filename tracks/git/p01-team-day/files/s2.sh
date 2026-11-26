# Stage 2: your branch has two commits and is pushed; Priya's free shipping landed on main, on the same lines.
. "$DOJO_FILES/team.sh"
cd ~/shop
git switch -q -c feature/SHOP-142-coupons
write src/Coupon.cs "class Coupon" "{" "    public int Percent;" "}"
commit "Add percentage coupons (SHOP-142)"
write src/Cart.cs "class Cart" "{" "    decimal Total()" "    {" "        var total = Subtotal();" "        total -= total * coupon.Percent / 100;" "        return total + 4.99m;" "    }" "}"
commit "Apply percentage coupon"
git push -q -u origin feature/SHOP-142-coupons
teammate shop
write src/Cart.cs "class Cart" "{" "    decimal Total()" "    {" "        var total = Subtotal();" "        var shipping = total >= 50 ? 0 : 4.99m;" "        return total + shipping;" "    }" "}"
commit "Free shipping over 50" "Priya Shah"
git push -q origin main
note main "$(git rev-parse main)"