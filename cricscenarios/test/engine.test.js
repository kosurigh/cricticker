/**
 * Tests for the table maths and the simulator.
 *
 *   node --test test/engine.test.js       (Node 18+)
 *
 * These are hand-checked cases, not snapshots: every expected number below is
 * one you can work out on paper, which is the point — the whole page is only
 * as trustworthy as the net run rate arithmetic underneath it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  oversToBalls, ballsToOvers, ballsToDecimalOvers, netRunRate, buildTable,
  standingsFor, certificates, countingBalls, DEFAULT_RULES, headToHead,
  baselineFromPublished, inferPointsSystem, pointsBounds, rulesForDivision, winsBeforeNrr,
} from '../assets/js/engine.js';
import {
  prepare, simulate, bradleyTerry, matchShapes, winProbability, outcomeRates,
  OUTCOME, OUTCOMES,
} from '../assets/js/simulate.js';
import {
  nrrAfterWins, requiredMargin, summarise, goalState, ownResultsBreakdown,
  ownMixBreakdown, keyFixtures,
} from '../assets/js/scenarios.js';

const RULES = { ...DEFAULT_RULES, overs_per_innings: 20 };

const T = (id, name) => ({ id, name, short: name.slice(0, 3).toUpperCase() });
const TEAMS = [T(1, 'Alpha'), T(2, 'Bravo'), T(3, 'Charlie'), T(4, 'Delta')];

/** A completed match in the project's schema. */
function done(id, home, away, first, second, winner, type, margin) {
  return {
    id, home, away, status: 'completed',
    result: {
      winner, type, margin,
      innings: [
        { team: first.team, runs: first.runs, overs: first.overs, allOut: !!first.allOut },
        { team: second.team, runs: second.runs, overs: second.overs, allOut: !!second.allOut },
      ],
    },
  };
}

/* ---------------------------------------------------------------- overs */

test('overs notation converts through balls without base-10 drift', () => {
  assert.equal(oversToBalls('19.3'), 117);
  assert.equal(oversToBalls(20), 120);
  assert.equal(oversToBalls(0), 0);
  assert.equal(ballsToOvers(117), 19.3);
  assert.equal(ballsToDecimalOvers(117), 19.5);
  // The trap this representation exists to avoid: 19.3 + 0.3 overs is 20.0.
  assert.equal(ballsToOvers(oversToBalls('19.3') + 3), 20);
});

test('a side bowled out is charged its full quota of overs', () => {
  assert.equal(countingBalls({ runs: 80, overs: 12, allOut: true }, RULES), 120);
  assert.equal(countingBalls({ runs: 80, overs: 12, allOut: false }, RULES), 72);
  // and an innings can never count for more than the quota
  assert.equal(countingBalls({ runs: 200, overs: 25, allOut: false }, RULES), 120);
});

/* ------------------------------------------------------------------ nrr */

test('net run rate matches the hand calculation, defending and chasing', () => {
  const matches = [
    // Alpha 160 in 20; Bravo all out 140 in 18 -> Bravo charged the full 20.
    done(101, 1, 2, { team: 1, runs: 160, overs: 20 },
         { team: 2, runs: 140, overs: 18, allOut: true }, 1, 'runs', 20),
    // Charlie 150 in 20; Delta chase 151 in 18 overs.
    done(102, 3, 4, { team: 3, runs: 150, overs: 20 },
         { team: 4, runs: 151, overs: 18 }, 4, 'wickets', 6),
  ];
  const rows = buildTable(TEAMS, matches, RULES);

  assert.equal(netRunRate(rows[1]), 160 / 20 - 140 / 20);   // +1.0
  assert.equal(netRunRate(rows[2]), 140 / 20 - 160 / 20);   // -1.0
  assert.ok(Math.abs(netRunRate(rows[4]) - (151 / 18 - 150 / 20)) < 1e-12);
  assert.ok(Math.abs(netRunRate(rows[3]) - (150 / 20 - 151 / 18)) < 1e-12);

  assert.equal(rows[1].points, 2);
  assert.equal(rows[2].points, 0);
  assert.equal(rows[1].won, 1);
  assert.equal(rows[2].lost, 1);
});

test('an abandoned match splits the points and leaves run rate untouched', () => {
  const matches = [{
    id: 103, home: 1, away: 2, status: 'completed',
    result: { type: 'no_result', innings: [] },
  }];
  const rows = buildTable(TEAMS, matches, RULES);
  assert.equal(rows[1].points, 1);
  assert.equal(rows[2].points, 1);
  assert.equal(rows[1].noResult, 1);
  assert.equal(netRunRate(rows[1]), 0);
  assert.equal(rows[1].ballsFor, 0);
});

test('a tie splits the points but still counts towards run rate', () => {
  const matches = [done(104, 1, 2, { team: 1, runs: 150, overs: 20 },
                        { team: 2, runs: 150, overs: 20 }, null, 'tie', 0)];
  const rows = buildTable(TEAMS, matches, RULES);
  assert.equal(rows[1].points, 1);
  assert.equal(rows[2].points, 1);
  assert.equal(rows[1].tied, 1);
  assert.equal(rows[1].ballsFor, 120);
  assert.equal(netRunRate(rows[1]), 0);
});

/* ------------------------------------------------------------ standings */

test('the table sorts on points first and net run rate second', () => {
  const matches = [
    done(1, 1, 3, { team: 1, runs: 180, overs: 20 }, { team: 3, runs: 120, overs: 20 }, 1, 'runs', 60),
    done(2, 2, 4, { team: 2, runs: 150, overs: 20 }, { team: 4, runs: 145, overs: 20 }, 2, 'runs', 5),
  ];
  const table = standingsFor(TEAMS, matches, RULES);
  // Alpha and Bravo both on 2 points; Alpha won by far more.
  assert.equal(table[0].teamId, 1);
  assert.equal(table[1].teamId, 2);
  assert.equal(table[3].teamId, 3);   // heaviest defeat, worst net run rate
  assert.deepEqual(table.map((r) => r.position), [1, 2, 3, 4]);
});

test('head-to-head separates two teams level on points and run rate', () => {
  // Identical scorelines both ways round, so points and NRR are dead level and
  // only the result between them can break the tie.
  const matches = [
    done(1, 1, 2, { team: 1, runs: 150, overs: 20 }, { team: 2, runs: 140, overs: 20 }, 1, 'runs', 10),
    done(2, 2, 1, { team: 2, runs: 150, overs: 20 }, { team: 1, runs: 140, overs: 20 }, 2, 'runs', 10),
    done(3, 1, 3, { team: 1, runs: 150, overs: 20 }, { team: 3, runs: 140, overs: 20 }, 1, 'runs', 10),
    done(4, 2, 3, { team: 2, runs: 140, overs: 20 }, { team: 3, runs: 150, overs: 20 }, 3, 'runs', 10),
  ];
  assert.equal(headToHead(matches, 1, 2), 0);   // one win each
  const single = [matches[0], matches[2], matches[3]];
  assert.equal(headToHead(single, 1, 2), 1);    // Alpha won the only meeting
  assert.equal(headToHead(single, 2, 1), -1);
});

/* ------------------------------------------- TCL handbook tie-breaks */

const HANDBOOK = { ...RULES, tiebreak: ['points', 'wins', 'nrr', 'h2h'] };
const NR = (id, home, away) => ({ id, home, away, status: 'completed', result: { type: 'no_result', innings: [] } });

test('TCL order (16.10.5): level on points, more wins beats a better net run rate', () => {
  // Alpha: a 1-run win and a 100-run defeat (2 pts, 1 win, NRR well below 0).
  // Bravo: two washouts (2 pts, 0 wins, NRR 0).
  const matches = [
    done(1, 1, 3, { team: 1, runs: 150, overs: 20 }, { team: 3, runs: 149, overs: 20 }, 1, 'runs', 1),
    done(2, 4, 1, { team: 4, runs: 200, overs: 20 }, { team: 1, runs: 100, overs: 20 }, 4, 'runs', 100),
    NR(3, 2, 3), NR(4, 2, 4),
  ];
  const old = standingsFor(TEAMS, matches, RULES).map((r) => r.teamId);
  const hb = standingsFor(TEAMS, matches, HANDBOOK).map((r) => r.teamId);
  assert.ok(old.indexOf(2) < old.indexOf(1), 'NRR first: Bravo above Alpha');
  assert.ok(hb.indexOf(1) < hb.indexOf(2), 'wins first: Alpha above Bravo');
  assert.equal(winsBeforeNrr(HANDBOOK), true);
  assert.equal(winsBeforeNrr(RULES), false);

  // The simulation orders the same way (one game left, Charlie v Delta, which
  // cannot touch either).
  const left = [...matches, { id: 9, home: 3, away: 4, status: 'upcoming' }];
  for (const [rules, above, below] of [[HANDBOOK, 1, 2], [RULES, 2, 1]]) {
    const ctx = prepare(TEAMS, left, rules);
    const res = simulate(ctx, { trials: 300, model: 'coinflip', seed: 7 });
    const n = ctx.n, ia = ctx.index.get(above), ib = ctx.index.get(below);
    const mean = (i) => { let s = 0, c = 0; for (let p = 0; p < n; p++) { s += p * res.posCounts[i * n + p]; c += res.posCounts[i * n + p]; } return s / c; };
    assert.ok(mean(ia) < mean(ib), `${JSON.stringify(rules.tiebreak)}: team ${above} above ${below} in every trial`);
  }
});

test('certificates use wins when wins come before net run rate', () => {
  // Alpha and Bravo are done on 2 points (1 win v 0); Delta already has 3,
  // Charlie v Delta is left. Wins first: Alpha is always above Bravo.
  const matches = [
    done(1, 1, 3, { team: 1, runs: 150, overs: 20 }, { team: 3, runs: 149, overs: 20 }, 1, 'runs', 1),
    done(2, 4, 1, { team: 4, runs: 200, overs: 20 }, { team: 1, runs: 100, overs: 20 }, 4, 'runs', 100),
    NR(3, 2, 3), NR(4, 2, 4), { id: 9, home: 3, away: 4, status: 'upcoming' },
  ];
  assert.equal(certificates(2, TEAMS, matches, HANDBOOK).bestPossiblePosition, 3);
  assert.equal(certificates(2, TEAMS, matches, RULES).bestPossiblePosition, 2);
  assert.equal(certificates(1, TEAMS, matches, HANDBOOK).worstPossiblePosition, 3);
  assert.equal(certificates(1, TEAMS, matches, RULES).worstPossiblePosition, 4);
});

test('teams level on everything modelled are flagged for last season / coin toss', () => {
  const matches = [NR(1, 1, 3), NR(2, 2, 4)];
  const table = standingsFor(TEAMS, matches, HANDBOOK);
  assert.ok(table.every((r) => r.unresolved), 'all four on 1 point, 0 wins, NRR 0, no head-to-head');
  const split = standingsFor(TEAMS, [done(1, 1, 3, { team: 1, runs: 150, overs: 20 }, { team: 3, runs: 140, overs: 20 }, 1, 'runs', 10)], HANDBOOK);
  assert.equal(split.find((r) => r.teamId === 1).unresolved, undefined);
});

test('division overrides: no promotion from the top division, no relegation from the bottom one', () => {
  const rules = { ...HANDBOOK, division_overrides: { 1: { promotion_spots: 0 }, 9: { relegation_spots: 0 } } };
  assert.equal(rulesForDivision(rules, 1).promotion_spots, 0);
  assert.equal(rulesForDivision(rules, 1).relegation_spots, rules.relegation_spots);
  assert.equal(rulesForDivision(rules, 9).relegation_spots, 0);
  assert.equal(rulesForDivision(rules, 5).promotion_spots, rules.promotion_spots);
  // And the simulation then never promotes or relegates anyone there.
  const ctx = prepare(TEAMS, [{ id: 1, home: 1, away: 2, status: 'upcoming' }], rulesForDivision(rules, 1));
  const res = simulate(ctx, { trials: 200, model: 'coinflip', seed: 1 });
  assert.ok(res.goalCounts.promotion.every((x) => x === 0));
});

/* --------------------------------------------------------- certificates */

test('certificates prove elimination and qualification from points alone', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const big = (id, a, b, w) => done(id, a, b, { team: a, runs: 160, overs: 20 },
                                    { team: b, runs: 140, overs: 20 }, w, 'runs', 20);
  const matches = [
    big(1, 1, 3, 1), big(2, 1, 4, 1), big(3, 1, 2, 1), big(4, 2, 3, 2),
    big(5, 2, 4, 2), big(6, 3, 4, 3),
    // one still to play, between the two teams at the bottom
    { id: 7, home: 3, away: 4, status: 'upcoming' },
  ];
  // Alpha 6 pts (done), Bravo 4 (done), Charlie 2 + 1 game, Delta 0 + 1 game.
  const alpha = certificates(1, TEAMS, matches, rules);
  assert.equal(alpha.playoff.clinched, true);
  assert.equal(alpha.bestPossiblePosition, 1);
  assert.equal(alpha.worstPossiblePosition, 1);
  assert.equal(alpha.relegation.safe, true);

  const charlie = certificates(3, TEAMS, matches, rules);
  // Alpha (6) and Bravo (4) both already exceed Charlie's ceiling of 4... Bravo
  // ties it, so only Alpha is *guaranteed* above; the second spot is still live.
  assert.equal(charlie.playoff.eliminated, false);
  assert.equal(charlie.promotion.eliminated, true);   // cannot catch Alpha

  const delta = certificates(4, TEAMS, matches, rules);
  assert.equal(delta.playoff.eliminated, true);       // ceiling of 2 < Bravo's 4
  assert.equal(delta.promotion.eliminated, true);
});

test('certificates never call a live race decided', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const matches = [
    { id: 1, home: 1, away: 2, status: 'upcoming' },
    { id: 2, home: 3, away: 4, status: 'upcoming' },
  ];
  for (const t of TEAMS) {
    const c = certificates(t.id, TEAMS, matches, rules);
    assert.equal(c.playoff.clinched, false);
    assert.equal(c.playoff.eliminated, false);
    assert.equal(c.bestPossiblePosition, 1);
    assert.equal(c.worstPossiblePosition, 4);
  }
});

/* -------------------------------------------------------- margin solver */

test('net run rate after a win rises with the margin and is solvable', () => {
  const base = { runsFor: 300, ballsFor: 240, runsAgainst: 320, ballsAgainst: 240 };
  const before = netRunRate(base);
  const small = nrrAfterWins(base, 2, 150, 5, 'runs', RULES);
  const large = nrrAfterWins(base, 2, 150, 60, 'runs', RULES);
  assert.ok(before < 0);
  assert.ok(small > before, 'any win should help');
  assert.ok(large > small, 'a bigger win should help more');

  const need = requiredMargin(base, 2, 150, 0.5, 'runs', RULES);
  assert.ok(need > 0 && need < 150);
  // The solver returns the *smallest* sufficient margin: one run either side
  // of it should straddle the target.
  assert.ok(nrrAfterWins(base, 2, 150, need + 0.01, 'runs', RULES) >= 0.5);
  assert.ok(nrrAfterWins(base, 2, 150, need - 1, 'runs', RULES) < 0.5);

  // Unreachable targets are reported as unreachable rather than clamped.
  assert.equal(requiredMargin(base, 2, 150, 99, 'runs', RULES), null);
  assert.equal(requiredMargin(base, 0, 150, 0.5, 'runs', RULES), null);
});

test('chasing faster lifts net run rate, and wickets in hand do not', () => {
  const base = { runsFor: 300, ballsFor: 240, runsAgainst: 320, ballsAgainst: 240 };
  const slow = nrrAfterWins(base, 2, 150, 0.5, 'overs', RULES);
  const quick = nrrAfterWins(base, 2, 150, 6, 'overs', RULES);
  assert.ok(quick > slow, 'overs to spare are what move the needle');

  const need = requiredMargin(base, 2, 150, 0.5, 'overs', RULES);
  assert.ok(need > 0 && need < RULES.overs_per_innings);
});

/* ------------------------------------------------------------ simulator */

/** A symmetric league: everyone has played nobody, everything still to play. */
function blankSeason(teams) {
  const matches = [];
  let id = 1;
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      matches.push({ id: id++, home: teams[i].id, away: teams[j].id, status: 'upcoming' });
    }
  }
  return matches;
}

test('simulation output is a proper distribution', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const ctx = prepare(TEAMS, blankSeason(TEAMS), rules);
  const res = simulate(ctx, { trials: 4000, model: 'coinflip', focusId: 1, seed: 7 });

  for (let i = 0; i < res.n; i++) {
    let sum = 0;
    for (let p = 0; p < res.n; p++) sum += res.posCounts[i * res.n + p];
    assert.equal(sum, res.trials, 'every team lands in exactly one position per trial');
  }
  // Each position is filled exactly once per trial.
  for (let p = 0; p < res.n; p++) {
    let sum = 0;
    for (let i = 0; i < res.n; i++) sum += res.posCounts[i * res.n + p];
    assert.equal(sum, res.trials);
  }
});

test('a symmetric league under coin flips gives everyone the same chance', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const ctx = prepare(TEAMS, blankSeason(TEAMS), rules);
  const res = simulate(ctx, { trials: 20000, model: 'coinflip', focusId: 1, seed: 11 });
  const summary = summarise(ctx, res);
  for (const s of summary) {
    assert.ok(Math.abs(s.p.playoff - 0.5) < 0.04,
      `${s.team.name} playoff ${s.p.playoff} should be near 0.5`);
    assert.ok(Math.abs(s.expectedPosition - 2.5) < 0.12);
  }
  // Probabilities across teams must add up to the number of places available.
  const total = summary.reduce((a, s) => a + s.p.playoff, 0);
  assert.ok(Math.abs(total - 2) < 0.02, `playoff probabilities summed to ${total}`);
});

test('the same seed reproduces the same run', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const ctx = prepare(TEAMS, blankSeason(TEAMS), rules);
  const a = simulate(ctx, { trials: 2000, model: 'coinflip', focusId: 1, seed: 42 });
  const b = simulate(ctx, { trials: 2000, model: 'coinflip', focusId: 1, seed: 42 });
  assert.deepEqual(Array.from(a.posCounts), Array.from(b.posCounts));
  const c = simulate(ctx, { trials: 2000, model: 'coinflip', focusId: 1, seed: 43 });
  assert.notDeepEqual(Array.from(a.posCounts), Array.from(c.posCounts));
});

test('winning more of your own games never lowers your chances', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const ctx = prepare(TEAMS, blankSeason(TEAMS), rules);
  const res = simulate(ctx, { trials: 30000, model: 'coinflip', focusId: 1, seed: 5 });
  const rows = ownResultsBreakdown(res, 'playoff').filter((b) => b.trials > 200);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].p >= rows[i - 1].p - 0.02,
      `P(playoff | ${rows[i].wins} wins)=${rows[i].p} should not be below ` +
      `P(playoff | ${rows[i - 1].wins} wins)=${rows[i - 1].p}`);
  }
  // And the extremes should be far apart in a three-game season.
  assert.ok(rows[rows.length - 1].p - rows[0].p > 0.5);
});

test('a decided league reports certainty, not a probability', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const big = (id, a, b, w) => done(id, a, b, { team: a, runs: 160, overs: 20 },
                                    { team: b, runs: 140, overs: 20 }, w, 'runs', 20);
  const matches = [big(1, 1, 3, 1), big(2, 1, 4, 1), big(3, 1, 2, 1),
                   big(4, 2, 3, 2), big(5, 2, 4, 2), big(6, 3, 4, 3)];
  const ctx = prepare(TEAMS, matches, rules);
  const res = simulate(ctx, { trials: 500, model: 'coinflip', focusId: 1, seed: 3 });
  const summary = summarise(ctx, res);
  const alpha = summary.find((s) => s.team.id === 1);
  const delta = summary.find((s) => s.team.id === 4);
  assert.deepEqual(goalState(alpha, 'playoff'), { state: 'clinched', p: 1 });
  assert.deepEqual(goalState(delta, 'playoff'), { state: 'eliminated', p: 0 });
  assert.deepEqual(goalState(delta, 'relegation'), { state: 'clinched', p: 1 });
});

/* ------------------------------------------------------- strength model */

test('Bradley-Terry ranks teams by results and stays finite on a clean sweep', () => {
  // Alpha beat everyone, Delta lost to everyone: without the prior this is the
  // degenerate case where strengths run off to infinity.
  const results = [
    { w: 0, l: 1 }, { w: 0, l: 2 }, { w: 0, l: 3 },
    { w: 1, l: 2 }, { w: 1, l: 3 }, { w: 2, l: 3 },
  ];
  const p = bradleyTerry(4, results);
  assert.ok(p.every((v) => isFinite(v) && v > 0), 'strengths must stay finite');
  assert.ok(p[0] > p[1] && p[1] > p[2] && p[2] > p[3], 'order should follow results');
});

test('the form model favours the stronger team but never by more than 85/15', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const big = (id, a, b, w) => done(id, a, b, { team: a, runs: 200, overs: 20 },
                                    { team: b, runs: 60, overs: 20, allOut: true }, w, 'runs', 140);
  const matches = [
    big(1, 1, 3, 1), big(2, 1, 4, 1), big(3, 1, 2, 1),
    big(4, 2, 3, 2), big(5, 2, 4, 2), big(6, 3, 4, 3),
    { id: 7, home: 1, away: 4, status: 'upcoming' },
    { id: 8, home: 2, away: 3, status: 'upcoming' },
  ];
  const ctx = prepare(TEAMS, matches, rules);
  const flat = simulate(ctx, { trials: 8000, model: 'coinflip', focusId: 4, seed: 9 });
  const form = simulate(ctx, { trials: 8000, model: 'form', focusId: 4, seed: 9 });
  const idx = ctx.index.get(4);
  // Delta has lost everything; the form model should rate it below a coin flip.
  assert.ok(form.goalCounts.playoff[idx] <= flat.goalCounts.playoff[idx]);

  const p = winProbability(ctx, ctx.index.get(1), ctx.index.get(4), 'form');
  assert.ok(p > 0.5 && p <= 0.85, `clamped win probability was ${p}`);
});

/* ----------------------------------------------------------- bootstrap */

test('simulated margins are drawn from this division\'s own matches', () => {
  const matches = [
    done(1, 1, 2, { team: 1, runs: 160, overs: 20 },
         { team: 2, runs: 140, overs: 18, allOut: true }, 1, 'runs', 20),
    done(2, 3, 4, { team: 3, runs: 150, overs: 20 },
         { team: 4, runs: 151, overs: 18 }, 4, 'wickets', 6),
    done(3, 1, 3, { team: 1, runs: 170, overs: 20 },
         { team: 3, runs: 120, overs: 20 }, 1, 'runs', 50),
  ];
  const shapes = matchShapes(matches, RULES);
  assert.equal(shapes.length, 3);
  assert.equal(shapes[0].firstRuns, 160);
  assert.equal(shapes[0].firstBalls, 120);
  assert.equal(shapes[0].secondBalls, 120, 'all out means the full quota');
  assert.equal(shapes[0].chaseWon, false);
  assert.equal(shapes[1].chaseWon, true, 'Delta won batting second');
  assert.equal(shapes[1].secondBalls, 108);
});

test('a division with no completed matches still simulates', () => {
  const ctx = prepare(TEAMS, blankSeason(TEAMS), RULES);
  assert.ok(ctx.shapes.length >= 3, 'falls back to generic T20 shapes');
  const res = simulate(ctx, { trials: 500, model: 'coinflip', focusId: 1, seed: 1 });
  assert.equal(res.trials, 500);
});

/* ------------------------------------------------------------------ *
 * Seeding from the published table.
 *
 * The played half of a real table comes from CricHeroes rather than from our
 * own recomputation of it, because two things in it cannot be derived from the
 * fixture list at all: organiser points penalties, and innings CricHeroes
 * counts as all out below ten wickets because it knows the squad sizes. What
 * must stay true is that the simulator then adds *only* the unplayed fixtures
 * on top — double-counting a played match would be invisible and ruinous.
 * ------------------------------------------------------------------ */

const PUBLISHED = [
  // Alpha carries a two-point penalty: three wins would be six, not four.
  { teamId: 1, name: 'Alpha', played: 4, won: 3, lost: 1, tied: 0, noResult: 0, points: 4, nrr: 0.5, runsFor: 600, oversFor: 80, runsAgainst: 560, oversAgainst: 80 },
  { teamId: 2, name: 'Bravo', played: 4, won: 2, lost: 2, tied: 0, noResult: 0, points: 4, nrr: 0, runsFor: 560, oversFor: 80, runsAgainst: 560, oversAgainst: 80 },
  { teamId: 3, name: 'Charlie', played: 4, won: 2, lost: 1, tied: 0, noResult: 1, points: 5, nrr: 0.25, runsFor: 580, oversFor: 80, runsAgainst: 560, oversAgainst: 80 },
  { teamId: 4, name: 'Delta', played: 4, won: 1, lost: 3, tied: 0, noResult: 0, points: 2, nrr: -0.75, runsFor: 500, oversFor: 80, runsAgainst: 560, oversAgainst: 80 },
];

test('a published table seeds the rows it covers', () => {
  const base = baselineFromPublished(PUBLISHED, TEAMS);
  assert.equal(base[1].points, 4, 'the penalty is carried, not recomputed');
  assert.equal(base[1].won, 3);
  assert.equal(base[1].runsFor, 600);
  assert.equal(base[1].ballsFor, 480, '80 overs');
  assert.equal(netRunRate(base[1]).toFixed(3), '0.500');
});

test('a published table that misses a team is refused rather than half-used', () => {
  assert.equal(baselineFromPublished(PUBLISHED.slice(1), TEAMS), null);
  assert.equal(baselineFromPublished([], TEAMS), null);
  assert.equal(baselineFromPublished(null, TEAMS), null);
  // Present but without the run figures net run rate needs.
  assert.equal(baselineFromPublished(
    PUBLISHED.map(({ runsFor, ...rest }) => rest), TEAMS), null);
});

test('with a baseline, only the unplayed fixtures are folded in', () => {
  const matches = [
    // Already in the published figures — must not be counted a second time.
    done(1, 1, 2, { team: 1, runs: 150, overs: 20 }, { team: 2, runs: 140, overs: 20 }, 1, 'runs', 10),
    { id: 2, home: 1, away: 3, status: 'upcoming' },
  ];
  const seeded = buildTable(TEAMS, matches, RULES, baselineFromPublished(PUBLISHED, TEAMS));
  assert.equal(seeded[1].played, 4, 'the completed match is already in the baseline');
  assert.equal(seeded[1].points, 4);
  assert.equal(seeded[1].runsFor, 600);

  // The same fixtures with no baseline are scored from scratch, as before.
  const scratch = buildTable(TEAMS, matches, RULES);
  assert.equal(scratch[1].played, 1);
  assert.equal(scratch[1].points, 2);
  assert.equal(scratch[1].runsFor, 150);
});

test('a simulated result lands on top of the published figures', () => {
  const matches = [
    done(1, 1, 2, { team: 1, runs: 150, overs: 20 }, { team: 2, runs: 140, overs: 20 }, 1, 'runs', 10),
    { id: 2, home: 1, away: 3, status: 'upcoming' },
  ];
  const baseline = baselineFromPublished(PUBLISHED, TEAMS);
  const ctx = prepare(TEAMS, matches, RULES, baseline);
  assert.equal(ctx.remaining.length, 1);
  const alpha = ctx.ids.indexOf(1);
  assert.equal(ctx.base.points[alpha], 4, 'every trial starts from the published points');
  assert.equal(ctx.base.runsFor[alpha], 600);
});

test('certainties are computed from the published points, penalties and all', () => {
  const matches = [{ id: 2, home: 1, away: 3, status: 'upcoming' }];
  const baseline = baselineFromPublished(PUBLISHED, TEAMS);
  const rules = { ...RULES, promotion_spots: 1, relegation_spots: 1, playoff_spots: 2 };
  const cert = certificates(1, TEAMS, matches, rules, baseline);
  // Alpha on 4 with one to play can reach 6; Charlie on 5 can reach 5 without
  // playing again, so Alpha is not yet guaranteed anything but is not out.
  assert.equal(cert.promotion.eliminated, false);
  assert.equal(cert.promotion.clinched, false);
  // Read without the baseline the same call would start Alpha from nought and
  // give a different answer entirely — which is the bug this pins down.
  assert.notDeepEqual(cert, certificates(1, TEAMS, matches, rules));
});

test('an innings carries its own overs quota when the fixture sets one', () => {
  const eighteen = { runs: 80, overs: 12.3, allOut: true, quotaOvers: 18 };
  assert.equal(countingBalls(eighteen, RULES), 108, 'all out charges 18, not the rules 20');
  const chased = { runs: 81, overs: 12.3, allOut: false, quotaOvers: 18 };
  assert.equal(countingBalls(chased, RULES), 75, '12.3 overs is 75 balls');
  // No quota on the innings — fall back to the tournament rules, as before.
  assert.equal(countingBalls({ runs: 80, overs: 12.3, allOut: true }, RULES), 120);
});

/* ------------------------------------------------------------------ *
 * Ties and washouts in the games still to come.
 * ------------------------------------------------------------------ */

test('the points system is read off the published points column', () => {
  const rows = [
    { won: 3, lost: 1, tied: 0, noResult: 0, points: 6 },
    { won: 2, lost: 1, tied: 1, noResult: 0, points: 5 },
    { won: 1, lost: 2, tied: 0, noResult: 1, points: 3 },
    { won: 0, lost: 3, tied: 1, noResult: 0, points: 1 },
    // A penalised row: no system explains it, and it must not derail the rest.
    { won: 2, lost: 2, tied: 0, noResult: 0, points: 2 },
  ];
  const got = inferPointsSystem(rows);
  assert.equal(got.source, 'cricheroes');
  assert.deepEqual(got.points, { points_win: 2, points_tie: 1, points_no_result: 1, points_loss: 0 });
  assert.equal(got.matched, 4);
  assert.ok(got.derived.points_tie && got.derived.points_no_result);

  // A different league's system is found, not assumed.
  const fours = [
    { won: 2, lost: 0, tied: 0, noResult: 1, points: 10 },
    { won: 1, lost: 1, tied: 1, noResult: 0, points: 6 },
    { won: 0, lost: 2, tied: 0, noResult: 1, points: 2 },
  ];
  assert.deepEqual(inferPointsSystem(fours).points,
    { points_win: 4, points_tie: 2, points_no_result: 2, points_loss: 0 });
});

test('a points value the table cannot pin down keeps the configured fallback', () => {
  // Nobody has tied, so the table says nothing about what a tie is worth.
  const rows = [
    { won: 3, lost: 1, tied: 0, noResult: 0, points: 6 },
    { won: 1, lost: 2, tied: 0, noResult: 1, points: 3 },
    { won: 0, lost: 4, tied: 0, noResult: 0, points: 0 },
  ];
  const got = inferPointsSystem(rows, { ...DEFAULT_RULES, points_tie: 1 });
  assert.equal(got.points.points_tie, 1);
  assert.equal(got.derived.points_tie, false);
  assert.equal(got.derived.points_win, true);
  // Too little to go on at all: everything stays configured.
  assert.equal(inferPointsSystem([]).source, 'config');
});

test('washout and tie rates blend the default with the division record', () => {
  const cfg = { enabled: true, abandonRate: 0.1, tieRate: 0.01, useDivisionHistory: true, priorMatches: 40 };
  const r = outcomeRates({ completed: 60, abandoned: 12, tied: 0 }, cfg);
  assert.ok(Math.abs(r.abandonRate - (12 + 4) / 100) < 1e-12);
  assert.ok(Math.abs(r.tieRate - 0.4 / 100) < 1e-12, 'no ties yet does not mean ties are impossible');
  assert.deepEqual(outcomeRates(null, { ...cfg, useDivisionHistory: false }),
    { abandonRate: 0.1, tieRate: 0.01, source: 'default' });
  assert.equal(outcomeRates({ completed: 10, abandoned: 5, tied: 0 }, { ...cfg, enabled: false }).abandonRate, 0);
});

test('with washouts and ties off, the simulation is the old win-or-lose one, draw for draw', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const ctx = prepare(TEAMS, blankSeason(TEAMS), rules);
  const a = simulate(ctx, { trials: 3000, model: 'coinflip', focusId: 1, seed: 9 });
  const b = simulate(ctx, { trials: 3000, model: 'coinflip', focusId: 1, seed: 9, abandonRate: 0, tieRate: 0 });
  assert.deepEqual(Array.from(a.posCounts), Array.from(b.posCounts));
  for (let m = 0; m < ctx.remaining.length; m++) {
    assert.equal(a.focus.swingCount[m * OUTCOMES + OUTCOME.TIE], 0);
    assert.equal(a.focus.swingCount[m * OUTCOMES + OUTCOME.ABANDONED], 0);
  }
});

test('remaining matches are tied and washed out at the configured rates', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const ctx = prepare(TEAMS, blankSeason(TEAMS), rules);
  const trials = 20000;
  const res = simulate(ctx, { trials, model: 'coinflip', focusId: 1, seed: 21, abandonRate: 0.2, tieRate: 0.05 });
  const f = res.focus;
  for (let m = 0; m < ctx.remaining.length; m++) {
    const c = (o) => f.swingCount[m * OUTCOMES + o] / trials;
    assert.ok(Math.abs(c(OUTCOME.ABANDONED) - 0.2) < 0.015, `washout rate ${c(OUTCOME.ABANDONED)}`);
    assert.ok(Math.abs(c(OUTCOME.TIE) - 0.05) < 0.01, `tie rate ${c(OUTCOME.TIE)}`);
    assert.ok(Math.abs(c(OUTCOME.HOME) - 0.375) < 0.02);
    const sum = [0, 1, 2, 3].reduce((s, o) => s + f.swingCount[m * OUTCOMES + o], 0);
    assert.equal(sum, trials, 'every match ends exactly one way per trial');
  }
  // The own-results split by wins and shared results adds back up.
  let total = 0;
  for (const v of f.ownMixCount) total += v;
  assert.equal(total, trials);
  const mix = ownMixBreakdown(res, 'playoff', { minTrials: 1 });
  assert.ok(mix.some((b) => b.shared === 3), 'all three washed out does come up');
  assert.ok(mix.every((b) => b.wins + b.shared + b.lost === 3));
});

test('a washed-out match shares the points and leaves net run rate alone', () => {
  // One game left; it can only be washed out.
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const matches = [
    done(1, 1, 2, { team: 1, runs: 160, overs: 20 }, { team: 2, runs: 140, overs: 20 }, 1, 'runs', 20),
    done(2, 3, 4, { team: 3, runs: 150, overs: 20 }, { team: 4, runs: 130, overs: 20 }, 3, 'runs', 20),
    { id: 3, home: 2, away: 4, status: 'upcoming' },
  ];
  const ctx = prepare(TEAMS, matches, rules);
  const res = simulate(ctx, { trials: 200, model: 'coinflip', focusId: 2, seed: 4, abandonRate: 0.5, tieRate: 0 });
  // Bravo (0 pts, NRR -1) and Delta (0 pts, NRR -1) share a point in a
  // washout, so the finishing order is the same as now in those trials.
  const f = res.focus;
  const washouts = f.swingCount[0 * OUTCOMES + OUTCOME.ABANDONED];
  assert.ok(washouts > 50 && washouts < 150);
  assert.equal(f.ownMixCount[0 * 2 + 1], washouts, 'Bravo: no win, one shared result');
});

test('a simulated tie gives both sides the tie points and level innings', () => {
  const rules = { ...RULES, points_tie: 1 };
  const matches = [{ id: 1, home: 1, away: 2, status: 'upcoming' }];
  const two = TEAMS.slice(0, 2);
  const ctx = prepare(two, matches, rules);
  const res = simulate(ctx, { trials: 2000, model: 'coinflip', focusId: 1, seed: 2, tieRate: 0.5 });
  const ties = res.focus.swingCount[OUTCOME.TIE];
  // Alpha's own results: every tie is a shared result, never a win.
  assert.equal(res.focus.ownMixCount[0 * 2 + 1], ties);
  assert.ok(ties > 800 && ties < 1200, `ties: ${ties}`);
  // In a tie the two are level on points and run rate, so it falls to the
  // final deterministic order; in a win the winner is first. Either way each
  // team holds exactly one place per trial.
  for (let i = 0; i < 2; i++) {
    assert.equal(res.posCounts[i * 2] + res.posCounts[i * 2 + 1], 2000);
  }
});

test('the key fixtures report what a washout does, as well as a win or a loss', () => {
  const rules = { ...RULES, playoff_spots: 2, promotion_spots: 1, relegation_spots: 1 };
  const ctx = prepare(TEAMS, blankSeason(TEAMS), rules);
  const res = simulate(ctx, { trials: 30000, model: 'coinflip', focusId: 1, seed: 8, abandonRate: 0.15, tieRate: 0.02 });
  const k = keyFixtures(ctx, res, 'playoff', { givenSweep: false });
  assert.ok(k.fixtures.length > 0);
  for (const f of k.fixtures) {
    assert.ok(f.pIfShared != null, 'enough washouts to report on');
    assert.ok(f.pIfShared >= 0 && f.pIfShared <= 1);
    assert.ok(f.pIfNeeded >= f.pIfNot);
  }
  // With nothing shared simulated, there is nothing to report.
  const off = simulate(ctx, { trials: 5000, model: 'coinflip', focusId: 1, seed: 8 });
  for (const f of keyFixtures(ctx, off, 'playoff', { givenSweep: false }).fixtures) {
    assert.equal(f.pIfShared, null);
  }
});

test('points bounds stay honest whatever a tie or washout is worth', () => {
  const matches = [{ id: 1, home: 1, away: 2, status: 'upcoming' }];
  const odd = { ...RULES, points_win: 2, points_tie: 3, points_no_result: 1, points_loss: 0 };
  const b = pointsBounds(TEAMS, matches, odd);
  assert.equal(b[1].max, 3, 'a tie worth more than a win raises the ceiling');
  assert.equal(b[1].min, 0);
  assert.equal(pointsBounds(TEAMS, matches, RULES)[1].max, 2);
});
