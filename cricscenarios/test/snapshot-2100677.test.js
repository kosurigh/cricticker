/**
 * The committed snapshots, checked against the numbers CricHeroes publishes.
 *
 *   node --test test/snapshot-2100677.test.js
 *
 * Unlike the other suites these run over real, committed data, and they are
 * the ones that would catch a CricHeroes field rename: every other test works
 * from payloads written by hand, so a parser that has quietly stopped reading
 * scores still passes them. Here a snapshot whose results no longer parse
 * cannot agree with the published table, and the suite says so.
 *
 * They are deliberately written against invariants rather than fixed figures,
 * so a refresh mid-season does not turn them red: the table this project shows
 * must match the published one row for row, the fixture list must be complete
 * and internally consistent, and nothing may be left marked as sample data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { hydrate } from '../assets/js/data.js';
import { netRunRate, standingsFor } from '../assets/js/engine.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.join(ROOT, 'assets', 'data', '2100677');
const read = (f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));

const meta = read('meta.json');
const index = read('index.json');
const divisions = meta.divisions.map((d) => hydrate(read(`division-${d}.json`)));

test('every division listed in the meta has a snapshot with teams and fixtures', () => {
  assert.equal(divisions.length, 9);
  for (const d of divisions) {
    assert.ok(d.teams.length >= 10, `division ${d.division} has ${d.teams.length} teams`);
    assert.ok(d.matches.length > 0, `division ${d.division} has no fixtures`);
    // Every fixture is between two teams of this division, both named.
    for (const m of d.matches) {
      assert.ok(d.teams.some((t) => t.id === m.home), `unknown home team in ${m.id}`);
      assert.ok(d.teams.some((t) => t.id === m.away), `unknown away team in ${m.id}`);
    }
    assert.ok(d.teams.every((t) => t.name && !/^Team \d+$/.test(t.name)),
      `division ${d.division} has unnamed teams`);
  }
});

test('the snapshots hold real results, not empty fixtures', () => {
  for (const d of divisions) {
    const played = d.matches.filter((m) => m.status === 'completed');
    assert.ok(played.length > 0, `division ${d.division} has no completed matches`);
    // A completed match either carries an innings pair or is a no-result; what
    // must not happen is a whole division of results that failed to parse.
    const scored = played.filter((m) => (m.result?.innings || []).length >= 2);
    assert.ok(scored.length > played.length / 2,
      `division ${d.division}: only ${scored.length} of ${played.length} results have scores`);
    assert.ok(d.matches.some((m) => m.status !== 'completed'),
      `division ${d.division} has nothing left to play, so nothing to project`);
  }
});

test('the table this project shows matches the published one, row for row', () => {
  for (const d of divisions) {
    assert.ok(d.published.length, `division ${d.division} has no published table to check`);
    assert.ok(d.baseline, `division ${d.division} did not seed from the published table`);
    const byId = new Map(d.published.map((p) => [p.teamId, p]));
    for (const row of d.standings) {
      const pub = byId.get(row.teamId);
      const who = `division ${d.division}, team ${row.teamId}`;
      assert.ok(pub, `${who} is missing from the published table`);
      assert.equal(row.points, pub.points, `${who}: points`);
      assert.equal(row.played, pub.played, `${who}: matches played`);
      assert.equal(row.won, pub.won, `${who}: wins`);
      assert.ok(Math.abs(netRunRate(row) - pub.nrr) < 0.0005,
        `${who}: NRR ${netRunRate(row).toFixed(4)} vs published ${pub.nrr}`);
    }
  }
});

test('the fixture list agrees with the win/loss record CricHeroes publishes', () => {
  // The published table is seeded in, so this is the independent check on it:
  // the fixtures we hold must account for the same matches, won by the same
  // sides. Points may legitimately differ — organisers apply penalties that no
  // endpoint exposes — but a win that is not in the fixture list is a parse bug.
  for (const d of divisions) {
    const own = new Map(standingsFor(d.teams, d.matches, d.rules).map((r) => [r.teamId, r]));
    for (const pub of d.published) {
      const r = own.get(pub.teamId);
      const who = `division ${d.division}, ${pub.name}`;
      assert.equal(r.played, pub.played, `${who}: played`);
      assert.equal(r.won, pub.won, `${who}: won`);
      assert.equal(r.lost, pub.lost, `${who}: lost`);
      assert.equal(r.noResult, pub.noResult, `${who}: no results`);
    }
  }
});

test('nothing is left marked as sample data', () => {
  assert.equal(index.divisions.length, 9);
  for (const d of index.divisions) {
    assert.equal(d.placeholder, false, `division ${d.division} is still placeholder data`);
    assert.equal(d.source, 'cricheroes', `division ${d.division} is not sourced from CricHeroes`);
    assert.ok(d.played > 0 && d.remaining > 0);
  }
  for (const d of divisions) {
    assert.equal(d.source, 'cricheroes');
    assert.ok(!d.placeholder && !d.placeholder_note);
  }
});

test('the division map covers every team in every snapshot', () => {
  const mapPath = path.join(ROOT, 'assets', 'data', 'divisions.json');
  assert.ok(existsSync(mapPath));
  const map = JSON.parse(readFileSync(mapPath, 'utf8'))['2100677'];
  for (const d of divisions) {
    for (const t of d.teams) {
      assert.equal(map.byId[String(t.id)], d.division,
        `${t.name} (${t.id}) is not mapped to division ${d.division}`);
    }
  }
});

test('the rules recorded for the tournament are the ones in play', () => {
  // Every remaining fixture is an 18-over game, so that is what the margin
  // advice and the fallback run-rate maths must assume.
  const upcoming = divisions.flatMap((d) => d.matches.filter((m) => m.status !== 'completed'));
  const overs = new Set(upcoming.map((m) => m.overs).filter((o) => o != null));
  assert.deepEqual([...overs], [meta.rules.overs_per_innings]);
  assert.deepEqual(meta.rules.tiebreak, ['points', 'nrr', 'h2h', 'wins']);
});

test('the published order is consistent with points then net run rate', () => {
  // Nothing in this tournament reaches the third tie-break key, so this is as
  // far as the ordering can be verified against live data — see meta.json.
  let level = 0;
  for (const d of divisions) {
    const pub = d.published;
    for (let i = 0; i < pub.length - 1; i++) {
      assert.ok(pub[i].points >= pub[i + 1].points,
        `division ${d.division}: published points ascend at row ${i + 1}`);
      if (pub[i].points !== pub[i + 1].points) continue;
      level++;
      assert.ok(pub[i].nrr > pub[i + 1].nrr,
        `division ${d.division}: ${pub[i].name} placed above ${pub[i + 1].name} against NRR`);
    }
  }
  assert.ok(level > 20, `only ${level} pairs level on points — too few to conclude anything`);
});
