/**
 * fixtures.js — assembling a tournament's fixture list out of per-team ones.
 *
 * CricHeroes used to serve the whole fixture list for a tournament in one call.
 * It no longer does: every `get-tournament-matches`-shaped route returns 404,
 * while `/api/v1/team/get-team-match/<teamId>` still works and is paginated.
 * So the list is rebuilt by asking each of the tournament's teams for its own
 * matches and keeping the ones that belong to this tournament.
 *
 * Every match comes back twice (once per side), which is the useful part: it
 * makes the result self-checking. A tournament of N teams each playing M games
 * yields N*M/2 distinct match ids, and the fetcher compares that against the
 * count the tournament detail endpoint advertises.
 *
 * The caller supplies `get`, so the same code runs in Node against the API
 * directly and in the browser through the CORS proxy.
 */

/** Follow `page.next` until a team's history runs out. */
async function pagesFor(get, path, maxPages) {
  const out = [];
  let next = path;
  for (let i = 0; i < maxPages && next; i++) {
    const body = await get(next);
    const records = Array.isArray(body?.data) ? body.data : [];
    if (!records.length) break;
    out.push(...records);
    const link = body?.page?.next;
    // `page.next` is served without the /api/v1 prefix the request needs.
    next = link ? (link.startsWith('/api/') ? link : `/api/v1${link}`) : null;
  }
  return out;
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/**
 * Build the fixture list for `tournamentId` from its teams' match lists.
 *
 * Returns the raw CricHeroes records, deduplicated by match id and untouched
 * otherwise — normalising them is chnorm.js's job, and the fetcher writes them
 * to disk exactly as they arrived.
 */
export async function collectFixtures({
  get, teamIds, tournamentId, template = '/api/v1/team/get-team-match/{id}',
  concurrency = 8, maxPages = 30, onProgress = null,
}) {
  const byId = new Map();
  const failures = [];
  let done = 0;

  await pool(teamIds, concurrency, async (teamId) => {
    try {
      const records = await pagesFor(get, template.replace('{id}', String(teamId)), maxPages);
      for (const r of records) {
        if (String(r.tournament_id) !== String(tournamentId)) continue;
        const id = r.match_id ?? r.matchId ?? r.id;
        if (id != null && !byId.has(id)) byId.set(id, r);
      }
    } catch (e) {
      failures.push(`team ${teamId}: ${e.message}`);
    }
    done++;
    if (onProgress) onProgress(done, teamIds.length, byId.size);
  });

  return { matches: Array.from(byId.values()), failures };
}
