/**
 * engine.js — league table maths.
 *
 * Everything here is pure and deterministic: given a set of matches it builds
 * the points table exactly the way CricHeroes does, so the same code can score
 * the real completed matches and the imagined ones the simulator invents.
 *
 * Overs are stored internally as *balls* (integers). Cricket's "19.3 overs"
 * notation is base-6 in the decimal place, so arithmetic on the decimal form
 * quietly goes wrong (19.3 + 0.3 is 20.0, not 19.6). Balls avoid all of it.
 */

export const BALLS_PER_OVER = 6;

/** "19.3" (19 overs 3 balls) -> 117 balls. */
export function oversToBalls(ov) {
  const n = Number(ov);
  if (!isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n + 1e-9);
  const frac = Math.round((n - whole) * 10);
  return whole * BALLS_PER_OVER + Math.min(frac, BALLS_PER_OVER - 1);
}

/** 117 balls -> "19.3" for display. */
export function ballsToOvers(b) {
  return Math.floor(b / BALLS_PER_OVER) + (b % BALLS_PER_OVER) / 10;
}

/** 117 balls -> 19.5 — the true decimal used in run-rate division. */
export function ballsToDecimalOvers(b) {
  return b / BALLS_PER_OVER;
}

export const DEFAULT_RULES = {
  playoff_spots: 4,
  promotion_spots: 3,
  relegation_spots: 3,
  points_win: 2,
  points_tie: 1,
  points_no_result: 1,
  points_loss: 0,
  overs_per_innings: 20,
  // Applied in order. "h2h" runs as a pairwise pass after the sort — see
  // sortStandings() — because head-to-head is not a transitive ordering.
  tiebreak: ['points', 'nrr', 'h2h', 'wins'],
};

export function emptyRow(teamId) {
  return {
    teamId,
    played: 0, won: 0, lost: 0, tied: 0, noResult: 0,
    points: 0,
    runsFor: 0, ballsFor: 0,
    runsAgainst: 0, ballsAgainst: 0,
  };
}

/**
 * Balls that count towards run rate for one innings.
 *
 * The rule that trips people up: a side bowled out inside its overs is treated
 * as having faced its *full* quota. Losing all ten wickets in 12 overs must not
 * flatter your run rate.
 */
export function countingBalls(inn, rules) {
  const quota = rules.overs_per_innings * BALLS_PER_OVER;
  if (inn.allOut) return quota;
  const b = inn.balls != null ? inn.balls : oversToBalls(inn.overs);
  return Math.min(b || 0, quota);
}

/** Fold one completed match into the running totals. Mutates `rows`. */
export function applyMatch(rows, match, rules) {
  const r = match.result;
  if (!r) return;
  const a = rows[match.home], b = rows[match.away];
  if (!a || !b) return;

  a.played++; b.played++;

  if (r.type === 'no_result' || r.type === 'abandoned') {
    a.noResult++; b.noResult++;
    a.points += rules.points_no_result;
    b.points += rules.points_no_result;
    return; // abandoned games never touch net run rate
  }

  for (const inn of (r.innings || [])) {
    const bat = rows[inn.team];
    const bowl = inn.team === match.home ? b : a;
    if (!bat || !bowl) continue;
    const balls = countingBalls(inn, rules);
    bat.runsFor += inn.runs; bat.ballsFor += balls;
    bowl.runsAgainst += inn.runs; bowl.ballsAgainst += balls;
  }

  if (r.type === 'tie') {
    a.tied++; b.tied++;
    a.points += rules.points_tie;
    b.points += rules.points_tie;
    return;
  }

  const win = rows[r.winner], lose = r.winner === match.home ? b : a;
  if (!win) return;
  win.won++; win.points += rules.points_win;
  lose.lost++; lose.points += rules.points_loss;
}

export function netRunRate(row) {
  const forOv = ballsToDecimalOvers(row.ballsFor);
  const agOv = ballsToDecimalOvers(row.ballsAgainst);
  if (forOv === 0 && agOv === 0) return 0;
  const scored = forOv > 0 ? row.runsFor / forOv : 0;
  const conceded = agOv > 0 ? row.runsAgainst / agOv : 0;
  return scored - conceded;
}

/** Build fresh rows for every team and fold in every completed match. */
export function buildTable(teams, matches, rules) {
  const rows = {};
  for (const t of teams) rows[t.id] = emptyRow(t.id);
  for (const m of matches) {
    if (m.status === 'completed' && m.result) applyMatch(rows, m, rules);
  }
  return rows;
}

/** Head-to-head record between two teams over the completed matches given. */
export function headToHead(matches, x, y) {
  let xw = 0, yw = 0;
  for (const m of matches) {
    if (m.status !== 'completed' || !m.result) continue;
    const pair = (m.home === x && m.away === y) || (m.home === y && m.away === x);
    if (!pair) continue;
    if (m.result.winner === x) xw++;
    else if (m.result.winner === y) yw++;
  }
  return xw === yw ? 0 : (xw > yw ? 1 : -1);
}

function keyValue(row, key) {
  switch (key) {
    case 'points': return row.points;
    case 'nrr': return netRunRate(row);
    case 'wins': return row.won;
    default: return 0;
  }
}

/**
 * Order the table. Returns rows sorted best-first, each stamped with `position`
 * (1-based) and `nrr`.
 *
 * `h2h` in the tiebreak list is handled by a pairwise pass over adjacent rows
 * that are level on every earlier key, rather than inside the comparator: head-
 * to-head can be circular (A beat B, B beat C, C beat A), and feeding a
 * non-transitive comparator to Array.sort gives an arbitrary answer.
 */
export function sortStandings(rows, matches, rules) {
  const keys = (rules.tiebreak || DEFAULT_RULES.tiebreak);
  const ordinary = keys.filter((k) => k !== 'h2h');
  const list = Object.values(rows).map((r) => ({ ...r, nrr: netRunRate(r) }));

  list.sort((p, q) => {
    for (const k of ordinary) {
      const d = keyValue(q, k) - keyValue(p, k);
      if (Math.abs(d) > 1e-9) return d;
    }
    return String(p.teamId).localeCompare(String(q.teamId));
  });

  if (keys.includes('h2h')) {
    const upto = keys.slice(0, keys.indexOf('h2h')).filter((k) => k !== 'h2h');
    const level = (p, q) => upto.every(
      (k) => Math.abs(keyValue(p, k) - keyValue(q, k)) < 1e-9);
    // One bubble pass is enough for the pairwise ties this is meant to fix.
    for (let i = 0; i < list.length - 1; i++) {
      if (!level(list[i], list[i + 1])) continue;
      if (headToHead(matches, list[i].teamId, list[i + 1].teamId) < 0) {
        const t = list[i]; list[i] = list[i + 1]; list[i + 1] = t;
      }
    }
  }

  list.forEach((r, i) => { r.position = i + 1; });
  return list;
}

export function standingsFor(teams, matches, rules) {
  return sortStandings(buildTable(teams, matches, rules), matches, rules);
}

/* ------------------------------------------------------------------ *
 * Certificates: facts that hold across *every* remaining outcome.
 *
 * These are deliberately separate from the simulator. A simulation that
 * never sees an outcome only shows it is unlikely; these functions prove
 * it is impossible (or unavoidable) from the points arithmetic alone, so
 * the page can say "eliminated" instead of "0%" and mean it.
 * ------------------------------------------------------------------ */

export function remainingPerTeam(teams, matches) {
  const left = {};
  for (const t of teams) left[t.id] = 0;
  for (const m of matches) {
    if (m.status === 'completed') continue;
    if (left[m.home] != null) left[m.home]++;
    if (left[m.away] != null) left[m.away]++;
  }
  return left;
}

export function pointsBounds(teams, matches, rules) {
  const rows = buildTable(teams, matches, rules);
  const left = remainingPerTeam(teams, matches);
  const out = {};
  for (const t of teams) {
    const row = rows[t.id];
    out[t.id] = {
      now: row.points,
      max: row.points + left[t.id] * rules.points_win,
      min: row.points + left[t.id] * rules.points_loss,
      remaining: left[t.id],
    };
  }
  return out;
}

/**
 * What the points arithmetic alone guarantees about `teamId`.
 *
 * A rival counts as "possibly above" on >= rather than >, because level on
 * points sends the placing to net run rate, which points bounds say nothing
 * about — so a tie has to be treated as a place we might lose.
 */
export function certificates(teamId, teams, matches, rules) {
  const b = pointsBounds(teams, matches, rules);
  const me = b[teamId];
  const others = teams.filter((t) => t.id !== teamId);

  const guaranteedAbove = others.filter((t) => b[t.id].min > me.max).length;
  const possiblyAbove = others.filter((t) => b[t.id].max >= me.min).length;
  const guaranteedBelow = others.filter((t) => b[t.id].max < me.min).length;
  const possiblyBelow = others.filter((t) => b[t.id].min <= me.max).length;

  const n = teams.length;
  const relegationLine = n - rules.relegation_spots; // finishing > this = relegated

  return {
    bestPossiblePosition: guaranteedAbove + 1,
    worstPossiblePosition: n - guaranteedBelow,
    playoff: {
      eliminated: guaranteedAbove >= rules.playoff_spots,
      clinched: possiblyAbove < rules.playoff_spots,
    },
    promotion: {
      eliminated: guaranteedAbove >= rules.promotion_spots,
      clinched: possiblyAbove < rules.promotion_spots,
    },
    relegation: {
      // "safe" = cannot be relegated; "doomed" = cannot escape relegation
      safe: n - guaranteedBelow <= relegationLine,
      doomed: guaranteedAbove + 1 > relegationLine,
    },
  };
}
