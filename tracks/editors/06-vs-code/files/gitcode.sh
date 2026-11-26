# Lesson 5: core.editor is "code" without --wait, so every git commit aborts with an empty message.
. "$DOJO_FILES/lib.sh"
install -m 755 "$DOJO_FILES/code-standin" /usr/local/bin/code
make_repo ~/shop
sed -i 's/Run:/Run it:/' README.md
git add README.md
cat >> ~/.gitconfig <<'EOF'
[core]
	editor = code
EOF
