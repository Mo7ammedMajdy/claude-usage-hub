// Regression test for the calibration fit on frozen real readings (2026-09-24, repriced).
// Run before deploying a change to api/_fit.js or api/_combine.js:  node tools/test-fit.mjs
// The bounds come from direct measurements on those readings (see HANDOFF.md, audit pass):
// Opus-only stretches ≈ 0.7-0.9 %/$, Fable-only stretches a·φ ≈ 2.1 %/$ (φ ≈ 3.5-4).
import { readFileSync } from "node:fs";
import { fitDevices } from "../api/_fit.js";

const S = JSON.parse(readFileSync(new URL("./fixtures/readings-2026-09-24.json", import.meta.url)));
for (const d of Object.keys(S)) S[d] = S[d].filter((s) => s.w5).sort((a, b) => a.t.localeCompare(b.t));
const t0 = Date.now();
const fit = fitDevices(S);
const ms = Date.now() - t0;
const f = fit.five;
const checks = [
  ["session rate a in 0.4-0.9 %/$", f.a >= 0.4 && f.a <= 0.9, f.a],
  ["Fable weight φ in 2.5-6", f.phi >= 2.5 && f.phi <= 6, f.phi],
  ["a·φ (Fable %/$) in 1.5-3", f.a * f.phi >= 1.5 && f.a * f.phi <= 3, f.a * f.phi],
  ["never over-counts a window by > 3 points", f.check.over_max <= 3, f.check.over_max],
  ["measured ± ≤ 25%", f.err_measured && f.err <= 25, f.err],
  ["week is 5-9 sessions", f.a / fit.week.a >= 5 && f.a / fit.week.a <= 9, f.a / fit.week.a],
  ["both laptops counted", Object.values(fit.devices).every((k) => k === 1), JSON.stringify(fit.devices)],
  ["refit under 3 s here (Vercel is ~4x slower)", ms < 3000, `${ms} ms`],
];
let bad = 0;
for (const [name, ok, v] of checks) { console.log(`${ok ? "ok  " : "FAIL"} ${name}  (${typeof v === "number" ? +v.toFixed(3) : v})`); bad += !ok; }
process.exit(bad ? 1 : 0);
