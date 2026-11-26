# Boss: a colleague's hotfix vanished after a reset --hard; work went on afterwards.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write src/Vat.cs "class Vat { decimal Rate = 0.21m; }"
write src/Cart.cs "class Cart {}"
commit "Release 3.2.0"
git switch -q -c hotfix/3.2.1
write src/Cart.cs "class Cart { decimal Total => Math.Round(sum, 2); }"
commit "Hotfix: round cart totals"
note hotfix "$(git rev-parse HEAD)"
write CHANGELOG.md "# 3.2.1" "- round cart totals"
commit "Hotfix: changelog for 3.2.1"
note hotfix-tip "$(git rev-parse HEAD)"
git reset -q --hard HEAD~2
write docs/oncall.md "# On-call notes"
commit "Add on-call notes"
git switch -q main