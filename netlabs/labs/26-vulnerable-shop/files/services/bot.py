"""The admin bot: a member of staff who is always signed in, in a real (headless) Chromium.

- When a new review is posted, they open that product's page to moderate it.
- When a support ticket comes in, they open the link in it.
Everything they do is logged to /var/log/bot.log. The bot only ever visits hosts inside the lab."""
import sys
import time
import urllib.error
import urllib.parse

sys.path.insert(0, "/lab/services")
import botlib  # noqa: E402

ALLOWED_HOSTS = {"shop", "attacker"}


def log(msg):
    print(time.strftime("%H:%M:%S ") + msg, flush=True)


def main():
    d = None
    seen_review = None
    visits = 0
    while True:
        try:
            if d is None or visits >= 40:  # a fresh browser now and then keeps memory low
                if d is not None:
                    d.quit()
                d = botlib.browser()
                visits = 0
                botlib.login(d)
                log("staff member signed in to the shop")
                open("/tmp/bot-ready", "w").close()
            cookie = botlib.sid(d)
            try:
                status, pending = botlib.api("/api/support/pending", cookie)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):  # session gone: sign in again
                    botlib.login(d)
                    log("signed in again")
                    continue
                raise
            _, latest = botlib.api("/api/reviews/latest")
            if seen_review is None:
                seen_review = latest["id"]
            if latest["id"] != seen_review:
                seen_review = latest["id"]
                d.get(botlib.SHOP + "/products/%d" % latest["productId"])
                time.sleep(3)
                visits += 1
                log("read the new review #%d on /products/%d" % (latest["id"], latest["productId"]))
            for t in pending or []:
                url = (t.get("url") or "").strip()
                host = urllib.parse.urlsplit(url).hostname or ""
                if url.startswith(("http://", "https://")) and host in ALLOWED_HOSTS:
                    log("ticket #%d: opening %s" % (t["id"], url))
                    try:
                        d.get(url)
                        time.sleep(3)
                        log("ticket #%d: the page ended at %s" % (t["id"], d.current_url))
                    except Exception as e:  # a page that never loads must not stop the bot
                        log("ticket #%d: could not open the link (%s)" % (t["id"], type(e).__name__))
                    visits += 1
                elif url:
                    log("ticket #%d: not opening %s (only shop and attacker exist in this lab)" % (t["id"], url))
                botlib.api("/api/support/%d/done" % t["id"], botlib.sid(d), method="POST")
        except urllib.error.URLError as e:
            if not isinstance(e, urllib.error.HTTPError):  # the shop is restarting: wait, keep the browser
                time.sleep(3)
                continue
            log("bot error: HTTP %s" % e.code)
        except Exception as e:
            log("bot error: %s: %s" % (type(e).__name__, str(e)[:200]))
            try:
                if d is not None:
                    d.quit()
            except Exception:
                pass
            d = None
            time.sleep(3)
        time.sleep(3)


if __name__ == "__main__":
    main()
