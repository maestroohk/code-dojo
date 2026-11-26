# Lesson 2: two local commits, and a teammate pushed first.
. "$DOJO_FILES/origin.sh"
cd ~/shop
write src/Coupon.cs "class Coupon {}"
commit "Add coupons"
write src/Coupon.cs "class Coupon { int Percent; }"
commit "Give coupons a percentage"
teammate shop
write docs/api.md "# API"
commit "Document the API" "Priya Shah"
git push -q origin main
note mate "$(git rev-parse HEAD)"