# Lesson 3: feature/pay is pushed and open for review. You rebased it on the new main locally.
# Meanwhile a teammate pushed a test commit to the same branch, and you have not fetched.
. "$DOJO_FILES/origin.sh"
cd ~/shop
git switch -q -c feature/pay
write src/Pay.cs "class Pay {}"
commit "Add payments"
write src/Pay.cs "class Pay { void Charge() {} }"
commit "Charge cards"
git push -q -u origin feature/pay
teammate shop
write README.md "# Shop" "Now with docs."
commit "Explain the shop" "Sam Okafor"
git push -q origin main
git switch -q feature/pay
write tests/PayTests.cs "class PayTests {}"
commit "Add payment tests" "Priya Shah"
git push -q origin feature/pay
note mate-test "$(git rev-parse HEAD)"
cd ~/shop
git fetch -q origin main
git rebase -q origin/main
