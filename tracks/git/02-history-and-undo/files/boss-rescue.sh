# Boss 1: a reset --hard typed into the wrong terminal, a half-finished feature, and an urgent hotfix.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/payments
write src/money.py "def to_cents(amount):" "    return round(amount * 100)" "" "def refund_total(items):" "    return round(sum(items))"
write src/report.py "def report(rows):" "    return len(rows)"
commit "Initial payments service"
write src/refund.py "from money import refund_total" "" "def refund(items):" "    return refund_total(items)"
commit "Add refund endpoint" "Priya Shah"
write src/refund.py "from money import refund_total" "" "def refund(items):" "    if not items:" "        raise ValueError('nothing to refund')" "    return refund_total(items)"
commit "Validate refund amount"
note lost-tip "$(git rev-parse HEAD)"
git reset -q --hard HEAD~2
# The half-finished feature, not ready to commit.
write src/report.py "def report(rows):" "    # TODO: group by day" "    return {'count': len(rows), 'total': sum(r['amount'] for r in rows)}"
