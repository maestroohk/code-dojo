# Lesson 2: a folder of notes that is not a repository yet.
. "$DOJO_FILES/lib.sh"
rm -rf ~/notes; mkdir -p ~/notes; cd ~/notes
write README.md "# Team notes" "Decisions and how-tos."
write todo.md "- set up CI" "- write the deploy guide"
