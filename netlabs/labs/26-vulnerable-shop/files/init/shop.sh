#!/bin/bash
# Boots the shop host: copies the app's source to /work/shop (with a small Git history), seeds the database,
# writes the secrets, builds the app and starts it under a supervisor. Runs as root; the app runs as shopsvc.
set -u
mkdir -p /work/logs /work/build /work/data /work/secrets /opt/dojo
exec >> /work/logs/shop-init.log 2>&1
echo "=== $(date '+%F %T') shop init"

paykey="pay_live_$(printf '%s' "${DOJO_PAYKEY:-0}" | tr -cd '0-9a-f')c41d07e9"
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

if [ ! -d /work/shop/.git ]; then
  cp -r /lab/app /work/shop
  cd /work/shop
  find . -type f \( -name '*.cs' -o -name '*.cshtml' -o -name '*.json' -o -name '*.csproj' -o -name '*.css' -o -name '*.md' \) -exec sed -i 's/\r$//' {} +
  git init -q -b main
  git config user.name "Sam Developer"
  git config user.email "sam@shop.example"
  git config core.pager cat
  commit() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"; }
  # 1. The first version kept the payments key in appsettings.json.
  jq --arg k "$paykey" '.Payments = { BaseUrl: .Payments.BaseUrl, ApiKey: $k }' /lab/app/appsettings.json > appsettings.json
  git add -A && commit "2026-09-14T10:02:00+02:00" "Lamp Shop: first version"
  # 2. Someone noticed and moved it out... but never rotated it.
  cp /lab/app/appsettings.json appsettings.json
  git add -A && commit "2026-09-30T16:41:00+02:00" "Read the payments key from a file instead of appsettings.json"
  # 3. Later work.
  printf '%s\n' "# Lamp Shop" "" "Run: \`dotnet run\`. In the lab: \`shop-rebuild\` builds this folder and restarts the shop." > README.md
  git add -A && commit "2026-10-12T09:15:00+02:00" "Add a README"
fi

# Secrets: the live key (still the leaked one) and a root-only copy the lab checks against.
printf '%s\n' "$paykey" > /opt/dojo/leaked.key && chmod 600 /opt/dojo/leaked.key
[ -f /work/secrets/payments.key ] || printf '%s\n' "$paykey" > /work/secrets/payments.key
chown -R shopsvc:shopsvc /work/secrets && chmod 700 /work/secrets && chmod 600 /work/secrets/payments.key

# Database and invoices.
if [ ! -f /work/data/shop.db ]; then
  sed -e "s/@ADMINHASH@/$(sha "Adm!n-${DOJO_ADMINPW:-1}")/" \
      -e "s/@ALICEHASH@/$(sha wonderland)/" \
      -e "s/@BOBHASH@/$(sha "bob-${DOJO_BOBPW:-1}")/" \
      -e "s/@CAROLHASH@/$(sha "${DOJO_CAROLPW:-sunshine1}")/" \
      -e "s/@PIN@/PIN-${DOJO_PIN:-0}/" \
      -e "s/@GATECODE@/${DOJO_GATECODE:-0}/" /lab/seed/seed.sql | sqlite3 /work/data/shop.db
  mkdir -p /work/data/invoices /work/data/invoices-old
  for o in 1001 1002 1003 1004; do
    printf 'Lamp Shop invoice %s\nVAT number: EX123456789\nThank you for your order.\n' "$o" > /work/data/invoices/invoice-$o.txt
  done
  printf 'Old supplier ledger (2024). Not for customers.\nSupplier bank account: EX00 0000 0000 0000 0000 00\n' > /work/data/invoices-old/ledger.txt
fi
chown -R shopsvc:shopsvc /work/data

# Build (offline: every package is already in the image's NuGet cache) and start the supervisor.
printf 'dt_%s\n' "${DOJO_DEPLOY:-0}" > /opt/dojo/deploy-token && chmod 600 /opt/dojo/deploy-token
cd /work/shop && dotnet restore --nologo -v q
/lab/bin/shop-rebuild --no-restart
nohup setsid bash /lab/bin/shop-supervise > /dev/null 2>&1 &
printf '%s\n' "cd /work/shop" "echo 'The shop source is here (/work/shop). Edit a file, then run shop-rebuild. Log: tail -f /work/logs/shop.log'" >> /root/.bashrc
touch /work/.seeded
echo "=== $(date '+%F %T') shop init done"
