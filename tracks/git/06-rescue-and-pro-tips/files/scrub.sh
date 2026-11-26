# Lesson 5: a secrets file committed three commits ago. Nothing after origin/main is pushed yet.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
write src/Api.cs "class Api {}"
commit "Start the shop"
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop && cd ~/shop
write secrets.env "STRIPE_KEY=sk_live_DO-NOT-USE-made-up-key"
write src/Pay.cs "class Pay {}"
commit "Add payments"
write src/Pay.cs "class Pay { void Charge() {} }"
commit "Charge cards"
write src/Refund.cs "class Refund {}"
commit "Add refunds"