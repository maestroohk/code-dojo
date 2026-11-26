# Lesson 4: a repo for a shared pre-commit hook, and a feature in progress when a hotfix comes in.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop"
write src/Vat.cs "class Vat { decimal Rate = 0.12m; }"
commit "Start the shop"
git switch -q -c feature/wishlist
write src/Wishlist.cs "class Wishlist {}"
commit "Start the wishlist"
write src/Wishlist.cs "class Wishlist { int Max; } // half done"