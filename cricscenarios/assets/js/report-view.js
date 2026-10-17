/**
 * report-view.js — the "what has to happen" cards, as HTML.
 *
 * Pure: takes a report from scenarios.buildReport() and the tournament rules
 * and returns markup, touching no page state. That is what lets
 * tools/check-all-teams.mjs (and the tests) render the report for every team
 * in every division and check the wording, not just the numbers.
 */

import { esc, pct, signed } from './ui.js';
import { GOALS } from './scenarios.js';

/** "win all 3", "win both", "win your last game" — and nothing silly for 0. */
export function winAll(games) {
  if (games === 1) return 'win your last game';
  if (games === 2) return 'win both';
  return `win all ${games}`;
}
export function winningAll(games) {
  if (games === 1) return 'Winning your last game';
  if (games === 2) return 'Winning both';
  return `Winning all ${games}`;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function goalCard(rep, rules) {
  const label = GOALS[rep.goal].label;
  const avoiding = rep.goal === 'relegation';
  const value = avoiding ? rep.probability : rep.probability;

  let headline;
  if (rep.state === 'clinched') {
    headline = avoiding
      ? `<span class="big out">Down</span><span class="lbl">relegation is already confirmed</span>`
      : `<span class="big sure">Through</span><span class="lbl">confirmed, whatever happens next</span>`;
  } else if (rep.state === 'eliminated') {
    headline = avoiding
      ? `<span class="big sure">Safe</span><span class="lbl">cannot be relegated</span>`
      : `<span class="big out">Out</span><span class="lbl">no longer mathematically possible</span>`;
  } else {
    headline = `<span class="big">${pct(value)}</span><span class="lbl">${
      avoiding ? 'chance of going down' : `chance of ${GOALS[rep.goal].verb === 'get promoted' ? 'promotion' : 'reaching the playoffs'}`}</span>`;
  }

  return `<div class="panelbox" style="margin-top:16px">
    <h3 style="margin-top:0">${esc(label)}</h3>
    <div class="verdict">${headline}</div>
    ${rep.state === 'live' ? requirements(rep, avoiding, rules) : settled(rep, avoiding, rules)}
  </div>`;
}

function settled(rep, avoiding, rules) {
  const c = rep.summaryRow.certainty;
  if (rep.state === 'clinched' && !avoiding) {
    return `<ul class="reqs"><li><span class="mark ok">✓</span><span>
      Even losing every remaining game, no one can push
      <strong>${esc(rep.team.name)}</strong> out of the top ${rules[rep.goal === 'promotion' ? 'promotion_spots' : 'playoff_spots']}.
      Worst possible finish: <b>${c.worstPossiblePosition}${ord(c.worstPossiblePosition)}</b>.
    </span></li></ul>`;
  }
  if (rep.state === 'eliminated' && !avoiding) {
    return `<ul class="reqs"><li><span class="mark no">✕</span><span>
      Winning every remaining game still leaves too many teams above.
      Best possible finish: <b>${c.bestPossiblePosition}${ord(c.bestPossiblePosition)}</b>.
    </span></li></ul>`;
  }
  if (avoiding && rep.state === 'eliminated') {
    return `<ul class="reqs"><li><span class="mark ok">✓</span><span>
      Worst possible finish is <b>${c.worstPossiblePosition}${ord(c.worstPossiblePosition)}</b>,
      clear of the bottom ${rules.relegation_spots}. Survival is already secured.
    </span></li></ul>`;
  }
  return `<ul class="reqs"><li><span class="mark no">✕</span><span>
    Best possible finish is <b>${c.bestPossiblePosition}${ord(c.bestPossiblePosition)}</b>,
    which is inside the relegation places however the rest of the season goes.
  </span></li></ul>`;
}

export function ord(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function requirements(rep, avoiding, rules) {
  const items = [];
  const games = rep.summaryRow.remaining;

  // 1. Your own games.
  const seen = rep.breakdown.filter((b) => b.trials >= 20);
  const sharedOn = rep.sharedRates.abandonRate + rep.sharedRates.tieRate > 0;
  if (games > 0 && sharedOn && rep.mix && rep.mix.length) {
    // Every combination of wins, washouts/ties and losses that came up, most
    // points first: "win it → 100% · washed out → 42% · lose it → 12%".
    const pointsOf = (b) => b.wins * rules.points_win + b.shared * rules.points_no_result + b.lost * rules.points_loss;
    const combos = [...rep.mix].sort((x, y) => pointsOf(y) - pointsOf(x) || y.wins - x.wins);
    const label = (b) => {
      if (games === 1) return b.wins ? 'win it' : (b.shared ? 'washed out or tied' : 'lose it');
      if (b.wins === games) return winAll(games);
      if (b.shared === games) return games === 2 ? 'both washed out/tied' : `all ${games} washed out/tied`;
      if (b.lost === games) return games === 2 ? 'lose both' : `lose all ${games}`;
      const bits = [];
      if (b.wins) bits.push(`${b.wins} won`);
      if (b.shared) bits.push(`${b.shared} washed out/tied`);
      if (b.lost) bits.push(`${b.lost} lost`);
      return bits.join(', ');
    };
    const parts = combos.slice(0, 12).map((b) => {
      const p = avoiding ? 1 - b.p : b.p;
      return `${label(b)} → <b>${pct(p)}</b>`;
    }).join(' &nbsp;·&nbsp; ');
    items.push(['ok', `<strong>Your own ${plural(games, 'game')}:</strong> ${parts}
      <br><em>${avoiding ? 'chance of staying up' : 'chance of making it'} after each set of results.
      A washout or tie is worth ${plural(rules.points_no_result, 'point')} each, against ${rules.points_win} for a win.</em>`]);
  } else if (games > 0 && seen.length) {
    const parts = seen.map((b) => {
      const p = avoiding ? 1 - b.p : b.p;
      const lbl = b.wins === games ? winAll(games)
        : (b.wins === 0 ? (games === 1 ? 'lose it' : 'lose them all') : `win ${b.wins}`);
      return `${lbl} → <b>${pct(p)}</b>`;
    }).join(' &nbsp;·&nbsp; ');
    items.push(['ok', `<strong>Your own ${plural(games, 'game')}:</strong> ${parts}
      <br><em>${avoiding ? 'chance of staying up' : 'chance of making it'} after each number of wins</em>`]);
  }

  // 2. Does winning everything settle it on its own?
  const sweepP = avoiding ? 1 - rep.sweep.base : rep.sweep.base;
  if (games > 0 && rep.sweep.baseTrials >= 50) {
    const outcome = avoiding ? 'stays up' : 'is enough';
    if (sweepP >= 0.995) {
      items.push(['ok', avoiding
        ? `<strong>${winningAll(games)} keeps you up</strong> — in every one of the
           ${rep.sweep.baseTrials.toLocaleString()} simulated seasons where it happened.`
        : `<strong>${winningAll(games)} is enough on its own</strong> — it worked in every one of the
           ${rep.sweep.baseTrials.toLocaleString()} simulated seasons where it happened.
           No other result needs to go your way.`]);
    } else if (sweepP <= 0.005) {
      // Nothing useful to list below: no arrangement of other results rescued
      // this in the sample, so pointing at "key fixtures" would be noise.
      items.push(['no', `<strong>${winningAll(games)} still ${avoiding ? 'does not keep you up' : 'is not enough'}</strong>
        — it did not happen in any of the ${rep.sweep.baseTrials.toLocaleString()} simulated seasons
        where ${avoiding ? 'they won out' : 'that happened'}. Not mathematically impossible yet, but
        it needs a combination of other results rare enough that the simulation never produced one.`]);
    } else {
      items.push(['maybe', `<strong>${winAll(games).replace(/^w/, 'W')} and it ${outcome} ${pct(sweepP)} of the time</strong> —
        ${sweepP >= 0.5 ? 'likely' : 'possible'}, but still dependent on results elsewhere.`]);
    }
  }

  // 3. What has to happen elsewhere.
  if (rep.sweep.fixtures.length && sweepP < 0.995 && sweepP > 0.005) {
    const list = rep.sweep.fixtures.slice(0, 5).map((f) => {
      const pGood = avoiding ? 1 - f.pIfNeeded : f.pIfNeeded;
      const pBad = avoiding ? 1 - f.pIfNot : f.pIfNot;
      const washed = sharedOn && f.pIfShared != null
        ? `, ${pct(avoiding ? 1 - f.pIfShared : f.pIfShared)} if washed out or tied`
        : '';
      return `<li><span class="mark maybe">→</span><span>
        <strong>${esc(f.needWinner.name)}</strong> to beat ${esc(f.needLoser.name)}
        &nbsp;<em>${pct(pGood)} if they do, ${pct(pBad)} if they ${sharedOn ? 'lose' : 'don\'t'}${washed}</em></span></li>`;
    }).join('');
    const lead = games > 0
      ? `Assuming you ${winAll(games)}, the results that matter most:`
      : 'With no games of your own left, the results that matter most:';
    items.push(['raw', `<strong>${lead}</strong>
      <ul class="reqs" style="margin-top:6px">${list}</ul>`]);
  }

  // 4. Net run rate.
  // Only worth saying when net run rate is genuinely the deciding factor: if
  // winning out still leaves the team short on points, no margin rescues it.
  const nrrDecides = sweepP > 0.02 && sweepP < 0.995;
  if (rep.margin && rep.margin.samples >= 30 && nrrDecides) {
    const m = rep.margin;
    const bits = [];
    if (m.runs != null) bits.push(`win by about <b>${m.runs} runs</b> batting first`);
    if (m.oversToSpare != null) bits.push(`chase it down with about <b>${m.oversToSpare} overs to spare</b>`);
    if (bits.length) {
      items.push(['maybe', `<strong>Margins matter.</strong> In the simulated seasons where
        ${esc(rep.team.name)} won everything and <em>still</em> missed out, the team that took
        <b>${m.cutPlace}${ord(m.cutPlace)} place</b> did so on net run rate, typically around
        <b>${signed(m.target)}</b>.
        To clear that from ${signed(m.currentNrr)}, ${esc(rep.team.name)} needs to
        ${bits.join(' — or ')} in ${m.games === 1 ? 'the last remaining game' : `each of the ${m.games} remaining games`}
        (typical first-innings total in this division is ${m.typicalScore}).
        <br><em>Wickets in hand do not affect net run rate when chasing — only the overs you leave
        unused do.</em>`]);
    }
  }

  if (!items.length) {
    items.push(['maybe', 'No specific requirement stands out — the outcome is spread across many results.']);
  }

  return `<ul class="reqs">${items.map(([mark, html]) => (
    mark === 'raw'
      ? `<li><span class="mark">·</span><span>${html}</span></li>`
      : `<li><span class="mark ${mark}">${mark === 'ok' ? '✓' : mark === 'no' ? '✕' : '→'}</span><span>${html}</span></li>`
  )).join('')}</ul>`;
}

