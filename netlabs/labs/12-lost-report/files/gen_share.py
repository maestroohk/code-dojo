# Builds Byte & Biscuit's messy shared drive under /srv/shared for mission 12.
import os, random, time

R = random.Random(int(os.environ.get("DOJO_SEED", "1")))
ncsv = int(os.environ["DOJO_NCSV"])
big = os.environ["DOJO_BIG"]
recent = os.environ["DOJO_RECENT"]
index = os.environ["DOJO_INDEX"]
root = "/srv/shared"
now = time.time()
DAY = 86400

dirs = ["marketing", "marketing/campaigns/2024", "finance/2024", "finance/2025", "hr/policies", "hr/holiday-photos",
        "design/assets", "design/fonts", "random/old/stuff", "random/gary", "projects/drone-delivery", "projects/biscuit-ai"]
for d in dirs:
    os.makedirs(os.path.join(root, d), exist_ok=True)

words = "biscuit crumb oven drone delivery budget meeting synergy quarterly llama jam custard tin crunchy recipe".split()
files = []

def write(path, text):
    full = os.path.join(root, path)
    with open(full, "w") as f:
        f.write(text)
    files.append(full)

def lorem(n):
    return "\n".join(" ".join(R.choice(words) for _ in range(R.randint(5, 12))) for _ in range(n)) + "\n"

# Ordinary clutter.
exts = [".txt", ".md", ".log", ".doc", ".old"]
for i in range(260):
    write(f"{R.choice(dirs)}/{R.choice(words)}-{i:03d}{R.choice(exts)}", lorem(R.randint(2, 30)))

# Exactly ncsv CSV files, all with different names.
for i in range(ncsv):
    write(f"{R.choice(dirs)}/export-{R.choice(words)}-{i:02d}.csv", "id,item,qty\n" + "".join(f"{j},{R.choice(words)},{R.randint(1, 99)}\n" for j in range(20)))

# Gary's temporary junk, plus one file that only looks like junk.
for i in range(14):
    write(f"{R.choice(dirs)}/autosave-{i:02d}.tmp", lorem(3))
write("random/gary/tmp-notes.txt", "Do not delete: Gary's notes about the tmp folder.\n")

# The report, and a draft that is not it.
write("random/old/stuff/notes-final-v2-REAL.txt", lorem(6) + f"Biscuit Index Q3: {index}\n" + lorem(4))
write("marketing/draft-ideas.md", lorem(3) + "Biscuit Index Q2: 412 (old numbers, ignore)\n" + lorem(2))

# Everything is old...
for f in files:
    t = now - R.randint(30, 400) * DAY
    os.utime(f, (t, t))

# ...except one file edited yesterday.
write(f"finance/2025/{recent}", "Budget, revised after the Great Custard Spill.\n" + lorem(5))
os.utime(files[-1], (now - DAY, now - DAY))

# One file far bigger than the rest (sparse: its size is real, it uses no disk).
with open(os.path.join(root, "design/assets", big), "wb") as f:
    f.truncate(7 * 1024 * 1024 + R.randint(1, 900000))
t = now - 200 * DAY
os.utime(os.path.join(root, "design/assets", big), (t, t))

# Folders old too, so only that one file shows up as recently changed.
for dirpath, _, _ in sorted(os.walk(root), key=lambda w: -w[0].count("/")):
    os.utime(dirpath, (now - 90 * DAY, now - 90 * DAY))
