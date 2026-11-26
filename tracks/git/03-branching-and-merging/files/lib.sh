# Shared helpers for this module's terminal-step scenarios (sourced by the other scripts here).
# The scripts run as root in the learner's home; the dojo hands the home folder to the learner afterwards.
# The same file is in every Git module's files/ folder (a step only sees its own module's files).
set -e -o pipefail
mkdir -p /opt/dojo/state

# Fixed, increasing commit times: every learner (and every validation run) gets the same history shape.
# The clock lives in a file, so subshells (a teammate's clone) keep counting too.
_dojo_clock=/opt/dojo/state/.clock
[ -f "$_dojo_clock" ] || echo 1735725600 > "$_dojo_clock"
commit() {   # commit "message" [author name]
  local t; t=$(( $(cat "$_dojo_clock") + 5400 )); echo "$t" > "$_dojo_clock"
  export GIT_AUTHOR_DATE="@$t +0000" GIT_COMMITTER_DATE="@$t +0000"
  git add -A
  if [ -n "${2:-}" ]; then
    local mail; mail="$(echo "$2" | tr 'A-Z ' 'a-z.')@shop.test"
    git -c user.name="$2" -c user.email="$mail" commit -q -m "$1"
  else
    git commit -q -m "$1"
  fi
}

# write FILE LINE... : create the file (and its folder) with these lines.
write() { mkdir -p "$(dirname "$1")"; local f="$1"; shift; printf '%s\n' "$@" > "$f"; }

# Private notes for the checks (hashes the learner should get back to). Not in the learner's home.
note() { printf '%s\n' "$2" > "/opt/dojo/state/$1"; chmod 644 "/opt/dojo/state/$1"; }

fresh_repo() { rm -rf "$1"; mkdir -p "$1"; cd "$1"; git init -q -b main; }

# publish NAME: make a bare "origin" at /srv/git/NAME.git, push every branch and tag of the current repo to it,
# and set each local branch to track its origin twin. Like a GitHub repository, but on this machine.
publish() {
  local bare="/srv/git/$1.git"
  rm -rf "$bare"; mkdir -p /srv/git
  git init -q --bare -b main "$bare"
  git remote add origin "$bare"
  git push -q origin --all
  git push -q origin --tags 2>/dev/null || true
  git fetch -q origin
  local b
  for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do git branch -q -u "origin/$b" "$b"; done
}

# teammate NAME: a teammate's own clone of origin NAME in /opt/dojo/mate (outside the learner's home).
teammate() { rm -rf /opt/dojo/mate; git clone -q "/srv/git/$1.git" /opt/dojo/mate; cd /opt/dojo/mate; }

# The learner pushes to /srv/git, so it must be theirs once setup is done.
trap 'chown -R learner:learner /srv/git 2>/dev/null || true; chmod -R a+rX /opt/dojo 2>/dev/null || true' EXIT
