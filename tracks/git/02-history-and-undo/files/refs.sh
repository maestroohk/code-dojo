# Lesson 1: a small shop repo with a feature branch and a release tag, to name commits in.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write README.md "# Shop" "A tiny web shop."
commit "Initial commit"
write src/products.js "export const products = ['mug', 'shirt'];"
commit "Add product list"
write src/cart.js "export const cart = [];"
commit "Add cart"
git tag v1.0
write src/checkout.js "export function checkout(cart) { return cart.length; }"
commit "Add checkout page" "Priya Shah"
write src/cart.js "export const cart = [];" "export const add = item => cart.push(item);"
commit "Let the cart add items"
write src/search.js "export const search = q => q.trim();"
commit "Add search box" "Sam Lee"
git switch -q -c feature/coupons
write src/coupons.js "export const coupons = {};"
commit "Add coupon model"
write src/coupons.js "export const coupons = { SAVE10: 0.1 };"
commit "Seed a first coupon"
write src/checkout.js "import { coupons } from './coupons.js';" "export function checkout(cart) { return cart.length; }"
commit "Use coupons at checkout"
git switch -q main
