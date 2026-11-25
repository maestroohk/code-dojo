# Writes the marketing team's messy customer export for mission 17:
# semicolons, random spaces, mixed case, Windows line endings and duplicate rows.
# Planted so that the answers are unambiguous: one clear best customer, distinct city totals.
import collections, os, random

R = random.Random(int(os.environ.get("DOJO_SEED", "1")))
first = ["ada", "alan", "grace", "linus", "margaret", "dennis", "barbara", "ken", "radia", "tim", "hedy", "katherine",
         "guido", "frances", "edsger", "annie", "claude", "sophie", "niklaus", "joan"]
last = ["lovelace", "turing", "hopper", "torvalds", "hamilton", "ritchie", "liskov", "thompson", "perlman", "berners-lee",
        "lamarr", "johnson", "rossum", "allen", "dijkstra", "easley", "shannon", "wilson", "wirth", "clarke"]
cities = ["leeds", "york", "bristol", "derby", "bath", "hull"]


def messy_case(s):
    return R.choice([s, s.upper(), s.capitalize(), s.title()])


def pad(s):
    return " " * R.randint(0, 2) + s + " " * R.randint(0, 3)


while True:
    people = []
    for i, (f, l) in enumerate(R.sample([(f, l) for f in first for l in last], 36)):
        people.append({"id": R.randint(1, 9) * 100 + i, "name": f"{f.capitalize()} {l.capitalize()}",
                       "email": f"{f}.{l}@example.com", "city": R.choice(cities), "orders": R.randint(0, 40)})
    best = max(people, key=lambda p: p["orders"])
    if sorted(p["orders"] for p in people)[-2] == best["orders"]:
        continue
    totals = collections.Counter()
    for p in people:
        totals[p["city"]] += p["orders"]
    if len(set(totals.values())) == len(totals) and all(c in totals for c in cities):
        break

rows = people + R.sample(people, 7)
R.shuffle(rows)
lines = ["ID ; Name ; Email ; City ; Orders"]
for p in rows:
    lines.append(";".join([pad(str(p["id"])), pad(p["name"]), pad(messy_case(p["email"])), pad(messy_case(p["city"])), pad(str(p["orders"]))]))
os.makedirs("/srv/export", exist_ok=True)
with open("/srv/export/customers.csv", "w", newline="") as f:
    f.write("\r\n".join(lines) + "\r\n")
