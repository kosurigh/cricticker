/**
 * The division-list page decides what to show from index.json, so a refresh of
 * one division must not erase what is known about the others.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeIndex } from '../tools/snapshot-index.mjs';

test('writing one division merges into the existing index', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cricidx-'));

  await writeIndex(dir, 2100677, [
    { division: 1, teams: 14, remaining: 15, source: 'placeholder', placeholder: true },
    { division: 7, teams: 14, remaining: 18, source: 'placeholder', placeholder: true },
  ]);

  // A real fetch of division 7 only.
  await writeIndex(dir, 2100677, [
    { division: 7, teams: 14, remaining: 2, source: 'cricheroes', placeholder: false },
  ]);

  const body = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(body.divisions.length, 2, 'division 1 must survive');
  const d1 = body.divisions.find((d) => d.division === 1);
  const d7 = body.divisions.find((d) => d.division === 7);
  assert.equal(d1.placeholder, true, 'untouched division keeps its old state');
  assert.equal(d7.placeholder, false, 'refreshed division is updated');
  assert.equal(d7.source, 'cricheroes');
  assert.equal(d7.remaining, 2);
  assert.deepEqual(body.divisions.map((d) => d.division), [1, 7], 'sorted by division');
});

test('a corrupt index is replaced rather than throwing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cricidx-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'index.json'), 'not json at all');
  const body = await writeIndex(dir, 1, [{ division: 3, teams: 8 }]);
  assert.equal(body.divisions.length, 1);
});
