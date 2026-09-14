/**
 * ui.js — small rendering helpers shared by the pages. No framework.
 */

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function pct(x, digits = 1) {
  if (x >= 0.9995) return '100%';
  if (x > 0 && x < 0.001) return '<0.1%';
  return `${(x * 100).toFixed(digits)}%`;
}

export function signed(x, digits = 3) {
  const v = Number(x) || 0;
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
}

export function initials(name, short) {
  if (short && short.trim()) return short.trim().toUpperCase().slice(0, 4);
  const w = String(name || '?').trim().split(/\s+/);
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  return String(name || '?').slice(0, 3).toUpperCase();
}

/* ------------------------------------------------------------ team logos */

let LOGOS = {};
export async function loadLogos() {
  try {
    const r = await fetch('assets/team-logos/manifest.json', { cache: 'force-cache' });
    if (r.ok) LOGOS = await r.json();
  } catch { /* initials are a fine fallback */ }
  return LOGOS;
}

export function logoFor(team) {
  const f = LOGOS[normName(team.name)];
  if (f) return `assets/team-logos/${encodeURIComponent(f)}`;
  return team.logo || null;
}

export function teamCell(team) {
  const src = logoFor(team);
  const ini = esc(initials(team.name, team.short));
  const badge = src
    ? `<img src="${esc(src)}" alt="" loading="lazy"
         onerror="this.outerHTML='<span class=&quot;ini&quot;>${ini}</span>'">`
    : `<span class="ini">${ini}</span>`;
  return `<span class="team">${badge}<span class="nm">${esc(team.name)}</span></span>`;
}

/* ---------------------------------------------------------------- layout */

export function breadcrumbs(parts) {
  return parts.map((p, i) => {
    const sep = i ? '<span>›</span>' : '';
    return sep + (p.href ? `<a href="${esc(p.href)}">${esc(p.label)}</a>` : esc(p.label));
  }).join('');
}

export function banner(kind, title, body) {
  return `<div class="banner${kind === 'error' ? ' err' : ''}">
    <div><strong>${esc(title)}</strong><p>${body}</p></div></div>`;
}

export function query() {
  return new URLSearchParams(location.search);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** A proportional bar cell for a probability, with certainty called out. */
export function probCell(kind, value, state) {
  const cls = state === 'clinched' ? 'sure' : (state === 'eliminated' ? 'out' : '');
  const text = state === 'clinched' ? 'Yes' : (state === 'eliminated' ? '—' : pct(value));
  const w = Math.max(0, Math.min(100, value * 100));
  return `<td class="p ${kind}">
    <div class="v ${cls}">${text}</div>
    <div class="bar"><i style="width:${w.toFixed(1)}%"></i></div>
  </td>`;
}
