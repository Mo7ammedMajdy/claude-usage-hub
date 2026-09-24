// Calibration: how many % of a limit one unit of logged usage is worth.
//
// Usage is logged as price-weighted amounts (API $), split into x (input, output, cache
// writes) and r (cache reads), and into Fable vs. every other model. Within a window,
//     official% = floor( a·U(t) + O(t) ),
//     U = (x + ρ·r)_opus + φ·(x + ρ·r)_fable + ψ·(x + ρ·r)_sonnet/haiku
// ρ = weight of a cache read relative to its API price. Controlled tests on 2026-09-19
//     (40 short Opus calls re-reading a cached 365k-token context; the session rose 8
//     points for x = $2.7 + r = $12.9) put it at 0.4–0.6.
// φ = how much heavier Fable counts than its API price suggests, relative to other models
//     (a Fable-only stretch the same day gave a·φ ≈ 2.6, i.e. φ ≈ 3).
// O = usage no synced laptop logged (claude.ai chats, Claude Code in the cloud or on
//     another machine, deleted logs): never negative, never goes down within a window.
//
// Estimator. For a candidate (a, ρ, φ) the readings of a window pin O from both sides:
//     O(t) ≥ p_t − a·U_hi(t)        (the official % is at least p_t)
//     O(t) < p_t + 1 − a·U_lo(t)    (and below p_t + 1)
// where U_lo/U_hi bracket what the other laptops had logged at that moment (see combine()
// in ingest.js). The smallest non-decreasing O that meets the first line is one forward
// pass (a running max); wherever it breaks the second line the candidate is over-counting
// by that many points. The cost of a candidate is
//     J = λ·(total rise of O) + (total violation)
// i.e. unlogged usage is allowed but not free (λ per point), over-counting costs one per
// point. At the true (a, ρ, φ) the violations are exactly zero and O is the true unlogged
// usage since the readings began (± a point of rounding), so J is minimal there; a too-small a puts
// the shortfall into O (λ per point), a too-large a over-counts. Every reading's floor
// contributes, so a clean, densely-read window pins a to about ±1/U(window). The known
// limit stays: unlogged use that never pauses is indistinguishable from a higher rate,
// and pushes a up by that rate.
//
// Uncertainty. The reported ranges are profile intervals: every (a, ρ, φ) on the grid
// whose cost is within DELTA points of the best is "as good" — the data cannot tell them
// apart to within a couple of rounding/timing artefacts. The range of a over that set is
// what the page shows (it narrows as clean readings accumulate: more floors, a longer
// rise), and ± is its half-width. DELTA was set on synthetic data (scratchpad
// fit7.test.mjs) so that the range covers the truth in ~90 % of runs with light
// unlogged use. Among the "as good" set, the point closest to the prior is the estimate,
// so an unidentified parameter shows as a range plus the prior, not an arbitrary extreme.
//
// Per-laptop weight. A laptop's Claude Code may not be billed to this account at all (an
// API key in its shell, another login), in which case its logged usage never moves the
// official % and would only drag the rate down. fitDevices() tries, for every laptop but
// the one with the most logged usage, counting it in full (κ = 1) or not at all (κ = 0),
// and keeps the cheapest combination; the page says which laptops count.
//
// Inputs: samples carry {t, w, p} and either flat totals (x, r, xf, rf) or two sets,
// `lo` and `hi` (see combine() in ingest.js).

import { canonical, combine } from "./_combine.js";

// Which readings the fit looks at: the last week (rates may drift over weeks), every window in
// it. It used to be "the 14 newest window ids", which after a quiet spell kept only windows with
// hardly any Fable in them — and then unlogged claude.ai use got blamed on the little Fable there
// was (φ read 11.6; the Fable-only stretches of 2026-09-19 say ≈ 3.5-4). Back-tested 2026-09-24
// (scratchpad backtest.mjs): no held-out window over-predicted, vs. two by 40+ points before.
const MAX_PER_WINDOW = 60;
const MAX_WINDOWS = 60;
const MAX_AGE_DAYS = 7;
const MIN_SPAN = 3;         // a window needs a ≥3-point rise before it says anything
const LAMBDA = 0.6;         // cost of a point of unlogged usage (O going up)
const MU = 1;               // cost of a point of over-counting (O going down)
const DELTA = 2;            // profile margin, in points (see above)
const CLEAN = 0.25;         // a window more than 25 % short of its official rise had unlogged use
const PRIOR = { a: 0.85, rho: 0.5, phi: 3, psi: 1 }; // measured 2026-09-19 (see above); tie-breaks only
const AS = Array.from({ length: 81 }, (_, i) => 0.02 * Math.pow(400, i / 80)); // 0.02 … 8 %/$, ×1.078
const RHOS = Array.from({ length: 20 }, (_, i) => +((i + 1) * 0.05).toFixed(2)); // 0.05 … 1
const PHIS = Array.from({ length: 41 }, (_, i) => 0.5 * Math.pow(30, i / 40));     // 0.5 … 15
// ψ: how much Sonnet/Haiku count against the limit versus their API price. Coarser than
// φ — these models are a small share of the usage, so a fine grid would only cost time.
const PSIS = [0.25, 0.4, 0.6, 0.8, 1, 1.3, 1.7, 2.2, 3];

function thin(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return out;
}

// Cost of (a, ρ, φ) on one window. W: {p, w (width of the rounding interval), lo, hi}
// arrays, lo/hi as [xn, rn, xF, rF]. Returns [rise of O, fall of O], in points.
// Each reading gives O a band [p − a·U_hi, p + w − a·U_lo]. O is moved only when it has
// to and by the least amount (for per-point costs that is the cheapest path): up when it
// is below the band, down when above. Going up is unlogged usage (λ per point); going
// down is a reversal that the model doesn't allow (1 per point): over-counting, or a
// transient such as a lag longer than the allowance below, a clock skew, a laptop's logs
// arriving late. A transient costs (λ + 1)·its size once and is then forgotten.
// Lag allowance: the logs and the official % can lag each other (a call is logged when
// its first block arrives, counted by Anthropic when it completes, or the other way
// round), so the floor uses the logged usage two readings later and the cap the usage
// two readings earlier.
const LAG = 2;
// Weighted usage U at every reading of a window, for one (ρ, φ, ψ). Kept apart from cost() so
// it is computed once per weight setting, not once per candidate rate.
function usage(W, rho, phi, psi) {
  const n = W.p.length, uLo = new Float64Array(n), uHi = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const lo = W.lo[t], hi = W.hi[t];
    uLo[t] = lo[0] + rho * lo[1] + phi * (lo[2] + rho * lo[3]) + psi * (lo[4] + rho * lo[5]);
    uHi[t] = hi[0] + rho * hi[1] + phi * (hi[2] + rho * hi[3]) + psi * (hi[4] + rho * hi[5]);
  }
  return [uLo, uHi];
}
function cost(W, a, [uLo, uHi]) {
  const n = W.p.length;
  // O starts wherever the first reading puts it, free of charge: what was used before the
  // readings began says nothing about the rate, and charging for it would reward a rate
  // that explains it away (readings of a 7-day limit usually start days into its window).
  let O = null, rise = 0, fall = 0;
  for (let t = 0; t < n; t++) {
    const L = W.p[t] - a * uHi[Math.min(n - 1, t + LAG)];
    const H = W.p[t] + W.w[t] - a * uLo[Math.max(0, t - LAG)];
    if (O === null) O = Math.max(0, L);
    else if (O < L) { rise += L - O; O = L; } else if (O > H) { fall += O - H; O = H; }
  }
  return [rise, fall];
}

export function fitPath(samples, { w, p, x, r, xf, rf, xl, rl, width = () => 1, minSpan = MIN_SPAN, rhos = RHOS, phis = PHIS, psis = PSIS, prior = PRIOR, lambda = LAMBDA, delta = DELTA,
  maxWindows = MAX_WINDOWS, maxPerWindow = MAX_PER_WINDOW, maxAgeDays = MAX_AGE_DAYS, fableShare = 0, skip = null }) {
  const byWin = {};
  const newest = samples.reduce((m, s) => (s.t > m ? s.t : m), "");
  for (const s of samples) {
    if (skip && skip(s)) continue;
    if (maxAgeDays && Date.parse(newest) - Date.parse(s.t) > maxAgeDays * 864e5) continue;
    const v = s.lo || s;
    // Readings priced with different tables aren't comparable within a window: keep them apart.
    if (s[w] && s[p] != null && v[x] != null && v[r] != null) (byWin[`${s[w]}|${s.pv || 1}`] ||= []).push(s);
  }
  // Six components: Opus-tier x/r, Fable x/r, Sonnet+Haiku x/r (0 when a reading predates the split).
  const parts = (v) => {
    const fx = xf ? v[xf] || 0 : 0, fr = rf ? v[rf] || 0 : 0, lx = xl ? v[xl] || 0 : 0, lr = rl ? v[rl] || 0 : 0;
    return [v[x] - fx - lx, v[r] - fr - lr, fx, fr, lx, lr];
  };
  const windows = [];
  let points = 0, span = 0;
  for (const key of Object.keys(byWin).sort().slice(-maxWindows)) {
    const S = thin(byWin[key].sort((a, b) => a.t.localeCompare(b.t)), maxPerWindow);
    points += S.length;
    const ps = S.map((s) => s[p]);
    span = Math.max(span, Math.max(...ps) - Math.min(...ps));
    windows.push({ key, p: ps, w: ps.map(width), lo: S.map((s) => parts(s.lo || s)), hi: S.map((s) => parts(s.hi || s)) });
  }
  if (span < minSpan || points < 2) return { a: null, n: points, span, need: Math.max(1, +(minSpan - span).toFixed(1)) };
  // Usage in the data, to know which parameters it can speak about at all.
  const tot = [0, 0, 0, 0, 0, 0];
  for (const W of windows) { const last = W.lo[W.lo.length - 1]; for (let k = 0; k < 6; k++) tot[k] += last[k]; }
  const all = tot.reduce((a, b) => a + b, 0);
  const hasFable = tot[2] + tot[3] > fableShare * all, hasReads = tot[1] + tot[3] + tot[5] > 0;
  // ψ is only worth searching when Sonnet/Haiku are a visible share of the logged usage.
  const light = tot[4] + tot[5], hasLight = light > 0.05 * (tot[0] + tot[1] + tot[2] + tot[3] + light);
  const phiGrid = hasFable ? phis : [prior.phi], rhoGrid = hasReads ? rhos : [prior.rho];
  const psiGrid = hasLight ? psis : [prior.psi];

  const cands = [];
  for (const rho of rhoGrid) for (const phi of phiGrid) for (const psi of psiGrid) {
    let bestA = null, bestJ = Infinity;
    const us = windows.map((W) => usage(W, rho, phi, psi));
    const J = (a) => { let rise = 0, viol = 0; windows.forEach((W, i) => { const [r1, v1] = cost(W, a, us[i]); rise += r1; viol += v1; }); return lambda * rise + MU * viol; };
    const js = AS.map(J);
    for (let i = 0; i < AS.length; i++) if (js[i] < bestJ) { bestJ = js[i]; bestA = i; }
    // Report every a on the grid within delta (for the ranges), and the minimum.
    for (let i = 0; i < AS.length; i++) if (js[i] <= bestJ + delta) cands.push({ a: AS[i], rho, phi, psi, j: js[i], min: i === bestA });
  }
  const best = Math.min(...cands.map((c) => c.j));
  const near = cands.filter((c) => c.j <= best + delta);
  const mins = near.filter((c) => c.min && c.j <= best + delta);
  const dist = (c) => Math.abs(Math.log(c.a / prior.a)) + Math.abs(Math.log(c.phi / prior.phi))
    + Math.abs(Math.log((c.psi ?? 1) / prior.psi)) + Math.abs(c.rho - prior.rho) * 2;
  const est = mins.slice().sort((p, q) => (p.j - q.j) / delta * 0.5 + dist(p) - dist(q))[0];
  const range = (key) => [Math.min(...near.map((c) => c[key])), Math.max(...near.map((c) => c[key]))];
  const aR = range("a"), rhoR = range("rho"), phiR = range("phi");
  // Grid resolution of a is ×1.078: half a step either side is inside the range anyway.
  const aLo = aR[0] / Math.sqrt(1.078), aHi = aR[1] * Math.sqrt(1.078);
  const err = Math.round(100 * Math.max(0.01, (aHi - aLo) / (2 * est.a)));
  // Measured error: in every window with a rise of 5+ points, what the fit says the logged usage
  // added against what the official % actually did. The official % can only rise *more* than the
  // logs explain (usage no laptop logged), so a window more than CLEAN short is set aside as
  // "had unlogged use" and the typical miss on the others is the error. Over-counting — the fit
  // saying more than the official % showed — is always a real miss, reported as over_max.
  const U = (v) => v[0] + est.rho * v[1] + est.phi * (v[2] + est.rho * v[3]) + (est.psi ?? 1) * (v[4] + est.rho * v[5]);
  const checks = [];
  for (const W of windows) {
    const n = W.p.length, rise = W.p[n - 1] - W.p[0];
    if (rise < 5) continue;
    const pred = est.a * ((U(W.lo[n - 1]) + U(W.hi[n - 1])) / 2 - (U(W.lo[0]) + U(W.hi[0])) / 2);
    checks.push({ key: W.key, rise, pred: +pred.toFixed(1), short: (rise - pred) / rise });
  }
  const clean = checks.filter((c) => c.short <= CLEAN).map((c) => Math.abs(c.short)).sort((m, q) => m - q);
  const check = {
    windows: checks.length, clean: clean.length, unlogged: checks.length - clean.length,
    err: clean.length >= 3 ? Math.round(100 * clean[Math.floor(clean.length / 2)]) : null,
    over_max: checks.length ? +Math.max(0, ...checks.map((c) => c.pred - c.rise)).toFixed(1) : null,
  };
  return {
    a: est.a, b: est.a * est.rho, rho: est.rho, phi: +est.phi.toFixed(2), psi: +(est.psi ?? 1).toFixed(2),
    a_range: [aLo, aHi].map((v) => +v.toFixed(4)), rho_range: rhoR.map((v) => +v.toFixed(2)),
    // φ / ρ count as learned only when the data single out a narrow range.
    phi_learned: hasFable && phiR[1] / phiR[0] < 2,
    phi_range: phiR.map((v) => +v.toFixed(2)),
    rho_learned: hasReads && rhoR[1] - rhoR[0] <= 0.25,
    psi_learned: hasLight && range("psi")[1] / range("psi")[0] < 2,
    psi_range: hasLight ? range("psi").map((v) => +v.toFixed(2)) : null,
    n: points, windows: windows.length, span, cost: +best.toFixed(2),
    // ± shown: the measured error once there are enough clean windows, else the profile range.
    err: check.err ?? err, err_profile: err, err_measured: check.err != null, check,
  };
}

export function fitAll(samples, over = {}) {
  // Model weights: API price ratios, except Fable, which gets the learned φ.
  const wrap = (f) => ({ ...f, m: { fable: f.phi ?? 1, opus: 1, other: 1, sonnet: f.psi ?? 1, haiku: f.psi ?? 1 },
    learned: !!f.phi_learned });
  const five = fitPath(samples, { w: "w5", p: "p5", x: "x5", r: "r5", xf: "x5f", rf: "r5f", xl: "x5l", rl: "r5l", ...over });
  // The weekly limit moves slowly, so its own data can't pin down per-model weights: it
  // reuses the session's ρ and φ and only fits its overall rate. Its % is the official
  // integer scaled by Anthropic's integer Claude Code share, so its rounding interval is
  // a little wider than one point. Its prior rate: the weekly limit has been about 7.5
  // sessions' worth (measured 2026-09-19).
  const rho = five.rho ?? PRIOR.rho, phi = five.phi ?? PRIOR.phi;
  const psi = five.psi ?? PRIOR.psi;
  const shared = { rhos: [rho], phis: [phi], psis: [psi], prior: { a: (five.a ?? PRIOR.a) / 7.5, rho, phi, psi } };
  const inherit = five.a != null ? { phi_learned: five.phi_learned, phi_range: five.phi_range, rho_learned: five.rho_learned,
    rho_range: five.rho_range, psi_learned: five.psi_learned, psi_range: five.psi_range } : {};
  const week = fitPath(samples, { w: "ww", p: "pw", x: "xw", r: "rw", xf: "xwf", rf: "rwf", xl: "xwl", rl: "rwl",
    width: (p) => 1 + p / 100, minSpan: 4, ...over, ...shared });
  // Fable's own weekly limit vs. logged Fable usage. It is a separate, smaller budget (it
  // has moved about 1 point per Fable API-$, i.e. ~4× faster than φ·a_week), so it is
  // fitted on its own; only ρ is shared, since its cache reads are too few to learn one.
  const fable = fitPath(samples, { w: "wf", p: "pf", x: "xf", r: "rf", minSpan: 4, ...over, rhos: [rho], phis: [1],
    psis: [1], prior: { a: (five.a ?? PRIOR.a) / 7.5 * phi * 4, rho, phi: 1, psi: 1 } });
  // The week and Fable fits ride on the session's weights: their ± can't be tighter than its.
  const atLeast = (f) => (f.a != null && five.err != null ? { ...f, err: Math.max(f.err, five.err) } : f);
  return {
    five: wrap(five),
    week: wrap(atLeast({ ...week, ...inherit })),
    fable: wrap(atLeast({ ...fable, ...(five.a != null ? { rho_learned: five.rho_learned, rho_range: five.rho_range } : {}) })),
    at: new Date().toISOString(),
  };
}

/** Past 5-hour windows: each one's final official % and what each laptop's logged usage in it
 *  is worth at the fitted rates. From the (canonical) readings the fit already has. */
export function windowHistory(perDevice, fit, max = 30) {
  const f = fit?.five;
  if (f?.a == null) return [];
  const U = (s) => {
    const fx = s.x5f || 0, fr = s.r5f || 0, lx = s.x5l || 0, lr = s.r5l || 0;
    return f.a * ((s.x5 - fx - lx) + f.rho * (s.r5 - fr - lr) + f.phi * (fx + f.rho * fr) + (f.psi ?? 1) * (lx + f.rho * lr));
  };
  const wins = {};
  for (const [d, list] of Object.entries(perDevice)) for (const s of list) {
    if (!s.w5 || s.x5 == null) continue;
    const w = (wins[s.w5] ||= { id: s.w5, pct: null, devices: {} });
    if (s.p5 != null && (w.pct == null || s.p5 > w.pct)) w.pct = s.p5;
    const prev = w.devices[d];
    if (!prev || s.t > prev.t) w.devices[d] = { t: s.t, est: U(s) };
  }
  return Object.values(wins).filter((w) => w.pct != null).sort((a, b) => a.id.localeCompare(b.id)).slice(-max)
    .map((w) => ({ id: w.id, pct: w.pct, devices: Object.fromEntries(Object.entries(w.devices).map(([d, v]) => [d, +v.est.toFixed(2)])) }));
}

// Fit on every device's raw readings, choosing which laptops' usage counts (see above).
export function fitDevices(raw, over = {}) {
  const perDevice = canonical(raw);
  const names = Object.keys(perDevice);
  const usage = (d) => { const last = perDevice[d][perDevice[d].length - 1] || {}; return (last.xw || 0) + (last.rw || 0); };
  const primary = names.slice().sort((p, q) => usage(q) - usage(p))[0];
  const others = names.filter((d) => d !== primary).slice(0, 3);
  let best = null;
  for (let mask = 0; mask < 1 << others.length; mask++) {
    const weight = Object.fromEntries(others.map((d, i) => [d, (mask >> i) & 1]));
    const fit = fitAll(combine(perDevice, weight), over);
    const cost = (fit.five.cost ?? 0) + (fit.week.cost ?? 0);
    // Counting a laptop is the default: leaving one out has to pay for itself clearly.
    const adj = cost + others.reduce((s, d) => s + (weight[d] ? 0 : 1.5), 0);
    if (!best || adj < best.adj) best = { adj, fit: { ...fit, devices: { [primary]: 1, ...weight } } };
  }
  if (!best) return { ...fitAll([], over), devices: {} };
  best.fit.windows5 = windowHistory(perDevice, best.fit);
  return best.fit;
}
