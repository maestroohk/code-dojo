"""Fake payments partner for the Camel + gateway lab.

POST /charges      charge an order. The partner is busy: the first two attempts for every
                   order fail with 503, the third one works. Callers have to retry.
GET  /_audit/<id>  the attempts the partner saw for one order (for tracing)
"""
import json, re, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAILS_BEFORE_OK = 2
LOG = open("/var/log/payments.log", "a", buffering=1)
attempts, seen, lock, seq = {}, {}, threading.Lock(), [5000]


def log(msg):
    LOG.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


class Handler(BaseHTTPRequestHandler):
    server_version = "payments-partner/1.0"

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        m = re.fullmatch(r"/_audit/([A-Za-z0-9._-]+)", self.path)
        if not m:
            return self.reply(404, {"error": "not found"})
        with lock:
            times = list(attempts.get(m.group(1), []))
            headers = sorted(seen.get(m.group(1), set()))
        gaps = [round((b - a) * 1000) for a, b in zip(times, times[1:])]
        self.reply(200, {"attempts": len(times), "gaps_ms": gaps, "succeeded": len(times) > FAILS_BEFORE_OK,
                                "headers": headers})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8", "replace")
        if self.path != "/charges":
            log(f"POST {self.path} -> 404")
            return self.reply(404, {"error": "not found", "path": self.path})
        try:
            order = json.loads(raw)
            oid = str(order["orderId"])
        except (ValueError, KeyError, TypeError):
            log("POST /charges -> 400 no orderId in the body")
            return self.reply(400, {"error": "a charge needs an orderId"})
        with lock:
            attempts.setdefault(oid, []).append(time.time())
            seen.setdefault(oid, set()).update(k.lower() for k in self.headers.keys())
            n = len(attempts[oid])
            seq[0] += 1
            receipt = f"RCPT-{seq[0]}"
        if n <= FAILS_BEFORE_OK:
            log(f"POST /charges order={oid} attempt {n} -> 503 busy, try again later")
            return self.reply(503, {"error": "partner busy, try again"})
        log(f"POST /charges order={oid} attempt {n} -> 200 receipt {receipt}")
        self.reply(200, {"receipt": receipt, "orderId": oid, "status": "charged"})

    def log_message(self, *args):
        pass


log("payments partner listening on :9100")
ThreadingHTTPServer(("0.0.0.0", 9100), Handler).serve_forever()
