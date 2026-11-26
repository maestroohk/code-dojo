"""The shop's internal neighbours, all on the 'internal' host. None of them is reachable from the attacker.

  169.254.169.254:80   a cloud metadata service (shaped like the AWS IMDSv1 one): instance details and the
                       temporary credentials of the role the shop runs with. Real clouds serve it at this address.
  cdn.shop.example:80  the shop's static content server (spec sheets). It also has an open redirect.
  payments.internal:9100  the payments provider's API: a health check and key rotation.
"""
import http.server
import json
import os
import re
import secrets
import socketserver
import sys
import threading
import urllib.parse

AKID = "LABKEY" + os.environ.get("DOJO_AKID", "0")
PAYKEY = "pay_live_" + re.sub(r"[^0-9a-f]", "", os.environ.get("DOJO_PAYKEY", "0")) + "c41d07e9"
valid_keys = {PAYKEY}
lock = threading.Lock()


def log(msg):
    print(msg, flush=True)


class Base(http.server.BaseHTTPRequestHandler):
    server_version = "internal/1.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        log("%s %s %s" % (self.address_string(), self.name, fmt % args))

    def send(self, code, body, ctype="text/plain", headers=None):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)


class Metadata(Base):
    name = "metadata"
    tree = {
        "/latest/meta-data/": "ami-id\nhostname\ninstance-id\niam/\nlocal-ipv4\n",
        "/latest/meta-data/ami-id": "ami-0lab0000000000000",
        "/latest/meta-data/hostname": "shop-web-1.shop.internal",
        "/latest/meta-data/instance-id": "i-0lab00000000shop1",
        "/latest/meta-data/local-ipv4": "10.66.2.20",
        "/latest/meta-data/iam/": "security-credentials/\n",
        "/latest/meta-data/iam/security-credentials/": "shop-web-role\n",
    }

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/", "/latest", "/latest/"):
            return self.send(200, "meta-data/\nuser-data\n")
        if path.rstrip("/") == "/latest/meta-data/iam/security-credentials/shop-web-role":
            creds = {
                "Code": "Success", "Type": "AWS-HMAC", "LastUpdated": "2026-11-27T06:00:00Z",
                "AccessKeyId": AKID,
                "SecretAccessKey": "lab-only-secret-" + secrets.token_hex(8),
                "Token": "lab-only-session-token",
                "Expiration": "2026-11-27T12:00:00Z",
            }
            return self.send(200, json.dumps(creds, indent=2), "application/json")
        if path == "/latest/user-data":
            return self.send(200, "#!/bin/bash\necho 'boot the shop'\n")
        if path in self.tree:
            return self.send(200, self.tree[path])
        return self.send(404, "Not Found")


class Cdn(Base):
    name = "cdn"

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/specs/desk-lamp.html":
            return self.send(200, "<!doctype html><title>Desk lamp spec sheet</title><h1>Desk lamp</h1><p>2700 K, 806 lm, 5 W.</p>", "text/html")
        if u.path == "/specs/floor-lamp.html":
            return self.send(200, "<!doctype html><title>Floor lamp spec sheet</title><h1>Floor lamp</h1><p>Dimmable, 1521 lm.</p>", "text/html")
        if u.path == "/redirect":
            # An open redirect: an old marketing feature. /redirect?to=<anywhere>
            to = urllib.parse.parse_qs(u.query).get("to", ["/"])[0]
            return self.send(302, "", headers={"Location": to})
        return self.send(404, "Not Found")


class Payments(Base):
    name = "payments"

    def key(self):
        h = self.headers.get("Authorization", "")
        return h[7:].strip() if h.startswith("Bearer ") else ""

    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path == "/v1/health":
            with lock:
                ok = self.key() in valid_keys
            return self.send(200 if ok else 401, json.dumps({"ok": ok}), "application/json")
        return self.send(404, "Not Found")

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path == "/v1/keys/rotate":
            with lock:
                old = self.key()
                if old not in valid_keys:
                    return self.send(401, json.dumps({"error": "unknown key"}), "application/json")
                new = "pay_live_" + secrets.token_hex(16)
                valid_keys.discard(old)
                valid_keys.add(new)
            log("payments: key rotated, the old key is revoked")
            return self.send(200, json.dumps({"key": new, "revoked": old[:12] + "..."}), "application/json")
        return self.send(404, "Not Found")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(addr, port, handler):
    srv = Server((addr, port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log("listening on %s:%d (%s)" % (addr, port, handler.name))


if __name__ == "__main__":
    serve(sys.argv[1], 80, Metadata)    # 169.254.169.254
    serve(sys.argv[2], 80, Cdn)         # backend address (cdn.shop.example)
    serve(sys.argv[2], 9100, Payments)  # backend address (payments.internal)
    threading.Event().wait()
