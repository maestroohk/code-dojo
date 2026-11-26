# Lesson 1: a shop repo with edits in several files, nothing staged yet.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop" "A tiny web shop."
write src/Cart.cs "class Cart" "{" "    decimal Total() => 0m;" "}"
write src/Order.cs "class Order" "{" "    int Id;" "}"
commit "Start the shop"
write README.md "# Shop" "A tiny web shop." "Run it with dotnet run."
write src/Cart.cs "class Cart" "{" "    decimal Total() => Math.Round(0m, 2);" "}"
write src/Order.cs "class Order" "{" "    int Id;" "    string Customer = \"\";" "}"
write src/Coupon.cs "class Coupon" "{" "    int Percent;" "}"
write notes.txt "ask about VAT"
