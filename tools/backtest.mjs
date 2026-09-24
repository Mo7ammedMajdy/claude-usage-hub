// Leave-one-window-out back-test of the session fit on the real readings (tools/dump.mjs first).
//   node tools/backtest.mjs tools/data/samples.json D
import { readFileSync } from "node:fs";
const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { fitPath } = await import(repo + "/api/_fit.js");
const { combine, canonical } = await import(repo + "/api/_combine.js");
const [file, cfgName = "C"] = process.argv.slice(2);
const CFG = {
  A: { canon: false, over: {} },                                          // as deployed
  B: { canon: true, over: {} },
  D: { canon: true, over: { maxWindows: 60, maxPerWindow: 60, maxAgeDays: 7 } },
  E: { canon: true, over: { maxWindows: 60, maxPerWindow: 60, maxAgeDays: 7, fableShare: 0.05 } },
  F: { canon: true, over: { maxWindows: 60, maxPerWindow: 60, maxAgeDays: 7, lambda: 0.3 } },
  G: { canon: true, over: { maxWindows: 60, maxPerWindow: 60, maxAgeDays: 7, lambda: 0.9 } },
}[cfgName];
let S = JSON.parse(readFileSync(file));
for (const d of Object.keys(S)) S[d] = S[d].filter((s) => s.w5).sort((a, b) => a.t.localeCompare(b.t));
if (CFG.canon) S = canonical(S);
const C = combine(S);
const opts = { w: "w5", p: "p5", x: "x5", r: "r5", xf: "x5f", rf: "r5f", xl: "x5l", rl: "r5l" };
const U = (v, f) => { const fx = v.x5f || 0, fr = v.r5f || 0, lx = v.x5l || 0, lr = v.r5l || 0;
  return (v.x5 - fx - lx) + f.rho * (v.r5 - fr - lr) + f.phi * (fx + f.rho * fr) + (f.psi ?? 1) * (lx + f.rho * lr); };
const wins = [...new Set(C.filter((s) => s.p5 != null).map((s) => s.w5))].sort();
const rows = [];
const t0 = Date.now();
for (const H of wins) {
  // one device's series per window (the one with most readings), so pairs are consistent
  const inH = C.filter((s) => s.w5 === H && s.p5 != null);
  const dev = Object.entries(inH.reduce((m, s) => ((m[s.d] = (m[s.d] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0][0];
  const H1 = inH.filter((s) => s.d === dev);
  const first = H1[0], last = H1[H1.length - 1];
  const rise = last.p5 - first.p5;
  const mid = (s, f) => (U(s.lo, f) + U(s.hi, f)) / 2;
  if (rise < 2 && mid(last, { rho: .5, phi: 3 }) - mid(first, { rho: .5, phi: 3 }) < 1) continue;
  const f = fitPath(C, { ...opts, ...CFG.over, skip: (s) => s.w5 === H });
  if (f.a == null) continue;
  const pred = f.a * (mid(last, f) - mid(first, f));
  const fab = (last.lo.x5f || 0) - (first.lo.x5f || 0);
  rows.push({ H: H.slice(5, 16), n: H1.length, rise, pred: +pred.toFixed(1), res: +(rise - pred).toFixed(1), a: +f.a.toFixed(3), phi: f.phi, rho: f.rho, err: f.err, fab: +fab.toFixed(1) });
}
console.table(rows);
const over = rows.filter((r) => r.res < -1.5);
const rel = rows.filter((r) => r.rise >= 5).map((r) => Math.abs(r.res) / r.rise).sort((a, b) => a - b);
console.log(`cfg ${cfgName}: windows ${rows.length}, over-predicted by >1.5 pts: ${over.length} (${over.map((r) => r.H + " " + r.res).join(", ")}), median |res|/rise (rise≥5): ${(100 * rel[Math.floor(rel.length / 2)]).toFixed(0)}%, mean |res| ${(rows.reduce((a, r) => a + Math.abs(r.res), 0) / rows.length).toFixed(1)} pts, ${Date.now() - t0} ms`);
