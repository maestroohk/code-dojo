"""Fake warehouse API (v2) for the Camel + gateway lab.

POST /shipments    book a shipment: {"reference": "...", "lines": [{"sku": "...", "qty": 1}]}
GET  /stock/<sku>  how many of an item are on the shelf
GET  /_audit/<id>  every request the warehouse received that mentions <id> (for tracing)
"""
import json, os, re, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STOCK = {"LAMP-01": 42, "LAMP-02": 7, "BULB-10": 310, "CABLE-3": 55, "SHADE-5": 12}
ERRCODE = "STK-" + os.environ.get("DOJO_ERRCODE", "000")
LOG = open("/var/log/warehouse.log", "a", buffering=1)
audit, lock, seq = [], threading.Lock(), [1000]


def log(msg):
    LOG.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def skus_of(order):
    lines = order.get("lines") if isinstance(order.get("lines"), list) else order.get("items")
    return [l.get("sku") for l in lines or [] if isinstance(l, dict)]


def check(order, raw):
    """Returns (status, reply). Order of checks matters for the lab: unknown SKUs are found first."""
    if not isinstance(order, dict):
        return 400, {"error": "the body is not a JSON object"}
    ref = order.get("reference") or order.get("orderId") or "?"
    for sku in skus_of(order):
        if sku not in STOCK:
            log(f"POST /shipments order={ref} -> 422 unknown SKU {sku!r} (code {ERRCODE})")
            return 422, {"error": "unknown SKU", "code": ERRCODE}
    lines = order.get("lines")
    if not isinstance(order.get("reference"), str) or not isinstance(lines, list) or not lines \
            or not all(isinstance(l, dict) and isinstance(l.get("sku"), str) and isinstance(l.get("qty"), int) and l["qty"] > 0 for l in lines):
        log(f"POST /shipments order={ref} -> 400 wrong shape: warehouse API v2 needs reference and lines[] with sku and qty")
        return 400, {"error": "warehouse API v2 needs {reference, lines: [{sku, qty}]}"}
    if "paymentToken" in raw:
        log(f"POST /shipments order={ref} -> 422 refused: the body contains payment data")
        return 422, {"error": "payment data must never be sent to the warehouse"}
    with lock:
        seq[0] += 1
        shipment = f"SHP-{seq[0]}"
    log(f"POST /shipments order={ref} -> 201 shipment {shipment}")
    return 201, {"shipment": shipment, "reference": order["reference"], "warehouse": "north-1"}


class Handler(BaseHTTPRequestHandler):
    server_version = "warehouse/2.3"

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Internal-Host", "wh-rack-07.north.backend.lab")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        m = re.fullmatch(r"/stock/([A-Za-z0-9-]+)", self.path)
        if m:
            sku = m.group(1)
            log(f"GET {self.path} -> {200 if sku in STOCK else 404}")
            return self.reply(200, {"sku": sku, "available": STOCK[sku], "warehouse": "north-1"}) if sku in STOCK \
                else self.reply(404, {"error": "no such SKU", "sku": sku})
        m = re.fullmatch(r"/_audit/([A-Za-z0-9._-]+)", self.path)
        if m:
            with lock:
                hits = [a for a in audit if m.group(1) in a["body"]]
            return self.reply(200, {"requests": hits})
        log(f"GET {self.path} -> 404")
        self.reply(404, {"error": "not found", "path": self.path})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8", "replace")
        if self.path != "/shipments":
            log(f"POST {self.path} -> 404 (the warehouse only takes POST /shipments)")
            return self.reply(404, {"error": "not found", "path": self.path})
        try:
            order = json.loads(raw)
        except ValueError:
            order = None
        code, body = check(order, raw)
        with lock:
            audit.append({"time": time.time(), "status": code, "body": raw,
                          "headers": {k.lower(): v for k, v in self.headers.items()}})
            del audit[:-500]
        self.reply(code, body)

    def log_message(self, *args):
        pass


log("warehouse API v2 listening on :9000")
ThreadingHTTPServer(("0.0.0.0", 9000), Handler).serve_forever()
