#!/usr/bin/env python3
# A small ticketing and health API for the REST lessons, on 127.0.0.1 only (the step's machine has no network).
#   GET  /api/tickets?page=N   needs "Authorization: Bearer <token in /opt/dojo/state/api-token>"; 3 pages of tickets,
#                              each page {"items": [...], "page": N, "next": "<url or null>"}, plus a Link: rel="next" header
#   GET  /api/flaky            503 for the first two calls (Retry-After: 1), then 200 {"report": "ready"}; /api/flaky/reset
#   GET  /health               {"status": "ok"}; on the "billing" port the status comes from /opt/dojo/state/billing-health
#   GET  /slow                 answers after 20 s (for -TimeoutSec)
#   GET  /delay?ms=N&id=X      answers {"id": X, "ok": true} after N ms (for parallel calls); 429 when more than 8 run at once
#   GET  /stats                how many calls each path got (the checks read it)
# Usage: api.py PORT [NAME]
import http.server, json, os, sys, threading, time, urllib.parse

PORT = int(sys.argv[1]); NAME = sys.argv[2] if len(sys.argv) > 2 else "tickets"
STATE = "/opt/dojo/state"
lock = threading.Lock()
calls = {}
flaky = {"n": 0}
active = {"n": 0, "max": 0}

def tickets():
    pri = ["low", "normal", "high", "urgent"]
    st = ["open", "open", "closed", "open", "pending"]
    return [{"id": 1000 + i, "title": f"Ticket {1000 + i}: " + ["disk full", "cert expiring", "login slow", "backup failed",
             "VPN drops", "printer offline", "queue backlog"][i % 7], "priority": pri[(i * 3) % 4], "status": st[i % 5]}
            for i in range(47)]

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def send(self, code, obj, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        with lock: calls[u.path] = calls.get(u.path, 0) + 1
        if u.path == "/stats": return self.send(200, calls)
        if u.path == "/health":
            status = "ok"
            if NAME == "billing" and os.path.exists(f"{STATE}/billing-health"):
                status = open(f"{STATE}/billing-health").read().strip()
            return self.send(200 if status == "ok" else 503, {"service": NAME, "status": status})
        if u.path == "/slow":
            time.sleep(20); return self.send(200, {"slow": True})
        if u.path == "/delay":
            with lock: active["n"] += 1; now = active["n"]; active["max"] = max(active["max"], now)
            try:
                if now > 8: return self.send(429, {"error": "too many concurrent requests"}, {"Retry-After": "1"})
                time.sleep(int(q.get("ms", ["1000"])[0]) / 1000)
                return self.send(200, {"id": q.get("id", [""])[0], "ok": True})
            finally:
                with lock: active["n"] -= 1
        if u.path == "/active": return self.send(200, active)
        if u.path == "/api/flaky/reset":
            flaky["n"] = 0; return self.send(200, {"reset": True})
        if u.path == "/api/flaky":
            with lock: flaky["n"] += 1; n = flaky["n"]
            if n <= 2: return self.send(503, {"error": "report is being generated"}, {"Retry-After": "1"})
            return self.send(200, {"report": "ready", "rows": 1280, "attempt": n})
        if u.path == "/api/tickets":
            token = open(f"{STATE}/api-token").read().strip()
            if self.headers.get("Authorization", "") != f"Bearer {token}":
                return self.send(401, {"error": "missing or invalid bearer token"}, {"WWW-Authenticate": "Bearer"})
            page = int(q.get("page", ["1"])[0]); size = 20; all_ = tickets()
            items = all_[(page - 1) * size: page * size]
            nxt = f"http://127.0.0.1:{PORT}/api/tickets?page={page + 1}" if page * size < len(all_) else None
            return self.send(200, {"items": items, "page": page, "next": nxt}, {"Link": f'<{nxt}>; rel="next"'} if nxt else {})
        self.send(404, {"error": "not found"})

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
