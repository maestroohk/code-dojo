# Lesson 1: a repo with old branches, some merged into main and some not.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop"
commit "Start the shop"
git switch -q -c feature/cart
write src/Cart.cs "class Cart {}"
commit "Add cart" "Priya Shah"
git switch -q main
git merge -q --ff-only feature/cart
git switch -q -c hotfix/typo
write README.md "# Shop" "A small shop."
commit "Fix README typo"
git switch -q main
git switch -q -c feature/search
write src/Search.cs "class Search {}"
commit "Add search" "Sam Okafor"
git switch -q main
GIT_AUTHOR_DATE="@1735900000 +0000" GIT_COMMITTER_DATE="@1735900000 +0000" git merge -q --no-ff -m "Merge branch 'feature/search'" feature/search
git merge -q --no-ff -m "Merge branch 'hotfix/typo'" hotfix/typo
git switch -q -c feature/coupons
write src/Coupon.cs "class Coupon {}"
commit "Start coupons (not merged)"
git switch -q main
git switch -q -c spike/graphql
write spike.txt "try GraphQL"
commit "Spike: GraphQL (not merged)"
git switch -q main