# Check the newest commit message in ~/shop against the team's rules. Prints every problem; exit 1 if any.
cd ~/shop || exit 1
[ "$(git rev-list --count HEAD)" -ge 2 ] || { echo "the staged change is not committed yet"; exit 1; }
git log -1 --format=%B > /tmp/msg.$$
subject=$(sed -n 1p /tmp/msg.$$)
second=$(sed -n 2p /tmp/msg.$$)
body=$(sed -n '3,$p' /tmp/msg.$$ | grep -v '^[[:space:]]*$' || true)
bad=0
say() { echo "$1"; bad=1; }
[ ${#subject} -le 50 ] || say "the subject is ${#subject} characters; keep it to 50 or fewer"
case $subject in *.) say "the subject ends with a period" ;; esac
case $subject in [A-Z]*) ;; *) say "the subject should start with a capital letter" ;; esac
case $subject in Added*|Adds*|Fixed*|Fixes*|Adding*|Fixing*) say "write the subject in the imperative: \"Retry ...\", \"Add ...\", not \"Added\" or \"Fixes\"" ;; esac
[ -z "$second" ] || say "the second line must be blank (it separates the subject from the body)"
[ -n "$body" ] || say "there is no body: say why the change was needed"
long=$(awk 'length > 72' /tmp/msg.$$ | head -n 1)
[ -z "$long" ] || say "a line is longer than 72 characters: $long"
rm -f /tmp/msg.$$
exit $bad
