# Writes a day of biscuit orders to /var/log/orders.log for mission 13. The planted answers
# (favourite flavour, grumpiest customer, top cities) always have a clear winner: no ties.
import collections, os, random

R = random.Random(int(os.environ.get("DOJO_SEED", "1")))
fav = os.environ["DOJO_FAV"]
grumpy = os.environ["DOJO_GRUMPY"]

flavours = ["chocolate-chip", "ginger-snap", "jammy-dodger", "oat-raisin", "custard-cream", "shortbread", "lemon-zest"]
customers = ["alice", "bob", "chen", "dolores", "eamon", "fatima", "gus", "hana", "ivan", "jules", "kofi", "lena",
             "mo", "nadia", "otto", "priya", "quinn", "rosa", "sam", "tariq"]
cities = ["leeds", "york", "bristol", "derby", "bath", "hull", "ely", "wells"]

while True:
    counts = R.sample(range(60, 400), len(cities))
    city_list = [c for c, n in zip(cities, counts) for _ in range(n)]
    R.shuffle(city_list)
    others = [f for f in flavours if f != fav]
    rows = []
    for city in city_list:
        flav = fav if R.random() < 0.3 else R.choice(others)
        who = R.choice(customers)
        failed = R.random() < 0.07
        rows.append([who, flav, R.randint(1, 12), city, "failed" if failed else "ok"])
    # The grumpy customer had a truly bad day.
    for row in R.sample(rows, 14):
        row[0], row[4] = grumpy, "failed"
    f = collections.Counter(r[1] for r in rows).most_common(2)
    g = collections.Counter(r[0] for r in rows if r[4] == "failed").most_common(2)
    if f[0][0] == fav and f[0][1] > f[1][1] and g[0][0] == grumpy and g[0][1] > g[1][1]:
        break

secs = sorted(R.sample(range(6 * 3600, 23 * 3600), len(rows)))
with open("/var/log/orders.log", "w") as out:
    for i, (s, (who, flav, qty, city, status)) in enumerate(zip(secs, rows)):
        out.write(f"2026-11-24T{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d} order={10000 + i} customer={who} cookie={flav} qty={qty} city={city} status={status}\n")
