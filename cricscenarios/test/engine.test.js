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
  baselineFromPublished,
} from '../assets/js/engine.js';
import {
  prepare, simulate, bradleyTerry, matchShapes, winProbability,
} from '../assets/js/simulate.js';
import {
  nrrAfterWins, requiredMargin, summarise, goalState, ownResultsBreakdown,
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
