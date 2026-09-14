/**
 * page-division.js — the division screen.
 *
 * Flow: render the committed snapshot immediately, then let the user refresh
 * from CricHeroes in place. The simulation is sliced across animation frames
 * rather than run in one blocking call, so a 200,000-trial run never freezes
 * the tab.
 */

import {
  $, esc, pct, signed, teamCell, loadLogos, breadcrumbs, query, banner,
  fmtWhen, probCell,
} from './ui.js';
import {
  loadSnapshot, loadTournamentMeta, loadDivisionMap, fetchLive, crossCheck,
} from './data.js';
import { prepare, createRun } from './simulate.js';
import { summarise, buildReport, GOALS } from './scenarios.js';
import { netRunRate } from './engine.js';
import { SIM_PRESETS, proxyBase } from './config.js';

const q = query();
const TID = q.get('t') || '2100677';
const DIV = Number(q.get('d') || 7);

const state = {
  data: null,      // hydrated snapshot
  meta: null,
  divisionMap: null,
  ctx: null,
  results: null,
  summary: null,
  focusId: null,
  model: 'coinflip',
  trials: 50000,
  running: false,
};

/* ------------------------------------------------------------- bootstrap */

async function init() {
  $('crumbs').innerHTML = breadcrumbs([
    { label: 'Tournaments', href: 'index.html' },
    { label: 'Divisions', href: `tournament.html?t=${encodeURIComponent(TID)}` },
    { label: `Division ${DIV}` },
  ]);

  await loadLogos();

  try {
    [state.meta, state.divisionMap] = await Promise.all([
      loadTournamentMeta(TID).catch(() => null),
      loadDivisionMap(TID),
    ]);
    state.data = await loadSnapshot(TID, DIV);
  } catch (e) {
    $('content').innerHTML = banner('error', 'No data for this division',
      `${esc(e.message)}<br>Generate it with <code>node tools/fetch-tournament.mjs ${esc(TID)} --division ${DIV}</code>.`);
    return;
  }

  document.title = `Division ${DIV} — ${state.data.tournament_name} — Cric Scenarios`;
  $('title').textContent = `${state.data.tournament_name}`;
  $('subtitle').textContent = `Division ${DIV}`;

  pickDefaultFocus();
  buildControls();
  rebuild();
}

/** Default to Guts N Glory where present — this was built for them. */
function pickDefaultFocus() {
  const saved = q.get('team');
  if (saved && state.data.teams.some((t) => String(t.id) === saved)) {
    state.focusId = state.data.teams.find((t) => String(t.id) === saved).id;
    return;
  }
  const gng = state.data.teams.find((t) => /guts\s*n.?\s*glory/i.test(t.name));
  state.focusId = (gng || state.data.teams[0]).id;
}

/* -------------------------------------------------------------- controls */

function buildControls() {
  const teams = [...state.data.teams].sort((a, b) => a.name.localeCompare(b.name));
  $('controls').innerHTML = `
    <div class="field">
      <label for="focus">Team</label>
      <select id="focus">${teams.map((t) =>
        `<option value="${esc(t.id)}"${t.id === state.focusId ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label>Remaining games</label>
      <span class="seg" role="group" aria-label="Match model">
        <button type="button" data-model="coinflip" aria-pressed="${state.model === 'coinflip'}">Coin flip</button>
        <button type="button" data-model="form" aria-pressed="${state.model === 'form'}">Form-weighted</button>
      </span>
    </div>
    <div class="field">
      <label for="trials">Simulations</label>
      <select id="trials">${SIM_PRESETS.map((p) =>
        `<option value="${p.trials}"${p.trials === state.trials ? ' selected' : ''}>${p.label} — ${p.trials.toLocaleString()}</option>`).join('')}</select>
    </div>
    <span class="spacer"></span>
    <span id="status" class="badge"></span>
    <button id="refresh" class="primary" ${proxyBase() ? '' : 'disabled title="Set WORKER_URL in assets/js/config.js, or run dev-server.py"'}>
      Refresh from CricHeroes
    </button>`;

  $('focus').onchange = (e) => {
    state.focusId = Number(e.target.value) || e.target.value;
    const u = new URL(location.href);
    u.searchParams.set('team', state.focusId);
    history.replaceState(null, '', u);
    rebuild();
  };
  $('trials').onchange = (e) => { state.trials = Number(e.target.value); rebuild(); };
  for (const b of $('controls').querySelectorAll('[data-model]')) {
    b.onclick = () => {
      state.model = b.dataset.model;
      for (const o of $('controls').querySelectorAll('[data-model]')) {
        o.setAttribute('aria-pressed', String(o.dataset.model === state.model));
      }
      rebuild();
    };
  }
  $('refresh').onclick = refreshLive;
}

async function refreshLive() {
  const btn = $('refresh');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    state.data = await fetchLive(TID, DIV, {
      divisionMap: state.divisionMap,
      rules: state.data.rules,
      meta: state.meta,
    });
    if (!state.data.teams.some((t) => t.id === state.focusId)) pickDefaultFocus();
    buildControls();
    rebuild();
  } catch (e) {
    $('warnings').innerHTML = banner('error', 'Live refresh failed',
      `${esc(e.message).replace(/\n/g, '<br>')}<br><br>The page is still showing the committed snapshot. ` +
      'If CricHeroes has renamed an endpoint, add the new path to <code>ENDPOINTS</code> in ' +
      '<code>assets/js/config.js</code>.') + $('warnings').innerHTML;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh from CricHeroes';
  }
}

/* ------------------------------------------------------------ simulation */

function rebuild() {
  renderMeta();
  renderWarnings();
  state.ctx = prepare(state.data.teams, state.data.matches, state.data.rules);

  if (!state.ctx.remaining.length) {
    state.results = null;
    renderFinalTable();
    return;
  }

  const run = createRun(state.ctx, {
    trials: state.trials,
    model: state.model,
    focusId: state.focusId,
    seed: 0x5eed,
  });

  state.running = true;
  setStatus(`<span class="spin"></span> simulating…`);

  // Slice the work so the browser keeps painting between chunks.
  const CHUNK = 4000;
  const tick = () => {
    const t0 = performance.now();
    while (run.done < run.trials && performance.now() - t0 < 24) run.step(CHUNK);
    if (run.done < run.trials) {
      setStatus(`<span class="spin"></span> ${Math.round(run.done / run.trials * 100)}%`);
      requestAnimationFrame(tick);
      return;
    }
    state.running = false;
    state.results = run.results;
    state.summary = summarise(state.ctx, run.results);
    setStatus(`${run.trials.toLocaleString()} simulations`);
    renderTable();
    renderReport();
  };
  requestAnimationFrame(tick);
}

function setStatus(html) {
  const el = $('status');
  if (el) el.innerHTML = html;
}

/* --------------------------------------------------------------- header */

function renderMeta() {
  const d = state.data;
  const played = d.matches.filter((m) => m.status === 'completed').length;
  const left = d.matches.length - played;
  const src = d.source === 'live'
    ? `<span class="badge live"><span class="dot"></span>Live · ${esc(fmtWhen(d.fetchedAt))}</span>`
    : d.placeholder
      ? '<span class="badge warn">Sample data</span>'
      : `<span class="badge">Snapshot · ${esc(fmtWhen(d.generated_at))}</span>`;

  $('meta').innerHTML = `${src}
    <span class="badge">${played} played · ${left} to play</span>
    <span class="badge">Top ${d.rules.promotion_spots} up · Top ${d.rules.playoff_spots} playoffs ·
      Bottom ${d.rules.relegation_spots} down</span>`;
}

function renderWarnings() {
  const d = state.data;
  const out = [];

  if (d.placeholder) {
    out.push(banner('warn', 'These are invented results, not real ones',
      `${esc(d.placeholder_note || '')} Every number below is computed correctly — from made-up matches.`));
  }

  const issues = crossCheck(
    state.data.standings.map((r) => ({
      ...r, name: (d.teams.find((t) => t.id === r.teamId) || {}).name, nrr: netRunRate(r),
    })),
    d.published);
  if (issues.length) {
    out.push(banner('error', 'Our table disagrees with the one CricHeroes publishes',
      `${issues.slice(0, 6).map(esc).join('<br>')}<br><br>` +
      'Usually a match result that did not parse, or different points rules. ' +
      'Projections below are only as good as this table.'));
  }

  for (const w of (d.warnings || [])) out.push(banner('warn', 'Note', esc(w)));

  const incomplete = d.matches.filter((m) => m.result && m.result.incomplete).length;
  if (incomplete) {
    out.push(banner('warn', `${incomplete} completed match(es) came through without scores`,
      'Their points are counted but they contribute nothing to net run rate, so NRR here will ' +
      'differ slightly from CricHeroes.'));
  }

  $('warnings').innerHTML = out.join('');
}

/* ---------------------------------------------------------------- table */

function zoneClass(position) {
  const r = state.data.rules;
  const n = state.data.teams.length;
  if (position <= r.promotion_spots) return 'zone-promote';
  if (position <= r.playoff_spots) return 'zone-playoff';
  if (position > n - r.relegation_spots) return 'zone-relegate';
  return '';
}

function renderTable() {
  const rows = [...state.summary].sort((a, b) => {
    const pa = state.data.standings.findIndex((r) => r.teamId === a.team.id);
    const pb = state.data.standings.findIndex((r) => r.teamId === b.team.id);
    return pa - pb;
  });

  const body = rows.map((s, i) => {
    const pos = i + 1;
    const g = (k) => {
      const c = s.certainty;
      if (k === 'relegation') {
        return c.relegation.doomed ? 'clinched' : (c.relegation.safe ? 'eliminated' : 'live');
      }
      return c[k].clinched ? 'clinched' : (c[k].eliminated ? 'eliminated' : 'live');
    };
    return `<tr class="clickable ${zoneClass(pos)}${s.team.id === state.focusId ? ' focus' : ''}"
              data-team="${esc(s.team.id)}">
      <td class="l pos">${pos}</td>
      <td class="l">${teamCell(s.team)}</td>
      <td class="num sm-hide">${s.row.played}</td>
      <td class="num sm-hide">${s.row.won}</td>
      <td class="num sm-hide">${s.row.lost}</td>
      <td class="num"><strong>${s.row.points}</strong></td>
      <td class="num sm-hide">${signed(s.nrr)}</td>
      <td class="num sm-hide">${s.remaining}</td>
      ${probCell('playoff', s.p.playoff, g('playoff'))}
      ${probCell('promotion', s.p.promotion, g('promotion'))}
      ${probCell('relegation', s.p.relegation, g('relegation'))}
    </tr>`;
  }).join('');

  $('table').innerHTML = `
    <div class="card scroll"><table>
      <thead><tr>
        <th class="l">#</th><th class="l">Team</th>
        <th class="num sm-hide">P</th><th class="num sm-hide">W</th><th class="num sm-hide">L</th>
        <th class="num">Pts</th><th class="num sm-hide">NRR</th><th class="num sm-hide">Left</th>
        <th>Playoffs</th><th>Promotion</th><th>Relegation</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="legend">
      <span><i style="background:var(--promote)"></i>Promotion places (top ${state.data.rules.promotion_spots})</span>
      <span><i style="background:var(--playoff)"></i>Playoff places (top ${state.data.rules.playoff_spots})</span>
      <span><i style="background:var(--relegate)"></i>Relegation places (bottom ${state.data.rules.relegation_spots})</span>
      <span><strong>Yes</strong> / <strong>—</strong> = mathematically settled, whatever happens</span>
    </div>`;

  for (const tr of $('table').querySelectorAll('tr[data-team]')) {
    tr.onclick = () => {
      const id = Number(tr.dataset.team) || tr.dataset.team;
      if (id === state.focusId) return;
      state.focusId = id;
      $('focus').value = String(id);
      const u = new URL(location.href);
      u.searchParams.set('team', id);
      history.replaceState(null, '', u);
      rebuild();
    };
  }
}

/** Season already over — show the final table with no projections. */
function renderFinalTable() {
  setStatus('season complete');
  const rows = state.data.standings.map((r, i) => {
    const team = state.data.teams.find((t) => t.id === r.teamId);
    return `<tr class="${zoneClass(i + 1)}">
      <td class="l pos">${i + 1}</td><td class="l">${teamCell(team)}</td>
      <td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.lost}</td>
      <td class="num"><strong>${r.points}</strong></td><td class="num">${signed(r.nrr)}</td>
    </tr>`;
  }).join('');
  $('table').innerHTML = `<div class="card scroll"><table>
    <thead><tr><th class="l">#</th><th class="l">Team</th><th class="num">P</th>
      <th class="num">W</th><th class="num">L</th><th class="num">Pts</th><th class="num">NRR</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  $('report').innerHTML = banner('warn', 'Every match has been played',
    'There is nothing left to project — this is the final table.');
}

/* --------------------------------------------------------------- report */

function renderReport() {
  const cards = ['promotion', 'playoff', 'relegation']
    .map((goal) => goalCard(buildReport(state.ctx, state.results, state.summary, state.focusId, goal)))
    .join('');

  const team = state.data.teams.find((t) => t.id === state.focusId);
  const fixtures = state.ctx.remaining
    .filter((m) => m.h === state.ctx.index.get(state.focusId) || m.a === state.ctx.index.get(state.focusId))
    .map((m) => {
      const oppIdx = m.h === state.ctx.index.get(state.focusId) ? m.a : m.h;
      return `<div class="fixture"><span>vs <strong>${esc(state.ctx.teams[oppIdx].name)}</strong></span>
        <span class="when">${esc(fmtWhen(m.date))}</span></div>`;
    }).join('') || '<p class="sub">No games left.</p>';

  $('report').innerHTML = `
    <h2>${esc(team.name)} — what has to happen</h2>
    <p class="note">
      Percentages come from ${state.results.trials.toLocaleString()} simulated seasons using the
      <strong>${state.model === 'form' ? 'form-weighted' : 'coin flip'}</strong> model.
      <strong>Through</strong> and <strong>out</strong> are proved from the points arithmetic and hold
      whatever happens.
    </p>
    ${cards}
    <div class="panelbox" style="margin-top:16px">
      <h3 style="margin-top:0">${esc(team.name)}'s remaining fixtures</h3>
      ${fixtures}
    </div>`;
}

function goalCard(rep) {
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
    ${rep.state === 'live' ? requirements(rep, avoiding) : settled(rep, avoiding)}
  </div>`;
}

function settled(rep, avoiding) {
  const c = rep.summaryRow.certainty;
  if (rep.state === 'clinched' && !avoiding) {
    return `<ul class="reqs"><li><span class="mark ok">✓</span><span>
      Even losing every remaining game, no one can push
      <strong>${esc(rep.team.name)}</strong> out of the top ${state.data.rules[rep.goal === 'promotion' ? 'promotion_spots' : 'playoff_spots']}.
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
      clear of the bottom ${state.data.rules.relegation_spots}. Survival is already secured.
    </span></li></ul>`;
  }
  return `<ul class="reqs"><li><span class="mark no">✕</span><span>
    Best possible finish is <b>${c.bestPossiblePosition}${ord(c.bestPossiblePosition)}</b>,
    which is inside the relegation places however the rest of the season goes.
  </span></li></ul>`;
}

function ord(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function requirements(rep, avoiding) {
  const items = [];
  const games = rep.summaryRow.remaining;

  // 1. Your own games.
  const seen = rep.breakdown.filter((b) => b.trials >= 20);
  if (games > 0 && seen.length) {
    const parts = seen.map((b) => {
      const p = avoiding ? 1 - b.p : b.p;
      const lbl = b.wins === games ? `win all ${games}` : (b.wins === 0 ? 'lose them all' : `win ${b.wins}`);
      return `${lbl} → <b>${pct(p)}</b>`;
    }).join(' &nbsp;·&nbsp; ');
    items.push(['ok', `<strong>Your own ${games} game${games > 1 ? 's' : ''}:</strong> ${parts}
      <br><em>${avoiding ? 'chance of staying up' : 'chance of making it'} after each number of wins</em>`]);
  }

  // 2. Does winning everything settle it on its own?
  const sweepP = avoiding ? 1 - rep.sweep.base : rep.sweep.base;
  if (games > 0 && rep.sweep.baseTrials >= 50) {
    const outcome = avoiding ? 'stays up' : 'is enough';
    if (sweepP >= 0.995) {
      items.push(['ok', avoiding
        ? `<strong>Winning all ${games} keeps you up</strong> — in every one of the
           ${rep.sweep.baseTrials.toLocaleString()} simulated seasons where it happened.`
        : `<strong>Winning all ${games} is enough on its own</strong> — it worked in every one of the
           ${rep.sweep.baseTrials.toLocaleString()} simulated seasons where it happened.
           No other result needs to go your way.`]);
    } else if (sweepP <= 0.005) {
      // Nothing useful to list below: no arrangement of other results rescued
      // this in the sample, so pointing at "key fixtures" would be noise.
      items.push(['no', `<strong>Winning all ${games} still ${avoiding ? 'does not keep you up' : 'is not enough'}</strong>
        — it did not happen in any of the ${rep.sweep.baseTrials.toLocaleString()} simulated seasons
        where ${avoiding ? 'they won out' : 'that happened'}. Not mathematically impossible yet, but
        it needs a combination of other results rare enough that the simulation never produced one.`]);
    } else {
      items.push(['maybe', `<strong>Win all ${games} and it ${outcome} ${pct(sweepP)} of the time</strong> —
        likely, but still dependent on results elsewhere.`]);
    }
  }

  // 3. What has to happen elsewhere.
  if (rep.sweep.fixtures.length && sweepP < 0.995 && sweepP > 0.005) {
    const list = rep.sweep.fixtures.slice(0, 5).map((f) => {
      const pGood = avoiding ? 1 - f.pIfNeeded : f.pIfNeeded;
      const pBad = avoiding ? 1 - f.pIfNot : f.pIfNot;
      return `<li><span class="mark maybe">→</span><span>
        <strong>${esc(f.needWinner.name)}</strong> to beat ${esc(f.needLoser.name)}
        &nbsp;<em>${pct(pGood)} if they do, ${pct(pBad)} if they don't</em></span></li>`;
    }).join('');
    items.push(['raw', `<strong>Assuming you win all ${games}, the results that matter most:</strong>
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
        ${bits.join(' — or ')} in each of the ${m.games} remaining games
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

init();
