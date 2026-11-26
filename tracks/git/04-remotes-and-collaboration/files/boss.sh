# Boss: a week of conventional commits since v1.4.0, a teammate pushing, and a stray local tag.
. "$DOJO_FILES/origin.sh"
cd ~/shop
git tag -a v1.4.0 -m "Release 1.4.0"
git push -q origin v1.4.0
write src/Gift.cs "class Gift {}"
commit "feat: add gift cards" "Priya Shah"
write src/Cart.cs "class Cart { bool Empty; }"
commit "fix: handle an empty cart" "Sam Okafor"
git switch -q -c topic && write x.txt x && commit "Topic work" && git switch -q main
GIT_COMMITTER_DATE="@1736000000 +0000" GIT_AUTHOR_DATE="@1736000000 +0000" git merge -q --no-ff -m "Merge branch 'topic'" topic && git branch -q -D topic
write src/Vat.cs "class Vat {}"
commit "fix: round VAT per line"
write README.md "# Shop" "Faster pages."
commit "docs: explain caching"
git push -q origin main
git tag try-me