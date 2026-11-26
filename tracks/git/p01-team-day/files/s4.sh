# Stage 4: main has fixes marked [backport]; one was backported last week. release/3.1 also moved on the server.
. "$DOJO_FILES/team.sh"
cd ~/shop
write src/Vat.cs "class Vat { decimal Of(decimal n) => n * 0.21m * 2; }"
write src/Refund.cs "class Refund { decimal Amount; }"
commit "Prepare 3.2 work" "Marco Rossi"
git push -q origin main
teammate shop
git switch -q release/3.1
write src/Vat.cs "class Vat { decimal Of(decimal n) => n * 0.21m * 2; }"
write src/Refund.cs "class Refund { decimal Amount; }"
commit "Prepare 3.1 maintenance" "Marco Rossi"
git push -q origin release/3.1
git switch -q main
write src/Refund.cs "class Refund { decimal Amount => Math.Round(raw, 2); }"
commit "fix: round refunds to cents [backport]" "Marco Rossi"
refund=$(git rev-parse HEAD)
write src/Gift.cs "class Gift {}"
commit "feat: gift cards" "Priya Shah"
write src/Vat.cs "class Vat { decimal Of(decimal n) => n * 0.21m; }"
commit "fix: apply VAT once [backport]" "Marco Rossi"
note f1x "$(git rev-parse HEAD)"
write src/Admin.cs "class Admin { string Title = \"Admin\"; }"
commit "fix: typo on the admin page" "Lee Chen"
write src/Basket.cs "class Basket { bool Empty => Items.Count == 0; }"
commit "fix: guard against an empty basket [backport]" "Priya Shah"
note empty "$(git rev-parse HEAD)"
git push -q origin main
git switch -q release/3.1
git cherry-pick -x "$refund" >/dev/null
write docs/release-3.1.md "# 3.1 notes"
commit "docs: 3.1 release notes" "Marco Rossi"
git push -q origin release/3.1
cd ~/shop
git fetch -q origin
git merge -q --ff-only origin/main
git branch -q --track release/3.1 origin/release/3.1
git branch -q -f release/3.1 origin/release/3.1~2
