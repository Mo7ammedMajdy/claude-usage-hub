// Checks the live unlogged path (api/_unlogged.js) on frozen readings:  node tools/test-unlogged.mjs
// Windows with known unlogged use (see HANDOFF.md, back-tests) must show O rising; clean
// windows must stay ~flat. Expectations are loose: they guard the sign, not the exact size.
import { readFileSync } from "node:fs";
import { fitDevices } from "../api/_fit.js";
import { unloggedPath } from "../api/_unlogged.js";

const S = JSON.parse(readFileSync(new URL("./fixtures/readings-2026-09-24.json", import.meta.url)));
for (const d of Object.keys(S)) S[d] = S[d].filter((s) => s.w5).sort((a, b) => a.t.localeCompare(b.t));
const fit = fitDevices(S);
const ids = [...new Set(Object.values(S).flat().map((s) => s.w5))].sort();
const pick = (prefix) => ids.filter((id) => id.startsWith(prefix)).pop();
const cases = [
  ["2026-09-24T03:0", "unlogged (official rose with zero logged)", (r) => r.since_start >= 3],
  ["2026-09-20T14:4", "unlogged (large)", (r) => r.since_start >= 5],
  ["2026-09-22T17:2", "clean", (r) => r.since_start <= 3],
  ["2026-09-24T15:4", "clean", (r) => r.since_start <= 3],
];
let bad = 0;
for (const [prefix, label, ok] of cases) {
  const id = pick(prefix);
  const r = id && unloggedPath(S, fit, { window: id, now: Date.parse(id) });
  if (!r) { console.log(`FAIL ${prefix} no window/fit`); bad++; continue; }
  const pass = ok(r);
  bad += !pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${id} ${label}: O ${r.points[0].O} → ${r.O} (+${r.since_start}), last60 +${r.last60}, official ${r.points[0].p}→${r.official}, logged ${r.logged}, n=${r.n}`);
}
// Default = latest window; confidence hint flips when a laptop is silent for > 10 min.
const latest = unloggedPath(S, fit, { now: Date.now() });
console.log(`${latest.synced === false && latest.stale.length ? "ok  " : "FAIL"} latest ${latest.window}: fixture is old, so every laptop reads stale → synced=${latest.synced} stale=${latest.stale}`);
bad += !(latest.synced === false);
const fresh = unloggedPath(S, fit, { now: Math.min(...Object.values(latest.last_seen).map(Date.parse)) + 60e3 });
console.log(`${fresh.synced ? "ok  " : "FAIL"} same window, now = 1 min after the quieter laptop's last reading → synced=${fresh.synced}`);
bad += !fresh.synced;
process.exit(bad ? 1 : 0);
