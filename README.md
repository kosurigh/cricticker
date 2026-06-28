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
# open http://localhost:8080/ticker.html?id=25801383&bg=078BDC&demo=1
```

`dev-server.py` serves the overlay **and** proxies `/api/<id>` to CricHeroes.

> **Transparency:** `&demo=1` paints a green backdrop *only* so you can preview
> the translucent bar outside OBS. Everything above the bottom bar is fully
> transparent — **drop `&demo=1` for the real overlay** and your video shows
> through everywhere above the bar.

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

Then set this URL **once** as `DEFAULT_API` at the top of `ticker.html`, so match
URLs don't need an `&api=` parameter:

```js
var DEFAULT_API = "https://cricticker.YOURNAME.workers.dev/";
```

### 2. Publish the overlay (GitHub Pages)

```bash
cd /Users/kosuri/git/cric-ticker
git init && git add index.html ticker.html README.md assets && git commit -m "Cric ticker"
gh repo create cricticker --public --source=. --push
gh api -X POST repos/{owner}/cricticker/pages -f 'source[branch]=main' -f 'source[path]=/'
```

Pages goes live at `https://YOURNAME.github.io/cricticker/` in ~1 minute.
(`assets/team-logos/` ships the crests; regenerate its `manifest.json` with the
snippet in **Team logos** below whenever you add files.)

---

## Use it in OBS / Streamlabs / PRISM

Add a **Browser Source**, size **1920×1080**, and use this short URL — only the
match ID and bar colour ever change:

```
https://YOURNAME.github.io/cricticker/ticker.html?id=<MATCH_ID>&bg=<HEX>
```

e.g. `…/ticker.html?id=25801306&bg=078BDC` → translucent royal-blue bar with a
matching deep-navy score box. Add `&provider=streamlabs` (or `&prism`) so long
batsman names aren't clipped in those apps. Open `index.html` (the setup page) to
generate this URL with a colour picker and app selector.

> **Note on the colour:** put the hex **without** a leading `#` — in a URL `#`
> starts the fragment and would be dropped. `bg=078BDC`, not `bg=#078BDC`.

### URL options

| Param      | Default       | Notes                                                          |
|------------|---------------|----------------------------------------------------------------|
| `id`       | `25801383`    | Match ID from the scorecard URL                                |
| `bg`       | dark          | 6- or 8-digit hex (no `#`); translucent bar. Score box is auto-tinted to a deep shade of it. |
| `provider` | off (large)   | `streamlabs` or `prism` — compacts text + logos so long names fit |
| `theme`    | `default`     | Batsman accent: `blue` · `purple` · `dark` · `gold`            |
| `refresh`  | `8`           | Seconds between updates (min 5)                                |
| `api`      | `DEFAULT_API` | Override the Worker URL (rarely needed)                        |
| `demo`     | off           | `1` = green backdrop to preview translucency locally           |

The match ID is the number in any scorecard URL:
`cricheroes.com/scorecard/`**`25801383`**`/mega-smash/…`

### Team logos

Corner logos load from `assets/team-logos/`, matched to the API team name by a
normalised key (lower-case, alphanumerics only) via `manifest.json`. Unmatched
teams fall back to the CricHeroes logo, then to an initials circle. Regenerate
the manifest after adding/renaming files:

```bash
python3 - <<'PY'
import os, json, re
d="assets/team-logos"
norm=lambda s: re.sub(r'[^a-z0-9]','',s.lower())
m={}
for f in sorted(os.listdir(d)):
    if f.lower().endswith(('.png','.jpg','.jpeg','.webp','.svg')):
        m.setdefault(norm(os.path.splitext(f)[0]), f)
json.dump(m, open(d+"/manifest.json","w"), indent=0, sort_keys=True)
print(len(m),"logos")
PY
```

---

## Notes

- Use a reasonable `refresh` (10s is plenty) — it's polite to the API and
  smooth enough for a live score bar.
- This reads publicly visible scorecard data for your own broadcast. Respect
  CricHeroes' terms of service.
