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
import { buildSnapshot, normaliseTeams } from './chnorm.js';
import { collectFixtures } from './fixtures.js';
import { DEFAULT_RULES, standingsFor, baselineFromPublished } from './engine.js';

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

/**
 * Fill in the derived bits a snapshot does not store.
 *
 * Where the published table covers the division it seeds the standings, so the
 * played half of the table is CricHeroes' own arithmetic (penalties and all)
 * and only the unplayed half is ours. See engine.baselineFromPublished.
 */
export function hydrate(snap) {
  const rules = { ...DEFAULT_RULES, ...(snap.rules || {}) };
  const teams = snap.teams || [];
  const matches = snap.matches || [];
  const baseline = baselineFromPublished(snap.published, teams);
  return {
    ...snap,
    rules,
    teams,
    matches,
    baseline,
    standings: standingsFor(teams, matches, rules, baseline),
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
 * tournament containing every division, so nothing that comes back is scoped to
 * the division on its own and everything has to be filtered down to it. It is
 * also what makes the refresh affordable — the fixture list has to be assembled
 * team by team now, and the map says which fourteen of the hundred and
 * twenty-six teams this division needs.
 */
export async function fetchLive(tid, division, { divisionMap, rules, meta } = {}) {
  const base = proxyBase();
  if (!base) throw new Error('No proxy configured — set WORKER_URL in assets/js/config.js');

  const warnings = [];
  const hasRecords = (b) => {
    try { return !!b && JSON.stringify(b).length > 40; } catch { return false; }
  };

  const teamsRes = await tryEndpoints(base, ENDPOINTS.teams, tid, hasRecords);
  const pointsRes = await tryEndpoints(base, ENDPOINTS.pointsTable, tid, hasRecords);
  if (!teamsRes.body) warnings.push('Team list endpoint unavailable; names taken from the fixture list.');
  if (!pointsRes.body) warnings.push('Published points table unavailable; no cross-check performed.');

  let matchesRaw = null;
  let matchesPath = null;
  const whole = await tryEndpoints(base, ENDPOINTS.matches, tid, hasRecords);
  if (whole.body) {
    matchesRaw = whole.body;
    matchesPath = whole.path;
  } else {
    // No whole-tournament fixture route answers any more, so the list is built
    // from the division's own teams. Only their matches are needed here: every
    // fixture in a division has a division team on both sides.
    if (!teamsRes.body) {
      throw new Error('Could not read the fixture list from CricHeroes.\n' +
        (whole.tried || []).join('\n'));
    }
    const divisionTeams = filterToDivision(
      { teams: normaliseTeams(teamsRes.body), matches: [] }, division, divisionMap).teams;
    if (!divisionTeams.length) {
      throw new Error(`No Division ${division} teams found in the CricHeroes response.`);
    }
    const got = await collectFixtures({
      get: (path) => getJson(`${base}/ch?path=${encodeURIComponent(path)}`, { cache: 'no-store' }),
      teamIds: divisionTeams.map((t) => t.id),
      tournamentId: tid,
      template: ENDPOINTS.teamMatches[0],
    });
    if (!got.matches.length) {
      throw new Error('Could not read the fixture list from CricHeroes.\n' +
        (whole.tried || []).concat(got.failures).join('\n'));
    }
    if (got.failures.length) {
      warnings.push(`${got.failures.length} team fixture list(s) failed to load; the table may be short of matches.`);
    }
    matchesRaw = { data: got.matches };
    matchesPath = ENDPOINTS.teamMatches[0];
  }

  const snap = buildSnapshot({
    matchesRaw,
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
    published: snap.published.filter((p) => filtered.teams.some((t) => t.id === p.teamId)),
    source: 'live',
    endpoints: { matches: matchesPath, teams: teamsRes.path, points: pointsRes.path },
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
