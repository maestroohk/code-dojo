# Lesson 3: main changed the base shipping price; feature/free-shipping added a free threshold on the same lines.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write shipping.sh '#!/bin/bash' '# shipping cost in cents for an order total in cents' 'cost() {' '  local total=$1' '  echo 495' '}' 'cost "$1"'
write test.sh '#!/bin/bash' '# Both behaviours must survive the merge.' 'set -e' \
  '[ "$(./shipping.sh 2000)" = 595 ] || { echo "FAIL: a 20.00 order should pay 5.95 shipping (main raised the price)"; exit 1; }' \
  '[ "$(./shipping.sh 6000)" = 0 ] || { echo "FAIL: orders of 50.00 or more ship free (feature/free-shipping)"; exit 1; }' \
  'echo "PASS: both shipping rules work"'
chmod +x shipping.sh test.sh
commit "Add shipping cost"
git switch -q -c feature/free-shipping
write shipping.sh '#!/bin/bash' '# shipping cost in cents for an order total in cents' 'cost() {' '  local total=$1' '  if [ "$total" -ge 5000 ]; then echo 0; else echo 495; fi' '}' 'cost "$1"'
commit "Ship free from 50.00" "Priya Shah"
git switch -q main
write shipping.sh '#!/bin/bash' '# shipping cost in cents for an order total in cents' 'cost() {' '  local total=$1' '  echo 595' '}' 'cost "$1"'
commit "Raise shipping to 5.95" "Sam Okafor"