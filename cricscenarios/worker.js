/**
 * Cloudflare Worker — CricHeroes read-only API proxy.
 *
 * Two problems this solves, both of which only exist in a browser:
 *   1. The CricHeroes API rejects requests that do not look like their own web
 *      client, so the headers below have to be added server-side.
 *   2. It sends no CORS header, so a page on GitHub Pages cannot read the JSON
 *      even if the request succeeds.
 *
 * Deploy (free tier is plenty):
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler deploy
 * Then put the URL it prints into assets/js/config.js as WORKER_URL.
 *
 *   GET /ch?path=/api/v1/tournament/get-tournament-matches/2100677
 *
 * `path` is deliberately open-ended within /api/v1/ rather than a fixed list of
 * routes: CricHeroes renames endpoints from time to time, and this way a rename
 * is a one-line change in the page's JavaScript instead of a Worker redeploy.
 */

const UPSTREAM_HOST = 'https://api.cricheroes.in';
const ALLOWED_PREFIX = '/api/v1/';

const UPSTREAM_HEADERS = {
  'api-key': 'cr!CkH3r0s',
  'udid': '8df0c0de-0000-4000-8000-cric0heroes00',
  'device-type': '3',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Referer': 'https://cricheroes.com/',
  'Origin': 'https://cricheroes.com',
  'Accept': 'application/json',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=120',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

    const url = new URL(request.url);
    let path = url.searchParams.get('path') || '';

    // Also accept the whole thing pasted in as an absolute CricHeroes URL.
    if (/^https?:\/\//i.test(path)) {
      try {
        const u = new URL(path);
        if (u.hostname !== 'api.cricheroes.in') {
          return json({ error: 'only api.cricheroes.in is proxied' }, 400);
        }
        path = u.pathname + u.search;
      } catch {
        return json({ error: 'unparseable path' }, 400);
      }
    }
    if (!path.startsWith('/')) path = '/' + path;

    // Refuse anything that escapes the read-only v1 surface.
    if (!path.startsWith(ALLOWED_PREFIX) || path.includes('..')) {
      return json({ error: `path must begin with ${ALLOWED_PREFIX}` }, 400);
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM_HOST + path, { headers: UPSTREAM_HEADERS });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
