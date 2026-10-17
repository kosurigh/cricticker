#!/usr/bin/env node
/**
 * check-all-teams.mjs — run the scenarios for every team in every division and
 * check what the page would say about each.
 *
 *   node tools/check-all-teams.mjs            (200,000 simulations, like the page)
 *   node tools/check-all-teams.mjs --trials 20000
 *
 * Reads the committed snapshots (refresh them first with fetch-tournament.mjs
 * to check live data), simulates in the page's default mode — form-weighted,
 * washouts and ties included — and renders each team's report with the same
 * code the page uses. Exits non-zero if any check fails.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hydrate } from '../assets/js/data.js';
import { prepare, createRun, outcomeRates } from '../assets/js/simulate.js';
import { summarise, buildReport } from '../assets/js/scenarios.js';
import { goalCard } from '../assets/js/report-view.js';
import { SHARED_OUTCOMES } from '../assets/js/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOALS = ['promotion', 'playoff', 'relegation'];
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

export async function loadDivision(tid, d) {
  const file = path.join(here, '..', 'assets', 'data', String(tid), `division-${d}.json`);
  return hydrate(JSON.parse(await readFile(file, 'utf8')));
}

/** Every check for one team; returns a list of problems (empty = fine). */
export function checkTeam(data, ctx, results, summary, team) {
  const problems = [];
  const bad = (msg) => problems.push(`${team.name}: ${msg}`);
  const row = summary.find((s) => s.team.id === team.id);
  const games = row.remaining;
  const sharedOn = results.abandonRate + results.tieRate > 0;

  for (const goal of GOALS) {
    const rep = buildReport(ctx, results, summary, team.id, goal);
    const p = row.p[goal];
    if (!(p >= 0 && p <= 1)) bad(`${goal} probability ${p} out of range`);
    if (!(rep.probability >= 0 && rep.probability <= 1)) bad(`${goal} headline ${rep.probability} out of range`);
    // Proof and sample must agree: a proved outcome happens in every trial,
    // an impossible one in none.
    const c = row.certainty;
    const proved = goal === 'relegation' ? c.relegation.doomed : c[goal].clinched;
    const ruled = goal === 'relegation' ? c.relegation.safe : c[goal].eliminated;
    if (proved && p !== 1) bad(`${goal} proved certain but simulated ${p}`);
    if (ruled && p !== 0) bad(`${goal} proved impossible but simulated ${p}`);

    // Own-games split: one row per (won, shared, lost) that adds up to the games left.
    let mixTrials = 0;
    for (const v of results.focus.ownMixCount) mixTrials += v;
    if (mixTrials !== results.trials) bad(`own-results split covers ${mixTrials} of ${results.trials} trials`);
    for (const b of rep.mix) {
      if (b.wins + b.shared + b.lost !== games) bad(`own-results combo ${JSON.stringify(b)} does not add to ${games}`);
    }

    const html = goalCard(rep, data.rules);
    const t = text(html);
    if (/undefined|NaN|null/.test(t)) bad(`${goal} card contains undefined/NaN/null: ${t.slice(0, 160)}`);
    if (/win all [01]\b|winning all [01]\b|all 0\b|1 games\b/i.test(t)) bad(`${goal} card wording: ${t.match(/.{0,40}(win all [01]|winning all [01]|all 0|1 games).{0,40}/i)[0]}`);

    const said = t.match(/(\d+(?:\.\d)?)% of the time — likely/);
    if (said && Number(said[1]) < 50) bad(`${goal}: calls ${said[1]}% "likely"`);

    if (rep.state === 'live') {
      if (games === 0 && /Your own/.test(t)) bad(`${goal}: own-games line shown with no games left`);
      if (games > 0 && !t.includes(`Your own ${games} game${games === 1 ? '' : 's'}:`)) {
        // Only expected when the sample saw the team's combinations at all.
        if (rep.mix.length) bad(`${goal}: missing "Your own ${games} game(s)" line`);
      }
      if (games > 0 && sharedOn && rep.mix.length && !/washed out/.test(t)) bad(`${goal}: own-games line has no washout combination`);
      if (/results that matter most/.test(t)) {
        const lead = games === 0 ? 'With no games of your own left'
          : (games === 1 ? 'Assuming you win your last game' : (games === 2 ? 'Assuming you win both' : `Assuming you win all ${games}`));
        if (!t.includes(lead)) bad(`${goal}: expected "${lead}" in the key-results lead`);
        const lines = (html.match(/to beat/g) || []).length;
        const washed = (html.match(/if washed out or tied/g) || []).length;
        if (sharedOn && washed !== lines) bad(`${goal}: ${lines - washed} of ${lines} key results lack the washout figure`);
      }
    }
  }
  return problems;
}

/** Run every team of every division. */
export async function checkAll({ tid = '2100677', trials = 200000, divisions = null, model = 'form' } = {}) {
  const meta = JSON.parse(await readFile(path.join(here, '..', 'assets', 'data', tid, 'meta.json'), 'utf8'));
  const out = [];
  for (const d of divisions || meta.divisions) {
    const data = await loadDivision(tid, d);
    const ctx = prepare(data.teams, data.matches, data.rules, data.baseline);
    const rates = outcomeRates(ctx.history, SHARED_OUTCOMES);
    const div = { division: d, teams: data.teams.length, remainingFixtures: ctx.remaining.length, rates, problems: [], rows: [] };
    // Probabilities across the division must fill exactly the places on offer.
    let firstSummary = null;
    for (const team of data.teams) {
      const run = createRun(ctx, { trials, model, focusId: team.id, seed: 0x5eed, ...rates });
      run.step(trials);
      const summary = summarise(ctx, run.results);
      firstSummary = firstSummary || summary;
      div.problems.push(...checkTeam(data, ctx, run.results, summary, team));
      const r = summary.find((s) => s.team.id === team.id);
      div.rows.push({ team: team.name, points: r.row.points, left: r.remaining, ...r.p });
    }
    const n = data.teams.length;
    const sum = (k) => firstSummary.reduce((a, s) => a + s.p[k], 0);
    const expect = { playoff: data.rules.playoff_spots, promotion: data.rules.promotion_spots, relegation: data.rules.relegation_spots };
    for (const k of Object.keys(expect)) {
      if (Math.abs(sum(k) - Math.min(expect[k], n)) > 1e-6) div.problems.push(`${k} probabilities sum to ${sum(k)}, not ${expect[k]}`);
    }
    out.push(div);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--trials');
  const trials = i > 0 ? Number(process.argv[i + 1]) : 200000;
  const res = await checkAll({ trials });
  let problems = 0, teams = 0;
  const f = (x) => (x * 100).toFixed(1).padStart(5);
  for (const d of res) {
    teams += d.teams;
    problems += d.problems.length;
    console.log(`\nDivision ${d.division}: ${d.teams} teams checked, ${d.remainingFixtures} fixtures left, ` +
      `washout ${(d.rates.abandonRate * 100).toFixed(1)}% / tie ${(d.rates.tieRate * 100).toFixed(1)}% — ` +
      `${d.problems.length ? `${d.problems.length} PROBLEM(S)` : 'all checks pass'}`);
    for (const r of d.rows.filter((x) => x.left > 0)) {
      console.log(`   ${r.team.padEnd(30)} ${String(r.points).padStart(3)} pts  ${r.left} left  ` +
        `playoff ${f(r.playoff)}%  promo ${f(r.promotion)}%  releg ${f(r.relegation)}%`);
    }
    d.problems.forEach((p) => console.log(`   ! ${p}`));
  }
  console.log(`\n${teams} teams checked, ${problems} problem(s).`);
  process.exit(problems ? 1 : 0);
}
