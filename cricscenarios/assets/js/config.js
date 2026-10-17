/**
 * config.js — the two things you are most likely to need to change.
 *
 * 1. WORKER_URL: where the CricHeroes proxy lives (see worker.js). Until you
 *    deploy one, the page still works — it just runs on the committed snapshot
 *    and the "Refresh from CricHeroes" button stays disabled.
 *
 * 2. SHARED_OUTCOMES: how often a remaining match is assumed to end with
 *    the points shared — washed out / abandoned, or tied — rather than won.
 *
 * 3. ENDPOINTS: candidate CricHeroes API paths, tried in order until one
 *    returns something usable. CricHeroes publishes no API contract and renames
 *    routes between releases, so this is a list rather than a constant. If live
 *    refresh stops working, add the new path to the top of the relevant list —
 *    that is the whole fix, no redeploy needed.
 */

/** Replace with your deployed Worker, e.g. "https://cricscenarios.you.workers.dev". */
export const WORKER_URL = 'https://cricscenarios.tclnc.workers.dev';

/** Running from dev-server.py? Use its built-in proxy instead. */
export function proxyBase() {
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const override = new URLSearchParams(location.search).get('api');
  if (override) return override.replace(/\/+$/, '');
  if (isLocal) return '/api';
  return WORKER_URL ? WORKER_URL.replace(/\/+$/, '') : '';
}

export const ENDPOINTS = {
  // Tried in order. CricHeroes retired every whole-tournament fixture route it
  // used to serve — all four of the paths below answer 404 today — so the
  // fixture list is assembled from `teamMatches` instead (see fixtures.js).
  // They stay here because they cost one request to try and, if CricHeroes ever
  // brings one back, it is the cheaper path by two orders of magnitude.
  matches: [
    '/api/v1/tournament/get-tournament-matches/{id}?page=1',
    '/api/v1/tournament/get-matches/{id}',
    '/api/v1/tournament/matches/{id}',
    '/api/v1/match/get-tournament-matches/{id}',
  ],
  // Per-team fixture list, paginated. `{id}` is a *team* id, not a tournament
  // id, and every page carries `page.next` until the team's history runs out.
  // Fanning this out over the tournament's teams and keeping the records whose
  // tournament_id matches reproduces the fixture list exactly.
  teamMatches: [
    '/api/v1/team/get-team-match/{id}',
  ],
  teams: [
    '/api/v1/tournament/get-tournament-teams/{id}',
    '/api/v1/tournament/get-teams/{id}',
    '/api/v1/tournament/teams/{id}',
  ],
  pointsTable: [
    '/api/v1/tournament/get-tournament-standing/{id}',
    '/api/v1/tournament/get-point-table/{id}',
    '/api/v1/tournament/get-tournament-point-table/{id}',
    '/api/v1/tournament/point-table/{id}',
  ],
  detail: [
    '/api/v1/tournament/get-tournament-detail/{id}',
    '/api/v1/tournament/get-tournament/{id}',
  ],
  // Proven route, borrowed from the ticker project: per-match detail, used to
  // fill in scores when the fixture list arrives without them.
  miniScorecard: [
    '/api/v1/scorecard/get-mini-scorecard/{id}',
  ],
};

export const SIM_PRESETS = [
  { label: 'Fast', trials: 10000 },
  { label: 'Normal', trials: 50000 },
  { label: 'Thorough', trials: 200000 },
];

/**
 * Remaining matches do not only end in a win. Some are washed out (abandoned /
 * no result: points shared, net run rate untouched) and a few are tied (points
 * shared, both innings still count towards net run rate). The points each
 * earns come from the tournament rules (`points_no_result`, `points_tie` in
 * assets/data/<id>/meta.json — 1 each in TCL, against 2 for a win).
 *
 * The rates below are the defaults, measured across the whole of TCL Mega
 * Smash 2026 on 17 Oct 2026: 69 abandoned and 8 tied out of 767 completed
 * matches.
 *
 * With `useDivisionHistory` the rate actually used is blended with the
 * division's own record, weighted as if the default were `priorMatches`
 * matches' worth of evidence. A division that has been unusually wet pulls
 * its rate up a little; one with no ties yet does not drop the tie rate to
 * zero on the strength of sixty games.
 *
 * Set `enabled: false` (or toggle "Wins only" on the page) to get the old
 * win-or-lose model back.
 */
export const SHARED_OUTCOMES = {
  enabled: true,
  abandonRate: 0.09,    // ≈ 69 / 767
  tieRate: 0.01,        // ≈ 8 / 767
  useDivisionHistory: true,
  priorMatches: 40,
};
