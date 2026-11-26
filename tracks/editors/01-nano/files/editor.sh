# Lesson 3: Git and every other tool keep opening Vim. A repo-local core.editor and an EDITOR line are to blame.
set -e -o pipefail
mkdir -p ~/app && cd ~/app
git init -q -b main
printf '# app\n' > README.md
git config core.editor vim        # left behind by an old setup script
printf '\n# added by the laptop setup script\nexport EDITOR=vim\n' >> ~/.bashrc
