"""Checks for ~/reports/report.py. Usage: check_loop.py heartbeat|deadline"""
import asyncio
import importlib.util
import os
import sys
import time

path = os.path.expanduser("~/reports/report.py")
spec = importlib.util.spec_from_file_location("report", path)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


async def heartbeat_case():
    gaps = []
    stop = False

    async def heartbeat():
        last = time.monotonic()
        while not stop:
            await asyncio.sleep(0.02)
            now = time.monotonic()
            gaps.append(now - last)
            last = now

    beat = asyncio.create_task(heartbeat())
    await asyncio.sleep(0.05)
    files = await report.build_reports(["q1", "q2", "q3"])
    stop = True
    await beat
    worst = max(gaps)
    print(f"files={files} loop_blocked={'yes' if worst > 0.2 else 'no'}")


async def deadline_case():
    async def get_price(sku):
        await asyncio.sleep(0.01 if sku.startswith("fast") else 5)
        return len(sku)

    started = time.monotonic()
    try:
        prices = await report.prices_by_deadline(["fast-a", "slow-b", "fast-c"], get_price, 0.3)
    except BaseException as e:  # noqa: BLE001 - report what escaped
        print(f"raised {type(e).__name__}")
        return
    took = time.monotonic() - started
    print(f"prices={dict(sorted(prices.items()))} on_time={'yes' if took < 1.5 else 'no'}")


asyncio.run(heartbeat_case() if sys.argv[1] == "heartbeat" else deadline_case())
