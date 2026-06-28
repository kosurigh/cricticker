# CricHeroes Live Ticker

A transparent lower-third score ticker for **OBS / Streamlabs / PRISM Live Studio**,
driven by live data from any CricHeroes match.

It reads the same JSON the official CricHeroes web ticker uses
(`api.cricheroes.in/.../get-mini-scorecard/<matchId>`) and renders a clean
broadcast lower-third:

- **Striker** (▶) and **non-striker** with runs (balls)
- Compact centre score pill: `BAT v BOW   <score>   <overs>` with the
  tournament name small underneath (no wasted space)
- **Current bowler** with figures (wkts-runs, overs) and the **recent-over**
  ball-by-ball dots (boundaries and wickets colour-coded)
- In the **second innings**, the live chase equation —
  e.g. "Need 106 runs in 98 balls • RRR 6.49"
- Special states (FREE HIT, INNINGS BREAK) shown in the centre when active

There is **no Cloudflare challenge to solve** — the API just rejects non-browser
requests, so a tiny proxy adds a normal browser `User-Agent` + the ticker's
`api-key`/`udid`/`device-type` headers and a CORS header. That's the only
server-side piece; GitHub Pages serves the rest as static files.

```
index.html      Setup page — paste a match ID, get a browser-source URL
ticker.html     The actual overlay (what you put in OBS)
dev-server.py    Local test server + proxy (Python 3, no dependencies)
worker.js        Production proxy — a Cloudflare Worker
wrangler.toml    Worker config
```

---

## Test it locally (no install needed)

```bash
python3 dev-server.py
# open http://localhost:8080/ticker.html?id=25801383&bg=1
```

`dev-server.py` serves the overlay **and** proxies `/api/<id>` to CricHeroes.

> **Transparency:** `&bg=1` paints a green demo backdrop *only* so you can see
> the bar outside OBS. The overlay itself is fully transparent except the bottom
> bar — **drop `&bg=1` for the real overlay** and your video shows through
> everywhere above the bar.

---

## Deploy (two short steps)

GitHub Pages can't run server code, so the proxy lives in a free Cloudflare
Worker and the overlay lives on Pages.

### 1. Deploy the proxy (Cloudflare Worker — free)

```bash
npm install -g wrangler      # one-time (needs Node; `brew install node`)
wrangler login               # opens browser
wrangler deploy              # reads wrangler.toml
```

Copy the URL it prints, e.g. `https://cricticker.YOURNAME.workers.dev`.
Verify: `https://cricticker.YOURNAME.workers.dev/25801383` should return JSON.

> No Node? You can paste `worker.js` into a new Worker in the Cloudflare
> dashboard (Workers & Pages → Create → Edit code) and click Deploy.

### 2. Publish the overlay (GitHub Pages)

```bash
cd /Users/kosuri/git/cric-ticker
git init && git add index.html ticker.html README.md && git commit -m "Cric ticker"
gh repo create cricticker --public --source=. --push
gh api -X POST repos/{owner}/cricticker/pages -f 'source[branch]=main' -f 'source[path]=/'
```

Pages goes live at `https://YOURNAME.github.io/cricticker/` in ~1 minute.

---

## Use it in OBS / Streamlabs / PRISM

Add a **Browser Source**, size **1920×1080**, and use:

```
https://YOURNAME.github.io/cricticker/ticker.html?id=<MATCH_ID>&api=https://cricticker.YOURNAME.workers.dev/
```

Open `index.html` (the setup page) to generate this URL by filling in the match
ID — no hand-editing per game.

### URL options

| Param     | Default       | Notes                                                        |
|-----------|---------------|--------------------------------------------------------------|
| `id`      | `25801383`    | Match ID from the scorecard URL                              |
| `api`     | `/api/`       | Your Worker URL in production; same-origin for local testing |
| `theme`   | `default`     | `default` · `blue` · `purple` · `dark` · `gold`              |
| `refresh` | `10`          | Seconds between updates (min 5)                              |
| `bg`      | off           | `1` = demo backdrop (local preview only)                     |

The match ID is the number in any scorecard URL:
`cricheroes.com/scorecard/`**`25801383`**`/mega-smash/…`

---

## Notes

- Use a reasonable `refresh` (10s is plenty) — it's polite to the API and
  smooth enough for a live score bar.
- This reads publicly visible scorecard data for your own broadcast. Respect
  CricHeroes' terms of service.
