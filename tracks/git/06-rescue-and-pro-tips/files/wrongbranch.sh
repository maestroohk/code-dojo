# Lesson 1: two commits landed on main instead of a branch, and a detached-HEAD experiment was left behind.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
write src/Login.cs "class Login {}"
commit "Start the shop"
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop && cd ~/shop
git switch -q --detach
write img/logo.svg "<svg/>"
commit "Try a new logo"
note logo "$(git rev-parse HEAD)"
git switch -q main 2>/dev/null
write src/Login.cs "class Login { bool Valid; }"
commit "Validate the login form"
write src/Login.cs "class Login { bool Valid; string Error; }"
commit "Show login errors"
note tip "$(git rev-parse HEAD)"
note origin "$(git rev-parse origin/main)"