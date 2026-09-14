/**
 * snapshot-index.mjs — maintain assets/data/<id>/index.json.
 *
 * The division list page needs to know, without downloading nine snapshots,
 * which divisions have data and whether that data is real or placeholder. This
 * writes the small index it reads.
 *
 * Entries are *merged*, not replaced: refreshing one division must not erase
 * what is known about the other eight.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeIndex(dataDir, tournamentId, entries) {
  const file = path.join(dataDir, 'index.json');

  let existing = [];
  try {
    const prev = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(prev.divisions)) existing = prev.divisions;
  } catch {
    // No index yet, or it is unreadable — start clean.
  }

  const merged = new Map(existing.map((d) => [d.division, d]));
  for (const e of entries) merged.set(e.division, e);

  const body = {
    tournament_id: tournamentId,
    updated_at: new Date().toISOString(),
    divisions: [...merged.values()].sort((a, b) => a.division - b.division),
  };
  await writeFile(file, JSON.stringify(body, null, 1));
  return body;
}
