// Rebuild the running week's forecast track record from the stored readings: what the forecast
// would have said every 6 h since `from` (default: the end of the ignored stretches), marked
// `replayed`. Merges into week:current without touching forecasts recorded live.
//   set -a && . ./.env.prod && set +a && node tools/forecast-replay.mjs [fromISO]
import { Redis } from "@upstash/redis";
import { SK } from "../api/ingest.js";
import { forecastWeek, weekHours } from "../api/_forecast.js";
const r = Redis.fromEnv();
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const cur = parse(await r.get("week:current"));
const ignore = parse(await r.get("forecast:ignore")) || [];
if (!cur?.id) { console.log("no running week"); process.exit(1); }
const per = {};
for (const d of await r.hkeys("devices")) per[d] = (await r.lrange(`ds:${d}`, 0, -1)).map(parse).map((a) => Object.fromEntries(SK.map((k, i) => [k, a[i]])));
const reset = Date.parse(cur.id), weekStart = reset - 7 * 864e5;
const from = Date.parse(process.argv[2] || ignore.reduce((m, g) => (g.to > m ? g.to : m), new Date(weekStart).toISOString()));
const out = [];
for (let t = Math.ceil(from / (6 * 36e5)) * 6 * 36e5; t < Math.min(Date.now(), reset); t += 6 * 36e5) {
  const upto = Object.fromEntries(Object.entries(per).map(([d, l]) => [d, l.filter((s) => Date.parse(s.t) <= t)]));
  const same = Object.values(upto).flat().filter((s) => s.pwr != null && s.ww && Math.abs(Date.parse(s.ww) - reset) < 10 * 60e3).sort((a, b) => a.t.localeCompare(b.t));
  if (!same.length) continue;
  const pct = same[same.length - 1].pwr;
  const fc = forecastWeek({ pct, resets_exact: cur.id }, weekHours(upto, t, ignore), t);
  if (!fc || fc.early) continue;
  const elapsed = Math.max(1, 168 - fc.left_h);
  out.push({ at: new Date(t).toISOString(), pct, expected: +fc.expected.toFixed(1), lo: +fc.lo.toFixed(1), hi: +fc.hi.toFixed(1), p: fc.p_limit,
    avg: +Math.min(200, pct + (pct / elapsed) * fc.left_h).toFixed(1), replayed: true });
}
const live = (cur.forecasts || []).filter((f) => !f.replayed);
const merged = [...out.filter((f) => !live.some((l) => Math.abs(Date.parse(l.at) - Date.parse(f.at)) < 3 * 36e5)), ...live].sort((a, b) => a.at.localeCompare(b.at));
await r.set("week:current", JSON.stringify({ ...cur, forecasts: merged }));
for (const f of merged) console.log(f.at.slice(5, 16), `${f.pct}%`, `→ ${f.expected} (${f.lo}–${f.hi})`, `p=${f.p}`, `old ${f.avg}`, f.replayed ? "replayed" : "live");
