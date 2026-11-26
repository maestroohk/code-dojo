# Lesson 2: VS Code's user settings folder on Linux, with a settings file that already has one setting.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/.config/Code/User
printf '%s\n' '{' '  "editor.fontSize": 14' '}' > ~/.config/Code/User/settings.json
