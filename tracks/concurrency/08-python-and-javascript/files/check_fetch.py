"""Checks for ~/prices/fetch.py. Usage: check_fetch.py limit|failure"""
import asyncio
import importlib.util
import os
import sys

path = os.path.expanduser("~/prices/fetch.py")
spec = importlib.util.spec_from_file_location("fetch", path)
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)


async def limit_case():
    inflight = peak = 0

    async def get_price(sku):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        await asyncio.sleep(0.01)
        inflight -= 1
        return len(sku) * 10

    skus = [f"sku-{i}" for i in range(10)]
    result = await fetch.fetch_all(skus, get_price, 3)
    ok = result == {s: len(s) * 10 for s in skus}
    print(f"peak={peak} results={'ok' if ok else result}")


async def failure_case():
    cancelled = False

    async def get_price(sku):
        nonlocal cancelled
        if sku == "bad":
            await asyncio.sleep(0.01)
            raise ValueError("bad sku")
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            cancelled = True
            raise
        return 1

    try:
        await asyncio.wait_for(fetch.fetch_all(["slow", "bad"], get_price, 2), 3)
        print("no error")
    except TimeoutError:
        print("hung: still waiting after 3 s")
    except ExceptionGroup as eg:
        print(f"group {[type(e).__name__ for e in eg.exceptions]} cancelled={cancelled}")
    except ValueError:
        print(f"plain ValueError cancelled={cancelled}")


asyncio.run(limit_case() if sys.argv[1] == "limit" else failure_case())
