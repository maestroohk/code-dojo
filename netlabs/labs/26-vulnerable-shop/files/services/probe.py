"""The lab's XSS check (run by Check on the bot host): a fresh browser signs in as staff, a test review with two
classic payloads is posted, and the browser opens the page. Prints one line per finding:

  script-ran / script-blocked      did either payload run?
  cookie-readable / cookie-httponly  can page scripts read the session cookie?
  page-script-ok / page-script-broken  does the page's own script still run (CSP nonce)?
"""
import random
import sys
import time

sys.path.insert(0, "/lab/services")
import botlib  # noqa: E402

PRODUCT = 4


def main():
    mark = "xss-probe-%06d" % random.randint(0, 999999)
    d = botlib.browser()
    try:
        botlib.login(d)
        payload = ('Probe review <img src=x onerror="document.title=\'%s\'"> '
                   '<script>document.title=\'%s\'</script>' % (mark, mark))
        botlib.api("/api/reviews", botlib.sid(d), "POST", {"productId": PRODUCT, "body": payload})
        d.get(botlib.SHOP + "/products/%d" % PRODUCT)
        time.sleep(1.5)
        print("script-ran" if d.title == mark else "script-blocked")
        cookies = d.execute_script("return document.cookie") or ""
        print("cookie-readable" if "sid=" in cookies else "cookie-httponly")
        ready = d.execute_script("return document.body.dataset.ready || ''")
        print("page-script-ok" if ready == "1" else "page-script-broken")
    finally:
        d.quit()


if __name__ == "__main__":
    main()
