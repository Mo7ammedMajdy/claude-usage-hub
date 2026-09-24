// Back-test of the week forecast's recent-pace estimator and range on the frozen readings
// (fixtures/readings-2026-09-24.json, week resetting 2026-09-25 01:00Z). Replays the forecast every
// 2 h from Sep 21 12:00 to Sep 24 16:00 and scores it against a final of 83 and 84 (the week had
// not ended when the fixture was taken). No network, no Redis.
//   node tools/forecast-pace.mjs [--no-ignore] [-v]
// --no-ignore: as if the Sep 18-20 spike had not been marked, i.e. how each estimator copes with
// the next burst nobody has marked yet.
import { readFileSync } from "node:fs";
import { recentPace } from "../api/_forecast.js";
import { forecastAt } from "./forecast-lib.mjs";

const H = 36e5;
const S = JSON.parse(readFileSync(new URL("./fixtures/readings-2026-09-24.json", import.meta.url)));
const reset = Date.parse("2026-09-25T01:00:00Z");
// what Redis `forecast:ignore` was seeded with (tools/forecast-ignore.mjs)
const IGNORE = process.argv.includes("--no-ignore") ? [] : [{ from: "2026-09-18T01:00:00Z", to: "2026-09-20T14:00:00Z", note: "the Sep 18-20 spike" }];
const FINALS = [83, 84];

// k = 0 is the clock hour in progress; "whole" variants skip it (its usage is already in the current %).
const day = (k) => Math.floor((k - 1) / 24);
const METHODS = {
  "EW 30 h, k=0..71 (old)": (inc, ig) => recentPace(inc, ig, (k) => 0.5 ** (k / 30), 72),
  "EW 30 h, whole hours": (inc, ig) => recentPace(inc, ig, (k) => (k ? 0.5 ** ((k - 1) / 30) : 0), 73),
  "mean 72 whole hours": (inc, ig) => recentPace(inc, ig, (k) => (k ? 1 : 0), 73),
  "EW 30 h over day blocks": (inc, ig) => recentPace(inc, ig, (k) => (k ? 0.5 ** (24 * day(k) / 30) : 0), 73),
  "forecastWeek's default": undefined,
};

const times = [];
for (let t = Date.parse("2026-09-21T12:00:00Z"); t <= Date.parse("2026-09-24T16:00:00Z"); t += 2 * H) times.push(t);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sgn = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
const replay = (pace, drop = false) => times.map((t) => ({ t, ...forecastAt(S, t, reset, IGNORE, pace, drop) })).filter((r) => r.fc && !r.fc.early);
console.log(`${times.length} replays every 2 h (early ones not scored); ignore: ${IGNORE.length ? IGNORE.map((g) => g.note).join(", ") : "none"}`);
for (const [name, pace] of Object.entries(METHODS)) {
  const rows = replay(pace);
  const rate = rows.map((r) => r.fc.per_day_recent);
  // daily-rhythm swing: the widest spread of the %/day figure within any 16 h (9 replays)
  const swing16 = Math.max(...rate.slice(8).map((_, i) => Math.max(...rate.slice(i, i + 9)) - Math.min(...rate.slice(i, i + 9))));
  const jitter = mean(rows.slice(1).map((r, i) => Math.abs(r.fc.expected - rows[i].fc.expected)));
  const parts = FINALS.map((F) => { const e = rows.map((r) => r.fc.expected - F); return `${F}: MAE ${mean(e.map(Math.abs)).toFixed(2)} bias ${sgn(mean(e))}`; });
  console.log(`${name.padEnd(24)} n=${rows.length} ${parts.join("  ")} | %/day ${Math.min(...rate).toFixed(1)}-${Math.max(...rate).toFixed(1)}, 16 h swing ${swing16.toFixed(2)}, mean 2 h move of expected ${jitter.toFixed(2)}`);
}
// Range and p_limit: burst days in the replay pool (now) vs left out (before). The week ended
// under 100, so the p_limit Brier score is the mean of p².
for (const [label, drop] of [["pool with burst days (now)", false], ["pool without them (before)", true]]) {
  const rows = replay(undefined, drop), w = rows.map((r) => r.fc.hi - r.fc.lo).sort((a, b) => a - b);
  const cover = FINALS.map((F) => `${F}: ${rows.filter((r) => r.fc.lo <= F && F <= r.fc.hi).length}/${rows.length}`).join(", ");
  const firm = rows.filter((r) => !r.fc.thin);
  console.log(`${label.padEnd(27)} range holds final ${cover} (not thin: ${firm.filter((r) => r.fc.lo <= FINALS[0] && FINALS[0] <= r.fc.hi).length}/${firm.length})` +
    ` | width median ${w[w.length >> 1].toFixed(1)} | p_limit>0 in ${rows.filter((r) => r.fc.p_limit > 0).length}, max ${Math.max(...rows.map((r) => r.fc.p_limit))},` +
    ` Brier ${mean(rows.map((r) => r.fc.p_limit ** 2)).toFixed(3)}`);
}
const rows = replay(undefined);
for (const F of FINALS) {
  const e = rows.map((r) => r.avg - F);
  console.log(`old average-pace method, same ignore handling, final ${F}: MAE ${mean(e.map(Math.abs)).toFixed(2)} bias ${sgn(mean(e))}`);
}
if (process.argv.includes("-v")) for (const r of rows) console.log(new Date(r.t).toISOString().slice(5, 16), `${r.pct}%`,
  `→ ${r.fc.expected.toFixed(1)} (${r.fc.lo.toFixed(1)}-${r.fc.hi.toFixed(1)}) p=${r.fc.p_limit} days=${r.fc.days}${r.fc.thin ? " thin" : ""} old ${r.avg.toFixed(1)}`);
