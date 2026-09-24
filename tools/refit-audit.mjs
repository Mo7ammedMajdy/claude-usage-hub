// Refit the dumped readings with the repo's fit code. Usage: node refit-audit.mjs <repo> [raw]
import { readFileSync } from "node:fs";
const repo = process.argv[2];
const { fitDevices, fitAll } = await import(repo + "/api/_fit.js");
const { combine } = await import(repo + "/api/_combine.js");
const S = JSON.parse(readFileSync(new URL(process.env.SAMPLES || "./data/samples.json", import.meta.url)));
for (const d of Object.keys(S)) S[d] = S[d].filter((s) => s.w5).sort((a, b) => a.t.localeCompare(b.t));
const show = (f) => JSON.stringify({ a: +f.a?.toFixed(3), rho: f.rho, phi: f.phi, psi: f.psi, a_range: f.a_range, phi_range: f.phi_range, windows: f.windows, n: f.n, err: f.err, errp: f.err_profile, check: f.check, cost: f.cost });
const t0 = Date.now();
const fit = process.argv[3] === "raw" ? { ...fitAll(combine(S)), devices: "raw" } : fitDevices(S);
console.log("five", show(fit.five)); console.log("week", show(fit.week)); console.log("fable", show(fit.fable)); console.log("devices", fit.devices, (Date.now() - t0) + "ms");
