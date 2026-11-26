#!/usr/bin/env bash
# The price fetcher scenario: a sequential fetch_all the learner turns into a bounded TaskGroup.
set -e -o pipefail
mkdir -p ~/prices
cat > ~/prices/fetch.py <<'EOF'
import asyncio


async def fetch_all(skus, get_price, limit):
    """Return {sku: price} for every sku. get_price(sku) is a coroutine (an HTTP call)."""
    prices = {}
    for sku in skus:
        prices[sku] = await get_price(sku)
    return prices
EOF
cat > ~/prices/README.txt <<'EOF'
fetch.py asks the supplier for one price at a time: 400 skus take 400 round trips.

Make fetch_all:
  - run the calls concurrently, but at most `limit` at once (asyncio.Semaphore);
  - use asyncio.TaskGroup, so that one failed call cancels the others and the
    error comes out as an ExceptionGroup.

Try it:   python3 /opt/dojo/files/check_fetch.py limit
          python3 /opt/dojo/files/check_fetch.py failure
EOF
