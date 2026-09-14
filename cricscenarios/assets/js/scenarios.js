/**
 * scenarios.js — turns raw simulation counters into the sentences a captain
 * actually wants: "win both and you are through", "you need Jaguars to lose",
 * "win by 24 runs or chase it with 3.2 overs to spare".
 *
 * Two distinct kinds of claim live here and are deliberately never mixed:
 *
 *   certainty  — from engine.js certificates(), true of every possible outcome.
 *   likelihood — from the simulation, true of the sampled outcomes.
 *
 * A team is only ever called "through" or "out" on the first kind.
 */

import {
  BALLS_PER_OVER, certificates, netRunRate, buildTable, ballsToOvers,
} from './engine.js';

export const GOALS = {
  playoff: { label: 'Playoffs', verb: 'reach the playoffs' },
  promotion: { label: 'Promotion', verb: 'get promoted' },
  relegation: { label: 'Relegation', verb: 'get relegated' },
};

const pct = (num, den) => (den > 0 ? num / den : 0);

/** Probability table for every team, plus the certainty flags. */
export function summarise(ctx, results) {
  const { teams, rules, matches } = ctx;
  const rows = buildTable(teams, matches, rules);
  const trials = results.trials;

  return teams.map((t, i) => {
    const cert = certificates(t.id, teams, matches, rules);
    const positions = [];
    for (let p = 0; p < results.n; p++) {
      positions.push(pct(results.posCounts[i * results.n + p], trials));
    }
    return {
      team: t,
      index: i,
      row: rows[t.id],
      nrr: netRunRate(rows[t.id]),
      remaining: ctx.remaining.filter((m) => m.h === i || m.a === i).length,
      p: {
        playoff: pct(results.goalCounts.playoff[i], trials),
        promotion: pct(results.goalCounts.promotion[i], trials),
        relegation: pct(results.goalCounts.relegation[i], trials),
      },
      certainty: cert,
      positions,
      expectedPosition: positions.reduce((s, v, k) => s + v * (k + 1), 0),
    };
  });
}

/**
 * Resolve the headline state for one goal, preferring proof over sampling.
 * Returns one of: 'clinched' | 'eliminated' | 'live', plus the probability.
 */
export function goalState(summaryRow, goal) {
  const c = summaryRow.certainty;
  const p = summaryRow.p[goal];
  if (goal === 'relegation') {
    if (c.relegation.doomed) return { state: 'clinched', p: 1 };
    if (c.relegation.safe) return { state: 'eliminated', p: 0 };
  } else {
    if (c[goal].clinched) return { state: 'clinched', p: 1 };
    if (c[goal].eliminated) return { state: 'eliminated', p: 0 };
  }
  return { state: 'live', p };
}

/**
 * "How many of your own games must you win?"
 *
 * Reads the own-wins counters: for each possible number of wins from the
 * team's remaining fixtures, how often the goal came off.
 */
export function ownResultsBreakdown(results, goal) {
  const f = results.focus;
  const out = [];
  for (let k = 0; k < f.ownCount.length; k++) {
    out.push({
      wins: k,
      trials: f.ownCount[k],
      hits: f.ownGoal[goal][k],
      p: pct(f.ownGoal[goal][k], f.ownCount[k]),
      seen: f.ownCount[k] > 0,
    });
  }
  return out;
}

/**
 * The minimum number of own wins that has ever produced the goal, and the
 * smallest number that produced it in *every* sampled trial.
 */
export function ownWinsThresholds(breakdown) {
  let minimumSeen = null, alwaysEnough = null;
  for (const b of breakdown) {
    if (!b.seen) continue;
    if (b.hits > 0 && minimumSeen === null) minimumSeen = b.wins;
    if (b.trials >= 30 && b.hits === b.trials && alwaysEnough === null) alwaysEnough = b.wins;
  }
  return { minimumSeen, alwaysEnough };
}

/**
 * Which other fixtures matter most, given the team wins all its own games.
 *
 * For each remaining fixture not involving the team, compare the goal rate in
 * trials where the home side won against trials where the away side won. The
 * bigger the gap, the more that game decides your season.
 */
export function keyFixtures(ctx, results, goal, { givenSweep = true, limit = 8, minimise = false } = {}) {
  const f = results.focus;
  const focusIdx = f.index;
  const count = givenSweep ? f.sweepCount : f.swingCount;
  const hits = givenSweep ? f.sweepGoal[goal] : f.swingGoal[goal];
  // Base rate under the conditioning, before knowing any single other result.
  // Winning every own game is exactly the top bucket of the own-wins counters,
  // so the sweep base rate is already tallied there.
  const FM = f.matches.length;
  const baseTrials = givenSweep ? f.ownCount[FM] : results.trials;
  const baseHits = givenSweep ? f.ownGoal[goal][FM] : results.goalCounts[goal][focusIdx];
  const base = pct(baseHits, baseTrials);

  const out = [];
  for (let m = 0; m < ctx.remaining.length; m++) {
    const fx = ctx.remaining[m];
    if (fx.h === focusIdx || fx.a === focusIdx) continue;
    const cH = count[m * 2], cA = count[m * 2 + 1];
    if (cH < 20 || cA < 20) continue;
    const pH = pct(hits[m * 2], cH), pA = pct(hits[m * 2 + 1], cA);
    // For a goal you are trying to avoid (relegation), the result you want is
    // the one that makes it *less* likely.
    const wantHome = minimise ? pH <= pA : pH >= pA;
    out.push({
      fixtureIndex: m,
      fixture: fx,
      homeTeam: ctx.teams[fx.h],
      awayTeam: ctx.teams[fx.a],
      needWinner: wantHome ? ctx.teams[fx.h] : ctx.teams[fx.a],
      needLoser: wantHome ? ctx.teams[fx.a] : ctx.teams[fx.h],
      pIfNeeded: wantHome ? pH : pA,
      pIfNot: wantHome ? pA : pH,
      swing: Math.abs(pH - pA),
      base,
    });
  }
  out.sort((x, y) => y.swing - x.swing);
  return { base, baseTrials, fixtures: out.slice(0, limit) };
}

/* ------------------------------------------------------------------ *
 * Net run rate: how big does the win have to be?
 * ------------------------------------------------------------------ */

/**
 * Net run rate after winning all remaining games by a given margin.
 *
 * `mode` 'runs'   — bat first, post `score`, restrict them to `score - margin`.
 * `mode` 'overs'  — chase `score` with `margin` overs to spare.
 *
 * Note the asymmetry that surprises people: batting second, the *wickets*
 * margin is irrelevant to net run rate. Only the balls you leave unused
 * change it. Winning by 9 wickets off the last ball does nothing for you.
 */
export function nrrAfterWins(baseRow, games, score, margin, mode, rules) {
  const quota = rules.overs_per_innings * BALLS_PER_OVER;
  let rf = baseRow.runsFor, bf = baseRow.ballsFor;
  let ra = baseRow.runsAgainst, ba = baseRow.ballsAgainst;

  for (let g = 0; g < games; g++) {
    if (mode === 'runs') {
      rf += score; bf += quota;
      ra += Math.max(0, score - margin); ba += quota;
    } else {
      const used = Math.max(6, quota - Math.round(margin * BALLS_PER_OVER));
      ra += score; ba += quota;
      rf += score + 1; bf += used;
    }
  }
  const fo = bf / BALLS_PER_OVER, ag = ba / BALLS_PER_OVER;
  return (fo > 0 ? rf / fo : 0) - (ag > 0 ? ra / ag : 0);
}

/**
 * Smallest margin that lifts net run rate past `target`, or null if even a
 * crushing win in every remaining game cannot get there.
 */
export function requiredMargin(baseRow, games, score, target, mode, rules) {
  if (games <= 0) return null;
  // Net run rate rises monotonically with the margin, so plain bisection works.
  // If the largest plausible margin still falls short, the target is out of reach.
  const ceiling = mode === 'runs'
    ? Math.max(1, Math.min(score - 1, 150))
    : rules.overs_per_innings - 1;
  if (nrrAfterWins(baseRow, games, score, ceiling, mode, rules) < target) return null;
  if (nrrAfterWins(baseRow, games, score, 0, mode, rules) >= target) return 0;

  let lo = 0, hi = ceiling;
  for (let i = 0; i < 60 && hi - lo > 1e-3; i++) {
    const mid = (lo + hi) / 2;
    if (nrrAfterWins(baseRow, games, score, mid, mode, rules) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The net run rate a team realistically has to beat: taken from the trials
 * where it won everything and still missed the cut, using the net run rate of
 * whoever took the last qualifying place. Median, not mean — the tail of NRR
 * outcomes is long and would drag a mean somewhere unrepresentative.
 */
export function contestedNrrTarget(results, goal = 'playoff') {
  const s = results.focus.cutNrr[goal];
  if (!s || !s.length) return null;
  const sorted = Array.from(s).sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
    samples: sorted.length,
  };
}

/**
 * The margin advice for a team, in both currencies (runs when batting first,
 * overs to spare when chasing).
 */
export function marginAdvice(ctx, results, summaryRow, goal = 'playoff') {
  const target = contestedNrrTarget(results, goal);
  if (!target) return null;
  const games = summaryRow.remaining;
  const score = Math.round(ctx.avgFirstInnings);
  const row = summaryRow.row;
  const runs = requiredMargin(row, games, score, target.median, 'runs', ctx.rules);
  const overs = requiredMargin(row, games, score, target.median, 'overs', ctx.rules);
  return {
    goal,
    // The place that gets contested on net run rate: 4th for a playoff spot,
    // 3rd for promotion.
    cutPlace: goal === 'promotion' ? ctx.rules.promotion_spots : ctx.rules.playoff_spots,
    target: target.median,
    samples: target.samples,
    typicalScore: score,
    games,
    runs: runs == null ? null : Math.ceil(runs),
    oversToSpare: overs == null ? null : Math.round(overs * 10) / 10,
    currentNrr: summaryRow.nrr,
  };
}

/* ------------------------------------------------------------------ *
 * Assembling the whole report for one team.
 * ------------------------------------------------------------------ */

export function buildReport(ctx, results, summary, teamId, goal) {
  const summaryRow = summary.find((s) => s.team.id === teamId);
  const state = goalState(summaryRow, goal);
  const breakdown = ownResultsBreakdown(results, goal);
  const thresholds = ownWinsThresholds(breakdown);
  const minimise = goal === 'relegation';
  const sweep = keyFixtures(ctx, results, goal, { givenSweep: true, minimise });
  const anyway = keyFixtures(ctx, results, goal, { givenSweep: false, limit: 5, minimise });
  const margin = goal === 'relegation' ? null : marginAdvice(ctx, results, summaryRow, goal);

  return {
    team: summaryRow.team,
    goal,
    state: state.state,
    probability: state.p,
    summaryRow,
    breakdown,
    thresholds,
    sweep,
    anyway,
    margin,
    ownGames: results.focus.matches.map((m) => {
      const fx = ctx.remaining[m];
      const oppIdx = fx.h === results.focus.index ? fx.a : fx.h;
      return { fixture: fx, opponent: ctx.teams[oppIdx], date: fx.date };
    }),
  };
}

export { ballsToOvers };
