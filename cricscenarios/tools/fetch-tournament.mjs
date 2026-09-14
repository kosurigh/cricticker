#!/usr/bin/env node
/**
 * Refresh the committed snapshots from CricHeroes.
 *
 *   node tools/fetch-tournament.mjs 2100677            # every division
 *   node tools/fetch-tournament.mjs 2100677 --division 7
 *   node tools/fetch-tournament.mjs 2100677 --dry-run  # fetch, print, write nothing
 *
 * Run from the project root. Node 18+ (it uses the built-in fetch).
 *
 * Unlike the browser, this talks to api.cricheroes.in directly — no Worker
 * needed — because the only reason that proxy exists is the browser's CORS
 * rules. The headers below are what make the API answer at all; they are the
 * same ones the CricHeroes web client sends.
 *
 * Every raw response is written to assets/data/<id>/raw/ before anything is
 * parsed. When a field mapping needs fixing, that directory is the evidence.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ENDPOINTS } from '../assets/js/config.js';
import { buildSnapshot } from '../assets/js/chnorm.js';
import { filterToDivision } from '../assets/js/data.js';
import { standingsFor, DEFAULT_RULES, netRunRate } from '../assets/js/engine.js';

const API = 'https://api.cricheroes.in';
const HEADERS = {
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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function parseArgs(argv) {
  const out = { id: null, division: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--division' || a === '-d') out.division = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (!out.id && /^\d+$/.test(a)) out.id = a;
  }
  return out;
}

async function get(apiPath) {
  const res = await fetch(API + apiPath, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`response was not JSON: ${text.slice(0, 200)}`);
  }
}

/** Walk the candidate list until one answers with something substantial. */
async function tryAll(label, paths, id) {
  const problems = [];
  for (const tpl of paths) {
    const p = tpl.replace('{id}', id);
    try {
      const body = await get(p);
      const size = JSON.stringify(body).length;
      if (size < 40) { problems.push(`${p}: empty`); continue; }
      console.log(`  ${label}: ${p}  (${size.toLocaleString()} bytes)`);
      return { body, path: p };
    } catch (e) {
      problems.push(`${p}: ${e.message}`);
    }
  }
  console.warn(`  ${label}: no endpoint answered`);
  for (const p of problems) console.warn(`      ${p}`);
  return { body: null, path: null, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    console.error('usage: node tools/fetch-tournament.mjs <tournamentId> [--division N] [--dry-run]');
    process.exit(2);
  }

  const dataDir = path.join(ROOT, 'assets', 'data', args.id);
  const rawDir = path.join(dataDir, 'raw');

  console.log(`Fetching tournament ${args.id} from CricHeroes…`);
  const matches = await tryAll('fixtures', ENDPOINTS.matches, args.id);
  if (!matches.body) {
    console.error('\nCould not read the fixture list — nothing else can be built without it.');
    console.error('Add the working path to ENDPOINTS.matches in assets/js/config.js and retry.');
    process.exit(1);
  }
  const teams = await tryAll('teams', ENDPOINTS.teams, args.id);
  const points = await tryAll('points table', ENDPOINTS.pointsTable, args.id);
  const detail = await tryAll('detail', ENDPOINTS.detail, args.id);

  if (!args.dryRun) {
    await mkdir(rawDir, { recursive: true });
    for (const [name, res] of Object.entries({ matches, teams, points, detail })) {
      if (res.body) await writeFile(path.join(rawDir, `${name}.json`), JSON.stringify(res.body, null, 1));
    }
    console.log(`  raw payloads -> assets/data/${args.id}/raw/`);
  }

  const snap = buildSnapshot({
    matchesRaw: matches.body,
    teamsRaw: teams.body,
    pointsRaw: points.body,
  });
  const completed = snap.matches.filter((m) => m.status === 'completed').length;
  console.log(`\nParsed ${snap.teams.length} teams and ${snap.matches.length} matches ` +
    `(${completed} completed, ${snap.matches.length - completed} to play).`);
  if (!snap.matches.length) {
    console.error('No matches parsed. Inspect assets/data/*/raw/matches.json and extend ALIASES in assets/js/chnorm.js.');
    process.exit(1);
  }

  // Division map: same file the page uses, so both agree on who is where.
  const mapPath = path.join(ROOT, 'assets', 'data', 'divisions.json');
  let divisionMap = null;
  if (existsSync(mapPath)) {
    const all = JSON.parse(await readFile(mapPath, 'utf8'));
    divisionMap = all[args.id] || null;
  }
  if (!divisionMap) {
    console.warn('\nNo division map for this tournament in assets/data/divisions.json —');
    console.warn('writing a single snapshot containing every team instead.');
  }

  const metaPath = path.join(dataDir, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf8')) : {};
  const rules = { ...DEFAULT_RULES, ...(meta.rules || {}) };

  const divisions = args.division != null ? [args.division]
    : (divisionMap ? [...new Set(Object.values(divisionMap.byId || {}))].sort((a, b) => a - b) : [null]);

  for (const division of divisions) {
    const sub = divisionMap
      ? filterToDivision(snap, division, divisionMap)
      : { teams: snap.teams, matches: snap.matches, warnings: [] };
    if (!sub.teams.length) {
      console.warn(`  Division ${division}: no teams matched, skipped.`);
      continue;
    }
    const table = standingsFor(sub.teams, sub.matches, rules);
    const left = sub.matches.filter((m) => m.status !== 'completed').length;

    const body = {
      tournament_id: Number(args.id),
      tournament_name: meta.name || `Tournament ${args.id}`,
      division,
      generated_at: new Date().toISOString(),
      source: 'cricheroes',
      endpoints: { matches: matches.path, teams: teams.path, points: points.path },
      rules,
      teams: sub.teams,
      matches: sub.matches,
      published: snap.published.filter((p) => sub.teams.some((t) => t.id === p.teamId)),
      warnings: sub.warnings,
    };

    const file = path.join(dataDir, `division-${division ?? 'all'}.json`);
    if (args.dryRun) {
      console.log(`\n[dry run] Division ${division}: ${sub.teams.length} teams, ${left} games left`);
      table.slice(0, 5).forEach((r, i) => {
        const t = sub.teams.find((x) => x.id === r.teamId);
        console.log(`   ${i + 1}. ${(t?.name || r.teamId).padEnd(24)} ${String(r.points).padStart(3)} pts  ` +
          `NRR ${netRunRate(r).toFixed(3)}`);
      });
    } else {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, JSON.stringify(body, null, 1));
      console.log(`  Division ${division}: ${sub.teams.length} teams, ${left} to play -> ` +
        path.relative(ROOT, file));
    }
  }

  if (!args.dryRun) console.log('\nDone. Commit the updated files to publish them.');
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
