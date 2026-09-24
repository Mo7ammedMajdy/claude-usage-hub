// Regression test for the calibration fit on frozen real readings (2026-09-24, repriced).
// Run before deploying a change to api/_fit.js or api/_combine.js:  node tools/test-fit.mjs
// The bounds come from direct measurements on those readings (see HANDOFF.md, audit pass):
// Opus-only stretches ≈ 0.7-0.9 %/$, Fable-only stretches a·φ ≈ 2.1 %/$ (φ ≈ 3.5-4).
import { readFileSync } from "node:fs";
import { fitDevices } from "../api/_fit.js";
import { canonical } from "../api/_combine.js";

const S = JSON.parse(readFileSync(new URL("./fixtures/readings-2026-09-24.json", import.meta.url)));
for (const d of Object.keys(S)) S[d] = S[d].filter((s) => s.w5).sort((a, b) => a.t.localeCompare(b.t));
const t0 = Date.now();
const fit = fitDevices(S);
const ms = Date.now() - t0;
const f = fit.five;
// Each real window checked once: distinct (canonical) session windows whose official % rose 5+
// points, over both laptops' readings (they sit on different price tables, pv 1 and 2).
const rises = {};
for (const s of Object.values(canonical(S)).flat().filter((s) => s.p5 != null).sort((a, b) => a.t.localeCompare(b.t)))
  (rises[s.w5] ||= [s.p5, s.p5])[1] = s.p5;
const risen = Object.values(rises).filter(([a, b]) => b - a >= 5).length;
// Once the Fable-heavy 2026-09-19 windows are gone from the readings, φ can't be learned: it has
// to stay at its prior (it read 11.6 from ~$1 of Fable), or at the φ carried from the last fit.
const cut = Object.fromEntries(Object.entries(S).map(([d, l]) => [d, l.filter((s) => s.t >= "2026-09-20")]));
const fCut = fitDevices(cut).five, fCarry = fitDevices(cut, { phiPrior: 3.85 }).five;
// …and while they are still stored but past the 7-day cut (as on 2026-09-27), they stay in as anchors.
const fLate = fitDevices(S, { now: "2026-09-27T12:00:00Z" }).five;
// A laptop that switches price tables mid-window: that window is cut in two, still checked once.
const sw = Object.fromEntries(Object.entries(canonical(S)).map(([d, l]) => [d, l.map((s) =>
  d.startsWith("laptop-b") && s.w5 === "2026-09-22T22:20:00+00:00" && s.t < "2026-09-22T20:00" ? { ...s, pv: 1 } : s)]));
const fSw = fitDevices(sw).five;
const checks = [
  ["session rate a in 0.4-0.9 %/$", f.a >= 0.4 && f.a <= 0.9, f.a],
  ["Fable weight φ in 2.5-6", f.phi >= 2.5 && f.phi <= 6, f.phi],
  ["a·φ (Fable %/$) in 1.5-3", f.a * f.phi >= 1.5 && f.a * f.phi <= 3, f.a * f.phi],
  ["never over-counts a window by > 3 points", f.check.over_max <= 3, f.check.over_max],
  ["measured ± ≤ 25%", f.err_measured && f.err <= 25, f.err],
  ["week is 5-9 sessions", f.a / fit.week.a >= 5 && f.a / fit.week.a <= 9, f.a / fit.week.a],
  ["week ± ≤ 25%", fit.week.err <= 25, fit.week.err],
  ["both laptops counted", Object.values(fit.devices).every((k) => k === 1), JSON.stringify(fit.devices)],
  ["refit under 3 s here (Vercel is ~4x slower)", ms < 3000, `${ms} ms`],
  ["each window checked once", f.check.windows === risen, `${f.check.windows} checked, ${risen} rose 5+`],
  ["cut at 09-20: φ in 2.5-6 (prior, not learned)", fCut.phi >= 2.5 && fCut.phi <= 6 && !fCut.phi_learned, fCut.phi],
  ["cut at 09-20: carried φ prior kept", fCarry.phi === 3.85, fCarry.phi],
  ["as of 09-27: 09-19 windows kept as anchors, φ in 2.5-6", fLate.anchors.length === 2 && fLate.phi >= 2.5 && fLate.phi <= 6 && fLate.phi_learned,
    `${fLate.phi}, anchors ${fLate.anchors.map((id) => id.slice(5, 16)).join(" ")}`],
  ["pv switch mid-window: cut in two, checked once", fSw.windows === f.windows + 1 && fSw.check.windows === risen,
    `${fSw.windows} series, ${fSw.check.windows} checked`],
];
let bad = 0;
for (const [name, ok, v] of checks) { console.log(`${ok ? "ok  " : "FAIL"} ${name}  (${typeof v === "number" ? +v.toFixed(3) : v})`); bad += !ok; }
process.exit(bad ? 1 : 0);
