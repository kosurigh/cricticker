#!/usr/bin/env python3
"""
Local dev server.

    python3 dev-server.py
    # then open http://localhost:8090/

Serves the static site and stands in for the Cloudflare Worker, so "Refresh
from CricHeroes" works locally before (or instead of) deploying anything:

    GET /api/ch?path=/api/v1/tournament/get-tournament-matches/2100677

Python 3 standard library only — no install step.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8090"))
UPSTREAM = "https://api.cricheroes.in"
ALLOWED_PREFIX = "/api/v1/"

# The headers that make the CricHeroes API answer. There is no challenge to
# solve: it simply rejects anything that does not look like their web client.
UPSTREAM_HEADERS = {
    "api-key": "cr!CkH3r0s",
    "udid": str(uuid.uuid4()),
    "device-type": "3",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    ),
    "Referer": "https://cricheroes.com/",
    "Origin": "https://cricheroes.com",
    "Accept": "application/json",
}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        # ES modules are fetched with CORS semantics even same-origin in some
        # setups; this keeps local development free of surprises.
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/ch"):
            return self.proxy()
        return super().do_GET()

    def proxy(self):
        query = urllib.parse.urlparse(self.path).query
        target = urllib.parse.parse_qs(query).get("path", [""])[0]

        if target.startswith("http://") or target.startswith("https://"):
            parts = urllib.parse.urlparse(target)
            if parts.hostname != "api.cricheroes.in":
                return self._json(400, {"error": "only api.cricheroes.in is proxied"})
            target = parts.path + (("?" + parts.query) if parts.query else "")
        if not target.startswith("/"):
            target = "/" + target
        if not target.startswith(ALLOWED_PREFIX) or ".." in target:
            return self._json(400, {"error": "path must begin with " + ALLOWED_PREFIX})

        req = urllib.request.Request(UPSTREAM + target, headers=UPSTREAM_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            body, code = e.read(), e.code
        except Exception as e:  # noqa: BLE001
            return self._json(502, {"error": str(e)})

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"cricscenarios dev server -> http://localhost:{PORT}/")
    print(f"Division 7 direct        -> http://localhost:{PORT}/division.html?t=2100677&d=7")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
