# Boss: a repo where one object file on disk was damaged.
. "$DOJO_FILES/lib.sh"
fresh_repo /opt/dojo/seed
write README.md "# Shop"
write src/Cart.cs "class Cart {}"
commit "Start the shop"
write src/Price.cs "static class Price" "{" "    public const decimal Vat = 0.21m;" "}"
commit "Add VAT constant"
write docs/notes.md "notes"
commit "Add notes"
publish shop
cd ~ && rm -rf ~/shop && git clone -q --no-local /srv/git/shop.git ~/shop
cd ~/shop
id=$(git rev-parse HEAD~1:src/Price.cs)
note bad "$id"
f=".git/objects/${id:0:2}/${id:2}"
mkdir -p /tmp/pk && mv .git/objects/pack/* /tmp/pk/ && git unpack-objects -q < /tmp/pk/*.pack && rm -rf /tmp/pk
chmod u+w "$f"
# Same object name, different bytes: a disk or a sync tool damaged the file (0.21 became 0.12).
python3 - "$f" <<'PY'
import sys, zlib
body = b"static class Price\n{\n    public const decimal Vat = 0.12m;\n}\n"
open(sys.argv[1], "wb").write(zlib.compress(b"blob %d\0" % len(body) + body))
PY
chmod 444 "$f"