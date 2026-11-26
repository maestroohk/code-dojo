# Lesson 4: no SSH config yet, and a repo without a dev container.
. "$DOJO_FILES/lib.sh"
make_repo ~/shop
mkdir -p ~/.ssh && chmod 700 ~/.ssh
rm -f ~/.ssh/config
touch ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
