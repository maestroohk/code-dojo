# Lesson 1: the learner has one unpushed commit; a teammate pushed two and deleted feature/old on the server.
. "$DOJO_FILES/origin.sh"
cd ~/shop
write src/Cart.cs "class Cart { decimal Total; }"
commit "Track cart total"
note local-main "$(git rev-parse main)"
teammate shop
write src/Order.cs "class Order { int Id; }"
commit "Give orders an id" "Priya Shah"
write docs/api.md "# API"
commit "Document the API" "Priya Shah"
git push -q origin main
git push -q origin --delete feature/old
note remote-main "$(git rev-parse main)"