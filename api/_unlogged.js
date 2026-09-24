// Live "not synced" signal: the unlogged-usage path O(t) of one 5-hour window, at the
// fitted rates. cost() in _fit.js walks the same path but keeps only its total rise; here
// the path itself is returned so the dashboard can say "+6 points in the last 60 min that
// no synced laptop logged" (claude.ai, Claude Code on another machine).
// Same rules as cost(): O starts wherever the first reading puts it, only moves when a
// reading's band forces it, and the lag allowance (LAG readings either side) keeps a call
// that is logged a little before or after Anthropic counts it from showing up as a bump.
// Caveat: O also rises when a laptop's logs arrive late (it was offline, or its collector
// stalled) and Anthropic already counted the use. `synced` says whether every laptop has
// reported within `staleMs`; when it is false, treat a rise as "unknown" not "someone else".
import { canonical, combine } from "./_combine.js";

const LAG = 2;                        // same as _fit.js
const STALE_MS = 10 * 60e3;           // a laptop silent longer than this may have unsent logs
const KEYS = ["x5", "r5", "x5f", "r5f", "x5l", "r5l"];

// Weighted usage of one combined reading's lo/hi totals (six components, see _fit.js).
function U(v, { rho, phi, psi = 1 }) {
  const fx = v.x5f || 0, fr = v.r5f || 0, lx = v.x5l || 0, lr = v.r5l || 0;
  return (v.x5 - fx - lx) + rho * (v.r5 - fr - lr) + phi * (fx + rho * fr) + psi * (lx + rho * lr);
}

/** The O path of one 5-hour window (the latest by default).
 *  readings: either raw per-device lists ({device: [snapshot…]}) or an already combined
 *  array from combine(). fit: the stored fit object (uses fit.five and fit.devices).
 *  Returns null when there is no usable fit or no readings of the window. */
export function unloggedPath(readings, fit, { window = null, now = Date.now(), staleMs = STALE_MS } = {}) {
  const f = fit?.five;
  if (f?.a == null) return null;
  const combined = Array.isArray(readings) ? readings : combine(canonical(readings), fit.devices || {});
  const S = combined.filter((s) => s.w5 && s.p5 != null && s.lo?.x5 != null && s.lo?.r5 != null);
  const w5 = window || S.reduce((m, s) => (s.w5 > m ? s.w5 : m), "");
  // Readings priced with an older table aren't comparable: keep the window's latest pricing only.
  const all = S.filter((s) => s.w5 === w5).sort((a, b) => a.t.localeCompare(b.t));
  if (!all.length) return null;
  const pv = all[all.length - 1].pv || 1, R = all.filter((s) => (s.pv || 1) === pv);
  const n = R.length, uLo = R.map((s) => U(s.lo, f)), uHi = R.map((s) => U(s.hi, f));
  const points = [];
  let O = null;
  for (let t = 0; t < n; t++) {
    const L = R[t].p5 - f.a * uHi[Math.min(n - 1, t + LAG)];
    const H = R[t].p5 + 1 - f.a * uLo[Math.max(0, t - LAG)];
    if (O === null) O = Math.max(0, L);
    else if (O < L) O = L; else if (O > H) O = Math.max(0, H);   // never below 0: it is usage
    points.push({ t: R[t].t, O: +O.toFixed(2), p: R[t].p5, logged: +(f.a * uLo[t]).toFixed(2) });
  }
  const last = points[n - 1];
  const at = (ms) => points.filter((q) => Date.parse(q.t) <= ms).pop() || points[0];
  const ago60 = at(Date.parse(last.t) - 60 * 60e3);
  // Which laptops have reported lately: a silent one may still hold logs of this window.
  const seen = {};
  for (const s of combined) if (!seen[s.d] || s.t > seen[s.d]) seen[s.d] = s.t;
  const stale = Object.entries(seen).filter(([, t]) => now - Date.parse(t) > staleMs).map(([d]) => d);
  return {
    window: w5, points, n,
    since_start: +(last.O - points[0].O).toFixed(2),
    last60: +(last.O - ago60.O).toFixed(2),
    O: last.O, logged: last.logged, official: last.p,
    synced: stale.length === 0, stale, last_seen: seen,
  };
}
