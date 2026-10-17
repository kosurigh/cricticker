/**
 * overview.js — how far along each division is, for the division list.
 *
 * The division list used to read `remaining` straight out of index.json,
 * which is only as fresh as the last committed snapshot — weeks stale by the
 * end of a season, so a division with six games left still said thirty-one.
 *
 * Live, the cheap and exact source is the published points table: one
 * request, and every division match has both teams in the division, so half
 * the sum of the division's `played` column is the number of matches played.
 * It is the same figure the division page shows (CricHeroes' own table, which
 * the snapshot tests check against the fixture list team by team). The
 * division's fixture total comes from the snapshot, and is checked against the
 * tournament's advertised match count so a rescheduled season is noticed
 * rather than quietly miscounted.
 */

import { ENDPOINTS, proxyBase } from './config.js';
import { normalisePointsTable } from './chnorm.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which division a published row belongs to, by id then by name. */
function divisionOf(row, divisionMap) {
  if (!divisionMap) return null;
  const { byId = {}, byName = {} } = divisionMap;
  if (row.teamId != null && byId[String(row.teamId)] != null) return byId[String(row.teamId)];
  if (byName[norm(row.name)] != null) return byName[norm(row.name)];
  return null;
}

/**
 * Per-division progress from a published table.
 *
 * `totals` maps division -> fixtures in the division (from the snapshot).
 * Returns Map(division -> { teams, played, total, remaining, complete }).
 * `played` is null for a division the table does not cover.
 */
export function divisionProgress(published, divisionMap, totals) {
  const sums = new Map();
  for (const p of published || []) {
    const d = divisionOf(p, divisionMap);
    if (d == null || p.played == null) continue;
    const s = sums.get(d) || { teams: 0, apps: 0 };
    s.teams++; s.apps += p.played;
    sums.set(d, s);
  }
  const out = new Map();
  for (const [d, total] of totals) {
    const s = sums.get(d);
    // Every match puts two division teams on the table, so appearances / 2.
    const played = s ? Math.round(s.apps / 2) : null;
    const remaining = played == null || total == null ? null : Math.max(0, total - played);
    out.set(d, {
      teams: s ? s.teams : null, played, total, remaining,
      complete: remaining === 0,
    });
  }
  return out;
}

/** The card's status line. */
export function progressLabel(info) {
  if (!info || info.remaining == null) return null;
  if (info.remaining === 0) return `Complete · all ${info.total} played`;
  return `${info.remaining} game${info.remaining === 1 ? '' : 's'} to play · ${info.played} of ${info.total} played`;
}

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.json();
}

async function firstAnswer(base, paths, tid) {
  for (const tpl of paths) {
    const path = tpl.replace('{id}', String(tid));
    try {
      const body = await getJson(`${base}/ch?path=${encodeURIComponent(path)}`);
      if (body && JSON.stringify(body).length > 40) return body;
    } catch { /* next candidate */ }
  }
  return null;
}

/**
 * Live progress for every division: the points table plus the tournament's
 * advertised match count. Returns null when no proxy is configured or the
 * points table cannot be read, so the caller keeps the snapshot figures.
 */
export async function fetchLiveProgress(tid, divisionMap, totals) {
  const base = proxyBase();
  if (!base) return null;
  const [points, detail] = await Promise.all([
    firstAnswer(base, ENDPOINTS.pointsTable, tid),
    firstAnswer(base, ENDPOINTS.detail, tid),
  ]);
  if (!points) return null;
  const progress = divisionProgress(normalisePointsTable(points), divisionMap, totals);
  const advertised = Number(detail?.data?.match_count);
  const snapshotTotal = [...totals.values()].reduce((a, b) => a + (b || 0), 0);
  return {
    progress,
    fetchedAt: new Date().toISOString(),
    // The fixture totals come from the snapshot; if CricHeroes now lists a
    // different number of matches, the season has been rescheduled since.
    scheduleChanged: Number.isFinite(advertised) && advertised > 0 && advertised !== snapshotTotal,
    advertised: Number.isFinite(advertised) ? advertised : null,
  };
}
