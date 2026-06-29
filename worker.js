/**
 * Cloudflare Worker — CricHeroes ticker proxy (production).
 *
 * GitHub Pages can only serve static files, so the overlay needs a tiny
 * server-side helper to (a) add the headers the CricHeroes API expects and
 * (b) add a CORS header so the browser overlay may read the JSON.
 *
 * Deploy (free):
 *   npm i -g wrangler        # one time
 *   wrangler login
 *   wrangler deploy          # uses wrangler.toml in this folder
 * Then point the overlay at it:
 *   ticker.html?id=25801383&api=https://cricticker.<you>.workers.dev/
 *
 * Usage:  GET /<matchId>        e.g.  /25801383
 *         GET /?id=<matchId>
 */

const API =
  "https://api.cricheroes.in/api/v1/scorecard/get-mini-scorecard/";
const SCORECARD =
  "https://api.cricheroes.in/api/v1/scorecard/v2/get-scorecard/";

const UPSTREAM_HEADERS = {
  "api-key": "cr!CkH3r0s",
  "udid": "8df0c0de-0000-4000-8000-cric0heroes00", // any stable UUID is fine
  "device-type": "3",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1.15",
  "Referer": "https://webticker.cricheroes.com/",
  "Origin": "https://webticker.cricheroes.com",
  "Accept": "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    // /sc/<id> -> full scorecard;  /<id> or ?id= -> live mini-scorecard
    const full = parts[0] === "sc";
    const id = url.searchParams.get("id") || (full ? parts[1] : parts[parts.length - 1]);

    if (!id || !/^\d+$/.test(id)) {
      return json({ status: false, error: "pass a numeric match id" }, 400);
    }

    let upstream;
    try {
      upstream = await fetch((full ? SCORECARD : API) + id, { headers: UPSTREAM_HEADERS });
    } catch (e) {
      return json({ status: false, error: String(e) }, 502);
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
