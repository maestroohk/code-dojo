#!/usr/bin/env bash
# The blocked event loop scenario (boss): a report job that calls blocking code from a coroutine.
set -e -o pipefail
mkdir -p ~/reports
cat > ~/reports/report.py <<'EOF'
import asyncio
import time


def render_pdf(name):
    """A blocking library call (think: a PDF renderer). About 0.3 s. Do not change it."""
    time.sleep(0.3)
    return f"{name}.pdf"


async def build_reports(names):
    """Render every report and return the file names, in order."""
    files = []
    for name in names:
        files.append(render_pdf(name))
    return files


async def prices_by_deadline(skus, get_price, seconds):
    """Return {sku: price} for the prices that arrive within `seconds`; cancel the rest."""
    prices = {}
    for sku in skus:
        prices[sku] = await get_price(sku)
    return prices
EOF
cat > ~/reports/README.txt <<'EOF'
While build_reports runs, the service stops answering its health checks:
the event loop is blocked. Fix report.py (see the lesson), then:

  python3 /opt/dojo/files/check_loop.py heartbeat
  python3 /opt/dojo/files/check_loop.py deadline
EOF
