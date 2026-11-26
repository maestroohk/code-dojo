# Boss step 2: you have a commit to push; a teammate pushed a change to the same line first.
. "$DOJO_FILES/boss.sh"
cd ~/shop
write src/Vat.cs "class Vat { decimal Rate = 0.21m; }"
commit "fix: use the 21% VAT rate"
teammate shop
write src/Vat.cs "class Vat { decimal Rate = 0.20m; }"
commit "fix: use the reduced VAT rate" "Sam Okafor"
write docs/vat.md "# VAT"
commit "docs: VAT rules" "Sam Okafor"
git push -q origin main
note mate "$(git rev-parse HEAD)"