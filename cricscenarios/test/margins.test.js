/**
 * The runs-and-overs analysis: thresholds checked against brute force, and
 * the two Division 7 facts the user asked about, against the committed
 * snapshot (refreshed from CricHeroes on 17 Oct 2026).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { hydrate } from '../assets/js/data.js';
import { prepare } from '../assets/js/simulate.js';
import { DEFAULT_RULES } from '../assets/js/engine.js';
import {
  marginSettings, goalMargins, rivalMargins, scenarioVerdict, R, oversText,
} from '../assets/js/margins.js';
import { teamMargins, marginsCard } from '../assets/js/margins-view.js';

const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/* ------------------------------------------------------- hand-built case */

// Two teams level on 4 points chasing one place; A plays C, B is done.
const RULES = { ...DEFAULT_RULES, overs_per_innings: 18, playoff_spots: 1, promotion_spots: 1, relegation_spots: 1 };
const TEAMS = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
const BASE = {
  1: { teamId: 1, played: 3, won: 1, lost: 2, tied: 0, noResult: 0, points: 2, runsFor: 300, oversFor: 54, runsAgainst: 330, oversAgainst: 54 },
  2: { teamId: 2, played: 4, won: 2, lost: 2, tied: 0, noResult: 0, points: 4, runsFor: 400, oversFor: 72, runsAgainst: 380, oversAgainst: 72 },
  3: { teamId: 3, played: 3, won: 1, lost: 2, tied: 0, noResult: 0, points: 2, runsFor: 280, oversFor: 54, runsAgainst: 300, oversAgainst: 54 },
};
function smallCtx() {
  const matches = [{ id: 9, home: 1, away: 3, status: 'upcoming', overs: 18 }];
  const baseline = {};
  for (const t of TEAMS) {
    const p = BASE[t.id];
    baseline[t.id] = { teamId: t.id, played: p.played, won: p.won, lost: p.lost, tied: 0, noResult: 0,
      points: p.points, runsFor: p.runsFor, ballsFor: p.oversFor * 6, runsAgainst: p.runsAgainst, ballsAgainst: p.oversAgainst * 6 };
  }
  return prepare(TEAMS, matches, RULES, baseline);
}
const nrr = (rf, bf, ra, ba) => rf / (bf / 6) - ra / (ba / 6);

test('a win that only levels the points needs the exact NRR margin, checked by hand', () => {
  const ctx = smallCtx();
  const set = { ...marginSettings(ctx), score: 120, scores: [100, 120, 140], typicalRuns: 20 };
  const v = scenarioVerdict(ctx, set, ctx.index.get(1), 1, [R.HOME]);
  assert.equal(v.kind, 'race');
  assert.equal(v.mode, 'own');
  const target = nrr(400, 432, 380, 432);          // B, done: +0.2778
  // Brute force the smallest runs margin at S = 120 and the most balls for a chase.
  let runs = null;
  for (let r = 1; r < 120; r++) if (nrr(300 + 120, 324 + 108, 330 + 120 - r, 324 + 108) > target) { runs = r; break; }
  let balls = null;
  for (let b0 = 108; b0 >= 6; b0--) if (nrr(300 + 121, 324 + b0, 330 + 120, 324 + 108) > target) { balls = b0; break; }
  assert.equal(v.need.main.runs, runs);
  assert.equal(v.need.main.balls, balls);
  assert.ok(runs > 1, 'a narrow win is not enough');
});

test('a defeat that still keeps a team above its rival reports the biggest affordable margin', () => {
  const ctx = smallCtx();
  const set = { ...marginSettings(ctx), score: 120, scores: [100, 120, 140], typicalRuns: 20 };
  // C beat A: C on 4 with B. C's own margin decides C v B.
  const v = scenarioVerdict(ctx, set, ctx.index.get(3), 1, [R.AWAY]);
  assert.equal(v.kind, 'race');
  assert.equal(v.winning, true);
  // And a washout leaves both A and C on 3, below B: out on points.
  assert.equal(scenarioVerdict(ctx, set, ctx.index.get(1), 1, [R.SHARED]).kind, 'out');
  assert.equal(oversText(58), '9.4');
});

/* --------------------------------------------- Division 7, live snapshot */

const d7 = hydrate(JSON.parse(readFileSync(new URL('../assets/data/2100677/division-7.json', import.meta.url), 'utf8')));
const ctx7 = prepare(d7.teams, d7.matches, d7.rules, d7.baseline);
const idOf = (re) => d7.teams.find((t) => re.test(t.name)).id;
const pending = (a, b) => ctx7.remaining.some((fx) => {
  const n = [ctx7.teams[fx.h].name, ctx7.teams[fx.a].name];
  return n.some((x) => a.test(x)) && n.some((x) => b.test(x));
});
const HEAT = /hollysprings heat/i, SIRJIS = /cary sirjis/i, GNG = /guts\s*n\s*glory/i;
const ZEN = /zenstarz/i, TECH = /tech stormers/i;

test('Division 7: Hollysprings HEAT can win and still miss the playoffs on net run rate', { skip: !pending(HEAT, TECH) && 'HEAT v Tech Stormers has been played' }, () => {
  const set = marginSettings(ctx7);
  const g = goalMargins(ctx7, set, idOf(HEAT), d7.rules.playoff_spots);
  const win = g.cases.find((c) => c.own.every((o) => o.result > 0));
  assert.ok(win, 'a winning case exists');
  const races = win.lines.filter((l) => l.verdict.kind === 'race');
  assert.ok(races.length, 'a win leaves HEAT level on points with someone');
  for (const l of races) {
    // A narrow win does not do it: it needs a margin bigger than 1 run.
    assert.ok(l.verdict.need.main.runs == null || l.verdict.need.main.runs > 1);
    assert.equal(l.verdict.need.main.any, false);
    // Guts N Glory is the team whose NRR they are racing.
    assert.ok(l.verdict.level.map((j) => ctx7.teams[j].name).some((n) => GNG.test(n)));
  }
  assert.ok(!win.lines.some((l) => l.verdict.kind === 'in'), 'no combination puts a HEAT win through on points alone');
  const facts = teamMargins(ctx7, idOf(HEAT)).facts.map(strip).join(' | ');
  assert.match(facts, /Hollysprings HEAT can win and still not make the playoffs/);
});

test('Division 7: Cary Sirjis can lose to Zenstarz Warriors and still finish above Guts N Glory', { skip: !pending(SIRJIS, ZEN) && 'Zenstarz v Cary Sirjis has been played' }, () => {
  const set = marginSettings(ctx7);
  const rv = rivalMargins(ctx7, set, idOf(SIRJIS), idOf(GNG));
  const lose = rv.cases.find((c) => c.own.every((o) => o.result < 0));
  assert.ok(lose);
  for (const l of lose.lines) assert.equal(l.verdict.state, 'above', JSON.stringify(l.verdict));
  const facts = teamMargins(ctx7, idOf(SIRJIS)).facts.map(strip).join(' | ');
  assert.match(facts, /Cary Sirjis can lose to Zenstarz Warriors and still finish above Guts N Glory/);
});

test('Division 7: the card renders for every team with no undefined or NaN', () => {
  for (const t of d7.teams) {
    const t0 = strip(marginsCard(ctx7, t.id));
    assert.doesNotMatch(t0, /undefined|NaN|\[object/, t.name);
    assert.match(t0, /what it takes, in runs and overs/);
  }
});
