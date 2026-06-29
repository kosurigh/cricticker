#!/usr/bin/env python3
"""
Local test server for the CricHeroes ticker.

Does two jobs:
  1. Serves the static overlay (ticker.html and friends) from this folder.
  2. Proxies  GET /api/<matchId>  ->  the CricHeroes "thirdparty" summary API,
     adding the browser-like headers the API expects and a permissive CORS
     header so the overlay (running in a browser) can read the JSON.

No third-party packages, no Node — just Python 3 standard library.

    python3 dev-server.py
    # then open http://localhost:8080/ticker.html?id=25801383

The production equivalent of the /api proxy is worker.js (Cloudflare Worker).
"""

import json
import uuid
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
import os
import sys

PORT = int(os.environ.get("PORT", "8080"))
API_BASE = "https://api.cricheroes.in/api/v1/scorecard/get-mini-scorecard/"
# Full per-player scorecard (used for the end-of-match scorecard view).
SCORECARD_BASE = "https://api.cricheroes.in/api/v1/scorecard/v2/get-scorecard/"

# The same headers the official web ticker sends. A real browser User-Agent is
# what gets us past Cloudflare's bot filter — there is no challenge to solve.
UDID = str(uuid.uuid4())
UPSTREAM_HEADERS = {
    "api-key": "cr!CkH3r0s",
    "udid": UDID,
    "device-type": "3",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    ),
    "Referer": "https://webticker.cricheroes.com/",
    "Origin": "https://webticker.cricheroes.com",
    "Accept": "application/json",
}


class Handler(BaseHTTPRequestHandler):
    # Quieter logging.
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api()
        # Fall through to static file serving (SimpleHTTPRequestHandler).
        return super().do_GET()

    # ---- /api/<id> (live) and /api/sc/<id> (full scorecard) proxy --------
    def handle_api(self):
        rest = self.path[len("/api/"):].split("?")[0].strip("/")
        if rest.startswith("sc/"):
            base, match_id = SCORECARD_BASE, rest[len("sc/"):]
        else:
            base, match_id = API_BASE, rest
        if not match_id.isdigit():
            return self._json(400, {"status": False, "error": "bad match id"})

        req = urllib.request.Request(base + match_id, headers=UPSTREAM_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                body = r.read()
                code = r.status
        except urllib.error.HTTPError as e:
            body, code = e.read(), e.code
        except Exception as e:  # noqa: BLE001
            return self._json(502, {"status": False, "error": str(e)})

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    os.chdir(here)
    # SimpleHTTPRequestHandler serves static files; our Handler adds /api.
    from http.server import SimpleHTTPRequestHandler

    class App(Handler, SimpleHTTPRequestHandler):
        pass

    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), App)
    print(f"Ticker dev server on  http://localhost:{PORT}")
    print(f"Try:                  http://localhost:{PORT}/ticker.html?id=25801383")
    print(f"(udid for this run: {UDID})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
