# Lesson 3: a pricing script whose discount() function has a history, including a reformat by a bot.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write prices.sh '#!/bin/bash' \
  'discount() {' '  local rate=10' '  echo $(( $1 * (100 - rate) / 100 ))' '}' '' \
  'shipping() {' '  echo 595' '}'
commit "Add discount and shipping" "Priya Shah"
write prices.sh '#!/bin/bash' \
  'discount() {' '  local rate=10' '  applyLegacyDiscount "$1"' '  echo $(( $1 * (100 - rate) / 100 ))' '}' '' \
  'shipping() {' '  echo 595' '}'
commit "Honour legacy discounts for old accounts" "Sam Okafor"
write prices.sh '#!/bin/bash' \
  'discount() {' '  local rate=15' '  applyLegacyDiscount "$1"' '  echo $(( $1 * (100 - rate) / 100 ))' '}' '' \
  'shipping() {' '  echo 595' '}'
commit "Raise the standard discount to 15%" "Priya Shah"
write prices.sh '#!/bin/bash' \
  'discount() {' '    local rate=15' '    applyLegacyDiscount "$1"' '    echo $(( $1 * (100 - rate) / 100 ))' '}' '' \
  'shipping() {' '    echo 595' '}'
commit "Reformat shell scripts (4 spaces)" "Format Bot"
note format "$(git rev-parse HEAD)"
write prices.sh '#!/bin/bash' \
  'discount() {' '    local rate=15' '    echo $(( $1 * (100 - rate) / 100 ))' '}' '' \
  'shipping() {' '    echo 595' '}'
commit "Remove the legacy discount path" "Sam Okafor"
write prices.sh '#!/bin/bash' \
  'discount() {' '    local rate=15' '    echo $(( $1 * (100 - rate) / 100 ))' '}' '' \
  'shipping() {' '    echo 695' '}'
commit "Raise shipping to 6.95" "Lee Chen"
write README.md "# Shop"
commit "Add a README" "Lee Chen"
