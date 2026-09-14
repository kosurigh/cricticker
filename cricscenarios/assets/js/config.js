/**
 * config.js — the two things you are most likely to need to change.
 *
 * 1. WORKER_URL: where the CricHeroes proxy lives (see worker.js). Until you
 *    deploy one, the page still works — it just runs on the committed snapshot
 *    and the "Refresh from CricHeroes" button stays disabled.
 *
 * 2. ENDPOINTS: candidate CricHeroes API paths, tried in order until one
 *    returns something usable. CricHeroes publishes no API contract and renames
 *    routes between releases, so this is a list rather than a constant. If live
 *    refresh stops working, add the new path to the top of the relevant list —
 *    that is the whole fix, no redeploy needed.
 */

/** Replace with your deployed Worker, e.g. "https://cricscenarios.you.workers.dev". */
export const WORKER_URL = '';

/** Running from dev-server.py? Use its built-in proxy instead. */
export function proxyBase() {
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const override = new URLSearchParams(location.search).get('api');
  if (override) return override.replace(/\/+$/, '');
  if (isLocal) return '/api';
  return WORKER_URL ? WORKER_URL.replace(/\/+$/, '') : '';
}

export const ENDPOINTS = {
  matches: [
    '/api/v1/tournament/get-tournament-matches/{id}?page=1',
    '/api/v1/tournament/get-matches/{id}',
    '/api/v1/tournament/matches/{id}',
    '/api/v1/match/get-tournament-matches/{id}',
  ],
  teams: [
    '/api/v1/tournament/get-tournament-teams/{id}',
    '/api/v1/tournament/get-teams/{id}',
    '/api/v1/tournament/teams/{id}',
  ],
  pointsTable: [
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
