/**
 * margins.js — what each team needs, in cricket terms rather than percentages.
 *
 * The simulator says "62% to reach the playoffs". This file says *why*: win
 * and you are through on points; or win and it comes down to net run rate
 * against Guts N Glory, so win by 62 runs batting first or chase it inside
 * 9.4 overs; or lose by fewer than 40 runs and you still finish above them.
 *
 * It is exact, not sampled. With a handful of fixtures left every combination
 * of results (win / lose / points shared) is enumerated, points are compared
 * first, then wins (TCL handbook 16.10.5), and wherever teams finish level on
 * points and wins the net run rate race is
 * solved for the margin, run by run and ball by ball, against the full
 * runs-for / overs-faced / runs-against / overs-bowled figures CricHeroes
 * publishes (engine.baselineFromPublished seeds those into ctx.base).
 *
 * Assumptions, all surfaced in the UI:
 *  - Remaining games are `overs` a side (18 in TCL Mega Smash).
 *  - Margins are quoted for a first-innings total of S: the median first
 *    innings in this division, rounded to 5, with S - 20 and S + 20 alongside.
 *  - Batting first, a win by r runs means S off the full quota against S - r
 *    off the full quota. A side bowled out is charged the full quota anyway,
 *    so this covers all-out finishes too.
 *  - Chasing, a win "within b balls" means S + 1 off b balls against S off
 *    the full quota. Wickets in hand do not enter net run rate.
 *  - A washout changes nobody's net run rate. A tie is treated the same way
 *    here (it moves both sides by almost exactly the same amount).
 *  - Where another team in the same race also has a decisive game left, that
 *    game is assumed to finish with the division's typical margin (median
 *    winning margin batting first). The statement says so.
 *  - Head-to-head and wins (the later tiebreaks) are not modelled: exact net
 *    run rate ties do not happen in practice.
 */

import { BALLS_PER_OVER, winsBeforeNrr } from './engine.js';
import { winProbability } from './simulate.js';

/** Outcome of one fixture, from the home side's point of view. */
export const R = { HOME: 0, AWAY: 1, SHARED: 2 };
const OUTCOMES = [R.HOME, R.AWAY, R.SHARED];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** "9.4" for 58 balls. */
export function oversText(balls) {
  return `${Math.floor(balls / BALLS_PER_OVER)}.${balls % BALLS_PER_OVER}`;
}

/**
 * The scoring assumptions: typical first-innings total and typical winning
 * margin, from this division's own completed matches.
 */
export function marginSettings(ctx) {
  const firsts = [], margins = [];
  for (const m of ctx.matches) {
    if (m.status !== 'completed' || !m.result) continue;
    const r = m.result;
    if (r.type !== 'runs' && r.type !== 'wickets') continue;
    const inn = r.innings || [];
    if (inn.length !== 2) continue;
    // Only full-length innings: rain-reduced par scores would drag S down.
    const q = inn[0].quotaOvers ?? ctx.rules.overs_per_innings;
    if (q !== ctx.rules.overs_per_innings) continue;
    firsts.push(inn[0].runs);
    if (r.type === 'runs' && r.margin != null) margins.push(r.margin);
  }
  const raw = median(firsts) ?? 140;
  const S = Math.max(40, Math.round(raw / 5) * 5);
  return {
    score: S,
    scores: [S - 20, S, S + 20],
    typicalRuns: Math.max(1, median(margins) ?? 20),
    // The top of this division's range: a defeat that needs the opponent to
    // score more than anyone has here is "not realistic".
    highest: firsts.length ? Math.max(...firsts) : S + 40,
    // A "big score here": the 90th percentile of first innings.
    high: firsts.length ? [...firsts].sort((a, b) => a - b)[Math.floor(0.9 * (firsts.length - 1))] : S + 30,
    firstInnings: [...firsts].sort((a, b) => a - b),
    quota: ctx.rules.overs_per_innings * BALLS_PER_OVER,
    samples: firsts.length,
  };
}

/* ------------------------------------------------------------------ *
 * Net run rate arithmetic over a scenario.
 * ------------------------------------------------------------------ */

function baseStats(ctx) {
  const b = ctx.base;
  return {
    rf: Float64Array.from(b.runsFor), bf: Float64Array.from(b.ballsFor),
    ra: Float64Array.from(b.runsAgainst), ba: Float64Array.from(b.ballsAgainst),
  };
}

function innings(st, bat, bowl, runs, balls) {
  st.rf[bat] += runs; st.bf[bat] += balls;
  st.ra[bowl] += runs; st.ba[bowl] += balls;
}

/**
 * Fold one decisive result into `st`. `margin` is from the winner's side:
 * { mode: 'runs', value: r } — winner batted first, won by r runs;
 * { mode: 'chase', value: b } — winner chased S + 1 off b balls.
 */
function decisive(st, winner, loser, margin, S, Q) {
  if (margin.mode === 'runs') {
    innings(st, winner, loser, S, Q);
    innings(st, loser, winner, Math.max(0, S - margin.value), Q);
  } else {
    innings(st, loser, winner, S, Q);
    innings(st, winner, loser, S + 1, margin.value);
  }
}

const nrrOf = (st, i) => {
  const fo = st.bf[i] / BALLS_PER_OVER, ag = st.ba[i] / BALLS_PER_OVER;
  return (fo > 0 ? st.rf[i] / fo : 0) - (ag > 0 ? st.ra[i] / ag : 0);
};

export function currentNrr(ctx, i) {
  return nrrOf(baseStats(ctx), i);
}

/**
 * Net run rates after every fixture in `combo` is played: decisive results in
 * `free` (a Set of fixture indices) at `margin` with score S, every other
 * decisive result at the typical margin.
 */
function nrrAfter(ctx, set, combo, free, margin, S) {
  const st = baseStats(ctx);
  const Q = set.quota;
  const typical = { mode: 'runs', value: set.typicalRuns };
  for (let f = 0; f < combo.length; f++) {
    const o = combo[f];
    if (o === R.SHARED) continue;
    const fx = ctx.remaining[f];
    const w = o === R.HOME ? fx.h : fx.a, l = o === R.HOME ? fx.a : fx.h;
    // Only the free game's first innings varies; everything else stays at the
    // division's typical score and margin.
    decisive(st, w, l, free.has(f) ? margin : typical, free.has(f) ? S : set.score, Q);
  }
  return (i) => nrrOf(st, i);
}

/** Wins after `combo` (a shared result is not a win). */
function winsAfter(ctx, combo) {
  const w = Float64Array.from(ctx.base.won);
  for (let f = 0; f < combo.length; f++) {
    const fx = ctx.remaining[f], o = combo[f];
    if (o === R.HOME) w[fx.h]++;
    else if (o === R.AWAY) w[fx.a]++;
  }
  return w;
}

/**
 * Points and wins after `combo`, and the comparison that comes before net
 * run rate: points, then (TCL handbook 16.10.5) most wins. `pre(i, j)` > 0
 * when i finishes above j whatever the net run rates, < 0 below, 0 when net
 * run rate decides.
 */
export function standAfter(ctx, combo) {
  const pts = pointsAfter(ctx, combo), wins = winsAfter(ctx, combo);
  const useWins = winsBeforeNrr(ctx.rules);
  const pre = (i, j) => {
    const d = pts[i] - pts[j];
    if (Math.abs(d) > 1e-9) return d;
    return useWins ? wins[i] - wins[j] : 0;
  };
  return { pts, wins, pre, useWins };
}

function pointsAfter(ctx, combo) {
  const rules = ctx.rules;
  const pts = Float64Array.from(ctx.base.points);
  for (let f = 0; f < combo.length; f++) {
    const fx = ctx.remaining[f], o = combo[f];
    if (o === R.SHARED) { pts[fx.h] += rules.points_no_result; pts[fx.a] += rules.points_no_result; }
    else if (o === R.HOME) { pts[fx.h] += rules.points_win; pts[fx.a] += rules.points_loss; }
    else { pts[fx.a] += rules.points_win; pts[fx.h] += rules.points_loss; }
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 * Margin thresholds.
 * ------------------------------------------------------------------ */

/**
 * Solve `ok(margin)` for the margin of the `free` fixtures, at score S.
 *
 * `winning` — the side we are asking about wins those games: find the
 * smallest runs margin and the most balls a chase may take. Otherwise it
 * loses them: find the biggest defeat in runs it can absorb, and the fewest
 * balls the opponent may take to chase. Net run rate is monotone in the
 * margin, so a scan finds the boundary exactly.
 */
/** Smallest x in [lo, hi] with pred(x) true, pred monotone false→true; null if none. */
function firstTrue(lo, hi, pred) {
  if (!pred(hi)) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export const MIN_CHASE_BALLS = BALLS_PER_OVER;   // a chase takes at least an over

function solve(ok, S, Q, winning) {
  const maxRuns = Math.max(1, S - 10);           // the other side makes at least 10
  const runsOk = (r) => ok({ mode: 'runs', value: r });
  const chaseOk = (b) => ok({ mode: 'chase', value: b });
  if (winning) {
    // Bigger runs margin helps; fewer balls to chase helps.
    const runs = firstTrue(1, maxRuns, runsOk);
    const fewest = firstTrue(0, Q - MIN_CHASE_BALLS, (k) => chaseOk(Q - k));
    const balls = fewest == null ? null : Q - fewest;
    return { runs, balls, any: runs === 1 && balls === Q, none: runs == null && balls == null, maxRuns };
  }
  // Losing: `runs` = largest defeat batting second that still works,
  // `balls` = fewest balls the winner may take to chase.
  const r0 = firstTrue(0, maxRuns - 1, (k) => runsOk(maxRuns - k));
  const runs = r0 == null ? null : maxRuns - r0;
  const balls = firstTrue(MIN_CHASE_BALLS, Q, chaseOk);
  return { runs, balls, any: runs === maxRuns && balls === MIN_CHASE_BALLS, none: runs == null && balls == null, maxRuns };
}

/** Thresholds at each assumed score; `main` is the one at S. */
function solveAcross(set, okAt, winning) {
  const at = set.scores.map((S) => ({ S, ...solve((mg) => okAt(mg, S), S, set.quota, winning) }));
  return { main: at[1], low: at[0], high: at[2] };
}

/* ------------------------------------------------------------------ *
 * One scenario: where does team T stand?
 * ------------------------------------------------------------------ */

function fixturesOf(ctx, i) {
  const out = [];
  for (let f = 0; f < ctx.remaining.length; f++) {
    const fx = ctx.remaining[f];
    if (fx.h === i || fx.a === i) out.push(f);
  }
  return out;
}

/** Did team i win (+1), lose (-1) or share (0) fixture f under combo? */
function resultFor(ctx, combo, f, i) {
  const o = combo[f];
  if (o === R.SHARED) return 0;
  const fx = ctx.remaining[f];
  return (o === R.HOME) === (fx.h === i) ? 1 : -1;
}

/**
 * Verdict for team `t` reaching the top `K` under `combo`.
 *
 *   { kind: 'in' }                       through on points
 *   { kind: 'out', above }               too many teams above on points
 *   { kind: 'race', mode: 'own', ... }   level on points; t's own margin decides
 *   { kind: 'race', mode: 'others', ...} level on points; t's game is done or
 *                                        shared, so rivals' margins decide
 */
export function scenarioVerdict(ctx, set, t, K, combo) {
  const { pts, wins, pre } = standAfter(ctx, combo);
  const n = ctx.n;
  let above = 0;
  const level = [], winsAbove = [], winsBelow = [];
  for (let i = 0; i < n; i++) {
    if (i === t) continue;
    const c = pre(i, t);
    const samePts = Math.abs(pts[i] - pts[t]) < 1e-9;
    if (c > 1e-9) { above++; if (samePts) winsAbove.push(i); }
    else if (Math.abs(c) < 1e-9) level.push(i);
    else if (samePts) winsBelow.push(i);
  }
  const m = K - above;            // places left for the level group, t included
  const w = wins[t];
  if (m <= 0) {
    // Did wins push them out? Only worth saying when points alone would not.
    const byWins = winsAbove.length && above - winsAbove.length < K ? winsAbove : [];
    return { kind: 'out', above, points: pts[t], wins: w, winsAbove: byWins, winsOf: byWins.map((j) => wins[j]) };
  }
  if (level.length < m) {
    const byWins = winsBelow.length && level.length + winsBelow.length >= m ? winsBelow : [];
    return { kind: 'in', points: pts[t], wins: w, winsBelow: byWins, winsOf: byWins.map((j) => wins[j]) };
  }

  // Only fixtures involving t or the level group move the race; cache on those.
  const involved = new Set([t, ...level]);
  const sig = combo.map((o, f) => (involved.has(ctx.remaining[f].h) || involved.has(ctx.remaining[f].a) ? o : 'x')).join('');
  const cacheKey = `${t}|${K}|${level.join(',')}|${sig}`;
  set.cache = set.cache || new Map();
  if (set.cache.has(cacheKey)) return set.cache.get(cacheKey);
  const v = { ...raceVerdict(ctx, set, t, K, combo, pts, level, m), wins: w };
  set.cache.set(cacheKey, v);
  return v;
}

function raceVerdict(ctx, set, t, K, combo, pts, level, m) {
  const own = fixturesOf(ctx, t).filter((f) => combo[f] !== R.SHARED);
  const results = own.map((f) => resultFor(ctx, combo, f, t));
  const uniform = results.length > 0 && results.every((r) => r === results[0]);

  if (uniform) {
    const winning = results[0] > 0;
    const free = new Set(own);
    const okAt = (margin, S) => {
      const nrr = nrrAfter(ctx, set, combo, free, margin, S);
      const mine = nrr(t);
      let better = 0;
      for (const j of level) if (nrr(j) >= mine - 1e-12) better++;   // level NRR is not a win: later tiebreaks unknown
      return better < m;
    };
    const need = solveAcross(set, okAt, winning);
    // Name the race: the rivals t must finish above, with where they stand.
    const others = level.filter((j) => !own.some((f) => ctx.remaining[f].h === j || ctx.remaining[f].a === j));
    return {
      kind: 'race', mode: 'own', winning, points: pts[t], level, places: m,
      mustBeat: level.length - m + 1, need,
      pendingRivals: level.filter((j) => fixturesOf(ctx, j).some((f) => combo[f] !== R.SHARED && !own.includes(f))),
      opponentInRace: level.filter((j) => !others.includes(j)),
    };
  }

  if (own.length) {
    // Mixed results over several games: margins are not a single number.
    // Judge it at typical margins and say so.
    const nrr = nrrAfter(ctx, set, combo, new Set(), null, set.score);
    let better = 0;
    for (const j of level) if (nrr(j) >= nrr(t) - 1e-12) better++;
    return { kind: 'race', mode: 'mixed', points: pts[t], level, places: m, typicalIn: better < m };
  }

  // t's own result is settled (no game left, or washed out): each level
  // rival either finishes above t already, or does so depending on its own
  // margin.
  const rivals = level.map((j) => ({ team: j, ...pairwise(ctx, set, combo, j, t) }));
  const always = rivals.filter((r) => r.state === 'above').length;
  const maybe = rivals.filter((r) => r.state === 'depends');
  return {
    kind: 'race', mode: 'others', points: pts[t], level, places: m, rivals,
    // t is in unless `canAfford + 1` rivals finish above it.
    canAfford: m - 1 - always,
    maybe: maybe.length,
  };
}

/**
 * Does team `a` finish above team `b` on net run rate under `combo` (where
 * they are level on points)? Solved for whichever of them has a decisive game
 * left — `a` first — with everything else at the typical margin.
 *
 *  { state: 'above' | 'below' }                     settled
 *  { state: 'depends', side, winning, need }         a's (side 'a') or b's
 *                                                    (side 'b') margin decides
 */
export function pairwise(ctx, set, combo, a, b) {
  const ownA = fixturesOf(ctx, a).filter((f) => combo[f] !== R.SHARED);
  const ownB = fixturesOf(ctx, b).filter((f) => combo[f] !== R.SHARED);
  const pick = (own, who) => {
    const res = own.map((f) => resultFor(ctx, combo, f, who));
    return res.length && res.every((r) => r === res[0]) ? { own, winning: res[0] > 0 } : null;
  };
  const free = pick(ownA, a) ? { side: 'a', ...pick(ownA, a) } : (pick(ownB, b) ? { side: 'b', ...pick(ownB, b) } : null);
  const gap = (margin, S) => {
    const nrr = nrrAfter(ctx, set, combo, free ? new Set(free.own) : new Set(), margin, S);
    return nrr(a) - nrr(b);
  };
  // Strict both ways: dead level on NRR goes to tiebreaks we do not model.
  const aAbove = (margin, S) => gap(margin, S) > 1e-12;
  const bAbove = (margin, S) => gap(margin, S) < -1e-12;
  // Nothing decisive left for either side: exact. Mixed results: typical margins.
  if (!free) return { state: aAbove(null, set.score) ? 'above' : 'below', robust: !ownA.length && !ownB.length };
  // Phrase the condition from the free side's point of view: "free side
  // finishes above the other".
  const freeAbove = free.side === 'a' ? aAbove : bAbove;
  const need = solveAcross(set, freeAbove, free.winning);
  if (need.main.any) return { state: free.side === 'a' ? 'above' : 'below', robust: true };
  if (need.main.none) return { state: free.side === 'a' ? 'below' : 'above', robust: true };
  return { state: 'depends', side: free.side, winning: free.winning, need };
}

/* ------------------------------------------------------------------ *
 * Every combination of the other results, merged into readable conditions.
 * ------------------------------------------------------------------ */

function fixtureProbs(ctx, model, rates) {
  const shared = (rates?.abandonRate || 0) + (rates?.tieRate || 0);
  return ctx.remaining.map((fx) => {
    const ph = winProbability(ctx, fx.h, fx.a, model);
    return [(1 - shared) * ph, (1 - shared) * (1 - ph), shared];
  });
}

/** All outcome vectors over fixture indices `dims`, others left at -1. */
function* combos(R0, dims, base) {
  const c = base.slice();
  function* rec(k) {
    if (k === dims.length) { yield c.slice(); return; }
    for (const o of OUTCOMES) { c[dims[k]] = o; yield* rec(k + 1); }
  }
  yield* rec(0);
}

/**
 * Merge combos that share a verdict into "cubes": per fixture, the set of
 * outcomes (bitmask) for which the line holds. Two cubes merge when they
 * differ in exactly one fixture.
 */
function mergeCubes(cubes) {
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < cubes.length; i++) {
      for (let j = i + 1; j < cubes.length; j++) {
        const a = cubes[i].masks, b = cubes[j].masks;
        let diff = -1, n = 0;
        for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { diff = k; n++; }
        if (n === 1) {
          const masks = a.slice(); masks[diff] = a[diff] | b[diff];
          cubes.splice(j, 1);
          cubes[i] = { masks };
          changed = true;
          break outer;
        }
      }
    }
  }
  return cubes;
}

const verdictKey = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x));

/**
 * The analysis for team `teamId`, one goal. `K` = places that count (6 for
 * the playoffs, 3 for promotion, n - 3 for staying up).
 *
 * Returns, per own outcome (win / shared / lose, or per combination when the
 * team has several games left), the conditions on other results and the
 * verdict under each.
 */
export function goalMargins(ctx, set, teamId, K, { model = 'form', rates = null } = {}) {
  const t = ctx.index.get(teamId);
  const probs = fixtureProbs(ctx, model, rates);
  const mine = fixturesOf(ctx, t);
  const others = ctx.remaining.map((_, f) => f).filter((f) => !mine.includes(f));
  const blank = new Array(ctx.remaining.length).fill(-1);

  const ownCases = mine.length ? [...combos(null, mine, blank)] : [blank.slice()];
  const out = [];
  for (const own of ownCases) {
    const groups = new Map();
    let ownProb = 1;
    for (const f of mine) ownProb *= probs[f][own[f]];
    for (const c of combos(null, others, own)) {
      const v = scenarioVerdict(ctx, set, t, K, c);
      const key = verdictKey(v);
      let p = 1;
      for (const f of others) p *= probs[f][c[f]];
      if (!groups.has(key)) groups.set(key, { verdict: v, prob: 0, cubes: [] });
      const g = groups.get(key);
      g.prob += p;
      g.cubes.push({ masks: others.map((f) => 1 << c[f]) });
    }
    const lines = [...groups.values()].map((g) => ({
      verdict: g.verdict,
      prob: g.prob,
      conditions: mergeCubes(g.cubes).map((cube) => cube.masks
        .map((mask, k) => ({ fixture: others[k], mask }))
        .filter((c) => c.mask !== 7)),
    })).sort((x, y) => y.prob - x.prob);
    out.push({
      own: mine.map((f) => ({ fixture: f, result: resultFor(ctx, own, f, t) })),
      prob: ownProb,
      lines,
    });
  }
  return { team: ctx.teams[t], index: t, K, fixtures: mine, cases: out };
}

/**
 * Pairwise: under each of team T's own outcomes, does it finish above `rival`
 * on the table? Points, then wins; level on both, net run rate with the margin
 * solved. The rival's own remaining games (if any, and not against T) are
 * enumerated.
 */
export function rivalMargins(ctx, set, teamId, rivalId) {
  const t = ctx.index.get(teamId), r = ctx.index.get(rivalId);
  const mine = fixturesOf(ctx, t);
  const theirs = fixturesOf(ctx, r).filter((f) => !mine.includes(f));
  const blank = new Array(ctx.remaining.length).fill(-1);
  const ownCases = mine.length ? [...combos(null, mine, blank)] : [blank.slice()];
  const cases = [];
  for (const own of ownCases) {
    const groups = new Map();
    for (const c of combos(null, theirs, own)) {
      // Fixtures involving neither team do not change either side's points or
      // NRR, so they stay unplayed (shared = no effect) here.
      const full = c.map((o) => (o === -1 ? R.SHARED : o));
      const s = standAfter(ctx, full);
      const pts = s.pts;
      const cw = s.pre(t, r);
      let v;
      if (pts[t] > pts[r] + 1e-9) v = { state: 'above', on: 'points' };
      else if (pts[t] < pts[r] - 1e-9) v = { state: 'below', on: 'points' };
      else if (cw > 1e-9) v = { state: 'above', on: 'wins', points: pts[t], wins: [s.wins[t], s.wins[r]] };
      else if (cw < -1e-9) v = { state: 'below', on: 'wins', points: pts[t], wins: [s.wins[t], s.wins[r]] };
      else v = { ...pairwise(ctx, set, full, t, r), on: 'nrr', points: pts[t], wins: [s.wins[t], s.wins[r]] };
      const key = verdictKey(v);
      if (!groups.has(key)) groups.set(key, { verdict: v, cubes: [] });
      groups.get(key).cubes.push({ masks: theirs.map((f) => 1 << c[f]) });
    }
    cases.push({
      own: mine.map((f) => ({ fixture: f, result: resultFor(ctx, own, f, t) })),
      lines: [...groups.values()].map((g) => ({
        verdict: g.verdict,
        conditions: mergeCubes(g.cubes).map((cube) => cube.masks
          .map((mask, k) => ({ fixture: theirs[k], mask }))
          .filter((x) => x.mask !== 7)),
      })),
    });
  }
  return { team: ctx.teams[t], rival: ctx.teams[r], cases };
}

/**
 * The rivals worth a pairwise line for team T: anyone T can finish level with
 * on points, given every possible result.
 */
export function racingRivals(ctx, teamId) {
  const t = ctx.index.get(teamId);
  const rules = ctx.rules;
  const per = [rules.points_win, rules.points_loss, rules.points_no_result];
  const left = (i) => fixturesOf(ctx, i).length;
  const range = (i) => [ctx.base.points[i] + left(i) * Math.min(...per), ctx.base.points[i] + left(i) * Math.max(...per)];
  const [lo, hi] = range(t);
  const out = [];
  for (let i = 0; i < ctx.n; i++) {
    if (i === t) continue;
    const [a, b] = range(i);
    if (b >= lo && a <= hi) out.push(i);
  }
  // Closest in the current table first.
  return out.sort((x, y) => Math.abs(ctx.base.points[x] - ctx.base.points[t]) - Math.abs(ctx.base.points[y] - ctx.base.points[t]))
    .map((i) => ctx.teams[i].id);
}

/* ------------------------------------------------------------------ *
 * How badly can a team lose before net run rate drops it below a rival?
 * ------------------------------------------------------------------ */

/**
 * Losing, in the right cricket direction:
 *  - bowling first: the opponent bats first and makes S; the team falls short
 *    by r runs (charged the full quota whether bowled out or not);
 *  - batting first: the team makes S (full quota charged); the opponent
 *    chases S + 1 in b balls.
 * Nothing is capped here: r runs up to S (bowled out for 0), b down to 1 ball.
 */
const MAX_SCORE = 600;

/**
 * For team `teamId` and each rival it could finish level with on points in a
 * race that matters (top-K boundary for any goal), with team losing one of
 * its games: exact margins at which its NRR is no longer above the rival's.
 *
 * Returns [{ rival, fixture, opponent, goals, conditions, assumed, nowT, nowR,
 *            runs: [{S, r}], minScore, chase: [{S, b}], chaseEver, worst,
 *            anyDefeat, realistic }]
 *  r      — smallest defeat in runs (opponent batting first on S) that does it
 *  minScore — smallest opponent first-innings total at which it can happen at
 *             all (bowled out for 0), null if not up to MAX_SCORE
 *  b      — most balls the opponent may take to chase S + 1 for it to happen
 *  worst  — the team's and rival's NRR after the worst case: bowled out for
 *           0 and chased off 1 ball
 */
export function lossMargins(ctx, set, teamId, goalKs) {
  const t = ctx.index.get(teamId);
  const mine = fixturesOf(ctx, t);
  if (!mine.length) return [];
  const Ks = goalKs || [];
  const out = [];
  const eps = 1e-12;
  for (const rid of racingRivals(ctx, teamId)) {
    const r = ctx.index.get(rid);
    const dims = [...new Set([...mine, ...fixturesOf(ctx, r)])];
    const rest = ctx.remaining.map((_, f) => f).filter((f) => !dims.includes(f));
    for (const f of mine) {
      const fx = ctx.remaining[f];
      const lose = fx.h === t ? R.AWAY : R.HOME;
      const opp = fx.h === t ? fx.a : fx.h;
      const vary = dims.filter((x) => x !== f);
      const blank = new Array(ctx.remaining.length).fill(-1);
      blank[f] = lose;
      const groups = new Map();
      for (const c of combos(null, vary, blank)) {
        const part = c.map((o) => (o === -1 ? R.SHARED : o));
        const s0 = standAfter(ctx, part);
        if (Math.abs(s0.pts[t] - s0.pts[r]) > 1e-9) continue;
        // Level on points but not on wins: wins decide, not the margin.
        const byWins = Math.abs(s0.pre(t, r)) > 1e-9;
        // Does the pair's order ever decide a goal? Every outcome of the
        // other fixtures; `pre` (points, then wins) decides who is level.
        const goals = new Set();
        for (const c2 of combos(null, rest, c)) {
          const s = standAfter(ctx, c2);
          let above = 0, level = 0;
          for (let i = 0; i < ctx.n; i++) {
            if (i === t) continue;
            // For a wins-decided pair, the race is the points-level group.
            const d = byWins ? s.pts[i] - s.pts[t] : s.pre(i, t);
            if (d > 1e-9) above++;
            else if (Math.abs(d) < 1e-9) level++;
          }
          for (const [goal, K] of Ks) {
            const m = K - above;
            if (m > 0 && level >= m) goals.add(goal);
          }
          if (goals.size === Ks.length) break;
        }
        if (!goals.size) continue;
        const res = byWins
          ? { winsDecide: true, state: s0.pre(t, r) > 0 ? 'above' : 'below', points: s0.pts[t],
            wins: [s0.wins[t], s0.wins[r]], nowT: currentNrr(ctx, t), nowR: currentNrr(ctx, r),
            assumed: false, realistic: true, anyDefeat: s0.pre(t, r) < 0 }
          : lossThresholds(ctx, set, t, r, f, part, dims);
        if (!byWins) { res.points = s0.pts[t]; res.wins = [s0.wins[t], s0.wins[r]]; }
        res.goals = [...goals];
        const key = verdictKey(res);
        if (!groups.has(key)) groups.set(key, { res, cubes: [] });
        groups.get(key).cubes.push({ masks: vary.map((x) => 1 << c[x]) });
      }
      for (const g of groups.values()) {
        out.push({
          rival: rid, fixture: f, opponent: ctx.teams[opp].id, ...g.res,
          conditions: mergeCubes(g.cubes).map((cube) => cube.masks
            .map((mask, k) => ({ fixture: vary[k], mask })).filter((x) => x.mask !== 7)),
        });
      }
    }
  }
  return out;
}

/**
 * The loss thresholds for one pair, whether or not their order decides a
 * goal: team `teamId` loses fixture `f`, every other game of the pair
 * washed out (no effect). Used by the tests and for facts.
 */
export function pairLossThresholds(ctx, set, teamId, rivalId, f) {
  const t = ctx.index.get(teamId), r = ctx.index.get(rivalId);
  const fx = ctx.remaining[f];
  const combo = ctx.remaining.map(() => R.SHARED);
  combo[f] = fx.h === t ? R.AWAY : R.HOME;
  return lossThresholds(ctx, set, t, r, f, combo, [f]);
}

function lossThresholds(ctx, set, t, r, f, combo, dims) {
  const Q = set.quota;
  const fx = ctx.remaining[f];
  const winner = fx.h === t ? fx.a : fx.h;
  const typical = { mode: 'runs', value: set.typicalRuns };
  let assumed = false;
  for (const x of dims) if (x !== f && combo[x] !== R.SHARED) assumed = true;
  const after = (margin, S) => {
    const st = baseStats(ctx);
    for (const x of dims) {
      const o = combo[x];
      if (o === R.SHARED) continue;
      const fy = ctx.remaining[x];
      const w = o === R.HOME ? fy.h : fy.a, l = o === R.HOME ? fy.a : fy.h;
      if (x === f) decisive(st, winner, t, margin, S, Q);
      else decisive(st, w, l, typical, set.score, Q);
    }
    return [nrrOf(st, t), nrrOf(st, r)];
  };
  const below = (margin, S) => { const [a, b0] = after(margin, S); return a - b0 <= eps0; };
  const eps0 = 1e-12;
  const runsAt = (S) => firstTrue(1, S, (k) => below({ mode: 'runs', value: k }, S));
  const chaseAt = (S) => {
    const k = firstTrue(0, Q - 1, (j) => below({ mode: 'chase', value: Q - j }, S));
    return k == null ? null : Q - k;
  };
  // Bowled out for 0 against a bigger and bigger total only gets worse.
  const minScore = firstTrue(1, MAX_SCORE, (S) => below({ mode: 'runs', value: S }, S));
  const scores = set.scores;
  const runs = scores.map((S) => ({ S, r: runsAt(S) }));
  const chase = scores.map((S) => ({ S, b: chaseAt(S) }));
  let chaseEver = null;          // lowest own total at which some chase does it
  for (let S = 0; S <= set.highest; S++) if (below({ mode: 'chase', value: 1 }, S)) { chaseEver = S; break; }
  const worst = after({ mode: 'chase', value: 1 }, 0);
  const anyDefeat = below({ mode: 'runs', value: 1 }, set.score) && below({ mode: 'chase', value: Q }, set.score);
  // Realistic: it happens at one of the quoted scores, or once the opponent
  // makes a score that one first innings in ten here reaches.
  const big = set.high;
  const realistic = runs.some((x) => x.r != null) || chase.some((x) => x.b != null)
    || (minScore != null && minScore <= big) || (chaseEver != null && chaseEver <= big);
  const reached = minScore == null ? 0 : (set.firstInnings || []).filter((x) => x >= minScore).length;
  const [nowT, nowR] = [currentNrr(ctx, t), currentNrr(ctx, r)];
  return { assumed, nowT, nowR, runs, minScore, reached, chase, chaseEver, worst, anyDefeat, realistic };
}
