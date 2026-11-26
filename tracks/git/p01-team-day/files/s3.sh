# Stage 3: the branch before review, with fixup! commits and a wip commit. It is pushed already.
. "$DOJO_FILES/team.sh"
cd ~/shop
git switch -q -c feature/SHOP-142-coupons
write src/Coupon.cs "class Coupon" "{" "    public int Percent;" "}"
commit "Add percentage coupons (SHOP-142)"
write src/CouponField.cs "class CouponField" "{" "    string Label = \"Coupon\";" "" "    // Shown under the basket total." "    int Order = 3;" "}"
commit "Show coupon field at checkout"
write src/Coupon.cs "class Coupon" "{" "    public int Percent; // 1 to 100" "}"
commit "fixup! Add percentage coupons (SHOP-142)"
write src/CouponField.cs "class CouponField" "{" "    string Label = \"Coupon\";" "" "    // Shown under the basket total." "    int Order = 3;" "    bool Valid(string code) => code.Length is > 0 and <= 20;" "}"
commit "wip"
write src/CouponField.cs "class CouponField" "{" "    string Label = \"Coupon code\";" "" "    // Shown under the basket total." "    int Order = 3;" "    bool Valid(string code) => code.Length is > 0 and <= 20;" "}"
commit "fixup! Show coupon field at checkout"
git push -q -u origin feature/SHOP-142-coupons
note tip-tree "$(git rev-parse 'HEAD^{tree}')"