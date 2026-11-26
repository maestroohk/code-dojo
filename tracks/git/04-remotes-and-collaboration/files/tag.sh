# Lesson 4: ready to tag the release. Someone already pushed a release-candidate tag by mistake.
. "$DOJO_FILES/origin.sh"
cd ~/shop
write CHANGELOG.md "# 1.5.0" "- gift cards"
commit "Prepare release 1.5.0"
git push -q origin main
git tag v1.5.0-rc HEAD~1
git push -q origin v1.5.0-rc