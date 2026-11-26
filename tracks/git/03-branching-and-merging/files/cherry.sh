# Lesson 5: a VAT fix on main that the release branch needs, between feature commits that it must not get.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write src/Vat.cs "static class Vat" "{" "    public static decimal Of(decimal net) => net * 0.21m;" "}"
commit "Start the shop"
git branch release/2.4
write src/Wishlist.cs "class Wishlist {}"
commit "Add wishlist" "Priya Shah"
write src/Vat.cs "static class Vat" "{" "    public static decimal Of(decimal net) => Math.Round(net * 0.21m, 2, MidpointRounding.AwayFromZero);" "}"
commit "Fix VAT rounding" "Sam Okafor"
note fix "$(git rev-parse HEAD)"
write src/Wishlist.cs "class Wishlist { int Max = 50; }"
commit "Limit wishlist size" "Priya Shah"