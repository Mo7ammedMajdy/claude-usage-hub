// Week forecast from how the account has actually been used, not from the average since the
// week began. That average carried a burst at the start of a week for days (2026-09-19/20 used
// 55 % in two days, then 3-5 % a day followed; it kept forecasting 117-192 % while the week
// ended near 84 %). On that week's official readings the recent pace was within ~5 points from
// day four on (tools/forecast-official.py).
//
// weekHours(): the official weekly % turned into hourly increments over the last 7 days, from
// every laptop's readings (a reset counts as the % since the reset).
// forecastWeek(): expected end = now + recent pace (exponentially weighted, 30 h half-life, over
// the last 72 h) × hours left; the range and the chance of hitting the limit come from
// replaying the last 7 days as whole-day blocks in random order (bursts included), 400 runs.

const H = 36e5;

// `ignore`: [{from, to, note}] stretches that were one-offs (Redis `forecast:ignore`); their hours
// don't count towards the recent pace or the replayed days. The fit still uses them.
export function weekHours(perDevice, now = Date.now(), ignore = [], pKey = "pwr", wKey = "ww") {
  const end = Math.floor(now / H) * H, n = 168;
  const pct = new Array(n).fill(null), win = new Array(n).fill(null);
  for (const list of Object.values(perDevice)) for (const s of list) {
    const pv = s[pKey], wv = s[wKey];
    if (pv == null || !wv) continue;
    const i = n - 1 - Math.floor((end - Math.floor(Date.parse(s.t) / H) * H) / H);
    if (i < 0 || i >= n) continue;
    // the newest window wins within an hour; within a window, the highest reading
    if (win[i] == null || wv > win[i] || (wv === win[i] && pv > pct[i])) { pct[i] = pv; win[i] = wv; }
  }
  const inc = new Array(n).fill(null);
  let lastP = null, lastW = null;
  for (let i = 0; i < n; i++) {
    if (pct[i] == null) { if (lastP != null) inc[i] = 0; continue; }       // no reading: nothing seen to move
    const sameWin = lastW != null && Math.abs(Date.parse(win[i]) - Date.parse(lastW)) < 10 * 60e3;
    inc[i] = lastP == null ? null : sameWin ? Math.max(0, pct[i] - lastP) : pct[i];
    lastP = pct[i]; lastW = win[i];
  }
  const skipped = [];
  for (const g of ignore || []) {
    const a = Date.parse(g.from), b = Date.parse(g.to);
    for (let i = 0; i < n; i++) {
      const t = end - (n - 1 - i) * H;
      if (t >= a && t < b && inc[i] != null) { inc[i] = null; if (!skipped.includes(g.note)) skipped.push(g.note); }
    }
  }
  return { end: new Date(end).toISOString(), inc, skipped };
}

// Deterministic, so the page doesn't flicker between reads.
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function forecastWeek(lim, profile, now = Date.now()) {
  const at = lim?.resets_exact || lim?.resets_at;
  if (!at || lim.pct == null) return null;
  const reset = Date.parse(at), leftH = Math.max(0, (reset - now) / H), pct = lim.pct;
  const inc = profile?.inc || [];
  // recent pace: % per hour, weighted towards the last day and a half
  let num = 0, den = 0;
  for (let k = 0; k < 72 && k < inc.length; k++) {
    const v = inc[inc.length - 1 - k];
    if (v == null) continue;
    const w = 0.5 ** (k / 30); num += w * v; den += w;
  }
  const known = inc.filter((v) => v != null).length;
  if (den === 0 || known < 24) return { pct, resets_at: at, left_h: leftH, early: true, budget_per_day: leftH > 0 ? (100 - pct) / leftH * 24 : null };
  const rate = num / den;
  const expected = pct + rate * leftH;
  // replay whole past days (24 h blocks ending at the current clock hour) in random order
  const days = [];
  for (let d = 0; d < 7; d++) {
    const block = inc.slice(inc.length - 24 * (d + 1), inc.length - 24 * d);
    if (block.length === 24 && block.filter((v) => v != null).length >= 12) days.push(block.map((v) => v ?? 0));
  }
  let lo = expected, hi = expected, pLimit = expected >= 100 ? 1 : 0;
  if (days.length) {
    const rand = rng(Math.floor(reset / H)), finals = [];
    for (let r = 0; r < 400; r++) {
      let s = pct, h = 0;
      while (h < leftH) {
        const b = days[Math.floor(rand() * days.length)];
        for (let j = 0; j < 24 && h < leftH; j++, h++) s += b[j] * Math.min(1, leftH - h);
      }
      finals.push(s);
    }
    finals.sort((a, b) => a - b);
    lo = finals[40]; hi = finals[359]; pLimit = finals.filter((f) => f >= 100).length / finals.length;
  }
  // The range always holds the expected value; with under 4 days to replay it is too narrow
  // to mean much, so widen it (half to double the expected rise) and say so.
  const thin = days.length < 4;
  lo = Math.min(lo, expected, thin ? pct + (expected - pct) * 0.5 : Infinity);
  hi = Math.max(hi, expected, thin ? pct + (expected - pct) * 2 : -Infinity);
  const runOut = rate > 0 ? now + ((100 - pct) / rate) * H : null;
  return { pct, resets_at: at, left_h: leftH, expected: Math.min(expected, 100), lo: Math.min(lo, 100), hi: Math.min(hi, 100),
    p_limit: +pLimit.toFixed(2), per_day_recent: rate * 24, budget_per_day: leftH > 0 ? (100 - pct) / leftH * 24 : null,
    runs_out_at: runOut != null && runOut < reset && pct < 100 ? new Date(runOut).toISOString() : null, days: days.length,
    skipped: profile?.skipped || [], thin };
}
