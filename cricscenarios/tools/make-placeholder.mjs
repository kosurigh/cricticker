#!/usr/bin/env node
/**
 * Generate the placeholder Division 7 snapshot.
 *
 *   node tools/make-placeholder.mjs
 *
 * This exists because the project was built without network access to the
 * CricHeroes API, and a scenario calculator with no data in it cannot be
 * reviewed. It invents a *self-consistent* season — real scorecards, correct
 * net run rates, a plausible spread of form — using the genuine Division 7
 * team names, so every screen and every calculation can be exercised.
 *
 * The output is stamped `"placeholder": true`, which makes the page show a
 * standing warning banner. Running tools/fetch-tournament.mjs overwrites the
 * file with real data and the banner disappears.
 *
 * It is deterministic: same seed, same season, so snapshots diff cleanly.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { standingsFor, netRunRate, DEFAULT_RULES } from '../assets/js/engine.js';
import { synthId } from '../assets/js/chnorm.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// The real Division 7 line-up, from the tournament's division map.
const NAMES = [
  'Blue Waves', 'Cary Avengers', 'Cary Sirjis', 'Dothraki', 'Guts N Glory',
  'Holly Springs Heat', 'Jaguars', 'Naughty40', 'R3', 'RTP Thunderbolts',
  'RTP Tigers', 'Sandstorm X1', 'Techstormers HT', 'Zen Starz Warriors',
];

const SHORT = {
  'Blue Waves': 'BW', 'Cary Avengers': 'CAV', 'Cary Sirjis': 'CSJ',
  'Dothraki': 'DOT', 'Guts N Glory': 'GNG', 'Holly Springs Heat': 'HSH',
  'Jaguars': 'JAG', 'Naughty40': 'N40', 'R3': 'R3', 'RTP Thunderbolts': 'RTB',
  'RTP Tigers': 'RTT', 'Sandstorm X1': 'SX1', 'Techstormers HT': 'TSH',
  'Zen Starz Warriors': 'ZSW',
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260914);
const normal = () => {
  // Box-Muller, good enough for innings totals.
  const u = Math.max(rnd(), 1e-9), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const teams = NAMES.map((name) => ({
  id: synthId(name),
  name,
  short: SHORT[name],
  logo: null,
}));

// A spread of ability so the table is not flat. Guts N Glory sit just inside
// the playoff places with work still to do — the situation worth modelling.
const STRENGTH = {
  'Cary Sirjis': 1.00, 'Dothraki': 0.82, 'RTP Tigers': 0.70,
  'Guts N Glory': 0.62, 'Jaguars': 0.58, 'Blue Waves': 0.50,
  'Holly Springs Heat': 0.46, 'Sandstorm X1': 0.42, 'Techstormers HT': 0.38,
  'Cary Avengers': 0.34, 'R3': 0.30, 'Naughty40': 0.24,
  'Zen Starz Warriors': 0.18, 'RTP Thunderbolts': 0.12,
};

/**
 * Circle-method round robin. With 14 teams there are 13 possible rounds; the
 * season uses the first 8, so everyone has an 8-game schedule.
 */
function schedule(list, rounds) {
  const n = list.length;
  const arr = list.slice();
  const out = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      out.push({ round: r, home: arr[i], away: arr[n - 1 - i] });
    }
    // rotate, holding the first fixed
    arr.splice(1, 0, arr.pop());
  }
  return out;
}

/** Invent one scorecard consistent with who won. */
function playMatch(homeName, awayName, id, date) {
  const sh = STRENGTH[homeName], sa = STRENGTH[awayName];
  const pHome = 0.5 + (sh - sa) * 0.55;
  const homeWins = rnd() < Math.min(0.88, Math.max(0.12, pHome));
  const winner = homeWins ? homeName : awayName;
  const loser = homeWins ? awayName : homeName;

  const base = 148 + normal() * 22 + (STRENGTH[winner] - 0.5) * 30;
  const first = Math.max(70, Math.round(base));
  const chase = rnd() < 0.48;

  let innings;
  if (chase) {
    // Loser bats first and is overhauled.
    const target = first;
    const oversUsed = Math.min(19.5, Math.max(13, 20 - Math.abs(normal()) * 2.2));
    const whole = Math.floor(oversUsed);
    const balls = Math.min(5, Math.round((oversUsed - whole) * 6));
    innings = [
      { team: loser, runs: target, wickets: 4 + Math.floor(rnd() * 6), overs: 20, allOut: false },
      { team: winner, runs: target + 1 + Math.floor(rnd() * 4), wickets: 2 + Math.floor(rnd() * 5),
        overs: Number(`${whole}.${balls}`), allOut: false },
    ];
    return { id, date, winner, type: 'wickets', margin: 10 - innings[1].wickets, innings };
  }

  // Winner bats first and defends.
  const margin = 5 + Math.round(Math.abs(normal()) * 26);
  const chasedTo = Math.max(45, first - margin);
  const allOut = rnd() < 0.45;
  innings = [
    { team: winner, runs: first, wickets: 3 + Math.floor(rnd() * 6), overs: 20, allOut: false },
    { team: loser, runs: chasedTo, wickets: allOut ? 10 : 7 + Math.floor(rnd() * 3),
      overs: allOut ? Number((14 + rnd() * 5).toFixed(1)) : 20, allOut },
  ];
  return { id, date, winner, type: 'runs', margin: first - chasedTo, innings };
}

const byName = new Map(teams.map((t) => [t.name, t.id]));
const fixtures = schedule(NAMES, 8);

/**
 * Which fixtures have been played.
 *
 * Guts N Glory are ahead of the rest of the division: all six of their first
 * six rounds are done and only their last two remain. Everyone else has a
 * scattering of earlier games still outstanding, which is what makes the
 * scenario interesting — their fate is not in their own hands alone.
 */
// Rounds are a week apart. Anchored so the six completed rounds sit in the
// recent past and the last two fall after today, which is the situation the
// page is for: most games played, a couple left.
const START = Date.UTC(2026, 7, 8, 14, 0);
const matches = fixtures.map((f, i) => {
  const date = new Date(START + f.round * 7 * 86400000 + (i % 7) * 1800000).toISOString();
  const involvesGng = f.home === 'Guts N Glory' || f.away === 'Guts N Glory';

  // Rounds 6 and 7 are still in the future, so nothing there has been played.
  // Guts N Glory have got all six of their earlier games in; the rest of the
  // division has a scattering of rounds 4 and 5 outstanding.
  let played;
  if (f.round >= 6) played = false;
  else if (involvesGng || f.round < 4) played = true;
  else played = rnd() < 0.72;

  const base = {
    id: 9700000 + i,
    date,
    venue: ['Cary Ground 1', 'Holly Springs Oval', 'RTP Park', 'Morrisville Turf'][i % 4],
    home: byName.get(f.home),
    away: byName.get(f.away),
  };

  if (!played) return { ...base, status: 'upcoming' };

  const r = playMatch(f.home, f.away, base.id, date);
  return {
    ...base,
    status: 'completed',
    resultText: `${r.winner} won by ${r.margin} ${r.type === 'runs' ? 'runs' : 'wickets'}`,
    result: {
      winner: byName.get(r.winner),
      type: r.type,
      margin: r.margin,
      innings: r.innings.map((inn) => ({
        team: byName.get(inn.team),
        runs: inn.runs,
        wickets: inn.wickets,
        overs: inn.overs,
        allOut: inn.allOut,
      })),
    },
  };
});

const rules = {
  ...DEFAULT_RULES,
  playoff_spots: 4, promotion_spots: 3, relegation_spots: 3, overs_per_innings: 20,
};

const snapshot = {
  tournament_id: 2100677,
  tournament_name: 'TCL Mega Smash 2026',
  division: 7,
  generated_at: new Date().toISOString(),
  source: 'placeholder',
  placeholder: true,
  placeholder_note:
    'Invented results with the real Division 7 team names. Built so every screen '
    + 'and calculation can be exercised before live data is wired up. Replace by '
    + 'running: node tools/fetch-tournament.mjs 2100677 --division 7',
  rules,
  teams,
  matches,
  published: [],
  warnings: [],
};

const out = path.join(ROOT, 'assets', 'data', '2100677', 'division-7.json');
await writeFile(out, JSON.stringify(snapshot, null, 1));

const table = standingsFor(teams, matches, rules);
const nameOf = (id) => teams.find((t) => t.id === id).name;
const left = matches.filter((m) => m.status !== 'completed').length;
console.log(`Wrote ${path.relative(ROOT, out)} — ${matches.length} matches, ${left} still to play\n`);
console.log('  #  Team                      P   W   L  Pts     NRR   left');
table.forEach((r, i) => {
  const rem = matches.filter((m) => m.status !== 'completed'
    && (m.home === r.teamId || m.away === r.teamId)).length;
  console.log(
    `  ${String(i + 1).padStart(2)} ${nameOf(r.teamId).padEnd(22)}`
    + `${String(r.played).padStart(3)}${String(r.won).padStart(4)}${String(r.lost).padStart(4)}`
    + `${String(r.points).padStart(5)}  ${netRunRate(r).toFixed(3).padStart(7)}   ${rem}`);
});
