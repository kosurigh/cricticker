/**
 * margins-view.js — margins.js analyses as plain cricket sentences.
 *
 * Pure (no page state), so tools/check-all-teams.mjs and the tests read
 * exactly what the page shows.
 */

import { esc, signed } from './ui.js';
import {
  R, oversText, marginSettings, goalMargins, rivalMargins, racingRivals, currentNrr, lossMargins,
} from './margins.js';
import { certificates } from './engine.js';

const GOAL_WORDS = {
  playoff: { name: 'Playoffs', reach: 'make the playoffs', in: 'Through to the playoffs', out: 'Misses the playoffs' },
  promotion: { name: 'Promotion', reach: 'get promoted', in: 'Promoted', out: 'Misses promotion' },
  relegation: { name: 'Staying up', reach: 'stay up', in: 'Safe', out: 'Relegated' },
};

export function goalPlaces(goal, rules, n) {
  if (goal === 'playoff') return rules.playoff_spots;
  if (goal === 'promotion') return rules.promotion_spots;
  return n - rules.relegation_spots;
}

const b = (s) => `<strong>${esc(s)}</strong>`;
const lowerFirst = (s) => esc(s.charAt(0).toLowerCase() + s.slice(1));
const nameOf = (ctx, i) => ctx.teams[i].name;
const listNames = (names) => (names.length <= 1 ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** "Zenstarz Warriors beat Cary Sirjis", from a fixture and an outcome mask. */
export function conditionText(ctx, { fixture, mask }) {
  const fx = ctx.remaining[fixture];
  const H = b(nameOf(ctx, fx.h)), A = b(nameOf(ctx, fx.a));
  switch (mask) {
    case 1 << R.HOME: return `${H} beat ${A}`;
    case 1 << R.AWAY: return `${A} beat ${H}`;
    case 1 << R.SHARED: return `${H} v ${A} is washed out or tied`;
    case (1 << R.HOME) | (1 << R.SHARED): return `${A} don't beat ${H}`;
    case (1 << R.AWAY) | (1 << R.SHARED): return `${H} don't beat ${A}`;
    case (1 << R.HOME) | (1 << R.AWAY): return `${H} v ${A} has a winner`;
    default: return '';
  }
}

function conditionsText(ctx, cubes) {
  const alts = cubes.map((c) => c.map((x) => conditionText(ctx, x)).join(' and ')).filter(Boolean);
  if (!alts.length) return '';
  return `If ${alts.join(', <em>or</em> if ')}`;
}

/** The margin, in runs and in overs, with the score assumption attached. */
function marginText(need, { winning, set, side = '' }) {
  const m = need.main;
  const bits = [];
  const range = (k, fmt) => {
    const lo = need.low[k], hi = need.high[k];
    if (lo == null && hi == null) return '';
    const f = (x) => (x == null ? 'out of reach' : fmt(x));
    return ` <span class="sub">(at ${need.low.S}: ${f(lo)}; at ${need.high.S}: ${f(hi)})</span>`;
  };
  if (winning) {
    if (m.runs != null) bits.push(`win by at least <b>${m.runs} run${m.runs === 1 ? '' : 's'}</b> batting first${range('runs', (x) => x)}`);
    if (m.balls != null) bits.push(`chase ${m.S + 1} within <b>${oversText(m.balls)} overs</b>${range('balls', oversText)}`);
  } else {
    if (m.runs != null) bits.push(`lose by no more than <b>${m.runs} run${m.runs === 1 ? '' : 's'}</b> chasing ${m.S + 1}${range('runs', (x) => x)}`);
    if (m.balls != null) bits.push(`${side || 'the opposition'} take at least <b>${oversText(m.balls)} overs</b> to chase ${m.S + 1}${range('balls', oversText)}`);
  }
  return bits.join(', or ');
}

function ownLabel(ctx, t, own) {
  if (!own.length) return 'No games left';
  return own.map(({ fixture, result }) => {
    const fx = ctx.remaining[fixture];
    const opp = nameOf(ctx, fx.h === t ? fx.a : fx.h);
    return result > 0 ? `Beat ${opp}` : (result < 0 ? `Lose to ${opp}` : `Washed out / tied v ${opp}`);
  }).join(', ');
}

function pointsAfterOwn(ctx, t, own) {
  const r = ctx.rules;
  let p = ctx.base.points[t];
  for (const { result } of own) p += result > 0 ? r.points_win : (result < 0 ? r.points_loss : r.points_no_result);
  return p;
}

function opponentName(ctx, t, own) {
  const f = own.find((o) => o.result !== 0) || own[0];
  if (!f) return null;
  const fx = ctx.remaining[f.fixture];
  return nameOf(ctx, fx.h === t ? fx.a : fx.h);
}

/** One verdict as a sentence. Returns { text, tone: 'ok'|'no'|'maybe' }. */
function verdictText(ctx, set, t, v, goal, own) {
  const w = GOAL_WORDS[goal];
  const opp = opponentName(ctx, t, own);
  if (v.kind === 'in') return { tone: 'ok', text: `${w.in} on points, whatever the margin.` };
  if (v.kind === 'out') {
    return { tone: 'no', text: goal === 'relegation'
      ? `Relegated on points — ${v.above} teams finish above.`
      : `Not enough on points — ${v.above} team${v.above === 1 ? '' : 's'} finish above.` };
  }
  const rivals = v.level.map((j) => `${b(nameOf(ctx, j))} (NRR ${signed(currentNrr(ctx, j))})`);
  const levelLine = `Level on ${v.points} points with ${listNames(rivals)}`
    + (v.level.length > 1 ? ` — must finish above ${v.mustBeat ?? (v.level.length - v.places + 1)} of them` : '');
  const assumed = v.pendingRivals && v.pendingRivals.length
    ? ` <span class="sub">(${esc(listNames(v.pendingRivals.map((j) => nameOf(ctx, j))))}'s game assumed to finish with a typical ${set.typicalRuns}-run margin)</span>`
    : '';
  if (v.mode === 'own') {
    const mine = signed(currentNrr(ctx, t));
    if (v.need.main.any) {
      return { tone: 'ok', text: `${levelLine}, but already ahead on net run rate (${mine}) — ${v.winning ? 'any win' : 'even a heavy defeat'} does it.${assumed}` };
    }
    if (v.need.main.none) {
      return { tone: 'no', text: `${levelLine} — and ${v.winning
        ? `no realistic win lifts net run rate (${mine}) enough, even by ${v.need.main.maxRuns} runs or chasing in an over`
        : 'a defeat leaves net run rate short whatever the margin'}. Misses out on net run rate.${assumed}` };
    }
    return { tone: 'maybe', text: `${levelLine} — net run rate decides (now ${mine}). To ${w.reach}: ${marginText(v.need, { winning: v.winning, set, side: b(opp) })}.${assumed}` };
  }
  if (v.mode === 'mixed') {
    return { tone: 'maybe', text: `${levelLine} — net run rate decides; at typical margins they would ${v.typicalIn ? w.reach : `miss out`}.` };
  }
  // Rivals' margins decide.
  if (v.canAfford < 0) return { tone: 'no', text: `${levelLine} — they already finish above on net run rate. ${w.out}.` };
  const conds = v.rivals.filter((r) => r.state === 'depends').map((r) => {
    const R0 = b(nameOf(ctx, r.team));
    const theirOpp = (() => {
      for (let f = 0; f < ctx.remaining.length; f++) {
        const fx = ctx.remaining[f];
        if (fx.h === r.team || fx.a === r.team) return b(nameOf(ctx, fx.h === r.team ? fx.a : fx.h));
      }
      return 'their opponents';
    })();
    return r.winning
      ? `${R0} pass them if they ${marginText(r.need, { winning: true, set })}`
      : `${R0} stay above them if they ${marginText(r.need, { winning: false, set, side: theirOpp })}`;
  });
  if (v.canAfford >= v.maybe) return { tone: 'ok', text: `${levelLine}, and stay ahead on net run rate whatever the margins. ${w.in}.` };
  const k = v.canAfford + 1;
  return { tone: 'maybe', conds, need: k, text: `${levelLine} — net run rate (${signed(currentNrr(ctx, t))}) decides. ${w.in} unless ${k === 1 && conds.length === 1 ? 'this happens' : `${k} of these happen`}: ${conds.join('; ')}.` };
}

/** Lines for one goal: own cases × conditions, merged by identical text. */
export function goalLines(ctx, set, teamId, goal, opts = {}) {
  const t = ctx.index.get(teamId);
  const K = goalPlaces(goal, ctx.rules, ctx.n);
  const a = goalMargins(ctx, set, teamId, K, opts);
  return a.cases.map((c) => {
    const merged = new Map();
    for (const l of c.lines) {
      const v = verdictText(ctx, set, t, l.verdict, goal, c.own);
      const key = v.text;
      if (!merged.has(key)) merged.set(key, { ...v, rivalConds: v.conds || [], prob: 0, conds: [], kind: l.verdict.kind, verdict: l.verdict });
      const m = merged.get(key);
      m.prob += l.prob;
      m.conds.push(...l.conditions);
    }
    const lines = [...merged.values()].sort((x, y) => y.prob - x.prob).map((m) => ({
      ...m,
      // Conditions only matter when the case has more than one line.
      cond: merged.size > 1 ? conditionsText(ctx, m.conds) : '',
    }));
    return { label: ownLabel(ctx, t, c.own), points: pointsAfterOwn(ctx, t, c.own), own: c.own, prob: c.prob, lines };
  });
}

/** Pairwise lines against the rivals T can finish level with. */
export function rivalLines(ctx, set, teamId, { limit = 4 } = {}) {
  const t = ctx.index.get(teamId);
  const out = [];
  for (const rid of racingRivals(ctx, teamId)) {
    const r = ctx.index.get(rid);
    const a = rivalMargins(ctx, set, teamId, rid);
    const anyNrr = a.cases.some((c) => c.lines.some((l) => l.verdict.on === 'nrr'));
    const states = new Set(a.cases.flatMap((c) => c.lines.map((l) => l.verdict.state)));
    if (!anyNrr && states.size < 2) continue;
    const RN = b(nameOf(ctx, r));
    const cases = a.cases.map((c) => {
      const opp = opponentName(ctx, t, c.own);
      const lines = c.lines.map((l) => {
        const v = l.verdict;
        let text;
        if (v.on === 'points') text = v.state === 'above' ? `finish above ${RN} on points` : `finish below ${RN} on points`;
        else if (v.state !== 'depends') {
          const losing = c.own.length && c.own.every((o) => o.result < 0);
          const how = !v.robust ? ' (at typical margins)'
            : (losing && v.state === 'above' ? ' — even losing heavily' : ', whatever the margin');
          text = `finish ${v.state === 'above' ? 'above' : 'below'} ${RN} on net run rate${how}`;
        } else if (v.side === 'a') {
          const T = b(nameOf(ctx, t));
          text = v.winning
            ? `finish above ${RN} if ${T} ${marginText(v.need, { winning: true, set })}`
            : `stay above ${RN} if ${T} ${marginText(v.need, { winning: false, set, side: b(opp) })}`;
        } else {
          text = v.winning
            ? `finish above ${RN} unless ${RN} ${marginText(v.need, { winning: true, set })}`
            : `finish below ${RN} unless ${RN} lose heavily: ${RN} stay above if they ${marginText(v.need, { winning: false, set })}`;
        }
        return { text, state: v.state, on: v.on, cond: c.lines.length > 1 ? conditionsText(ctx, l.conditions) : '' };
      });
      return { label: ownLabel(ctx, t, c.own), own: c.own, lines };
    });
    // Worth showing: anything net run rate decides, and a defeat that still
    // leaves them above the rival. Plain points lines are in the cards above.
    const losing = (c) => c.own.length && c.own.every((o) => o.result < 0);
    const shown = cases.map((c) => ({ ...c, lines: c.lines.filter((l) => l.on === 'nrr' || (losing(c) && l.state === 'above')) }))
      .filter((c) => c.lines.length);
    if (!shown.length) continue;
    out.push({ rival: ctx.teams[r], cases, shown });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The headline facts, in the user's own terms: "can win and still miss out on
 * net run rate", "can lose to X and still finish above Y".
 */
export function keyFacts(ctx, set, teamId, goals, rivals, losses = []) {
  const t = ctx.index.get(teamId);
  const team = nameOf(ctx, t);
  const facts = [];
  for (const [goal, cases] of Object.entries(goals)) {
    if (!cases) continue;
    const w = GOAL_WORDS[goal];
    for (const c of cases) {
      const won = c.own.length && c.own.every((o) => o.result > 0);
      const lost = c.own.length && c.own.every((o) => o.result < 0);
      const nrrLines = c.lines.filter((l) => l.kind === 'race');
      const allIn = c.lines.every((l) => l.tone === 'ok' && l.kind === 'in');
      const anyOk = c.lines.some((l) => l.tone !== 'no');
      if (won && nrrLines.some((l) => !(l.verdict.need?.main?.any))) {
        facts.push(`${b(team)} can win and still not ${w.reach} — it can come down to net run rate (see below).`);
      } else if (won && allIn) {
        facts.push(`A win ${goal === 'relegation' ? 'keeps' : 'takes'} ${b(team)} ${goal === 'relegation' ? 'up' : (goal === 'promotion' ? 'up a division' : 'into the playoffs')} on points, whatever the margin.`);
      }
      if (lost && anyOk) facts.push(`${b(team)} can ${lowerFirst(c.label)} and still ${w.reach}${c.lines.every((l) => l.tone === 'ok') ? ', whatever else happens' : ' — depending on the results below'}.`);
      if (lost && !anyOk) facts.push(`Defeat ends ${b(team)}'s chance to ${w.reach}.`);
      if (!c.own.length) {
        const caught = c.lines.filter((l) => l.tone === 'maybe' && l.rivalConds.length);
        if (caught.length && c.lines.every((l) => l.tone !== 'no')) {
          const conds = [...new Set(caught.flatMap((l) => l.rivalConds))];
          facts.push(`With no games left, ${b(team)} ${w.reach} unless overtaken on net run rate: ${conds.join('; ')}.`);
        } else if (c.lines.every((l) => l.kind === 'in')) {
          facts.push(`${b(team)} ${w.reach} whatever happens in the remaining games.`);
        }
      }
    }
  }
  for (const r of rivals) {
    for (const c of r.cases) {
      const lost = c.own.length && c.own.every((o) => o.result < 0);
      if (lost && c.lines.every((l) => l.state === 'above')) {
        let how;
        if (c.lines.every((l) => l.on === 'points')) how = ' on points';
        else {
          const ls = losses.filter((x) => x.rival === r.rival.id && c.own.some((o) => o.result < 0 && o.fixture === x.fixture));
          how = ls.length && ls.every((x) => !x.realistic)
            ? ' — no realistic defeat changes that (see "If they lose" below)'
            : ' at typical margins (see "If they lose" below)';
        }
        facts.push(`${b(team)} can ${lowerFirst(c.label)} and still finish above ${b(r.rival.name)}${how}.`);
      }
    }
  }
  return [...new Set(facts)];
}

/** Everything for one team, ready to render. */
export function teamMargins(ctx, teamId, opts = {}) {
  const set = marginSettings(ctx);
  const goals = {};
  for (const goal of ['promotion', 'playoff', 'relegation']) {
    const cert = certificates(teamId, ctx.teams, ctx.matches, ctx.rules, ctx.baseline);
    const settled = goal === 'relegation'
      ? (cert.relegation.safe ? 'in' : (cert.relegation.doomed ? 'out' : null))
      : (cert[goal].clinched ? 'in' : (cert[goal].eliminated ? 'out' : null));
    goals[goal] = settled ? null : goalLines(ctx, set, teamId, goal, opts);
    if (settled) goals[`${goal}Settled`] = settled;
  }
  const allSettled = ['promotion', 'playoff', 'relegation'].every((g) => goals[`${g}Settled`]);
  // Nothing left to play for: the table races around them are noise.
  const rivals = allSettled ? [] : rivalLines(ctx, set, teamId);
  // Only races still open count for the loss lines.
  const Ks = ['playoff', 'promotion', 'relegation'].filter((g) => !goals[`${g}Settled`])
    .map((g) => [g, goalPlaces(g, ctx.rules, ctx.n)]);
  const losses = Ks.length ? lossMargins(ctx, set, teamId, Ks) : [];
  const plain = Object.fromEntries(Object.entries(goals).filter(([k]) => !k.endsWith('Settled')));
  return { set, goals, rivals, losses, facts: keyFacts(ctx, set, teamId, plain, rivals, losses) };
}

const GOAL_RACE = { playoff: 'playoff race', promotion: 'promotion race', relegation: 'relegation fight' };
const runsWord = (r) => `${r} run${r === 1 ? '' : 's'}`;

/**
 * "If they lose": for each rival they could end level with on points, how
 * badly they must lose for net run rate to drop them below it — in the right
 * direction: losing by runs only when bowling first (the opponent batted
 * first), being chased down when batting first.
 */
export function lossLines(ctx, set, teamId, losses) {
  const t = ctx.index.get(teamId);
  const T = b(nameOf(ctx, t));
  return losses.map((l) => {
    const r = ctx.index.get(l.rival), o = ctx.index.get(l.opponent);
    const RN = b(nameOf(ctx, r)), O = b(nameOf(ctx, o));
    const cond = l.conditions.length && l.conditions.some((c) => c.length) ? conditionsText(ctx, l.conditions) : '';
    const race = listNames(l.goals.map((g) => GOAL_RACE[g]));
    const now = `NRR now ${signed(l.nowT)} v ${signed(l.nowR)}`;
    const assumed = l.assumed ? ` <span class="sub">(other results in this pair's games assumed at a typical ${set.typicalRuns}-run margin)</span>` : '';
    const head = `${cond ? `${cond}, and ${T} lose to ${O}` : `If ${T} lose to ${O}`}, they finish level on points with ${RN} in the ${race} (${now}).`;
    let verdict, table = '';
    if (l.anyDefeat) {
      verdict = `Any defeat drops ${T} below ${RN} on net run rate.`;
    } else if (!l.realistic) {
      verdict = `No realistic defeat drops ${T} below ${RN}: ${O} would have to bat first and make at least <b>${l.minScore ?? `more than ${600}`}</b>`
        + `${l.minScore != null ? ` and bowl ${T} out for 0` : ''} (${l.reached
          ? `${l.reached} of ${set.firstInnings.length} first innings in this division have reached ${l.minScore}`
          : `the highest first innings in this division is ${set.highest}`}); with ${T} batting first, ${l.chaseEver == null ? 'no chase is quick enough' : `it needs them out for ${l.chaseEver}+ and chased in an over or so`}.`
        + ` Worst case — bowled out for 0, then chased off 1 ball — leaves ${T} on ${signed(l.worst[0])} against ${signed(l.worst[1])}.`;
    } else {
      verdict = `${T} drop below ${RN} on net run rate only with a heavy enough defeat:`;
      const row = (i) => {
        const a = l.runs[i], c = l.chase[i];
        const bowl = a.r == null ? 'no margin does it' : `lose by <b>${runsWord(a.r)}</b> or more (${esc(nameOf(ctx, t))} ${a.S - a.r} or fewer)`;
        const bat = c.b == null ? 'no chase is quick enough' : `${O} chase ${c.S + 1} within <b>${oversText(c.b)} overs</b>`;
        return `<tr><td>${a.S}</td><td>${bowl}</td><td>${bat}</td></tr>`;
      };
      table = `<table class="ltable"><thead><tr><th>First innings</th><th>${O} bat first (${esc(nameOf(ctx, t))} lose by runs)</th><th>${T} bat first (${O} chase)</th></tr></thead>
        <tbody>${l.runs.map((_, i) => row(i)).join('')}</tbody></table>`
        + `<p class="sub">Losing by runs can only do it once ${esc(nameOf(ctx, o))} make ${l.minScore ?? 'more than 600'} or more.`
        + ` Worst case (bowled out for 0, chased off 1 ball): ${signed(l.worst[0])} against ${signed(l.worst[1])}.</p>`;
    }
    return { tone: l.anyDefeat ? 'no' : (l.realistic ? 'maybe' : 'ok'), text: `${head} ${verdict}${assumed}`, table, loss: l };
  });
}

/** Above this many fixtures the exact enumeration (3^n) is not worth it. */
export const MAX_FIXTURES = 9;

/** The card. */
export function marginsCard(ctx, teamId, opts = {}) {
  const t = ctx.index.get(teamId);
  const team = nameOf(ctx, t);
  if (ctx.remaining.length > MAX_FIXTURES) {
    return `<div class="panelbox margins" style="margin-top:16px">
      <h3 style="margin-top:0">${esc(team)} — what it takes, in runs and overs</h3>
      <p class="sub">Worked out exactly once ${MAX_FIXTURES} or fewer games are left in the division
      (${ctx.remaining.length} now). Until then, see the percentages below.</p></div>`;
  }
  const a = teamMargins(ctx, teamId, opts);
  const s = a.set;
  const parts = [];
  parts.push(`<p class="note">Points first, then net run rate. Margins are worked out exactly from
    CricHeroes' runs-for / overs-faced and runs-against / overs-bowled figures, for an
    ${s.quota / 6}-over game with a first-innings total of <b>${s.score}</b> (this division's median;
    figures for ${s.scores[0]} and ${s.scores[2]} in brackets). A side bowled out is charged the full
    ${s.quota / 6} overs; washouts leave net run rate alone; wickets in hand do not count.</p>`);
  if (a.facts.length) {
    parts.push(`<ul class="reqs facts">${a.facts.map((f) => `<li><span class="mark ok">!</span><span>${f}</span></li>`).join('')}</ul>`);
  }
  for (const goal of ['playoff', 'promotion', 'relegation']) {
    const w = GOAL_WORDS[goal];
    const settled = a.goals[`${goal}Settled`];
    if (settled) {
      parts.push(`<h4>${esc(w.name)}</h4><p class="sub">${settled === 'in' ? `${esc(w.in)} — settled whatever happens.` : `${esc(w.out)} — settled whatever happens.`}</p>`);
      continue;
    }
    const cases = a.goals[goal];
    parts.push(`<h4>${esc(w.name)}</h4>`);
    for (const c of cases) {
      parts.push(`<div class="mcase"><div class="mhead"><strong>${esc(c.label)}</strong>
        <span class="sub">→ ${c.points} pts${c.own.length ? ` · ${Math.round(c.prob * 100)}% likely` : ''}</span></div>
        <ul class="reqs">${c.lines.map((l) => `<li><span class="mark ${l.tone}">${l.tone === 'ok' ? '✓' : l.tone === 'no' ? '✕' : '→'}</span><span>${
          l.cond ? `${l.cond}: ` : ''}${l.text}${c.lines.length > 1 ? ` <span class="sub">(${Math.round(l.prob * 100)}%)</span>` : ''}</span></li>`).join('')}</ul></div>`);
    }
  }
  if (a.rivals.length) {
    parts.push('<h4>Against the teams around them</h4>');
    for (const r of a.rivals) {
      const items = r.shown.flatMap((c) => c.lines.map((l) => `<li><span class="mark ${l.state === 'above' ? 'ok' : l.state === 'below' ? 'no' : 'maybe'}">${l.state === 'above' ? '▲' : l.state === 'below' ? '▼' : '→'}</span><span><strong>${esc(c.label)}</strong>${l.cond ? ` — ${l.cond}` : ''}: ${l.text}.</span></li>`));
      parts.push(`<ul class="reqs">${items.join('')}</ul>`);
    }
  }
  const ll = lossLines(ctx, s, teamId, a.losses);
  if (ll.length) {
    parts.push(`<h4>If they lose — how badly before net run rate drops them below a rival</h4>`);
    parts.push(ll.map((l) => `<div class="mcase"><ul class="reqs"><li><span class="mark ${l.tone}">${l.tone === 'ok' ? '▲' : l.tone === 'no' ? '▼' : '→'}</span><span>${l.text}</span></li></ul>${l.table}</div>`).join(''));
  }
  return `<div class="panelbox margins" style="margin-top:16px">
    <h3 style="margin-top:0">${esc(team)} — what it takes, in runs and overs</h3>
    ${parts.join('\n')}
  </div>`;
}
