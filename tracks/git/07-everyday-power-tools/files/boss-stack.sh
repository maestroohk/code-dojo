# Boss: a pushed stack of two pull requests; main moved on and the reviewer wants a change in the bottom one.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
commit "Start the shop" "Marco Rossi"
git switch -q -c stack/1-model
write src/Coupon.cs "class Coupon" "{" "    public int Percent;" "}"
commit "Add the coupon model"
git switch -q -c stack/2-api
write src/CouponApi.cs "class CouponApi {}"
commit "Add the coupon API"
git switch -q main
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop && cd ~/shop
git branch -q -t stack/1-model origin/stack/1-model
git switch -q -t stack/2-api origin/stack/2-api 2>/dev/null || git switch -q stack/2-api
teammate shop
write docs/ci.md "# CI"
commit "Document CI" "Lee Chen"
git push -q origin main
note main "$(git rev-parse main)"