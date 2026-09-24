// Rebuild the running week's forecast track record from the stored readings: what the forecast
// would have said every 6 h since `from` (default: the end of the ignored stretches), marked
// `replayed: true`. Merges into week:current without touching forecasts recorded live.
// `avg` is the old average-pace method with the ignored stretches left out the same way the new
// method's pace leaves them out (tools/forecast-lib.mjs), so the two are scored like for like.
// Live entries (api/ingest.js) compute `avg` on their own.
//   set -a && . ./.env.prod && set +a && node tools/forecast-replay.mjs [fromISO]      writes Redis
//   … node tools/forecast-replay.mjs --dry [fromISO]                                   reads Redis only
//   node tools/forecast-replay.mjs --fixture tools/fixtures/readings-2026-09-24.json \
//     [--ignore 2026-09-18T01:00Z,2026-09-20T14:00Z] [fromISO]                          no Redis at all
import { readFileSync } from "node:fs";
import { forecastAt } from "./forecast-lib.mjs";

const args = process.argv.slice(2);
const take = (k, n) => { const i = args.indexOf(k); return i < 0 ? null : args.splice(i, n); };
const dry = !!take("--dry", 1), fixture = take("--fixture", 2)?.[1], ign = take("--ignore", 2)?.[1];
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
let r, cur, ignore, per;
if (fixture) {
  per = JSON.parse(readFileSync(fixture));
  const ids = Object.values(per).flat().map((s) => s.ww).filter(Boolean).sort();
  cur = { id: ids[ids.length - 1], forecasts: [] };
  const [a, b, note = "ignored"] = (ign || "").split(",");
  ignore = ign ? [{ from: a, to: b, note }] : [];
} else {
  const { Redis } = await import("@upstash/redis");
  const { SK } = await import("../api/ingest.js");
  r = Redis.fromEnv();
  cur = parse(await r.get("week:current"));
  ignore = parse(await r.get("forecast:ignore")) || [];
  per = {};
  for (const d of await r.hkeys("devices")) per[d] = (await r.lrange(`ds:${d}`, 0, -1)).map(parse).map((a) => Object.fromEntries(SK.map((k, i) => [k, a[i]])));
}
if (!cur?.id) { console.log("no running week"); process.exit(1); }
const reset = Date.parse(cur.id), weekStart = reset - 7 * 864e5;
const newest = Math.max(...Object.values(per).flat().map((s) => Date.parse(s.t)));
const from = Date.parse(args[0] || ignore.reduce((m, g) => (g.to > m ? g.to : m), new Date(weekStart).toISOString()));
const out = [];
for (let t = Math.ceil(from / (6 * 36e5)) * 6 * 36e5; t <= Math.min(Date.now(), reset, newest); t += 6 * 36e5) {
  const got = forecastAt(per, t, reset, ignore);
  if (!got || got.fc.early) continue;
  const { pct, fc, avg } = got;
  out.push({ at: new Date(t).toISOString(), pct, expected: +fc.expected.toFixed(1), lo: +fc.lo.toFixed(1), hi: +fc.hi.toFixed(1), p: fc.p_limit,
    avg: +avg.toFixed(1), replayed: true });
}
const live = (cur.forecasts || []).filter((f) => !f.replayed);
const merged = [...out.filter((f) => !live.some((l) => Math.abs(Date.parse(l.at) - Date.parse(f.at)) < 3 * 36e5)), ...live].sort((a, b) => a.at.localeCompare(b.at));
if (r && !dry) await r.set("week:current", JSON.stringify({ ...cur, forecasts: merged }));
for (const f of merged) console.log(f.at.slice(5, 16), `${f.pct}%`, `→ ${f.expected} (${f.lo}–${f.hi})`, `p=${f.p}`, `old ${f.avg}`, f.replayed ? "replayed" : "live");
if (!r || dry) console.log("(printed only, nothing written)");
