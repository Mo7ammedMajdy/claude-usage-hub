// Week forecast from how the account has actually been used, not from the average since the
// week began. That average carried a burst at the start of a week for days (2026-09-19/20 used
// 55 % in two days, then 3-5 % a day followed; it kept forecasting 117-192 % while the week
// ended near 84 %). On that week's official readings the recent pace was within ~5 points from
// day four on (tools/forecast-official.py).
//
// weekHours(): the official weekly % turned into hourly increments over the last 7 days, from
// every laptop's readings (a reset counts as the % since the reset).
// forecastWeek(): expected end = now + recent pace (exponentially weighted, 30 h half-life, over
// the last 72 whole hours) × hours left; the range and the chance of hitting the limit come from
// replaying the last 7 days as whole-day blocks in random order (bursts included), 400 runs.
//
// Checks on that week (tools/forecast-pace.mjs: a replay every 2 h, Sep 21 12:00-Sep 24 16:00,
// 38 scored, final taken as 83 / 84):
// - Pace, Sep 18-20 spike ignored: EW 30 h MAE 5.64 / 6.63 counting the clock hour in progress,
//   5.45 / 6.44 over whole hours; plain mean of 72 h 5.40 / 6.40; EW over whole-day blocks 5.42 /
//   6.42. All under-forecast by ~5 (usage went from 1-2 %/day to ~5 %/day), and the old average
//   pace with the same ignore handling scores the same (5.37 / 6.37): the gain over it came from
//   leaving the spike out. The 72 h mean swings least with the daily rhythm (1.4 %/day within
//   16 h vs 2.4), but with the spike NOT marked, as any new burst is at first, it scores
//   6.91 / 7.00 against 4.02 / 4.36 for EW (it holds a burst at full weight for 3 days); day
//   blocks 4.13 / 4.39 and swing more then (5.0 vs 3.8). So: EW 30 h, whole hours. The hour in
//   progress is left out because its usage is already in the current % and it counted as a full
//   (mostly empty) hour, pulling the pace down.
// - Range, burst days in the replayed pool: holds the final in 38/38 for both (median width
//   20.4 points; aim is 80 %, so it may be wider than needed, but that is one week); p_limit > 0
//   in 24/38, up to 0.7 while only 2-3 days could be replayed (flagged `thin`). Without them it
//   held 83 in 21/38 and 84 in 12/38 (width 9.1), and p_limit was always 0.

const H = 36e5;

// `ignore`: [{from, to, note}] stretches that were one-offs (Redis `forecast:ignore`). They are
// only marked (`ignored`, 0/1 per hour): the recent pace leaves them out, the replayed days keep
// them, since bursts are exactly the tail risk the range and the chance of running out are for
// (with them dropped from the replays too, p_limit was 0 in every replayed forecast of the week
// ending 2026-09-25). The fit still uses them.
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
  const skipped = [], ignored = new Array(n).fill(0);
  for (const g of ignore || []) {
    const a = Date.parse(g.from), b = Date.parse(g.to);
    for (let i = 0; i < n; i++) {
      const t = end - (n - 1 - i) * H;
      if (t >= a && t < b && inc[i] != null) { ignored[i] = 1; if (!skipped.includes(g.note)) skipped.push(g.note); }
    }
  }
  return { end: new Date(end).toISOString(), inc, ignored, skipped };
}

// Deterministic, so the page doesn't flicker between reads.
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// Recent pace in % per hour: weighted mean of the hourly increments `k` hours back (k = 0 is the
// clock hour in progress), leaving out unknown and ignored hours. `weight(k)` picks the estimator.
export function recentPace(inc, ignored, weight, span) {
  let num = 0, den = 0;
  for (let k = 0; k < span && k < inc.length; k++) {
    const i = inc.length - 1 - k, v = inc[i];
    if (v == null || ignored?.[i]) continue;
    const w = weight(k); num += w * v; den += w;
  }
  return den > 0 ? num / den : null;
}
// 30 h half-life over the 72 whole hours before the one in progress (see the top of the file)
const pace30 = (inc, ignored) => recentPace(inc, ignored, (k) => (k ? 0.5 ** ((k - 1) / 30) : 0), 73);

// `pace` is only for the back-test (tools/forecast-pace.mjs); the page always uses the default.
export function forecastWeek(lim, profile, now = Date.now(), pace = pace30) {
  const at = lim?.resets_exact || lim?.resets_at;
  if (!at || lim.pct == null) return null;
  const reset = Date.parse(at), leftH = Math.max(0, (reset - now) / H), pct = lim.pct;
  const inc = profile?.inc || [], ignored = profile?.ignored || [];
  const rate = pace(inc, ignored);
  const known = inc.filter((v, i) => v != null && !ignored[i]).length;
  if (rate == null || known < 24) return { pct, resets_at: at, left_h: leftH, early: true, budget_per_day: leftH > 0 ? (100 - pct) / leftH * 24 : null };
  const expected = pct + rate * leftH;
  // replay whole past days (24 h blocks ending at the current clock hour) in random order,
  // ignored stretches included (see weekHours)
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

/** The old average-pace forecast, for the track record's like-for-like comparison: the week's %
 *  over the hours elapsed, with the ignored stretches' rise and hours taken out the same way the
 *  new pace leaves them out (tools/forecast-lib.mjs has the same function for the replays).
 *  `same`: readings of this week, each {t, pwr}, oldest first. */
export function averageForecast(same, pct, t, reset, ignore = []) {
  const start = reset - 168 * H, left = Math.max(0, (reset - t) / H);
  const at = (x) => { let p = null; for (const s of same) if (Date.parse(s.t) <= x) p = s.pwr; return p ?? 0; };
  let rise = 0, hours = 0;
  for (const g of ignore || []) {
    const a = Math.max(start, Date.parse(g.from)), b = Math.min(t, Date.parse(g.to));
    if (b <= a) continue;
    rise += at(b) - (a <= start ? 0 : at(a)); hours += (b - a) / H;
  }
  const elapsed = Math.max(1, (t - start) / H - hours);
  return Math.min(200, pct + (Math.max(0, pct - rise) / elapsed) * left);
}
