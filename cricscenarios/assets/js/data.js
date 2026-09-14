/**
 * data.js — loading a division, from the committed snapshot or from CricHeroes.
 *
 * The page always renders from a snapshot first so there is never a blank
 * screen waiting on a network call, then optionally refreshes in place. Both
 * paths end in the same object, so nothing downstream knows or cares which was
 * used:
 *
 *   { tournament, division, teams, matches, rules, source, fetchedAt, warnings }
 */

import { ENDPOINTS, proxyBase } from './config.js';
import { buildSnapshot } from './chnorm.js';
import { DEFAULT_RULES, standingsFor } from './engine.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

/* ------------------------------------------------------------- snapshots */

export async function loadRegistry() {
  return getJson('assets/data/tournaments.json', { cache: 'no-cache' });
}

export async function loadTournamentMeta(tid) {
  return getJson(`assets/data/${tid}/meta.json`, { cache: 'no-cache' });
}

/** The team -> division map, shared by every division of a tournament. */
export async function loadDivisionMap(tid) {
  try {
    const all = await getJson('assets/data/divisions.json', { cache: 'force-cache' });
    return all[String(tid)] || null;
  } catch {
    return null;
  }
}

export async function loadSnapshot(tid, division) {
  const snap = await getJson(`assets/data/${tid}/division-${division}.json`, { cache: 'no-cache' });
  return hydrate(snap);
}

/** Fill in the derived bits a snapshot does not store. */
export function hydrate(snap) {
  const rules = { ...DEFAULT_RULES, ...(snap.rules || {}) };
  const teams = snap.teams || [];
  const matches = snap.matches || [];
  return {
    ...snap,
    rules,
    teams,
    matches,
    standings: standingsFor(teams, matches, rules),
    warnings: snap.warnings || [],
  };
}

/* ----------------------------------------------------------- live reload */

/**
 * Try each candidate path in turn, returning the first response that yields
 * records. Returns `null` rather than throwing when every candidate fails, so
 * one dead endpoint does not take the whole refresh down.
 */
async function tryEndpoints(base, paths, tid, validate) {
  const tried = [];
  for (const tpl of paths) {
    const path = tpl.replace('{id}', String(tid));
    const url = `${base}/ch?path=${encodeURIComponent(path)}`;
    try {
      const body = await getJson(url, { cache: 'no-store' });
      if (validate(body)) return { body, path };
      tried.push(`${path}: no usable records`);
    } catch (e) {
      tried.push(`${path}: ${e.message}`);
    }
  }
  return { body: null, path: null, tried };
}

/**
 * Pull a division straight from CricHeroes through the proxy.
 *
 * `divisionMap` is what keeps this honest: a TCL tournament is one CricHeroes
 * tournament containing every division, so the fixture list comes back with all
 * ~125 teams in it and has to be filtered down to the division in question.
 */
export async function fetchLive(tid, division, { divisionMap, rules, meta } = {}) {
  const base = proxyBase();
  if (!base) throw new Error('No proxy configured — set WORKER_URL in assets/js/config.js');

  const warnings = [];
  const hasRecords = (b) => {
    try { return !!b && JSON.stringify(b).length > 40; } catch { return false; }
  };

  const matchesRes = await tryEndpoints(base, ENDPOINTS.matches, tid, hasRecords);
  if (!matchesRes.body) {
    throw new Error('Could not read the fixture list from CricHeroes.\n' +
      (matchesRes.tried || []).join('\n'));
  }
  const teamsRes = await tryEndpoints(base, ENDPOINTS.teams, tid, hasRecords);
  const pointsRes = await tryEndpoints(base, ENDPOINTS.pointsTable, tid, hasRecords);
  if (!teamsRes.body) warnings.push('Team list endpoint unavailable; names taken from the fixture list.');
  if (!pointsRes.body) warnings.push('Published points table unavailable; no cross-check performed.');

  const snap = buildSnapshot({
    matchesRaw: matchesRes.body,
    teamsRaw: teamsRes.body,
    pointsRaw: pointsRes.body,
  });

  const filtered = filterToDivision(snap, division, divisionMap);
  if (!filtered.teams.length) {
    throw new Error(`No Division ${division} teams found in the CricHeroes response.`);
  }
  warnings.push(...filtered.warnings);

  return hydrate({
    tournament_id: tid,
    tournament_name: meta?.name || `Tournament ${tid}`,
    division,
    rules: rules || meta?.rules || DEFAULT_RULES,
    teams: filtered.teams,
    matches: filtered.matches,
    published: snap.published,
    source: 'live',
    fetchedAt: new Date().toISOString(),
    warnings,
  });
}

/**
 * Reduce a whole-tournament snapshot to one division.
 *
 * Matching is by CricHeroes team id first and normalised name second — the same
 * two-step the ticker uses, because the division map was built from ids but
 * teams occasionally reappear under a new id between seasons.
 */
export function filterToDivision(snap, division, divisionMap) {
  const warnings = [];
  if (!divisionMap) {
    return { teams: snap.teams, matches: snap.matches, warnings: ['No division map — showing every team in the tournament.'] };
  }
  const { byId = {}, byName = {} } = divisionMap;
  const divisionOf = (team) => {
    if (team.id != null && byId[String(team.id)] != null) return byId[String(team.id)];
    if (byName[norm(team.name)] != null) return byName[norm(team.name)];
    return null;
  };

  const teams = [];
  const unknown = [];
  for (const t of snap.teams) {
    const d = divisionOf(t);
    if (d === division) teams.push(t);
    else if (d == null) unknown.push(t.name);
  }
  if (unknown.length) {
    warnings.push(`${unknown.length} team(s) in the tournament are not in the division map ` +
      `and were left out: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`);
  }

  const ids = new Set(teams.map((t) => t.id));
  const matches = snap.matches.filter((m) => ids.has(m.home) && ids.has(m.away));
  return { teams, matches, warnings };
}

/* ------------------------------------------------------------ crosscheck */

/**
 * Compare our computed table against the one CricHeroes publishes.
 *
 * Any disagreement is worth surfacing rather than hiding: it usually means a
 * match result did not parse, or the division uses different points rules than
 * the snapshot assumes, and either way the projections downstream are suspect.
 */
export function crossCheck(standings, published) {
  if (!published || !published.length) return [];
  const byName = new Map(published.map((p) => [norm(p.name), p]));
  const issues = [];
  for (const row of standings) {
    const pub = (row.teamId != null && published.find((p) => p.teamId === row.teamId))
      || byName.get(norm(row.name || ''));
    if (!pub) continue;
    if (pub.points != null && pub.points !== row.points) {
      issues.push(`${pub.name}: we compute ${row.points} points, CricHeroes shows ${pub.points}.`);
    }
    if (pub.nrr != null && Math.abs(pub.nrr - row.nrr) > 0.05) {
      issues.push(`${pub.name}: we compute NRR ${row.nrr.toFixed(3)}, CricHeroes shows ${pub.nrr}.`);
    }
  }
  return issues;
}
