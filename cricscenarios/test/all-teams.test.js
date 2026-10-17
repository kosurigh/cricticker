/**
 * Every team in every division, through the same code the page runs: the
 * simulation with washouts and ties on, the report, and the card markup.
 * tools/check-all-teams.mjs holds the checks; this runs them at a lighter
 * trial count so the suite stays quick.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAll } from '../tools/check-all-teams.mjs';

test('the scenarios hold up for all 126 teams, washouts and ties included', async () => {
  const res = await checkAll({ trials: 20000 });
  assert.equal(res.length, 9, 'nine divisions');
  assert.equal(res.reduce((a, d) => a + d.teams, 0), 126, 'every team checked');
  for (const d of res) {
    assert.ok(d.rates.abandonRate > 0 && d.rates.tieRate > 0, `division ${d.division} simulates washouts and ties`);
    assert.deepEqual(d.problems, [], `division ${d.division}`);
  }
});
