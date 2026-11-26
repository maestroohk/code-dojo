# Lesson 3: a stack of three branches (a -> b -> c), each a pull request; main moved on.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop"
commit "Start the shop"
git switch -q -c stack/1-model
write src/Coupon.cs "class Coupon {}"
commit "Add the coupon model"
git switch -q -c stack/2-api
write src/CouponApi.cs "class CouponApi {}"
commit "Add the coupon API"
git switch -q -c stack/3-ui
write src/CouponField.cs "class CouponField {}"
commit "Add the coupon field"
write src/CouponField.cs "class CouponField { string Label = \"Coupon\"; }"
commit "Label the coupon field"
git switch -q main
write docs/ci.md "# CI"
commit "Document CI"
write .editorconfig "root = true"
commit "Add editorconfig"
note main "$(git rev-parse main)"
git switch -q stack/3-ui