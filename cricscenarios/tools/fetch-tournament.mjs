#!/usr/bin/env node
/**
 * Refresh the committed snapshots from CricHeroes.
 *
 *   node tools/fetch-tournament.mjs 2100677            # every division
 *   node tools/fetch-tournament.mjs 2100677 --division 7
 *   node tools/fetch-tournament.mjs 2100677 --dry-run  # fetch, print, write nothing
 *
 * Node 18+ (it uses the built-in fetch); no npm install, the project has no
 * dependencies. Runnable from any directory — paths resolve from this file's
 * own location, not the working directory.
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
import { buildSnapshot, normaliseTeams, collectRecords } from '../assets/js/chnorm.js';
import { collectFixtures } from '../assets/js/fixtures.js';
import { filterToDivision, crossCheck } from '../assets/js/data.js';
import {
  standingsFor, DEFAULT_RULES, netRunRate, baselineFromPublished,
} from '../assets/js/engine.js';
import { writeIndex } from './snapshot-index.mjs';

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

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Read the team -> division map straight off the published standings.
 *
 * CricHeroes calls them groups ("Group 7 (League Matches)"); TCL calls them
 * divisions. Deriving the map here rather than maintaining it by hand means a
 * team that moves — or one that was simply missed — is picked up on the next
 * fetch instead of quietly vanishing from its division.
 */
function divisionMapFromStandings(pointsRaw) {
  const groups = collectRecords(pointsRaw, (o) => o && typeof o === 'object'
    && o.team_id != null && (o.group != null || o.group_id != null));
  const byId = {};
  const byName = {};
  for (const row of groups) {
    const m = String(row.group ?? '').match(/(\d+)/);
    if (!m) continue;
    const division = Number(m[1]);
    byId[String(row.team_id)] = division;
    if (row.team_name) byName[norm(row.team_name)] = division;
  }
  return Object.keys(byId).length ? { byId, byName } : null;
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
  const teams = await tryAll('teams', ENDPOINTS.teams, args.id);
  const points = await tryAll('points table', ENDPOINTS.pointsTable, args.id);
  const detail = await tryAll('detail', ENDPOINTS.detail, args.id);

  // The fixture list. CricHeroes retired every whole-tournament route, so the
  // list is normally assembled team by team; the old routes are still tried
  // first because one call beats a hundred and twenty-six.
  const matches = await tryAll('fixtures', ENDPOINTS.matches, args.id);
  if (!matches.body) {
    if (!teams.body) {
      console.error('\nNo fixture route answered and the team list is unavailable too —');
      console.error('there is nothing to assemble a fixture list from. Check assets/js/config.js.');
      process.exit(1);
    }
    const teamIds = normaliseTeams(teams.body).map((t) => t.id);
    if (process.stdout.isTTY) process.stdout.write(`  fixtures: assembling from ${teamIds.length} team match lists…`);
    const got = await collectFixtures({
      get: (p) => get(p),
      teamIds,
      tournamentId: args.id,
      template: ENDPOINTS.teamMatches[0],
      // Redrawn in place on a terminal; silent when the output is a log file.
      onProgress: process.stdout.isTTY
        ? (done, total, found) => process.stdout.write(
          `\r  fixtures: assembling from ${total} team match lists… ${done}/${total} teams, ${found} matches`)
        : null,
    });
    if (process.stdout.isTTY) process.stdout.write('\n');
    for (const f of got.failures) console.warn(`      ${f}`);
    if (!got.matches.length) {
      console.error('\nCould not read the fixture list — nothing else can be built without it.');
      process.exit(1);
    }
    matches.body = { data: got.matches };
    matches.path = ENDPOINTS.teamMatches[0];
    const advertised = detail.body?.data?.match_count;
    if (advertised != null) {
      console.log(`  fixtures: ${got.matches.length} of the ${advertised} matches CricHeroes reports` +
        `${got.matches.length === advertised ? ' — complete' : ''}`);
    }
  }

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

  // Division map: same file the page uses, so both agree on who is where. The
  // published standings are the authority; the committed file supplies anyone
  // the standings have dropped (a withdrawn team still has fixtures on record).
  const mapPath = path.join(ROOT, 'assets', 'data', 'divisions.json');
  const allMaps = existsSync(mapPath) ? JSON.parse(await readFile(mapPath, 'utf8')) : {};
  const committed = allMaps[args.id] || null;
  const fromStandings = points.body ? divisionMapFromStandings(points.body) : null;
  let divisionMap = committed;
  if (fromStandings) {
    divisionMap = {
      byId: { ...(committed?.byId || {}), ...fromStandings.byId },
      byName: { ...(committed?.byName || {}), ...fromStandings.byName },
    };
    const added = Object.keys(fromStandings.byId).filter((k) => committed?.byId?.[k] == null);
    const moved = Object.keys(fromStandings.byId)
      .filter((k) => committed?.byId?.[k] != null && committed.byId[k] !== fromStandings.byId[k]);
    if (added.length || moved.length) {
      console.log(`  division map: ${added.length} team(s) added, ${moved.length} moved ` +
        '(from the published standings)');
    }
    if (!args.dryRun) {
      allMaps[args.id] = divisionMap;
      await writeFile(mapPath, JSON.stringify(allMaps));
    }
  }
  if (!divisionMap) {
    console.warn('\nNo division map for this tournament in assets/data/divisions.json —');
    console.warn('writing a single snapshot containing every team instead.');
  }

  const metaPath = path.join(dataDir, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf8')) : {};
  const rules = { ...DEFAULT_RULES, ...(meta.rules || {}) };

  const written = [];
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
    const published = snap.published.filter((p) => sub.teams.some((t) => t.id === p.teamId));
    const baseline = baselineFromPublished(published, sub.teams);
    const table = standingsFor(sub.teams, sub.matches, rules, baseline);
    const left = sub.matches.filter((m) => m.status !== 'completed').length;

    // Recompute from the fixtures too and say where the two disagree. The
    // snapshot ships the published figures, so this is not a correctness gate
    // — it is the signal that a result stopped parsing.
    const ownIssues = crossCheck(
      standingsFor(sub.teams, sub.matches, rules).map((r) => ({
        teamId: r.teamId, points: r.points, nrr: netRunRate(r),
        name: (sub.teams.find((t) => t.id === r.teamId) || {}).name,
      })),
      published);
    if (!published.length) {
      sub.warnings.push('CricHeroes published no points table for this division; ' +
        'the table below is computed from the fixtures alone.');
    } else if (!baseline) {
      sub.warnings.push('The published points table does not cover every team in this ' +
        'division, so the table below is computed from the fixtures alone.');
    }

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
      published,
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
      if (ownIssues.length) {
        console.log(`   recomputed from fixtures, ${ownIssues.length} row(s) differ from the published table:`);
        ownIssues.forEach((i) => console.log(`     ${i}`));
      }
    } else {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, JSON.stringify(body, null, 1));
      written.push({
        division,
        teams: sub.teams.length,
        matches: sub.matches.length,
        played: sub.matches.length - left,
        remaining: left,
        source: 'cricheroes',
        placeholder: false,
        generated_at: body.generated_at,
      });
      console.log(`  Division ${division}: ${sub.teams.length} teams, ${left} to play` +
        `${baseline ? '' : ', no published baseline'}` +
        `${ownIssues.length ? `, ${ownIssues.length} row(s) differ when recomputed` : ''}` +
        ` -> ${path.relative(ROOT, file)}`);
    }
  }

  if (!args.dryRun) {
    // Refresh the index the division-list page reads, merging rather than
    // replacing so a single --division run leaves the others intact.
    await writeIndex(dataDir, Number(args.id), written);
    console.log(`\nUpdated index.json for ${written.length} division(s).`);
    console.log('Done. Commit the updated files to publish them.');
  }
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
