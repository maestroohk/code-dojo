# Lesson 4: a feature branch with review fixes recorded as fixup! commits.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop"
commit "Start the shop"
git switch -q -c feature/coupons
write src/Coupon.cs "class Coupon" "{" "    public int Percent;" "}"
commit "Add coupon model"
write src/CouponApi.cs "class CouponApi" "{" "    // POST /coupons" "}"
commit "Add coupon endpoint"
write src/Coupon.cs "class Coupon" "{" "    public int Percent; // 1 to 100" "}"
commit "fixup! Add coupon model"
write src/CouponApi.cs "class CouponApi" "{" "    // POST /coupons, returns 201 Created" "}"
commit "fixup! Add coupon endpoint"
write src/Coupon.cs "class Coupon" "{" "    public int Percent; // 1 to 100" "    public string Code = \"\";" "}"
commit "fixup! Add coupon model"
note tip-tree "$(git rev-parse 'HEAD^{tree}')"
note main "$(git rev-parse main)"