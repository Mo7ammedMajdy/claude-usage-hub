// Combine every device's readings on one timeline. Each combined reading carries the
// official %s one laptop saw and two totals of *all* laptops' logged usage at that moment:
//   lo — this laptop's own totals plus, for every other laptop, its latest reading at or
//        before then (a lower bound: usage only ever grows);
//   hi — the same, but the other laptops' earliest reading at or after then (an upper
//        bound; their last reading of the window if there is none).
// The fit uses lo at the end of a pair and hi at its start, so another laptop's usage
// that isn't pinned down by a reading (it was idle, offline, or its logs arrived in one
// lump, as after a reinstall) can only loosen a bound, never tighten it. Before that
// used a stale "latest reading", so a laptop's first reading of a window showed up as a
// sudden jump in logged usage against no rise in the official %, and dragged the rate
// down for everyone.
// `weight` scales a device's logged usage (1 = counts in full, 0 = doesn't count against
// this account's %; see fitDevices() in _fit.js).
const W5 = ["x5", "r5", "x5f", "r5f", "x5l", "r5l"], WW = ["xw", "rw", "xwf", "rwf", "xwl", "rwl"];

// One window, one id. Anthropic's reset time for the same window wobbles around the minute
// (…:39:59.9 on one read, …:40:00.1 on the next), and collectors truncate it to the minute, so
// a window used to arrive under two ids — splitting its readings, and hiding one laptop's usage
// from the other's. Two real windows of a limit are hours apart, so ids within a few minutes
// of each other are the same window: map each to the latest id of its cluster.
const SAME_WINDOW_MS = 5 * 60e3;
export function canonical(perDevice) {
  const out = {};
  const maps = {};
  for (const key of ["w5", "ww", "wf"]) {
    const ids = [...new Set(Object.values(perDevice).flat().map((s) => s[key]).filter(Boolean))].sort();
    const m = (maps[key] = {});
    let group = [];
    const flush = () => { for (const id of group) m[id] = group[group.length - 1]; group = []; };
    for (const id of ids) {
      if (group.length && Date.parse(id) - Date.parse(group[group.length - 1]) > SAME_WINDOW_MS) flush();
      group.push(id);
    }
    flush();
  }
  for (const [d, list] of Object.entries(perDevice))
    out[d] = list.map((s) => ({ ...s, w5: maps.w5[s.w5] ?? s.w5, ww: maps.ww[s.ww] ?? s.ww, wf: maps.wf[s.wf] ?? s.wf }));
  return out;
}

export function combine(perDevice, weight = {}) {
  const k = (d) => weight[d] ?? 1;
  const out = [];
  const devs = Object.keys(perDevice);
  const add = (tot, q, keys, f) => { for (const key of keys) tot[key] += f * (q[key] || 0); };
  for (const d of devs) for (const s of perDevice[d]) {
    const own = Object.fromEntries([...W5, ...WW].map((key) => [key, k(d) * (s[key] || 0)]));
    const lo = { ...own }, hi = { ...own };
    for (const o of devs) {
      if (o === d) continue;
      let before5 = null, after5 = null, last5 = null, beforeW = null, afterW = null, lastW = null;
      for (const q of perDevice[o]) {
        if (q.w5 === s.w5) { last5 = q; if (q.t <= s.t) before5 = q; else if (!after5) after5 = q; }
        if (q.ww === s.ww) { lastW = q; if (q.t <= s.t) beforeW = q; else if (!afterW) afterW = q; }
      }
      if (before5) add(lo, before5, W5, k(o));
      if (after5 || last5) add(hi, after5 || last5, W5, k(o));
      if (beforeW) add(lo, beforeW, WW, k(o));
      if (afterW || lastW) add(hi, afterW || lastW, WW, k(o));
    }
    // The Fable-only limit is checked against logged Fable use (whole week).
    for (const v of [lo, hi]) { v.xf = s.wf ? v.xwf : null; v.rf = s.wf ? v.rwf : null; }
    out.push({ t: s.t, d, pv: s.pv || 1, w5: s.w5, p5: s.p5, ww: s.ww, wf: s.wf, pf: s.pf,
      pw: s.pwr == null ? null : +(s.pwr * (s.cc ?? 100) / 100).toFixed(3), lo, hi });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

