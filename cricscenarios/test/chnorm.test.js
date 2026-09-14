/**
 * Tests for the CricHeroes payload normaliser.
 *
 * The payloads below are reconstructions of the shapes CricHeroes endpoints
 * return, not captures — this project was built without network access to the
 * API. They exist to pin the *behaviour we rely on*: find the fixture list
 * wherever it is nested, read scores out of summary strings, get the all-out
 * flag right, and never invent a result that was not in the payload.
 *
 * When a real payload is captured (tools/fetch-tournament.mjs writes one to
 * assets/data/<id>/raw/), add it here as a case rather than replacing these.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSummary, parseResultText, normaliseStatus, normaliseMatches,
  normaliseTeams, normalisePointsTable, findRecords, synthId, buildSnapshot,
} from '../assets/js/chnorm.js';
import { buildTable, netRunRate, DEFAULT_RULES } from '../assets/js/engine.js';

test('innings summary strings parse in every format seen', () => {
  assert.deepEqual(parseSummary('165/6 (20)'),
    { runs: 165, wickets: 6, overs: 20, allOut: false });
  assert.deepEqual(parseSummary('165/6 (19.3 Ov)'),
    { runs: 165, wickets: 6, overs: 19.3, allOut: false });
  assert.deepEqual(parseSummary('88/10 (14.2)'),
    { runs: 88, wickets: 10, overs: 14.2, allOut: true });
  // No wicket count and no overs in the string — the overs hint fills in.
  assert.deepEqual(parseSummary('142', 20),
    { runs: 142, wickets: null, overs: 20, allOut: false });
  assert.equal(parseSummary(null), null);
});

test('result text yields margin and type', () => {
  assert.deepEqual(parseResultText('Alpha won by 23 runs'), { type: 'runs', margin: 23 });
  assert.deepEqual(parseResultText('Bravo won by 5 wickets'), { type: 'wickets', margin: 5 });
  assert.deepEqual(parseResultText('Match tied'), { type: 'tie', margin: 0 });
  assert.deepEqual(parseResultText('Match abandoned due to rain'),
    { type: 'no_result', margin: null });
  assert.deepEqual(parseResultText('Match yet to begin'), { type: null, margin: null });
});

test('match status is read from the status field or the result text', () => {
  assert.equal(normaliseStatus('completed'), 'completed');
  assert.equal(normaliseStatus(3), 'completed');
  assert.equal(normaliseStatus('upcoming'), 'upcoming');
  assert.equal(normaliseStatus(null, 'Alpha won by 12 runs'), 'completed');
  assert.equal(normaliseStatus('live'), 'live');
  assert.equal(normaliseStatus('completed', 'Match abandoned'), 'abandoned');
});

test('the fixture list is found however deeply it is nested', () => {
  const payload = {
    status: true,
    data: { page: 1, result: { matches: [
      { match_id: 1, team_a_id: 10, team_b_id: 11, team_a: 'A', team_b: 'B' },
      { match_id: 2, team_a_id: 10, team_b_id: 12, team_a: 'A', team_b: 'C' },
    ] } },
  };
  const found = findRecords(payload, (o) => o && o.match_id != null);
  assert.equal(found.length, 2);
  assert.equal(found[0].match_id, 1);
});

/** A reconstruction of a tournament match-list response. */
const MATCH_PAYLOAD = {
  status: true,
  data: [
    {
      match_id: 9001, match_status: 'completed',
      team_a_id: 501, team_a: 'Guts N Glory', team_a_summary: '178/4 (20 Ov)',
      team_b_id: 502, team_b: 'Jaguars', team_b_summary: '155/9 (20 Ov)',
      winning_team_id: 501, match_result: 'Guts N Glory won by 23 runs',
      match_start_time: '2026-08-02T14:00:00Z', ground_name: 'Cary Ground 1',
    },
    {
      match_id: 9002, match_status: 'completed',
      team_a_id: 503, team_a: 'Dothraki', team_a_summary: '140/8 (20 Ov)',
      team_b_id: 501, team_b: 'Guts N Glory', team_b_summary: '141/4 (18.2 Ov)',
      winning_team_id: 501, match_result: 'Guts N Glory won by 6 wickets',
      match_start_time: '2026-08-09T14:00:00Z',
    },
    {
      match_id: 9003, match_status: 'completed',
      team_a_id: 502, team_a: 'Jaguars', team_a_summary: '96/10 (13.4 Ov)',
      team_b_id: 503, team_b: 'Dothraki', team_b_summary: '97/2 (11.1 Ov)',
      winning_team_id: 503, match_result: 'Dothraki won by 8 wickets',
    },
    {
      match_id: 9004, match_status: 'upcoming',
      team_a_id: 501, team_a: 'Guts N Glory',
      team_b_id: 503, team_b: 'Dothraki',
      match_start_time: '2026-09-20T14:00:00Z',
    },
  ],
};

test('a tournament match list normalises into the project schema', () => {
  const { matches, teams } = normaliseMatches(MATCH_PAYLOAD);
  assert.equal(matches.length, 4);
  assert.equal(teams.length, 3);

  const m1 = matches.find((m) => m.id === 9001);
  assert.equal(m1.status, 'completed');
  assert.equal(m1.result.winner, 501);
  assert.equal(m1.result.type, 'runs');
  assert.equal(m1.result.margin, 23);
  // Won by runs, so Guts N Glory batted first.
  assert.equal(m1.result.innings[0].team, 501);
  assert.equal(m1.result.innings[0].runs, 178);
  assert.equal(m1.result.innings[1].runs, 155);

  const m2 = matches.find((m) => m.id === 9002);
  // Won by wickets, so the winner batted second regardless of listing order.
  assert.equal(m2.result.innings[0].team, 503);
  assert.equal(m2.result.innings[1].team, 501);
  assert.equal(m2.result.innings[1].overs, 18.2);

  const m3 = matches.find((m) => m.id === 9003);
  assert.equal(m3.result.innings[0].allOut, true, '96/10 is all out');

  const up = matches.find((m) => m.id === 9004);
  assert.equal(up.status, 'upcoming');
  assert.equal(up.result, undefined);
});

test('normalised matches feed the table maths correctly end to end', () => {
  const { matches, teams } = normaliseMatches(MATCH_PAYLOAD);
  const rows = buildTable(teams, matches, DEFAULT_RULES);

  // Guts N Glory: two wins from two.
  assert.equal(rows[501].points, 4);
  assert.equal(rows[501].played, 2);
  // Runs for: 178 (20 ov) + 141 (18.2 ov = 110 balls)
  assert.equal(rows[501].runsFor, 178 + 141);
  assert.equal(rows[501].ballsFor, 120 + 110);
  // Against: 155 in 20, and Dothraki's 140 in 20.
  assert.equal(rows[501].runsAgainst, 155 + 140);
  assert.equal(rows[501].ballsAgainst, 240);

  // Jaguars were bowled out for 96 in 13.4 — charged the full 20 overs.
  assert.equal(rows[502].ballsFor, 120 + 120);
  assert.ok(netRunRate(rows[502]) < 0);
  assert.ok(netRunRate(rows[501]) > 0);
});

test('an abandoned match becomes a no-result that leaves run rate alone', () => {
  const { matches, teams } = normaliseMatches({
    data: [{
      match_id: 9101, match_status: 'completed',
      team_a_id: 1, team_a: 'A', team_b_id: 2, team_b: 'B',
      match_result: 'Match abandoned without a ball bowled',
    }],
  });
  const rows = buildTable(teams, matches, DEFAULT_RULES);
  assert.equal(matches[0].result.type, 'no_result');
  assert.equal(rows[1].points, 1);
  assert.equal(rows[1].ballsFor, 0);
});

test('a completed match with no scores keeps its points but not its run rate', () => {
  const { matches, teams } = normaliseMatches({
    data: [{
      match_id: 9102, match_status: 'completed',
      team_a_id: 1, team_a: 'A', team_b_id: 2, team_b: 'B',
      winning_team_id: 1, match_result: 'A won by 10 runs',
    }],
  });
  assert.equal(matches[0].result.incomplete, true);
  assert.equal(matches[0].result.innings.length, 0);
  const rows = buildTable(teams, matches, DEFAULT_RULES);
  assert.equal(rows[1].points, 2);
  assert.equal(rows[1].ballsFor, 0, 'no invented runs');
});

test('payloads without team ids still join up, via stable synthetic ids', () => {
  const { matches, teams } = normaliseMatches({
    data: [
      { match_id: 1, team_a: 'Blue Waves', team_b: 'R3', match_result: 'Blue Waves won by 4 runs',
        match_status: 'completed', team_a_summary: '150/7 (20)', team_b_summary: '146/8 (20)' },
      { match_id: 2, team_a: 'R3', team_b: 'Blue Waves', match_status: 'upcoming' },
    ],
  });
  assert.equal(teams.length, 2, 'the same name must map to the same team');
  assert.equal(matches[0].home, matches[1].away);
  assert.equal(synthId('Blue Waves'), synthId('Blue Waves'));
  assert.notEqual(synthId('Blue Waves'), synthId('R3'));
});

test('team and points-table payloads normalise', () => {
  const teams = normaliseTeams({
    data: { teams: [
      { team_id: 501, team_name: 'Guts N Glory', short_name: 'GNG', team_logo: 'x.png' },
      { team_id: 502, team_name: 'Jaguars' },
    ] },
  });
  assert.equal(teams.length, 2);
  assert.equal(teams[0].short, 'GNG');

  const table = normalisePointsTable({
    data: { groups: [{ teams: [
      { team_id: 501, team_name: 'Guts N Glory', matches: 6, win: 5, loss: 1, points: 10, nrr: 1.234 },
      { team_id: 502, team_name: 'Jaguars', matches: 6, win: 2, loss: 4, points: 4, nrr: -0.567 },
    ] }] },
  });
  assert.equal(table.length, 2);
  assert.equal(table[0].points, 10);
  assert.equal(table[1].nrr, -0.567);
});

test('buildSnapshot merges declared team names over the ones seen in fixtures', () => {
  const snap = buildSnapshot({
    matchesRaw: MATCH_PAYLOAD,
    teamsRaw: { data: [{ team_id: 501, team_name: 'Guts N Glory', short_name: 'GNG' }] },
    pointsRaw: null,
  });
  const gng = snap.teams.find((t) => t.id === 501);
  assert.equal(gng.short, 'GNG');
  assert.equal(snap.matches.length, 4);
  assert.equal(snap.published.length, 0);
});
