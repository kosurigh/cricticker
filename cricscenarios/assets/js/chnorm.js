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
  // The margin lives in its own field on the per-team fixture endpoint:
  // `match_result` only ever says "resulted" / "tie" / "abandoned", while
  // `win_by` carries "43 runs", "6 wickets", "walkover", "rain out".
  marginText: ['win_by', 'won_by', 'win_by_text', 'winning_margin'],
  status: ['match_status', 'status', 'match_state'],
  date: ['match_start_time', 'start_datetime', 'match_date', 'start_time', 'date'],
  venue: ['ground_name', 'ground', 'venue', 'city_name'],
  // Overs allotted per side for this fixture. TCL runs 14-, 15-, 16- and
  // 18-over games in the same tournament, and net run rate charges a side
  // bowled out its *match* quota, so this cannot be a tournament constant.
  matchOvers: ['overs', 'match_overs', 'total_overs', 'no_of_overs'],
  // Structured innings, far better than the summary string: it carries the
  // overs actually faced, the innings number and any D/L revision.
  homeInnings: ['team_a_innings', 'team_1_innings', 'teamAInnings'],
  awayInnings: ['team_b_innings', 'team_2_innings', 'teamBInnings'],
  inningsRuns: ['total_run', 'total_runs', 'runs', 'score'],
  inningsWickets: ['total_wicket', 'total_wickets', 'wickets'],
  inningsOvers: ['overs_played', 'overs', 'over'],
  inningsNumber: ['inning', 'innings', 'inning_number'],
  revisedOvers: ['revised_overs'],
  revisedTarget: ['revised_target'],
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
  ptNrr: ['net_rr', 'nrr', 'net_run_rate', 'netRunRate', 'run_rate'],
  ptTied: ['tied', 'tie', 'ties'],
  ptNoResult: ['no_result', 'noResult', 'nr', 'no_results'],
  // "926/119.3" — runs scored off overs faced, as CricHeroes counted them.
  ptFor: ['for', 'runs_for', 'For'],
  ptAgainst: ['against', 'runs_against', 'Against'],
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

/**
 * "won by 23 runs" / "won by 5 wickets" / "match tied" / "walkover".
 *
 * The "won by" is optional because the per-team fixture endpoint states the
 * margin bare, in its own field: `win_by: "43 runs"`. D/L results append their
 * workings ("5 runs (DLS method - match reduced to 16.0 overs, target 124
 * runs)"); the leading margin is the one that counts, and it is the one the
 * scan reaches first.
 */
export function parseResultText(text) {
  const s = String(text ?? '').toLowerCase();
  if (/\btied?\b/.test(s)) return { type: 'tie', margin: 0 };
  if (/abandon|cancel|no result|washed|rain out/.test(s)) return { type: 'no_result', margin: null };
  // A conceded match: a win with no cricket behind it.
  if (/walkover|forfeit|conceded|awarded/.test(s)) return { type: 'walkover', margin: null };
  const runs = s.match(/(?:by\s+)?(\d+)\s+runs?\b/);
  const wkts = s.match(/(?:by\s+)?(\d+)\s+wickets?\b/);
  // Whichever is stated first is this match's margin; the other, if present,
  // belongs to the D/L workings.
  if (runs && (!wkts || runs.index <= wkts.index)) return { type: 'runs', margin: Number(runs[1]) };
  if (wkts) return { type: 'wickets', margin: Number(wkts[1]) };
  return { type: null, margin: null };
}

/**
 * Read one side's innings out of the structured `team_a_innings` array.
 *
 * Better than the summary string in three ways that all matter for net run
 * rate: it states the overs actually faced, it numbers the innings (so who
 * batted second is known rather than guessed), and it carries the D/L revision.
 *
 * The D/L case is the subtle one. When a match is cut short, CricHeroes does
 * not credit the side batting first with what it actually scored — it credits
 * it with the *par score*, one run below the target the chasing side was set,
 * over the revised overs. A side that made 133 off 18 before rain, with the
 * chase reset to 108 off 14, goes into the table as 107 off 14. Reproducing
 * that is the difference between agreeing with the published table and not.
 */
export function parseInnings(list, matchOvers) {
  const rows = Array.isArray(list) ? list : (list ? [list] : []);
  const first = rows.find((r) => r && pick(r, ALIASES.inningsRuns) != null);
  if (!first) return null;

  const revisedOvers = num(pick(first, ALIASES.revisedOvers)) || 0;
  const revisedTarget = num(pick(first, ALIASES.revisedTarget)) || 0;
  const quotaOvers = revisedOvers > 0 ? revisedOvers : num(matchOvers);
  const inning = num(pick(first, ALIASES.inningsNumber));
  const wickets = num(pick(first, ALIASES.inningsWickets));

  // Par score for the side that batted before the interruption.
  if (inning === 1 && revisedTarget > 0 && quotaOvers != null) {
    return {
      runs: revisedTarget - 1, wickets, overs: quotaOvers,
      allOut: false, inning, quotaOvers, revised: true,
    };
  }
  return {
    runs: num(pick(first, ALIASES.inningsRuns)),
    wickets,
    overs: num(pick(first, ALIASES.inningsOvers)),
    allOut: wickets !== null && wickets >= 10,
    inning,
    quotaOvers: quotaOvers === null ? undefined : quotaOvers,
  };
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

/**
 * Every record anywhere in the payload that passes `test`, in document order.
 *
 * `findRecords` returns the single biggest matching array, which is what you
 * want for a fixture list. A points table is the opposite case: CricHeroes
 * returns one array *per group*, so this tournament's nine divisions arrive as
 * nine sibling arrays and taking the biggest would silently keep only one.
 */
export function collectRecords(root, test, depth = 0, seen = new Set()) {
  if (depth > 8 || root == null || typeof root !== 'object') return [];
  if (seen.has(root)) return [];
  seen.add(root);
  const out = [];
  if (Array.isArray(root)) {
    for (const item of root) {
      if (test(item)) out.push(item);
      else out.push(...collectRecords(item, test, depth + 1, seen));
    }
    return out;
  }
  for (const key of Object.keys(root)) out.push(...collectRecords(root[key], test, depth + 1, seen));
  return out;
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

    // `match_result` classifies the match, `win_by` states the margin; neither
    // is much use without the other, so the pair travels together from here on.
    const resultText = [pick(r, ALIASES.resultText), pick(r, ALIASES.marginText)]
      .filter((v) => v != null && v !== '').join(' — ') || null;
    const status = normaliseStatus(pick(r, ALIASES.status), resultText);
    const matchOvers = num(pick(r, ALIASES.matchOvers));
    const match = {
      id: id ?? `${home}-${away}-${matches.length}`,
      date: pick(r, ALIASES.date),
      venue: pick(r, ALIASES.venue),
      home,
      away,
      status: status === 'live' ? 'upcoming' : status,
      resultText,
    };
    if (matchOvers != null) match.overs = matchOvers;

    if (status === 'abandoned') {
      match.status = 'completed';
      match.result = { type: 'no_result', winner: null, margin: null, innings: [] };
      matches.push(match);
      continue;
    }
    if (status !== 'completed') { matches.push(match); continue; }

    // Structured innings where the endpoint provides them, summary strings
    // where it does not.
    const hi = parseInnings(pick(r, ALIASES.homeInnings), matchOvers);
    const ai = parseInnings(pick(r, ALIASES.awayInnings), matchOvers);
    const withQuota = (s) => (s && matchOvers != null ? { ...s, quotaOvers: matchOvers } : s);
    const hs = hi || withQuota(parseSummary(pick(r, ALIASES.homeSummary), pick(r, ALIASES.homeOvers)));
    const as = ai || withQuota(parseSummary(pick(r, ALIASES.awaySummary), pick(r, ALIASES.awayOvers)));
    const parsed = parseResultText(resultText);
    let winner = num(pick(r, ALIASES.winnerId));
    if (winner != null && winner !== home && winner !== away) winner = null;
    if (winner == null && parsed.type && parsed.type !== 'tie' && hs && as) {
      winner = hs.runs > as.runs ? home : (as.runs > hs.runs ? away : null);
    }

    // A conceded match. CricHeroes charges the side that did not turn up with
    // nought off the full quota and leaves the winner's figures untouched —
    // hence one innings here, not two.
    if (parsed.type === 'walkover' && winner != null && !hs && !as) {
      const loser = winner === home ? away : home;
      match.result = {
        type: 'walkover', winner, margin: null,
        innings: matchOvers != null
          ? [{ team: loser, runs: 0, wickets: null, overs: matchOvers, allOut: false, quotaOvers: matchOvers, conceded: true }]
          : [],
      };
      matches.push(match);
      continue;
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
    const innings = (team, s) => {
      const { inning, revised, ...rest } = s;
      return { team, ...rest };
    };
    const first = homeFirst ? innings(home, hs) : innings(away, as);
    const second = homeFirst ? innings(away, as) : innings(home, hs);

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
  // Where the payload numbers the innings there is nothing to work out.
  if (hs.inning === 1 || as.inning === 2) return true;
  if (hs.inning === 2 || as.inning === 1) return false;
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

/** "926/119.3" -> { runs: 926, overs: 119.3 }; anything else -> null. */
export function parseForAgainst(text) {
  const m = String(text ?? '').match(/^\s*(-?\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  return { runs: Number(m[1]), overs: Number(m[2]) };
}

/**
 * The published points table.
 *
 * Worth carrying in full rather than just as a cross-check. CricHeroes states
 * each side's runs-for and runs-against with the overs it counted them over,
 * which is the only way to see where its arithmetic and ours part company —
 * and its `points` include any penalty the organiser applied, which no
 * endpoint exposes on its own.
 */
export function normalisePointsTable(raw) {
  const records = collectRecords(raw, looksLikeStanding);
  return records.map((r) => {
    const forRuns = parseForAgainst(pick(r, ALIASES.ptFor));
    const against = parseForAgainst(pick(r, ALIASES.ptAgainst));
    const row = {
      teamId: num(pick(r, ALIASES.teamId)),
      name: String(pick(r, ALIASES.teamName, '')),
      played: num(pick(r, ALIASES.ptPlayed)),
      won: num(pick(r, ALIASES.ptWon)),
      lost: num(pick(r, ALIASES.ptLost)),
      tied: num(pick(r, ALIASES.ptTied)),
      noResult: num(pick(r, ALIASES.ptNoResult)),
      points: num(pick(r, ALIASES.ptPoints)),
      nrr: num(pick(r, ALIASES.ptNrr)),
    };
    if (forRuns) { row.runsFor = forRuns.runs; row.oversFor = forRuns.overs; }
    if (against) { row.runsAgainst = against.runs; row.oversAgainst = against.overs; }
    return row;
  }).filter((r) => r.name);
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
