# Lesson 4 (and its cold rebuild): a shop whose history is pushed up to "Log checkout errors".
# An old commit broke production, and the newest, unpushed commit has a typo and a forgotten file.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop" "Run it with: make run"
write config/cache.conf "enabled=false" "ttl=60"
commit "Initial shop"
write src/products.py "PRODUCTS = ['mug', 'shirt']"
commit "Add product list"
write config/cache.conf "enabled=true" "ttl=60"
commit "Enable experimental cache" "Priya Shah"
write src/coupons.py "COUPONS = {'SAVE10': 0.1}"
commit "Add coupon page"
write src/checkout.py "import logging" "log = logging.getLogger('checkout')"
commit "Log checkout errors" "Sam Lee"
note pushed "$(git rev-parse HEAD)"
write README.md "# Shop" "Run it with: make run" "See CHANGELOG.md for what changed."
commit "Fix typo in READNE"
write CHANGELOG.md "# Changelog" "- Coupons at checkout" "- Checkout errors are logged"
