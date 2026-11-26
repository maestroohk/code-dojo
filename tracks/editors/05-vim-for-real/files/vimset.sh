# Used by the checks: vimset.sh FILE OPTION... prints "option=value" for each option, as real Vim has it for FILE
# after reading ~/.vimrc like a normal start (booleans print 1 or 0). Plain `vim -es` skips the vimrc, so -u
# names it; -N is the nocompatible mode a vimrc normally switches on.
f="$1"; shift
out="$(mktemp)"
vim -Nes -u ~/.vimrc -c "e $f" \
  -c "call writefile(map(split('$*'), {_, n -> n . '=' . eval('&' . n)}), '$out')" -c 'qa!' </dev/null >/dev/null 2>&1 || true
cat "$out"
rm -f "$out"
