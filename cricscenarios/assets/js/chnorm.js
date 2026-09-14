/**
 * chnorm.js — turn a CricHeroes API payload into this project's schema.
 *
 * CricHeroes has no published API contract. Field names differ between the
 * tournament, match-list and scorecard endpoints, and they change between
 * releases. So rather than hard-coding one shape, everything here works from
 * *alias lists* and a deep search for the array that looks like a fixture list.
 *
 * That means a CricHeroes rename usually breaks nothing; when it does, the fix
 * is adding one string to an alias list below, not rewriting a parser. The
 * fetch script also writes the untouched payload to disk next to the snapshot,
 * so there is always something to read when a mapping needs adjusting.
 *
 * Output schema (also what the committed snapshots hold):
 *
 *   team  { id, name, short, logo }
 *   match { id, date, home, away, status, venue,
 *           result: { winner, type, margin, innings: [{team, runs, wickets,
 *                                                      overs, allOut}] } }
 */

/* --------------------------------------------------------------- helpers */

/** First alias present on `obj` with a non-empty value. */
export function pick(obj, aliases, fallback = null) {
  if (!obj) return fallback;
  for (const k of aliases) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

export const ALIASES = {
  matchId: ['match_id', 'matchId', 'id'],
  homeId: ['team_a_id', 'team_1_id', 'teamAId', 'home_team_id', 'batting_team_id'],
  awayId: ['team_b_id', 'team_2_id', 'teamBId', 'away_team_id', 'bowling_team_id'],
  homeName: ['team_a', 'team_a_name', 'team_1_name', 'teamA', 'home_team_name'],
  awayName: ['team_b', 'team_b_name', 'team_2_name', 'teamB', 'away_team_name'],
  homeSummary: ['team_a_summary', 'team_1_summary', 'teamASummary', 'team_a_score'],
  awaySummary: ['team_b_summary', 'team_2_summary', 'teamBSummary', 'team_b_score'],
  homeOvers: ['team_a_overs', 'team_1_overs'],
  awayOvers: ['team_b_overs', 'team_2_overs'],
  winnerId: ['winning_team_id', 'winner_team_id', 'win_team_id', 'winnerId'],
  resultText: ['match_result', 'result', 'summary', 'match_summary', 'status_note'],
  status: ['match_status', 'status', 'match_state'],
  date: ['match_start_time', 'start_datetime', 'match_date', 'start_time', 'date'],
  venue: ['ground_name', 'ground', 'venue', 'city_name'],
  // Teams
  teamId: ['team_id', 'id'],
  teamName: ['team_name', 'name'],
  teamShort: ['short_name', 'team_short_name', 'abbreviation'],
  teamLogo: ['team_logo', 'logo', 'profile_photo'],
  // Points table
  ptPlayed: ['matches', 'played', 'total_matches', 'M', 'mat'],
  ptWon: ['win', 'won', 'wins', 'W'],
  ptLost: ['loss', 'lost', 'losses', 'L'],
  ptPoints: ['points', 'point', 'pts', 'total_points'],
  ptNrr: ['nrr', 'net_run_rate', 'netRunRate', 'run_rate'],
};

/** Everything CricHeroes has ever meant by "this match is over". */
const COMPLETED = new Set([
  'completed', 'complete', 'finished', 'result', 'past', 'closed', 'ended', '2', '3',
]);
const ABANDONED = new Set([
  'abandoned', 'cancelled', 'canceled', 'no result', 'no_result', 'washed out',
]);

export function normaliseStatus(raw, resultText) {
  const s = String(raw ?? '').toLowerCase().trim();
  const t = String(resultText ?? '').toLowerCase();
  if (ABANDONED.has(s) || /abandon|cancel|no result|washed/.test(t)) return 'abandoned';
  if (COMPLETED.has(s)) return 'completed';
  if (/\bwon by\b|\bwon the match\b|\btied\b|\bmatch tied\b/.test(t)) return 'completed';
  if (s === 'live' || s === '1' || /in progress/.test(s)) return 'live';
  return 'upcoming';
}

/**
 * Parse a CricHeroes innings summary string.
 *
 * Seen in the wild: "165/6 (20)", "165/6 (19.3 Ov)", "165 (20 Ov)",
 * "165/10 (18.2)". Ten wickets down means all out, which matters: net run rate
 * charges a side bowled out for its full quota of overs.
 */
export function parseSummary(text, oversHint) {
  if (text == null && oversHint == null) return null;
  const s = String(text ?? '');
  const m = s.match(/(\d+)\s*(?:\/\s*(\d+))?\s*(?:\(\s*([\d]+(?:\.\d)?)\s*(?:ov|overs)?\s*\))?/i);
  if (!m) return null;
  const runs = num(m[1]);
  if (runs === null) return null;
  const wickets = num(m[2]);
  const overs = num(m[3]) ?? num(oversHint);
  return {
    runs,
    wickets: wickets === null ? null : wickets,
    overs: overs === null ? null : overs,
    allOut: wickets !== null && wickets >= 10,
  };
}

/** "won by 23 runs" / "won by 5 wickets" / "match tied". */
export function parseResultText(text) {
  const s = String(text ?? '').toLowerCase();
  if (/tied/.test(s)) return { type: 'tie', margin: 0 };
  if (/abandon|cancel|no result|washed/.test(s)) return { type: 'no_result', margin: null };
  const runs = s.match(/by\s+(\d+)\s+run/);
  if (runs) return { type: 'runs', margin: Number(runs[1]) };
  const wkts = s.match(/by\s+(\d+)\s+wicket/);
  if (wkts) return { type: 'wickets', margin: Number(wkts[1]) };
  return { type: null, margin: null };
}

/* ----------------------------------------------------- finding the array */

function looksLikeMatch(o) {
  if (!o || typeof o !== 'object') return false;
  const hasTeams = (pick(o, ALIASES.homeId) != null || pick(o, ALIASES.homeName) != null)
    && (pick(o, ALIASES.awayId) != null || pick(o, ALIASES.awayName) != null);
  return hasTeams && pick(o, ALIASES.matchId) != null;
}

function looksLikeStanding(o) {
  if (!o || typeof o !== 'object') return false;
  return pick(o, ALIASES.teamName) != null
    && (pick(o, ALIASES.ptPoints) != null || pick(o, ALIASES.ptNrr) != null);
}

/**
 * Depth-first search for the largest array whose elements pass `test`.
 *
 * Responses nest the useful list at an unpredictable depth — sometimes
 * `data`, sometimes `data.matches`, sometimes `data.groups[0].teams` — so
 * searching beats guessing a path.
 */
export function findRecords(root, test, depth = 0) {
  if (depth > 8 || root == null) return [];
  if (Array.isArray(root)) {
    const hits = root.filter(test);
    if (hits.length && hits.length >= root.length / 2) return hits;
    let best = [];
    for (const item of root) {
      const found = findRecords(item, test, depth + 1);
      if (found.length > best.length) best = found;
    }
    return best;
  }
  if (typeof root === 'object') {
    let best = [];
    for (const key of Object.keys(root)) {
      const found = findRecords(root[key], test, depth + 1);
      if (found.length > best.length) best = found;
    }
    return best;
  }
  return [];
}

/* ------------------------------------------------------------ normalisers */

export function normaliseTeams(raw) {
  const records = findRecords(raw, (o) => o && typeof o === 'object'
    && pick(o, ALIASES.teamName) != null && pick(o, ALIASES.teamId) != null);
  const byId = new Map();
  for (const r of records) {
    const id = num(pick(r, ALIASES.teamId));
    if (id == null || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: String(pick(r, ALIASES.teamName, `Team ${id}`)),
      short: pick(r, ALIASES.teamShort) || null,
      logo: pick(r, ALIASES.teamLogo) || null,
    });
  }
  return Array.from(byId.values());
}

/**
 * Normalise a fixture list. Teams are keyed by CricHeroes team id where one is
 * present; where the payload only carries names, a stable id is synthesised
 * from the name so the rest of the pipeline still has something to join on.
 */
export function normaliseMatches(raw) {
  const records = findRecords(raw, looksLikeMatch);
  const teams = new Map();

  const teamKey = (id, name) => {
    const n = num(id);
    if (n != null) {
      if (!teams.has(n)) teams.set(n, { id: n, name: name ? String(name) : `Team ${n}`, short: null, logo: null });
      else if (name && /^Team \d+$/.test(teams.get(n).name)) teams.get(n).name = String(name);
      return n;
    }
    if (!name) return null;
    const synth = synthId(String(name));
    if (!teams.has(synth)) teams.set(synth, { id: synth, name: String(name), short: null, logo: null, synthetic: true });
    return synth;
  };

  const matches = [];
  for (const r of records) {
    const id = num(pick(r, ALIASES.matchId));
    const home = teamKey(pick(r, ALIASES.homeId), pick(r, ALIASES.homeName));
    const away = teamKey(pick(r, ALIASES.awayId), pick(r, ALIASES.awayName));
    if (home == null || away == null || home === away) continue;

    const resultText = pick(r, ALIASES.resultText);
    const status = normaliseStatus(pick(r, ALIASES.status), resultText);
    const match = {
      id: id ?? `${home}-${away}-${matches.length}`,
      date: pick(r, ALIASES.date),
      venue: pick(r, ALIASES.venue),
      home,
      away,
      status: status === 'live' ? 'upcoming' : status,
      resultText: resultText ? String(resultText) : null,
    };

    if (status === 'abandoned') {
      match.status = 'completed';
      match.result = { type: 'no_result', winner: null, margin: null, innings: [] };
      matches.push(match);
      continue;
    }
    if (status !== 'completed') { matches.push(match); continue; }

    const hs = parseSummary(pick(r, ALIASES.homeSummary), pick(r, ALIASES.homeOvers));
    const as = parseSummary(pick(r, ALIASES.awaySummary), pick(r, ALIASES.awayOvers));
    const parsed = parseResultText(resultText);
    let winner = num(pick(r, ALIASES.winnerId));
    if (winner != null && winner !== home && winner !== away) winner = null;
    if (winner == null && parsed.type && parsed.type !== 'tie' && hs && as) {
      winner = hs.runs > as.runs ? home : (as.runs > hs.runs ? away : null);
    }

    if (!hs || !as) {
      // Completed, but the scores did not come through on this endpoint. Keep
      // the points, drop it from the run-rate maths rather than inventing runs.
      match.result = {
        type: parsed.type === 'tie' ? 'tie' : (winner != null ? (parsed.type || 'runs') : 'no_result'),
        winner, margin: parsed.margin, innings: [], incomplete: true,
      };
      matches.push(match);
      continue;
    }

    // Whoever posted the higher total with 20 overs used batted first in the
    // common case; where a chase was won, the winner's innings is the shorter.
    const homeFirst = decideBattingOrder(hs, as, winner, home, away, parsed);
    const first = homeFirst ? { team: home, ...hs } : { team: away, ...as };
    const second = homeFirst ? { team: away, ...as } : { team: home, ...hs };

    match.result = {
      type: parsed.type === 'tie' ? 'tie' : (parsed.type || (winner != null ? 'runs' : 'no_result')),
      winner: parsed.type === 'tie' ? null : winner,
      margin: parsed.margin,
      innings: [first, second],
    };
    matches.push(match);
  }

  return { matches, teams: Array.from(teams.values()) };
}

/**
 * Work out who batted first from the scorecard shape.
 *
 * It matters only for reconstructing the two innings in order; net run rate is
 * unaffected by which way round they go, because each side's runs and overs are
 * credited to that side either way. The heuristic: a side that wins by wickets
 * batted second, a side that wins by runs batted first.
 */
function decideBattingOrder(hs, as, winner, home, away, parsed) {
  if (parsed.type === 'wickets' && winner != null) return winner !== home;
  if (parsed.type === 'runs' && winner != null) return winner === home;
  // Fall back to overs used: the side batting second often uses fewer.
  if (hs.overs != null && as.overs != null && hs.overs !== as.overs) {
    return hs.overs > as.overs;
  }
  return true;
}

/** Stable positive integer from a team name, for payloads with no team ids. */
export function synthId(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Keep well clear of real CricHeroes ids (8-digit range) to avoid collisions.
  return 900000000 + (h >>> 0) % 99999999;
}

/** Published points table, used only to cross-check our own computation. */
export function normalisePointsTable(raw) {
  const records = findRecords(raw, looksLikeStanding);
  return records.map((r) => ({
    teamId: num(pick(r, ALIASES.teamId)),
    name: String(pick(r, ALIASES.teamName, '')),
    played: num(pick(r, ALIASES.ptPlayed)),
    won: num(pick(r, ALIASES.ptWon)),
    lost: num(pick(r, ALIASES.ptLost)),
    points: num(pick(r, ALIASES.ptPoints)),
    nrr: num(pick(r, ALIASES.ptNrr)),
  })).filter((r) => r.name);
}

/** Normalise a whole tournament payload bundle into a snapshot body. */
export function buildSnapshot({ matchesRaw, teamsRaw, pointsRaw }) {
  const { matches, teams: fromMatches } = normaliseMatches(matchesRaw);
  const declared = teamsRaw ? normaliseTeams(teamsRaw) : [];

  const byId = new Map(fromMatches.map((t) => [t.id, t]));
  for (const t of declared) {
    const existing = byId.get(t.id);
    if (existing) Object.assign(existing, { name: t.name, short: t.short || existing.short, logo: t.logo || existing.logo });
    else byId.set(t.id, t);
  }

  return {
    teams: Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name)),
    matches,
    published: pointsRaw ? normalisePointsTable(pointsRaw) : [],
  };
}
