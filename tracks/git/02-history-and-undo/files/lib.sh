# Shared helpers for this module's terminal-step scenarios (sourced by the other scripts here).
# The scripts run as root in the learner's home; the dojo hands the home folder to the learner afterwards.
set -e -o pipefail

# Fixed, increasing commit times: every learner (and every validation run) gets the same history shape.
_dojo_t=1735725600
commit() {   # commit "message" [author name]
  _dojo_t=$((_dojo_t + 5400))
  export GIT_AUTHOR_DATE="@$_dojo_t +0000" GIT_COMMITTER_DATE="@$_dojo_t +0000"
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
note() { mkdir -p /opt/dojo/state; printf '%s\n' "$2" > "/opt/dojo/state/$1"; chmod 644 "/opt/dojo/state/$1"; }

fresh_repo() { rm -rf "$1"; mkdir -p "$1"; cd "$1"; git init -q -b main; }
