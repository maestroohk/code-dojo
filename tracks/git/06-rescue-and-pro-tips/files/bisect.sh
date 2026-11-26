# Lesson 2 and the boss: a long history where one commit broke the VAT total. The test lives outside the repo.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write price.sh '#!/bin/bash' '# price with 21% VAT, in cents' 'total() { echo $(( $1 * 121 / 100 )); }' 'total "$1"'
chmod +x price.sh
commit "Start pricing"
git tag -a "${GOOD_TAG:-v1.0.0}" -m "Release"
n=${COMMITS:-40}; bad=${BAD_AT:-27}
for i in $(seq 1 "$n"); do
  if [ "$i" = "$bad" ]; then
    write price.sh '#!/bin/bash' '# price with VAT, in cents' 'total() { echo $(( $1 * 112 / 100 )); }' 'total "$1"'
    commit "Tidy the VAT calculation" "Sam Okafor"
    note bad "$(git rev-parse HEAD)"
  else
    write "docs/page$((i % 7)).md" "# Page $i"
    commit "Update docs page $((i % 7)) (#$((100 + i)))" "Priya Shah"
  fi
done
write ~/check-total.sh '#!/bin/bash' '# exit 0 when a 1.00 order costs 1.21 with VAT, 1 when it does not' 'test "$(./price.sh 100)" = 121'
chmod +x ~/check-total.sh