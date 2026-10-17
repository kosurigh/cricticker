/**
 * The division list's "N games to play" must be the same count the division
 * page works from. It is computed from the published points table (half the
 * division's appearances) against the division's fixture total; this checks
 * that against the fixture list in every committed snapshot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { divisionProgress, progressLabel } from '../assets/js/overview.js';
import { normalisePointsTable } from '../assets/js/chnorm.js';
import { prepare } from '../assets/js/simulate.js';
import { hydrate } from '../assets/js/data.js';

const at = (p) => new URL(`../assets/data/${p}`, import.meta.url);
const json = (p) => JSON.parse(readFileSync(at(p), 'utf8'));

test('division-list counts agree with each division page, all nine divisions', () => {
  const index = json('2100677/index.json');
  const map = json('divisions.json')['2100677'];
  const published = normalisePointsTable(json('2100677/raw/points.json'));
  const totals = new Map(index.divisions.map((d) => [d.division, d.matches]));
  const progress = divisionProgress(published, map, totals);
  for (const d of index.divisions) {
    const data = hydrate(json(`2100677/division-${d.division}.json`));
    // What the division page counts: fixtures not yet completed.
    const ctx = prepare(data.teams, data.matches, data.rules, data.baseline);
    const p = progress.get(d.division);
    assert.equal(p.remaining, ctx.remaining.length, `division ${d.division}: remaining`);
    assert.equal(p.played, data.matches.filter((m) => m.status === 'completed').length, `division ${d.division}: played`);
    assert.equal(p.total, data.matches.length, `division ${d.division}: total`);
    // And the committed index says the same.
    assert.equal(d.remaining, ctx.remaining.length, `division ${d.division}: index.json`);
  }
});

test('the card says complete when nothing is left, and counts otherwise', () => {
  assert.equal(progressLabel({ played: 91, total: 91, remaining: 0 }), 'Complete · all 91 played');
  assert.equal(progressLabel({ played: 85, total: 91, remaining: 6 }), '6 games to play · 85 of 91 played');
  assert.equal(progressLabel({ played: 90, total: 91, remaining: 1 }), '1 game to play · 90 of 91 played');
  assert.equal(progressLabel(null), null);
});

test('a division the table does not cover reports no count rather than a wrong one', () => {
  const map = { byId: { 1: 1, 2: 1, 3: 2 }, byName: {} };
  const pub = [
    { teamId: 1, name: 'A', played: 3 }, { teamId: 2, name: 'B', played: 3 },
  ];
  const p = divisionProgress(pub, map, new Map([[1, 4], [2, 2]]));
  assert.deepEqual(p.get(1), { teams: 2, played: 3, total: 4, remaining: 1, complete: false });
  assert.equal(p.get(2).remaining, null);
});
