# Module 3 scenarios: service logs to search, files with awkward names, a nested JSON config, an Excel CSV,
# and a legacy export in Windows-1252. Deterministic, so checks can recompute the answers.
set -e -o pipefail
mkdir -p ~/answers ~/scripts ~/logs ~/app ~/data ~/inbox ~/archive
python3 - <<'EOF'
import json, os, random
home = os.path.expanduser("~")
rnd = random.Random(11)

# Three service logs with a few upstream timeouts in each.
for svc in ["billing", "orders", "search"]:
    with open(os.path.join(home, "logs", f"{svc}.log"), "w") as f:
        for i in range(300):
            r = rnd.random()
            if r < 0.02:
                line = f"2026-11-26T09:{i // 60:02d}:{i % 60:02d}Z ERROR upstream timed out after 30 s (req {svc[:2]}-{4000 + i})"
            elif r < 0.05:
                line = f"2026-11-26T09:{i // 60:02d}:{i % 60:02d}Z ERROR invalid input: price: $5.00 (USD) not allowed (req {svc[:2]}-{4000 + i})"
            elif r < 0.12:
                line = f"2026-11-26T09:{i // 60:02d}:{i % 60:02d}Z WARN  slow response {rnd.randint(900, 3000)} ms"
            else:
                line = f"2026-11-26T09:{i // 60:02d}:{i % 60:02d}Z INFO  ok {rnd.randint(5, 300)} ms"
            f.write(line + "\n")

# Reports whose names contain square brackets (a real export tool names them like this).
for name in ["report[2026-10].txt", "report[2026-11].txt", "summary[final].txt", "notes.txt"]:
    with open(os.path.join(home, "inbox", name), "w") as f:
        f.write(f"contents of {name}\n")

# A nested appsettings.json, five levels deep in places.
cfg = {
    "Logging": {"LogLevel": {"Default": "Information", "Microsoft.AspNetCore": "Warning"}},
    "ConnectionStrings": {"Orders": "Server=db.example.com;Database=orders;Integrated Security=true"},
    "Features": {"Checkout": {"NewFlow": {"Enabled": False, "Rollout": {"Percent": 10, "Regions": ["eu-west", "us-east"]}}}},
    "AllowedHosts": "*",
}
with open(os.path.join(home, "app", "appsettings.json"), "w") as f:
    json.dump(cfg, f, indent=2)

# Stock levels exported by Excel on a German machine: semicolons, and decimal commas in prices.
rows = [("SKU-1001", "Kaffeebecher", 120, "4,50"), ("SKU-1002", "Teekanne", 8, "24,90"), ("SKU-1003", "Untersetzer", 0, "1,20"),
        ("SKU-1004", "Milchkännchen", 35, "9,99"), ("SKU-1005", "Zuckerdose", 3, "7,25")]
with open(os.path.join(home, "data", "stock.csv"), "w", encoding="utf-8-sig") as f:
    f.write("Sku;Name;Qty;Price\n")
    for r in rows:
        f.write(";".join(map(str, r)) + "\n")

# A customer export from a legacy system, in Windows-1252 (the "ANSI" code page of Western European Windows).
customers = [("C-001", "Müller GmbH", "München"), ("C-002", "Café Olé", "Lyon"), ("C-003", "Señor Pérez SA", "Málaga"),
             ("C-004", "Øresund Logistik", "Malmö"), ("C-005", "Smith & Co", "Leeds")]
with open(os.path.join(home, "data", "customers-legacy.csv"), "w", encoding="cp1252", newline="") as f:
    f.write("Id,Name,City\r\n")
    for c in customers:
        f.write(",".join(c) + "\r\n")
EOF
