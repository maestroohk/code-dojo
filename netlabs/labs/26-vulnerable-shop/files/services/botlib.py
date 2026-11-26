"""Shared by the admin bot and the lab's probe: a real headless Chromium, driven with Selenium.

Chromium enforces everything a browser does (HttpOnly, SameSite, CSP), which is why the lab uses a real one."""
import json
import os
import urllib.request

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By

SHOP = "http://shop:8080"
ADMIN_PW = "Adm!n-" + os.environ.get("DOJO_ADMINPW", "1")


def browser():
    os.environ.setdefault("SE_OFFLINE", "true")
    o = Options()
    o.binary_location = "/usr/bin/chromium"
    for a in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
              "--disable-extensions", "--disable-background-networking", "--disable-sync", "--mute-audio",
              "--js-flags=--max-old-space-size=128", "--window-size=1000,800"):
        o.add_argument(a)
    o.set_capability("unhandledPromptBehavior", "dismiss")  # alert(1) in a review must not stop the staff member
    d =webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=o)
    d.set_page_load_timeout(10)
    d.set_script_timeout(5)
    return d


def login(d, username="admin", password=None):
    d.get(SHOP + "/login")
    d.find_element(By.NAME, "username").send_keys(username)
    d.find_element(By.NAME, "password").send_keys(password or ADMIN_PW)
    d.find_element(By.CSS_SELECTOR, "form button").click()


def sid(d):
    c = d.get_cookie("sid")
    return c["value"] if c else ""


def api(path, cookie="", method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SHOP + path, data=data, method=method)
    if cookie:
        req.add_header("Cookie", "sid=" + cookie)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as r:
        text = r.read().decode() or "null"
        return r.status, json.loads(text) if text.strip()[:1] in "[{" else text
