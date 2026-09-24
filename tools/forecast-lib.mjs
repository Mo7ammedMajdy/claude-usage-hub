// Shared by the forecast back-tests (forecast-replay.mjs, forecast-pace.mjs): what the week
// forecast would have said at time `t`, rebuilt from the stored readings up to `t`.
import { forecastWeek, weekHours } from "../api/_forecast.js";
const H = 36e5;

// `per`: {device: [readings]} (unpacked). `reset`: the week's reset (ms). `pace`: see forecastWeek.
// `dropIgnored`: the pre-2026-09-25 behaviour, ignored hours left out of the replayed days too.
export function forecastAt(per, t, reset, ignore = [], pace, dropIgnored = false) {
  const upto = Object.fromEntries(Object.entries(per).map(([d, l]) => [d, l.filter((s) => Date.parse(s.t) <= t)]));
  const same = Object.values(upto).flat().filter((s) => s.pwr != null && s.ww && Math.abs(Date.parse(s.ww) - reset) < 10 * 60e3)
    .sort((a, b) => a.t.localeCompare(b.t));
  if (!same.length) return null;
  const pct = same[same.length - 1].pwr, prof = weekHours(upto, t, ignore);
  if (dropIgnored) prof.inc = prof.inc.map((v, i) => (prof.ignored[i] ? null : v));
  const fc = forecastWeek({ pct, resets_exact: new Date(reset).toISOString() }, prof, t, pace);
  return fc && { pct, fc, avg: averageForecast(same, pct, t, reset, ignore) };
}

// The old method (average pace since the week began × hours left), with the ignored stretches
// handled the way the recent pace handles them: their rise and their hours both left out.
// Otherwise the old method gets scored with the burst in and the new one without it.
export function averageForecast(same, pct, t, reset, ignore = []) {
  const start = reset - 168 * H, left = Math.max(0, (reset - t) / H);
  const at = (x) => { let p = null; for (const s of same) if (Date.parse(s.t) <= x) p = s.pwr; return p ?? 0; };
  let rise = 0, hours = 0;
  for (const g of ignore) {
    const a = Math.max(start, Date.parse(g.from)), b = Math.min(t, Date.parse(g.to));
    if (b <= a) continue;
    rise += at(b) - (a <= start ? 0 : at(a)); hours += (b - a) / H;
  }
  const elapsed = Math.max(1, (t - start) / H - hours);
  return Math.min(200, pct + (Math.max(0, pct - rise) / elapsed) * left);
}
