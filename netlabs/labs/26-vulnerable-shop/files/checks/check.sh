#!/bin/bash
# The lab's checks: `bash /lab/checks/check.sh <name>`. Each one exits 0 when it passes.
# Every check sends its own requests with fresh accounts, so the learner's own experiments do not matter.
# Checks that sign in as alice run on the shop host: once task 18 rate limits sign-ins per address, the
# attacker's address may be throttled for a minute, and a check must not depend on that.
S=http://shop:8080
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# login USER PASSWORD JAR: sign in, keeping the cookies in JAR. The session is reused across checks while it is
# valid, so the checks themselves stay far below the sign-in rate limit.
login() {
  local cache=/tmp/.check-$1.jar
  if [ -f "$cache" ] && [ "$(code -b "$cache" "$S/api/me")" = 200 ]; then cp "$cache" "$3"; return; fi
  curl -s -m5 -o /dev/null -c "$3" -d "username=$1&password=$2" "$S/login"
  cp "$3" "$cache"
}
# newuser JAR: register a fresh customer and keep the session in JAR
newuser() { curl -s -m5 -o /dev/null -D "$T/reg-headers" -c "$1" -d "username=chk$RANDOM$RANDOM&password=check-password-1" "$S/register"; }
code() { curl -s -m8 -o /dev/null -w '%{http_code}' "$@"; }
get() { curl -s -m8 "$@"; }

case "$1" in
  idor-blocked)
    login alice wonderland "$T/a"
    [ "$(code -b "$T/a" "$S/api/orders/1003")" = 404 ] ;;
  idor-own)
    login alice wonderland "$T/a"
    get -b "$T/a" "$S/api/orders/1001" | grep -q 'Ring the bell' || exit 1
    newuser "$T/n"
    [ "$(code -b "$T/n" "$S/api/orders/1001")" = 404 ] ;;

  massassign-attack)   # on shop
    [ "$(sqlite3 /work/data/shop.db "select count(*) from users where is_admin = 1 and username in ('alice','bob','carol')")" -ge 1 ] ;;
  massassign-blocked)
    newuser "$T/n"
    curl -s -m5 -o /dev/null -b "$T/n" -X PUT "$S/api/me" -H 'Content-Type: application/json' \
      -d '{"id":1,"username":"admin","displayName":"Checker","email":"checker@customer.example","isAdmin":true,"supportPin":"x"}'
    get -b "$T/n" "$S/api/me" | jq -e '.isAdmin == false and .username != "admin"' >/dev/null ;;
  massassign-works)
    newuser "$T/n"
    curl -s -m5 -o /dev/null -b "$T/n" -X PUT "$S/api/me" -H 'Content-Type: application/json' \
      -d '{"displayName":"Renamed Checker","email":"renamed@customer.example"}'
    get -b "$T/n" "$S/api/me" | jq -e '.displayName == "Renamed Checker" and .email == "renamed@customer.example"' >/dev/null ;;

  sqli-blocked)
    for q in "' UNION SELECT id, username || ':' || password_hash, 0 FROM users--" "%' OR 1=1--" "' OR hidden = 1--" \
             "x' UNION SELECT 1, sqlite_version(), 1--"; do
      out=$(get -G "$S/api/products/search" --data-urlencode "q=$q")
      echo "$out" | grep -qiE 'admin:|[0-9a-f]{64}|Prototype|"name":"3\.' && exit 1
    done
    exit 0 ;;
  sqli-works)
    get -G "$S/api/products/search" --data-urlencode "q=lamp" | jq -e 'map(.name) | index("Desk lamp") != null and index("Floor lamp") != null' >/dev/null || exit 1
    get -G "$S/api/products/search" --data-urlencode "q=O'Clock" | jq -e 'length == 1 and .[0].name == "Night Owl O'"'"'Clock Lamp"' >/dev/null ;;

  xss-probe)   # on bot: a real browser opens a page with payloads in it
    bot-probe > /tmp/probe.txt 2>/tmp/probe.err || { cat /tmp/probe.err; exit 1; }
    grep -qx script-blocked /tmp/probe.txt ;;
  xss-cookie)  # on bot, after xss-probe
    grep -qx cookie-httponly /tmp/probe.txt ;;
  xss-page)    # on bot, after xss-probe
    grep -qx page-script-ok /tmp/probe.txt ;;
  xss-encoded)
    newuser "$T/n"
    curl -s -m5 -o /dev/null -b "$T/n" -X POST "$S/api/reviews" -H 'Content-Type: application/json' \
      -d '{"productId":3,"body":"Check <script>alert(7)</script> & <b>bold</b>"}'
    get "$S/products/3" > "$T/page"
    grep -q '&lt;script&gt;alert(7)&lt;/script&gt;' "$T/page" && ! grep -q '<script>alert(7)' "$T/page" ;;
  xss-csp)
    get -D "$T/h" -o "$T/page" "$S/products/3"
    csp=$(grep -i '^content-security-policy:' "$T/h" | tr -d '\r')
    nonce=$(echo "$csp" | grep -o "'nonce-[^']*'" | head -1 | sed "s/'nonce-//; s/'//")
    [ -n "$nonce" ] || exit 1
    echo "$csp" | grep -qi "unsafe-inline" && exit 1
    # Razor encodes + / = in attributes as &#x2B; &#x2F; &#x3D; (the browser decodes them): compare decoded.
    sed -e 's/&#x2B;/+/g' -e 's|&#x2F;|/|g' -e 's/&#x3D;/=/g' "$T/page" | grep -qF "<script nonce=\"$nonce\">" ;;

  csrf-attack)   # on shop
    sqlite3 /work/data/shop.db "select email from users where username = 'admin'" | grep -qi '@evil\.example$' ;;
  csrf-get)
    newuser "$T/n"
    curl -s -m5 -o /dev/null -b "$T/n" "$S/account/email?email=csrf-get@evil.example"
    ! get -b "$T/n" "$S/api/me" | grep -q 'csrf-get@evil' ;;
  csrf-notoken)
    newuser "$T/n"
    curl -s -m5 -o /dev/null -b "$T/n" -d 'email=csrf-post@evil.example' "$S/account/email"
    ! get -b "$T/n" "$S/api/me" | grep -q 'csrf-post@evil' ;;
  csrf-works)
    newuser "$T/n"
    get -b "$T/n" -c "$T/n" "$S/account" > "$T/page"
    field=$(grep -o 'name="__RequestVerificationToken" value="[^"]*"' "$T/page" | head -1 | sed 's/.*value="//; s/"$//')
    [ -n "$field" ] || field=$(grep -oE 'type="hidden" name="[^"]+" value="[^"]+"' "$T/page" | head -1 | sed 's/.*value="//; s/"$//')
    [ -n "$field" ] || exit 1
    name=$(grep -oE 'type="hidden" name="[^"]+"' "$T/page" | head -1 | sed 's/.*name="//; s/"$//')
    curl -s -m5 -o /dev/null -b "$T/n" -c "$T/n" --data-urlencode "$name=$field" --data-urlencode 'email=legit@customer.example' "$S/account/email"
    get -b "$T/n" "$S/api/me" | grep -q 'legit@customer.example' ;;
  csrf-samesite)
    newuser "$T/n"
    grep -i '^set-cookie: sid=' "$T/reg-headers" | grep -qiE 'samesite=(lax|strict)' ;;

  ssrf-blocked)
    for u in "http://169.254.169.254/latest/meta-data/iam/security-credentials/shop-web-role" \
             "http://2852039166/latest/meta-data/iam/security-credentials/shop-web-role" \
             "http://0xa9fea9fe/latest/meta-data/iam/security-credentials/shop-web-role" \
             "http://cdn.shop.example@169.254.169.254/latest/meta-data/iam/security-credentials/shop-web-role" \
             "http://cdn.shop.example/redirect?to=http://169.254.169.254/latest/meta-data/iam/security-credentials/shop-web-role" \
             "http://payments.internal:9100/v1/health" "file:///etc/passwd"; do
      out=$(get -G "$S/api/preview" --data-urlencode "url=$u")
      echo "$out" | grep -qE 'LABKEY|AccessKeyId|root:x|"ok"' && exit 1
    done
    exit 0 ;;
  ssrf-works)
    get -G "$S/api/preview" --data-urlencode "url=http://cdn.shop.example/specs/desk-lamp.html" | jq -e '.title == "Desk lamp spec sheet"' >/dev/null ;;

  traversal-blocked)
    login alice wonderland "$T/a"
    for f in "../../../etc/passwd" "/etc/passwd" "....//....//....//etc/passwd" "../invoices-old/ledger.txt" "/proc/self/environ" \
             "invoice-1001.txt/../../../../etc/passwd"; do
      out=$(get -b "$T/a" -G "$S/api/invoices/download" --data-urlencode "file=$f")
      echo "$out" | grep -qE 'root:x|Supplier|DEPLOY_TOKEN' && exit 1
    done
    out=$(get -b "$T/a" "$S/api/invoices/download?file=..%2f..%2f..%2fetc%2fpasswd")
    ! echo "$out" | grep -q 'root:x' ;;
  traversal-works)
    login alice wonderland "$T/a"
    get -b "$T/a" -G "$S/api/invoices/download" --data-urlencode "file=invoice-1001.txt" | grep -q 'invoice 1001' ;;

  cmdi-blocked)
    login alice wonderland "$T/a"
    for h in '127.0.0.1; id' '127.0.0.1 && id' '$(id)' '`id`' '127.0.0.1 | id' $'127.0.0.1\nid' '-c 1 127.0.0.1; id'; do
      out=$(get -b "$T/a" -G "$S/api/tools/ping" --data-urlencode "host=$h")
      echo "$out" | grep -q 'uid=' && exit 1
    done
    exit 0 ;;
  cmdi-works)
    login alice wonderland "$T/a"
    get -b "$T/a" -G "$S/api/tools/ping" --data-urlencode "host=127.0.0.1" | grep -q '1 packets transmitted' ;;

  ratelimit-works)   # on internal (an address nobody else signs in from)
    [ "$(code -d 'username=alice&password=wonderland' "$S/login")" = 302 ] ;;
  ratelimit-blocks)  # on attacker
    for i in $(seq 1 12); do code -d "username=carol&password=wrong-$i" "$S/login"; echo; done > "$T/codes"
    grep -q 429 "$T/codes" ;;

  rotate-revoked)    # on shop
    [ "$(curl -s -m5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat /opt/dojo/leaked.key)" http://payments.internal:9100/v1/health)" = 401 ] ;;
  rotate-works)      # on shop
    [ "$(tr -d '[:space:]' < /work/secrets/payments.key)" != "$(tr -d '[:space:]' < /opt/dojo/leaked.key)" ] || exit 1
    curl -s -m5 http://127.0.0.1:8080/api/checkout/health | jq -e '.payments == "ok"' >/dev/null ;;

  errors-hidden)
    get "$S/api/products/999999" > "$T/body"
    ! grep -qE 'Exception|   at |Microsoft\.|/work/shop' "$T/body" ;;
  headers-set)
    get -D "$T/h" -o /dev/null "$S/"
    grep -qi '^x-content-type-options: nosniff' "$T/h" || exit 1
    grep -qi '^referrer-policy:' "$T/h" || exit 1
    grep -qiE '^x-frame-options: (deny|sameorigin)|^content-security-policy:.*frame-ancestors' "$T/h" ;;
  server-hidden)
    get -D "$T/h" -o /dev/null "$S/"
    ! grep -qi '^server:' "$T/h" ;;

  *) echo "unknown check $1" >&2; exit 2 ;;
esac
