/**
 * simulate.js — Monte Carlo over the unplayed fixtures.
 *
 * Why simulate at all: a division with ~40 games left has 2^40 possible result
 * sets, far too many to enumerate, and net run rate is continuous anyway, so
 * even enumerating win/loss would not settle the placings. So we sample.
 *
 * Two things make the output trustworthy rather than decorative:
 *
 *  1. Margins are *bootstrapped* from the division's own completed matches
 *     rather than invented. Each simulated game replays the shape of a real
 *     one from this division (its first-innings total, its margin, the overs
 *     used), so simulated net run rates move the way real ones have.
 *  2. Anything stated as certain comes from engine.js `certificates()`, not
 *     from here. "Never happened in 200,000 trials" is evidence; it is not
 *     proof, and the UI keeps the two apart.
 *
 * The hot loop runs on flat typed arrays with no allocation per trial.
 */

import {
  BALLS_PER_OVER, countingBalls, buildTable, netRunRate, DEFAULT_RULES,
} from './engine.js';

/* Small deterministic PRNG so a given seed always reproduces a run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bradley–Terry strengths fitted to the completed results by MM iteration.
 *
 * Each team also plays `prior` phantom wins and `prior` phantom losses against
 * a virtual average opponent. Without that, a team that has won all four of
 * its games gets infinite strength and the model asserts certainties the
 * sample cannot support.
 */
export function bradleyTerry(n, results, prior = 1.0, iterations = 200) {
  const wins = new Float64Array(n);
  const nij = [];
  for (let i = 0; i < n; i++) nij.push(new Float64Array(n));
  for (const r of results) {
    if (r.w === r.l) continue;
    wins[r.w] += 1;
    nij[r.w][r.l] += 1;
    nij[r.l][r.w] += 1;
  }

  let p = new Float64Array(n).fill(1);
  const next = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      let den = 2 * prior / (p[i] + 1);
      for (let j = 0; j < n; j++) {
        if (j === i || nij[i][j] === 0) continue;
        den += nij[i][j] / (p[i] + p[j]);
      }
      next[i] = den > 0 ? (wins[i] + prior) / den : p[i];
    }
    // Normalise to geometric mean 1 — BT strengths are only defined up to scale.
    let logSum = 0;
    for (let i = 0; i < n; i++) logSum += Math.log(Math.max(next[i], 1e-12));
    const scale = Math.exp(-logSum / n);
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const v = next[i] * scale;
      delta = Math.max(delta, Math.abs(v - p[i]));
      p[i] = v;
    }
    if (delta < 1e-10) break;
  }
  return p;
}

/**
 * Pull the "shape" of every completed match: what a real game in this division
 * looks like. Simulated games replay these shapes rather than a bell curve.
 */
export function matchShapes(matches, rules) {
  const shapes = [];
  for (const m of matches) {
    if (m.status !== 'completed' || !m.result) continue;
    const r = m.result;
    if (r.type === 'no_result' || r.type === 'abandoned') continue;
    const inn = r.innings || [];
    if (inn.length !== 2) continue;

    const firstTeam = inn[0].team;
    const shape = {
      firstRuns: inn[0].runs,
      firstBalls: countingBalls(inn[0], rules),
      secondRuns: inn[1].runs,
      secondBalls: countingBalls(inn[1], rules),
      // Did the side batting second win? That decides which slot the winner of
      // a simulated match is dropped into.
      chaseWon: r.type !== 'tie' && r.winner != null && r.winner !== firstTeam,
      tie: r.type === 'tie',
    };
    if (shape.firstRuns > 0 && shape.secondRuns > 0) shapes.push(shape);
  }

  if (shapes.length < 3) {
    // Too little history to bootstrap from — fall back to a plain T20 shape so
    // the page still works on a division that has barely started.
    const q = rules.overs_per_innings * BALLS_PER_OVER;
    for (let s = 110; s <= 190; s += 10) {
      shapes.push({ firstRuns: s, firstBalls: q, secondRuns: s - 15, secondBalls: q, chaseWon: false, tie: false });
      shapes.push({ firstRuns: s, firstBalls: q, secondRuns: s + 1, secondBalls: Math.round(q * 0.93), chaseWon: true, tie: false });
    }
  }
  return shapes;
}

/** Average first-innings total in this division — used for margin advice. */
export function averageFirstInnings(shapes) {
  if (!shapes.length) return 150;
  let sum = 0;
  for (const s of shapes) sum += s.firstRuns;
  return sum / shapes.length;
}

/**
 * Freeze everything the hot loop needs into flat arrays.
 */
export function prepare(teams, matches, rules = DEFAULT_RULES, baseline = null) {
  const ids = teams.map((t) => t.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  // With a published baseline the played matches are already counted in it;
  // every trial then starts from CricHeroes' own table and adds only the
  // fixtures still to come.
  const rows = buildTable(teams, matches, rules, baseline);
  const base = {
    points: new Float64Array(n),
    runsFor: new Float64Array(n),
    ballsFor: new Float64Array(n),
    runsAgainst: new Float64Array(n),
    ballsAgainst: new Float64Array(n),
    won: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const r = rows[ids[i]];
    base.points[i] = r.points;
    base.runsFor[i] = r.runsFor;
    base.ballsFor[i] = r.ballsFor;
    base.runsAgainst[i] = r.runsAgainst;
    base.ballsAgainst[i] = r.ballsAgainst;
    base.won[i] = r.won;
  }

  const remaining = [];
  for (const m of matches) {
    if (m.status === 'completed') continue;
    const h = index.get(m.home), a = index.get(m.away);
    if (h == null || a == null) continue;
    remaining.push({ h, a, id: m.id, date: m.date || null });
  }

  const played = [];
  for (const m of matches) {
    if (m.status !== 'completed' || !m.result || m.result.winner == null) continue;
    const w = index.get(m.result.winner);
    const l = index.get(m.result.winner === m.home ? m.away : m.home);
    if (w != null && l != null) played.push({ w, l });
  }

  const shapes = matchShapes(matches, rules);
  const strengths = bradleyTerry(n, played);

  return {
    ids, index, n, base, remaining, shapes, strengths, rules, teams, matches, baseline,
    avgFirstInnings: averageFirstInnings(shapes),
  };
}

/** P(home team wins) for a remaining fixture under the chosen model. */
export function winProbability(ctx, h, a, model) {
  if (model !== 'form') return 0.5;
  const ph = ctx.strengths[h], pa = ctx.strengths[a];
  const raw = ph / (ph + pa);
  // Clamp: the sample behind these strengths is a handful of games per team,
  // so refuse to claim anyone is more than 85% certain to win a cricket match.
  return Math.min(0.85, Math.max(0.15, raw));
}

/**
 * Create a resumable simulation run. Call `step(k)` to advance k trials; the
 * UI slices the work so the page keeps painting. Read `results` at any time.
 */
export function createRun(ctx, opts = {}) {
  const {
    trials = 25000,
    model = 'coinflip',
    focusId = null,
    seed = 0x5eed,
    goals = ['playoff', 'promotion', 'relegation'],
  } = opts;

  const n = ctx.n;
  const rules = ctx.rules;
  const rnd = mulberry32(seed);
  const focus = focusId != null ? ctx.index.get(focusId) : null;

  // Pre-compute per-fixture win probability once, not per trial.
  const R = ctx.remaining.length;
  const probs = new Float64Array(R);
  for (let m = 0; m < R; m++) {
    probs[m] = winProbability(ctx, ctx.remaining[m].h, ctx.remaining[m].a, model);
  }

  const focusMatches = [];
  if (focus != null) {
    for (let m = 0; m < R; m++) {
      if (ctx.remaining[m].h === focus || ctx.remaining[m].a === focus) focusMatches.push(m);
    }
  }
  const FM = focusMatches.length;

  // --- accumulators -------------------------------------------------
  const posCounts = new Int32Array(n * n);       // [team * n + (pos-1)]
  const goalCounts = {};
  for (const g of goals) goalCounts[g] = new Int32Array(n);

  // Conditional counters for the focus team. Two counters per fixture per
  // possible winner is all the "what has to happen elsewhere" analysis needs.
  const ownCount = new Int32Array(FM + 1);
  const ownGoal = {};
  for (const g of goals) ownGoal[g] = new Int32Array(FM + 1);

  const swingCount = new Int32Array(R * 2);
  const swingGoal = {};
  for (const g of goals) swingGoal[g] = new Int32Array(R * 2);
  const sweepCount = new Int32Array(R * 2);
  const sweepGoal = {};
  for (const g of goals) sweepGoal[g] = new Int32Array(R * 2);

  let sweepTrials = 0;
  // Net run rate of whoever holds the last qualifying place, in trials where
  // the focus team won everything and *still* missed out. Sampled separately
  // per goal, because the promotion cut (3rd) and the playoff cut (4th) are
  // different teams with different net run rates — aiming at the wrong one
  // would give the team a target that is too soft or too hard.
  const cutNrr = { playoff: [], promotion: [] };
  const missedNrr = { playoff: [], promotion: [] };
  const CUT_SAMPLE_LIMIT = 20000;

  // --- scratch (reused every trial, never reallocated) ---------------
  const pts = new Float64Array(n);
  const rf = new Float64Array(n), bf = new Float64Array(n);
  const ra = new Float64Array(n), ba = new Float64Array(n);
  const nrr = new Float64Array(n);
  const order = new Int32Array(n);
  const winnerOf = new Int32Array(R);

  const playoffSpots = rules.playoff_spots;
  const promotionSpots = rules.promotion_spots;
  const relegationLine = n - rules.relegation_spots;

  const cmp = (x, y) => {
    const d = pts[y] - pts[x];
    if (Math.abs(d) > 1e-9) return d;
    const e = nrr[y] - nrr[x];
    if (Math.abs(e) > 1e-12) return e;
    return x - y;
  };

  let done = 0;

  function step(k) {
    const end = Math.min(trials, done + k);
    for (; done < end; done++) {
      pts.set(ctx.base.points);
      rf.set(ctx.base.runsFor); bf.set(ctx.base.ballsFor);
      ra.set(ctx.base.runsAgainst); ba.set(ctx.base.ballsAgainst);

      let focusWins = 0;

      for (let m = 0; m < R; m++) {
        const fx = ctx.remaining[m];
        const homeWins = rnd() < probs[m];
        const w = homeWins ? fx.h : fx.a;
        const l = homeWins ? fx.a : fx.h;
        winnerOf[m] = homeWins ? 0 : 1;

        pts[w] += rules.points_win;
        pts[l] += rules.points_loss;
        if (w === focus) focusWins++;

        const s = ctx.shapes[(rnd() * ctx.shapes.length) | 0];
        // The winner takes whichever innings slot actually won in the real
        // match this shape came from, so margins land the right way round.
        const batFirst = s.chaseWon ? l : w;
        const batSecond = s.chaseWon ? w : l;

        rf[batFirst] += s.firstRuns; bf[batFirst] += s.firstBalls;
        ra[batSecond] += s.firstRuns; ba[batSecond] += s.firstBalls;
        rf[batSecond] += s.secondRuns; bf[batSecond] += s.secondBalls;
        ra[batFirst] += s.secondRuns; ba[batFirst] += s.secondBalls;
      }

      for (let i = 0; i < n; i++) {
        const fo = bf[i] / BALLS_PER_OVER, ag = ba[i] / BALLS_PER_OVER;
        nrr[i] = (fo > 0 ? rf[i] / fo : 0) - (ag > 0 ? ra[i] / ag : 0);
        order[i] = i;
      }
      order.sort(cmp);

      let focusPos = -1, playoffCut = -1, promotionCut = -1;
      for (let p = 0; p < n; p++) {
        const t = order[p];
        posCounts[t * n + p]++;
        if (goalCounts.playoff && p < playoffSpots) goalCounts.playoff[t]++;
        if (goalCounts.promotion && p < promotionSpots) goalCounts.promotion[t]++;
        if (goalCounts.relegation && p >= relegationLine) goalCounts.relegation[t]++;
        if (t === focus) focusPos = p;
        if (p === playoffSpots - 1) playoffCut = t;
        if (p === promotionSpots - 1) promotionCut = t;
      }

      if (focus != null) {
        const hitPlayoff = focusPos < playoffSpots;
        const hitPromotion = focusPos < promotionSpots;
        const hitRelegation = focusPos >= relegationLine;

        ownCount[focusWins]++;
        if (hitPlayoff && ownGoal.playoff) ownGoal.playoff[focusWins]++;
        if (hitPromotion && ownGoal.promotion) ownGoal.promotion[focusWins]++;
        if (hitRelegation && ownGoal.relegation) ownGoal.relegation[focusWins]++;

        const swept = focusWins === FM;
        if (swept) sweepTrials++;

        for (let m = 0; m < R; m++) {
          const slot = m * 2 + winnerOf[m];
          swingCount[slot]++;
          if (hitPlayoff && swingGoal.playoff) swingGoal.playoff[slot]++;
          if (hitPromotion && swingGoal.promotion) swingGoal.promotion[slot]++;
          if (hitRelegation && swingGoal.relegation) swingGoal.relegation[slot]++;
          if (swept) {
            sweepCount[slot]++;
            if (hitPlayoff && sweepGoal.playoff) sweepGoal.playoff[slot]++;
            if (hitPromotion && sweepGoal.promotion) sweepGoal.promotion[slot]++;
            if (hitRelegation && sweepGoal.relegation) sweepGoal.relegation[slot]++;
          }
        }

        if (swept) {
          if (!hitPlayoff && playoffCut >= 0 && cutNrr.playoff.length < CUT_SAMPLE_LIMIT) {
            cutNrr.playoff.push(nrr[playoffCut]);
            missedNrr.playoff.push(nrr[focus]);
          }
          if (!hitPromotion && promotionCut >= 0 && cutNrr.promotion.length < CUT_SAMPLE_LIMIT) {
            cutNrr.promotion.push(nrr[promotionCut]);
            missedNrr.promotion.push(nrr[focus]);
          }
        }
      }
    }
    return done;
  }

  return {
    step,
    get done() { return done; },
    trials,
    model,
    focusIndex: focus,
    focusMatches,
    results: {
      get trials() { return done; },
      n, posCounts, goalCounts,
      focus: {
        index: focus,
        matches: focusMatches,
        ownCount, ownGoal,
        swingCount, swingGoal,
        sweepCount, sweepGoal,
        get sweepTrials() { return sweepTrials; },
        cutNrr, missedNrr,
      },
    },
  };
}

/** Convenience: run the whole thing in one go (used by the tests). */
export function simulate(ctx, opts) {
  const run = createRun(ctx, opts);
  run.step(run.trials);
  return run.results;
}
