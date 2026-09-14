# Cric Scenarios

An interactive page that answers, for every team in a league division:

- **What are my chances of making the playoffs?**
- **What are my chances of being promoted?**
- **What are my chances of being relegated?**
- **And exactly what has to happen — mine and everyone else's results — for each of those?**

Built for [TCL Mega Smash 2026](https://cricheroes.com/tournament/2100677/point-table)
(CricHeroes tournament `2100677`, nine divisions of fourteen teams), but nothing in it is
TCL-specific: the rules, the divisions and the data source are all configuration.

```
index.html          Tournament list
tournament.html     Division list        ?t=2100677
division.html       The analysis         ?t=2100677&d=7[&team=<id>]

assets/js/engine.js      Points, net run rate, tie-breaks, mathematical certainties
assets/js/simulate.js    Monte Carlo over the unplayed fixtures
assets/js/scenarios.js   Turning counters into "win both and you are through"
assets/js/chnorm.js      CricHeroes payload -> this project's schema
assets/js/data.js        Snapshot loading + live refresh + cross-check
assets/js/config.js      Worker URL and the CricHeroes endpoint candidates

tools/fetch-tournament.mjs   Refresh the committed snapshots from CricHeroes
tools/make-placeholder.mjs   Regenerate the sample seasons (all divisions)
tools/team-names.mjs         Recover display names from the division map (build-time)
tools/snapshot-index.mjs     Maintain assets/data/<id>/index.json
dev-server.py                Local server + API proxy (Python 3, no install)
worker.js / wrangler.toml    Production API proxy (Cloudflare Worker)
test/                        33 tests over the maths, the parser and the index
```

---

## Read this first: the data in the repo right now is **fake**

The session that built this had no network route to `api.cricheroes.in` — the egress
policy blocked it — so no real TCL data could be fetched. Rather than ship empty pages,
all nine divisions hold an **invented but self-consistent season**: the real team rosters
from `assets/data/divisions.json`, with made-up scorecards that produce a real points
table and real net run rates. Every calculation on the page is correct; the matches it is
calculating from are not.

Divisions in that state are labelled **"Sample data"** on the division list and carry a
standing banner on their own page. One command replaces all nine with the real thing:

```bash
node tools/fetch-tournament.mjs 2100677
```

## Run it locally

```bash
python3 dev-server.py
# open http://localhost:8090/division.html?t=2100677&d=7
```

`dev-server.py` serves the static files **and** proxies `/api/ch?path=…` to CricHeroes,
so the "Refresh from CricHeroes" button works locally without deploying anything.

```bash
node --test test/*.test.js     # run the tests
```

---

## Using it

### Once, to get it online

```bash
# 1. real data
node tools/fetch-tournament.mjs 2100677

# 2. the proxy that lets the page refresh itself later
npm i -g wrangler && wrangler login && wrangler deploy
#    put the URL it prints into WORKER_URL in assets/js/config.js

# 3. publish
git add -A && git commit -m "Real TCL data" && git push
```

With GitHub Pages enabled the site is at `https://<you>.github.io/cricscenarios/`, and
Division 7 is a direct link worth bookmarking:

```
https://<you>.github.io/cricscenarios/division.html?t=2100677&d=7
```

Add `&team=<id>` and the link opens on a specific team — clicking a row updates the URL,
so you can copy the address bar and send someone the exact view you are looking at.

### After every match day

Either press **Refresh from CricHeroes** on the page (needs step 2 above; nothing is
committed, it just re-reads and recomputes), or re-run the fetcher and commit so everyone
sees the new numbers without pressing anything:

```bash
node tools/fetch-tournament.mjs 2100677 && git commit -am "Round N" && git push
```

### Reading the page

The table is the division as it stands, with three extra columns. Each is that team's
chance of finishing there once every remaining fixture in the division has been simulated.

| What you see | What it means |
|---|---|
| `62.4%` | 62.4% of simulated seasons ended that way |
| **`Yes`** | Settled. True whatever happens in every remaining game |
| `—` | Impossible. Not "unlikely" — arithmetically out of reach |
| `<0.1%` | Possible, but it did not come up often enough to put a number on |

Green rows are the promotion places, blue the rest of the playoff places, red the
relegation places. **Click any row** to switch the report underneath to that team.

Two controls change the answer, and it is worth understanding both:

- **Coin flip vs Form-weighted.** Coin flip gives every remaining match 50/50 — no opinion
  about who is better, just the combinatorics of who plays whom. Form-weighted rates teams
  from results so far. Flip between them: if a number barely moves, it is solid; if it
  swings a lot, your fate depends on an assumption rather than on arithmetic.
- **Simulations.** More trials, less jitter. Fast (10k) is enough to browse; Thorough
  (200k) is what to quote to anyone.

### The report underneath

Three cards — Promotion, Playoffs, Relegation — each answering the same four questions:

1. **What do we need to do?** Your chance after each possible number of wins from your own
   remaining games.
2. **Is it in our hands?** Whether winning out settles it outright, or still leaves you
   waiting on someone else.
3. **Who else matters?** The remaining fixtures elsewhere ranked by how much they swing
   your chances, each with the number if it goes your way and the number if it does not.
4. **How big do the wins need to be?** When net run rate is what decides the last place,
   the margin needed to clear it — in runs batting first, or overs to spare chasing.

On that last point: **wickets in hand do not affect net run rate.** Chasing, only the
balls you leave unused count. Winning by 9 wickets off the final ball does nothing for
your run rate; winning by 2 wickets with 4 overs to spare does a lot.

### If a number looks wrong

The page cross-checks its own table against the one CricHeroes publishes and shows a loud
red banner on any disagreement. That banner means a match result failed to parse, and
every projection below it is suspect — fix that before trusting anything else. Raw
payloads are in `assets/data/2100677/raw/` to work from.

---

## Getting real data in

There are two paths to real numbers, and they use the same code.

### 1. Snapshot (committed, what the page loads by default)

```bash
node tools/fetch-tournament.mjs 2100677                 # all nine divisions
node tools/fetch-tournament.mjs 2100677 --division 7     # just yours
node tools/fetch-tournament.mjs 2100677 --dry-run        # fetch and print, write nothing
```

The tournament is fetched once and split across divisions using
`assets/data/divisions.json`, so doing all nine costs no more network than doing one.
`assets/data/2100677/index.json` records what each division holds and whether it is real
or placeholder; the division list page reads it so it can label the cards.

Node 18+, and no `npm install` — the project has no dependencies. It can be run from any
directory: the script resolves paths from its own location, so it always writes into
`cricscenarios/assets/data/`, whatever your shell is sitting in.

It talks to `api.cricheroes.in` directly — no proxy needed, because the proxy only exists
to satisfy the *browser's* CORS rules. Commit the files it writes and the published page
picks them up.

Every raw response is also written to `assets/data/2100677/raw/` before anything is
parsed. If a field ever fails to map, that directory is the evidence to fix it from.

### 2. Live refresh (the button on the page)

Deploy the proxy once:

```bash
npm i -g wrangler
wrangler login
wrangler deploy
```

Put the URL it prints into `WORKER_URL` in `assets/js/config.js`. The button then pulls
current data straight from CricHeroes and re-runs the analysis in place, without a
commit. The committed snapshot is still what renders first, so the page is never blank
waiting on a network call.

### When CricHeroes changes an endpoint

CricHeroes publishes no API contract and renames routes between releases. Both paths try
a **list of candidate paths** in order, from `ENDPOINTS` in `assets/js/config.js`, and
report which ones answered. When live refresh stops working, add the new path to the top
of the relevant list — that is the whole fix, and it needs no Worker redeploy.

The field-name mapping in `assets/js/chnorm.js` is alias-driven for the same reason:
a renamed field is one string added to `ALIASES`, not a rewritten parser.

> The CricHeroes payload shapes in `test/chnorm.test.js` are **reconstructions**, not
> captures — they were written without access to the API. They pin the behaviour the
> project relies on. Once you have a real payload in `assets/data/*/raw/`, adding it to
> that file as a case is the single highest-value follow-up.

---

## How the numbers are produced

### The table

Points and net run rate are computed from the match results, not read from the published
table — the simulator has to score imagined matches the same way it scores real ones, so
there is only one code path. Where the published CricHeroes table *is* available, the page
compares against it and shows a loud banner on any disagreement, because a mismatch means
a result failed to parse and everything downstream is suspect.

Two details that are easy to get wrong and are tested in `test/engine.test.js`:

- **Overs are stored as balls.** `19.3` overs is 19 overs and 3 balls; the decimal place
  is base 6. Arithmetic on the decimal form silently produces wrong run rates.
- **A side bowled out is charged its full quota of overs.** Being dismissed for 80 in 12
  overs counts as 80 from 20, not 80 from 12.

### Probabilities

Every unplayed fixture in the division is simulated, tens of thousands of seasons at a
time. Two choices make the output meaningful rather than decorative:

- **Margins are bootstrapped from this division's own completed matches.** Each simulated
  game replays the shape of a real one — its first-innings total, its margin, the overs
  used — so simulated net run rates move the way real ones actually have, instead of
  following an invented bell curve.
- **Two models, switchable on the page.** *Coin flip* gives every remaining match 50/50:
  pure combinatorics, no opinion about who is better. *Form-weighted* fits
  [Bradley–Terry](https://en.wikipedia.org/wiki/Bradley%E2%80%93Terry_model) strengths to
  the results so far, with a prior that stops an unbeaten team being rated as certain and
  a clamp at 85/15. Seeing both is the honest presentation: the gap between them is how
  much the answer depends on the assumption.

### Certainty vs likelihood

These are never mixed. **Through**, **out**, **safe** and **down** come from
`certificates()` in `engine.js`, which proves the result from the points arithmetic across
every possible remaining outcome — not from the simulation. A simulation that never saw an
outcome in 200,000 trials shows it is unlikely; it does not show it is impossible, and the
page says so in those words.

### What has to happen

For the selected team the page reports, in order:

1. **Your own games.** The chance after each possible number of wins from your remaining
   fixtures.
2. **Whether winning out settles it.** If winning every remaining game got you there in
   every simulated season where it happened, nothing else matters and the page says so.
3. **Otherwise, whose results matter.** Every other remaining fixture, ranked by how much
   its outcome swings your chances, conditioned on you winning all of yours.
4. **How big the wins need to be.** Taken from the seasons where you won everything and
   *still* missed out: the net run rate of whoever took the last qualifying place, and the
   margin that clears it — in runs batting first, or overs to spare chasing.

On that last point, a thing worth knowing: **wickets in hand do not affect net run rate
when chasing.** Only the balls you leave unused do. Winning by 9 wickets off the final
ball does nothing for your run rate; winning by 2 wickets with 4 overs to spare does a
lot. The page states the requirement in overs, not wickets, for that reason.

---

## Rules and tie-breaks

Per tournament, in `assets/data/<id>/meta.json`:

```json
"rules": {
  "playoff_spots": 4, "promotion_spots": 3, "relegation_spots": 3,
  "points_win": 2, "points_tie": 1, "points_no_result": 1, "points_loss": 0,
  "overs_per_innings": 20,
  "tiebreak": ["points", "nrr", "h2h", "wins"]
}
```

`tiebreak` is the CricHeroes default — points, then net run rate. **This was not
verifiable from the session that built the project** (the TCL and CricHeroes pages were
both unreachable), so if TCL publishes a different order, change it here: it is one line
and everything downstream follows.

---

## Adding a tournament or a division

1. Add an entry to `assets/data/tournaments.json`.
2. Create `assets/data/<id>/meta.json` with its divisions and rules.
3. If the tournament runs divisions inside one CricHeroes tournament (TCL does), add its
   team → division map to `assets/data/divisions.json` under the tournament id, keyed
   `byId` and `byName`.
4. `node tools/fetch-tournament.mjs <id>`.

---

## Publishing

Static files, no build step:

```bash
git init && git add . && git commit -m "Cric scenarios"
gh repo create cricscenarios --public --source=. --push
gh api -X POST repos/{owner}/cricscenarios/pages -f 'source[branch]=main' -f 'source[path]=/'
```

---

Unofficial. Not affiliated with CricHeroes, the Triangle Cricket League, or any team.
Probabilities are estimates from simulation, not predictions.
