# Lesson 2, second step: same rewrite, but you have no work of your own on the branch, only a stale copy.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
commit "Start the shop" "Marco Rossi"
git switch -q -c release/3.2
write CHANGELOG.md "# 3.2" "- draft"
commit "Draft 3.2 notes" "Marco Rossi"
write CHANGELOG.md "# 3.2" "- draft" "- typo"
commit "Fix typo in notes" "Marco Rossi"
git switch -q main
publish shop
cd ~ && rm -rf ~/shop && git clone -q /srv/git/shop.git ~/shop && cd ~/shop
git switch -q release/3.2
teammate shop
git switch -q release/3.2
git reset -q --hard main
write CHANGELOG.md "# 3.2" "- gift cards" "- faster search"
commit "Release notes for 3.2" "Marco Rossi"
git push -q --force origin release/3.2
note new "$(git rev-parse HEAD)"