# Lesson 2: a working tree in a mess. Some edits are accidents, one is real work in progress.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/app
write README.md "# App" "Run it with: npm start"
write config/app.json '{' '  "port": 8080,' '  "debug": false' '}'
write src/cart.js "export function total(items) {" "  return items.reduce((s, i) => s + i.price, 0);" "}"
write NOTES.md "# Notes" "- ship the cart"
commit "Initial app"
write src/tax.js "export const rate = 0.2;"
commit "Add tax rate" "Sam Lee"
# The accidents: debug edits to the config, a deleted README, notes staged by mistake.
write config/app.json '{' '  "port": 9999,' '  "debug": true,' '  "token": "dev-only-do-not-commit"' '}'
rm README.md
write NOTES.md "# Notes" "- ship the cart" "- Ask Sam about tax rounding"
git add NOTES.md
# The real work: a rounding fix that is not finished yet.
write src/cart.js "export function total(items) {" "  const total = items.reduce((s, i) => s + i.price, 0);" "  return Math.round(total * 100) / 100;" "}"
