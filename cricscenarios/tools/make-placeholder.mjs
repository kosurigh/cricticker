#!/usr/bin/env node
/**
 * Generate placeholder snapshots for every division of a tournament.
 *
 *   node tools/make-placeholder.mjs                 # all divisions of 2100677
 *   node tools/make-placeholder.mjs --division 7
 *
 * This exists because the project was built without network access to the
 * CricHeroes API, and a scenario calculator with no data in it cannot be
 * reviewed. It invents *self-consistent* seasons — real scorecards, correct net
 * run rates, a plausible spread of form — using the genuine team rosters from
 * assets/data/divisions.json, so every screen and every calculation can be
 * exercised.
 *
 * Output is stamped `"placeholder": true`, which makes the page show a standing
 * warning banner. tools/fetch-tournament.mjs overwrites these with real data
 * and the banner disappears.
 *
 * Deterministic: same seed, same seasons, so snapshots diff cleanly.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { standingsFor, netRunRate, DEFAULT_RULES } from '../assets/js/engine.js';
import { synthId } from '../assets/js/chnorm.js';
import { displayName, shortCode, unresolved } from './team-names.mjs';
import { writeIndex } from './snapshot-index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TOURNAMENT = '2100677';

/** The team whose situation this was built to answer, where it appears. */
const FOCUS = 'Guts N Glory';

/**
 * Per-division seeds. Division 7 is pinned to a seed that puts Guts N Glory on
 * the playoff cut line with two games left — the live, undecided case this page
 * exists to analyse. A mid-table team with nothing riding on it would exercise
 * the code but demonstrate nothing. Override with SEED_<n> env vars when
 * hunting for a different shape.
 */
const SEEDS = Object.fromEntries(
  Object.entries(process.env)
    .filter(([k]) => /^SEED_\d+$/.test(k))
    .map(([k, v]) => [Number(k.slice(5)), Number(v)]));
if (SEEDS[7] === undefined) SEEDS[7] = 1008;

function parseArgs(argv) {
  const out = { division: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--division' || argv[i] === '-d') out.division = Number(argv[++i]);
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Circle-method round robin. With 14 teams there are 13 possible rounds; a
 * season uses the first 8, so everyone has an 8-game schedule.
 */
function schedule(list, rounds) {
  const n = list.length;
  const arr = list.slice();
  const out = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < Math.floor(n / 2); i++) {
      out.push({ round: r, home: arr[i], away: arr[n - 1 - i] });
    }
    arr.splice(1, 0, arr.pop());
  }
  return out;
}

/**
 * Rounds sit a week apart, anchored so the first six are in the recent past and
 * the last two are still to come — the situation the page is for: most games
 * played, a couple left.
 */
const START = Date.UTC(2026, 7, 8, 14, 0);
const VENUES = ['Cary Ground 1', 'Holly Springs Oval', 'RTP Park', 'Morrisville Turf'];

function buildDivision(division, names, seed) {
  const rnd = mulberry32(seed);
  const normal = () => {
    const u = Math.max(rnd(), 1e-9), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const teams = names.map((name) => ({
    id: synthId(name), name, short: shortCode(name), logo: null,
  }));

  // A spread of ability so the table is not flat, shuffled per division. Where
  // the focus team is present it is dropped into the fourth-strongest slot, so
  // it sits on the playoff cut line with work still to do — the case the whole
  // page exists to analyse.
  const ladder = names.map((_, i) => 1 - (i / (names.length - 1)) * 0.88);
  const order = names.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (order.includes(FOCUS)) {
    const at = order.indexOf(FOCUS);
    [order[3], order[at]] = [order[at], order[3]];
  }
  const STRENGTH = Object.fromEntries(order.map((n, i) => [n, ladder[i]]));

  function playMatch(homeName, awayName) {
    const pHome = 0.5 + (STRENGTH[homeName] - STRENGTH[awayName]) * 0.55;
    const homeWins = rnd() < Math.min(0.88, Math.max(0.12, pHome));
    const winner = homeWins ? homeName : awayName;
    const loser = homeWins ? awayName : homeName;

    const first = Math.max(70, Math.round(148 + normal() * 22 + (STRENGTH[winner] - 0.5) * 30));

    if (rnd() < 0.48) {
      // The side batting second chases it down.
      const oversUsed = Math.min(19.5, Math.max(13, 20 - Math.abs(normal()) * 2.2));
      const whole = Math.floor(oversUsed);
      const balls = Math.min(5, Math.round((oversUsed - whole) * 6));
      const wkts = 2 + Math.floor(rnd() * 5);
      return {
        winner, type: 'wickets', margin: 10 - wkts,
        innings: [
          { team: loser, runs: first, wickets: 4 + Math.floor(rnd() * 6), overs: 20, allOut: false },
          { team: winner, runs: first + 1 + Math.floor(rnd() * 4), wickets: wkts,
            overs: Number(`${whole}.${balls}`), allOut: false },
        ],
      };
    }

    // The side batting first defends.
    const chasedTo = Math.max(45, first - (5 + Math.round(Math.abs(normal()) * 26)));
    const allOut = rnd() < 0.45;
    return {
      winner, type: 'runs', margin: first - chasedTo,
      innings: [
        { team: winner, runs: first, wickets: 3 + Math.floor(rnd() * 6), overs: 20, allOut: false },
        { team: loser, runs: chasedTo, wickets: allOut ? 10 : 7 + Math.floor(rnd() * 3),
          overs: allOut ? Number((14 + rnd() * 5).toFixed(1)) : 20, allOut },
      ],
    };
  }

  const byName = new Map(teams.map((t) => [t.name, t.id]));
  const fixtures = schedule(names, 8);

  const matches = fixtures.map((f, i) => {
    const date = new Date(START + f.round * 7 * 86400000 + (i % 7) * 1800000).toISOString();
    const involvesFocus = f.home === FOCUS || f.away === FOCUS;

    // Rounds 6 and 7 are in the future, so nothing there has been played. The
    // focus team has got all six of its earlier games in; the rest of the
    // division has a scattering of rounds 4 and 5 outstanding, which is what
    // makes the scenario interesting — its fate is not in its own hands alone.
    let played;
    if (f.round >= 6) played = false;
    else if (involvesFocus || f.round < 4) played = true;
    else played = rnd() < 0.72;

    const base = {
      id: Number(`${division}${String(700000 + i)}`),
      date,
      venue: VENUES[i % VENUES.length],
      home: byName.get(f.home),
      away: byName.get(f.away),
    };
    if (!played) return { ...base, status: 'upcoming' };

    const r = playMatch(f.home, f.away);
    return {
      ...base,
      status: 'completed',
      resultText: `${r.winner} won by ${r.margin} ${r.type === 'runs' ? 'runs' : 'wickets'}`,
      result: {
        winner: byName.get(r.winner),
        type: r.type,
        margin: r.margin,
        innings: r.innings.map((inn) => ({
          team: byName.get(inn.team), runs: inn.runs, wickets: inn.wickets,
          overs: inn.overs, allOut: inn.allOut,
        })),
      },
    };
  });

  return { teams, matches };
}

/* ------------------------------------------------------------------ main */

const args = parseArgs(process.argv.slice(2));

const divisionsFile = JSON.parse(
  await readFile(path.join(ROOT, 'assets', 'data', 'divisions.json'), 'utf8'));
const manifest = JSON.parse(
  await readFile(path.join(ROOT, 'assets', 'team-logos', 'manifest.json'), 'utf8'));
const map = divisionsFile[TOURNAMENT];
if (!map) throw new Error(`No division map for tournament ${TOURNAMENT}`);

const metaPath = path.join(ROOT, 'assets', 'data', TOURNAMENT, 'meta.json');
const meta = JSON.parse(await readFile(metaPath, 'utf8'));
const rules = { ...DEFAULT_RULES, ...(meta.rules || {}) };

// Group the roster by division, recovering display names from the normalised keys.
const rosters = {};
for (const [key, d] of Object.entries(map.byName)) {
  (rosters[d] = rosters[d] || []).push(displayName(key, manifest));
}
for (const d of Object.keys(rosters)) rosters[d].sort();

const wanted = args.division != null
  ? [args.division]
  : Object.keys(rosters).map(Number).sort((a, b) => a - b);

const dataDir = path.join(ROOT, 'assets', 'data', TOURNAMENT);
await mkdir(dataDir, { recursive: true });

const written = [];
for (const division of wanted) {
  const names = rosters[division];
  if (!names || names.length < 4) {
    console.warn(`Division ${division}: roster too small (${names ? names.length : 0}), skipped.`);
    continue;
  }

  const seed = SEEDS[division] ?? (20260914 + division * 7919);
  const { teams, matches } = buildDivision(division, names, seed);
  const played = matches.filter((m) => m.status === 'completed').length;

  const snapshot = {
    tournament_id: Number(TOURNAMENT),
    tournament_name: meta.name,
    division,
    generated_at: new Date().toISOString(),
    source: 'placeholder',
    placeholder: true,
    placeholder_note:
      "Invented results using this division's real team roster. Built so every screen and "
      + 'calculation can be exercised before live data is wired up. Replace by running: '
      + `node tools/fetch-tournament.mjs ${TOURNAMENT}`,
    rules,
    teams,
    matches,
    published: [],
    warnings: [],
  };

  await writeFile(path.join(dataDir, `division-${division}.json`),
    JSON.stringify(snapshot, null, 1));

  written.push({
    division, teams: teams.length, matches: matches.length,
    played, remaining: matches.length - played,
    source: 'placeholder', placeholder: true,
    generated_at: snapshot.generated_at,
  });

  const table = standingsFor(teams, matches, rules);
  const nameOf = (id) => teams.find((t) => t.id === id).name;
  const focusAt = table.findIndex((r) => nameOf(r.teamId) === FOCUS);
  console.log(`Division ${division}: ${teams.length} teams, ${played} played, `
    + `${matches.length - played} to play`
    + (focusAt >= 0
      ? `  —  ${FOCUS} ${focusAt + 1}${['th', 'st', 'nd', 'rd'][(focusAt + 1) % 10] || 'th'} `
        + `on ${table[focusAt].points} pts, NRR ${netRunRate(table[focusAt]).toFixed(3)}`
      : ''));
}

await writeIndex(dataDir, Number(TOURNAMENT), written);

const missed = unresolved();
if (missed.length) {
  console.warn(`\n${missed.length} team name(s) could not be split and were title-cased:`);
  console.warn('  ' + missed.join(', '));
  console.warn('  Add them to OVERRIDES in tools/team-names.mjs.');
}
console.log(`\nWrote ${written.length} division snapshot(s) + index.json.`);
