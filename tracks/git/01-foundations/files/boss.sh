# Boss: the first week. Build output, a committed local settings file, and a fix and a feature mixed in Cart.cs.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write .gitignore "bin/" "obj/"
write appsettings.json "{ \"Shop\": { \"Currency\": \"EUR\" } }"
write src/Cart.cs \
  "class Cart" "{" \
  "    public decimal Total(decimal sum)" "    {" "        return sum;" "    }" \
  "" "    // line 9" "    // line 10" "    // line 11" "    // line 12" "    // line 13" "" \
  "    public decimal Discount(decimal sum)" "    {" "        return 0m;" "    }" "}"
commit "Start the shop"
# Someone committed their local settings with a password last month.
write appsettings.Local.json "{ \"Db\": { \"Password\": \"local-only-secret\" } }"
commit "Add local settings"
# Now: the fix (rounding, first hunk) and the feature (coupon discount, second hunk), plus a new file.
write src/Cart.cs \
  "class Cart" "{" \
  "    public decimal Total(decimal sum)" "    {" "        return Math.Round(sum, 2, MidpointRounding.AwayFromZero);" "    }" \
  "" "    // line 9" "    // line 10" "    // line 11" "    // line 12" "    // line 13" "" \
  "    public decimal Discount(decimal sum)" "    {" "        return coupon is null ? 0m : sum * coupon.Percent / 100m;" "    }" "}"
write src/Coupon.cs "class Coupon" "{" "    public int Percent;" "}"
write src/bin/Shop.dll "binary"
