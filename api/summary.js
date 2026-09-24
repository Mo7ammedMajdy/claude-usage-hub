import { redact, redis, slug, viewer } from "./_lib.js";
import { freshestOfficial, split } from "./_split.js";
import { forecastWeek } from "./_forecast.js";
import { cleanChat } from "./web.js";

// The small view the claude.ai userscript needs: the official limits, each person's estimated
// share, the learned rates for pricing the next message, and the claude.ai chats seen so far.
// Same maths as the dashboard's estModels(), done here so the userscript stays thin.
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// Pace forecast, as the dashboard's pace(): the average rate since the window opened, carried
// to its reset. `hours` is the window's length. In a window's first day the rate so far rests on
// a few hours, so it is blended with `prior` (% per hour, e.g. last week's average), moving
// fully to the window's own rate by hour 24; with no prior there is no projection yet.
function pace(lim, hours, now, prior = null) {
  const at = lim?.resets_exact || lim?.resets_at;      // exact when the collector sends it
  if (!at || lim.pct == null) return null;
  const reset = Date.parse(at);
  const elapsedH = Math.max(0.25, hours - (reset - now) / 36e5);
  const own = lim.pct / elapsedH, w = Math.min(1, elapsedH / 24);
  const early = w < 1 && prior == null;
  const rate = w < 1 && prior != null ? w * own + (1 - w) * prior : own;
  const runOut = !early && rate > 0 ? now + ((100 - lim.pct) / rate) * 36e5 : null;
  return { pct: lim.pct, resets_at: at, elapsed_h: elapsedH, per_day: own * 24, early, blended: w < 1 && prior != null,
    projected: early ? null : lim.pct + rate * Math.max(0, reset - now) / 36e5,
    runs_out_at: runOut != null && runOut < reset && lim.pct < 100 ? new Date(runOut).toISOString() : null };
}

export default async function handler(req, res) {
  const who = viewer(req);
  if (!who) return res.status(401).json({ error: "bad key" });
  const [all, fit, people, line, lastWeeks] = await redis.pipeline().hgetall("devices").get("fit").smembers("webpeople").lrange("line", 0, -1).lrange("weeks", -1, -1).exec();
  // Last finished week's average pace (% per hour), to steady the forecast in a week's first day.
  const lastWeek = (lastWeeks || []).map(parse)[0];
  const prior = lastWeek?.week != null ? lastWeek.week / 168 : null;
  const devices = Object.values(all || {}).map((d) => redact(parse(d), who));
  const fresh = freshestOfficial(devices);
  const { people: peopleSplit, elsewhere } = split(devices, fit, fresh?.official);
  const five = fit?.five;

  const web = {};
  if ((people || []).length) {
    const q = redis.pipeline();
    for (const p of people) q.hgetall(`webchat:${slug(p)}`);
    const got = await q.exec();
    people.forEach((p, i) => {
      // Re-checked on the way out too: a chat stored before /api/web checked its fields stays until pushed out.
      web[p] = Object.values(got[i] || {}).map((v) => { try { return cleanChat(parse(v)); } catch { return null; } }).filter(Boolean)
        .sort((a, b) => (b.last || "").localeCompare(a.last || "")).slice(0, 30);
    });
  }

  const off = fresh?.official || null;
  const now = Date.now();
  let forecast = null;
  const wk = off && pace(off.seven_day, 168, now, prior);
  if (wk) {
    // Recent burn from the 5-minute line, when it spans 3+ hours without a weekly reset.
    const pts = (line || []).map((v) => (typeof v === "string" ? JSON.parse(v) : v))
      .filter((h) => h.week != null && now - Date.parse(h.t) < 24 * 36e5).sort((a, b) => a.t.localeCompare(b.t));
    let recent = null;
    if (pts.length >= 2) {
      const a = pts[0], b = pts[pts.length - 1], span = (Date.parse(b.t) - Date.parse(a.t)) / 36e5;
      if (span >= 3 && b.week >= a.week) recent = { span_h: span, per_day: (b.week - a.week) / span * 24 };
    }
    forecast = { week: wk, recent, pattern: forecastWeek(off.seven_day, fit?.week_hours, now),
      scoped: (off.scoped || []).map((x) => {
        const g = /fable/i.test(x.name) ? forecastWeek(x, fit?.fable_hours, now) : null;
        return g && !g.early ? { name: x.name, runs_out_at: g.runs_out_at } : { name: x.name, ...pace(x, 168, now) };
      }).filter((x) => x.runs_out_at) };
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    now: new Date().toISOString(), viewer: who,
    official: off && { five: off.five_hour, week: off.seven_day, scoped: off.scoped, breakdown: off.breakdown, read_at: fresh.sent_at },
    people: peopleSplit,
    elsewhere,
    // For pricing a message: % of the session per API-$ of non-cache tokens (a), of cache reads
    // (b), and the per-family weights. The userscript turns a context size into a %.
    forecast,
    rate: five?.a != null ? { a: five.a, b: five.b ?? five.a, m: five.m || {}, err: five.err ?? null } : null,
    web,
  });
}
