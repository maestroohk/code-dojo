# Stage 5: Sam reset the gift-card branch to origin/main by mistake.
. "$DOJO_FILES/team.sh"
cd ~/shop
git switch -q -c giftcards
write src/GiftCard.cs "class GiftCard { decimal Balance; }"
commit "Add GiftCard model"
write src/GiftCard.cs "class GiftCard { decimal Balance; bool Covers(decimal x) => Balance >= x }"
commit "Add gift card balance check"
write src/GiftCard.cs "class GiftCard { decimal Balance; bool Covers(decimal x) => Balance >= x; }"
git add -A
GIT_COMMITTER_DATE="@1737000000 +0000" git commit -q --amend --no-edit
note lost "$(git rev-parse HEAD)"
git reset -q --hard origin/main